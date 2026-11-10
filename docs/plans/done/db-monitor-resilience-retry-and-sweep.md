# Job-monitor resilience — the monitor never fails a job on its own error; a sweep re-attaches orphans; storage is the source of truth for results

## Status

**IMPLEMENTED 2026-11-09.** Operator decisions resolved (see "Decisions needed" — each now
annotated with the chosen option). Design substantially revised 2026-11-09 (see "Design" — the
earlier infra/non-infra classifier and failure-path job-kill were dropped as a false premise;
replaced by "the monitor never records a terminal state from its own exception").

What shipped, by change:
- **A** — `deps/Ymerflow-process-sdk/ymerflow_runner/runner.py` writes
  `{storage_base}/processes/{process_id}/{version}/info.json` (`{status, completed_at}`) after
  `run()` returns, before `sys.exit(0)`; never on the failure path. *(SDK: push to GitHub master so
  the runner image rebuilds — see the stale-deps trap in project memory.)*
- **B** — `backend/models/process.py` `monitor_job` catch-all now logs + finalizes + returns,
  leaving state untouched (no `INFRA_EXCEPTIONS`/`_is_infra_error` — never introduced).
- **C** — both TTL-404 paths call `ProcessVersion._resolve_ttl_404`, which reads the marker via
  `_completion_marker_present`: present → `_handle_job_completion(..., "succeeded")`, absent →
  `FAILED`.
- **D** — `ProcessVersion.resume_orphaned_monitors(respect_heartbeat)` (recover + reap), wired into
  `backend/main.py` `startup_event` (initial `respect_heartbeat=False`) and a periodic
  `_orphan_sweep_loop`, cancelled in `shutdown_event`. Inline reap (`_reap_job`) on every terminal
  path. New `K8sClient.list_jobs`. Liveness via the `last_monitored_at` heartbeat column
  (migration `ab62620adb17`). Config: `monitor_sweep_interval_seconds=300`,
  `monitor_stale_seconds=900`.

Tests: `backend/test_monitor_resilience.py` (9 cases: catch-all no-fail, TTL-404 present/absent,
recover respects heartbeat+job, startup recover ignores heartbeat, reap only terminal-unmonitored,
`_reap_job` tolerance, SDK marker on success / not on failure). `backend/stress/stress_pool.py`
extended with the `node-wait` scenario + the "Job monitoring failed" regression guard.

Covers asks 2, 3 and 4 of ymerflow-business
[#160](https://github.com/YmerFlow/ymerflow-business/issues/160)
(doc: `0160-db-pool-exhausted-again.md`). The sibling plan
`docs/plans/done/db-pool-commit-before-k8s-io.md` (shipped) addressed ask 1 — it stopped the pool
being *drained* by never parking a connection across K8s/storage I/O. This plan addresses the
*resilience* half: what happens to a monitor that still hits an error, and to a job whose monitor
is gone. Ask 1 makes these rare; it does not make them impossible (node scale-up + 8–10 min image
pulls can still spike concurrency), and when they happen today a transient backend error is turned
into a permanently-wrong `FAILED`, or a finished job is stranded with its outputs unrecorded.

## Root cause (recap)

The tail of `monitor_job` (`backend/models/process.py:698-718`) is a catch-all:

```python
except Exception as e:                        # ANY error — infra OR a bug in the monitor itself
    ...
    async with async_session_maker() as db:   # needs a fresh connection...
        ...
        await process_version.update_state(db, ProcessState.FAILED, ...)
    except Exception as inner_e:
        logger.error("Failed to update process state ...")   # ...and if THAT fails, give up
```

Two defects, which are exactly asks 2 and 3:

1. **It marks a version `FAILED` for errors that say nothing about the job.** A `QueuePool …
   timeout` marks the version `FAILED` just like a real crash — on 2026-11-06, 19 running
   inversions (one mid Gauss-Newton) were failed while their pods kept running correctly. `FAILED`
   must mean *the job* failed.
2. **A dead monitor is never replaced.** When the pool was exhausted the `except` block's own
   session also failed; the inner `except` just logged and returned. The version stayed
   `starting`/`running` for hours with no monitor and nothing to re-attach one — 15 stranded that
   night, plus 5 jobs that *completed* (data in storage) but were never recorded. Manual
   cancel-and-rerun (~140×) was the only recovery.

Ask 4 is adjacent: a version marked `FAILED` while its K8s job still exists leaves a pod running
(on Azure, still billing) and a Kueue `Workload` holding quota, with nobody to reap it.

## Signal model — what is actually authoritative

Understanding the fix requires seeing how a pod reports results. There are **two independent
channels, and only one is durable** (verified in `ymerflow_runner/runner.py`):

| signal | channel | lifetime |
|---|---|---|
| succeeded / failed | pod **exit code** (`sys.exit(0)` / `sys.exit(1)`) → K8s job status | **ephemeral — the Job is TTL-reaped 1h after finishing (`ttl_seconds_after_finished=3600`)** |
| the actual outputs | per-dataset `info.json` written to blob storage, discovered by `_create_outputs` via `fs.ls` | durable |

Key consequences:

- **There is no result callback to the backend.** `runner.py:146` has a `# TODO: POST outputs`
  that was never implemented. Outputs flow *only* through storage.
- **Jobs are `backoff_limit=0` + `restart_policy=Never`** (`services/job_orchestrator.py:230-242`):
  a failed pod is never restarted, so a *running* pod is a *correct* pod.
- **K8s is the source of truth for liveness** (is a job still running) but **storage is the source
  of truth for results** (did it finish, and what did it produce). The monitor today wrongly treats
  the ephemeral K8s exit code as the only truth, so when the Job is gone (TTL-404) it fails a run
  whose outputs are sitting in the bucket — exactly the 5 lost-but-completed jobs on 11-06.

This plan adds a **durable terminal marker** (see Changes A) so a monitor that arrives after the
Job is gone can still read ground truth from storage.

## Design — three principles

1. **The monitor never records a terminal state from its own exception.** A caught exception means
   *the monitor* had a problem (pool timeout, K8s API 5xx, network blip, a bug in our code) — it is
   never the signal that *the job* failed. Every genuine job failure is detected *explicitly* (pod
   exit code via K8s status, `get_pod_error_status`, `get_job_error_status`), never via the
   catch-all. So on any caught exception: log, finalize logs, **leave state untouched, return.** The
   sweep re-attaches. *(This retires the previously-planned `INFRA_EXCEPTIONS`/`_is_infra_error`
   classifier — the infra/non-infra split was a distinction without a difference, because neither
   bucket ever legitimately means "the job failed.")*

2. **Terminal states are authoritative, so `FAILED` means "reap".** Because the monitor never lies,
   a `DONE`/`FAILED` version in the DB is always true. The sweep therefore never reconciles a
   terminal version back to running; a live K8s job behind a terminal version is just leftover, and
   the only correct action is to **delete it** (releasing the pod and its Kueue `Workload`). The
   old Feature 4 ("kill the job when a monitor marks FAILED") is reframed: the delete is a *reaper
   of terminal-but-live jobs*, never a kill of still-running correct work.

3. **Kubernetes = liveness, storage = results; a sweep reconciles.** Since `monitor_job` is already
   self-reconciling (given any non-terminal `(process_id, version)` it re-checks live K8s status,
   handles the TTL-404 marker path below, waits/watches, and records outputs via
   `_handle_job_completion` → `_create_outputs`), **re-attaching a monitor is all recovery needs** —
   output-recording comes for free.

### Monitor liveness tracking

The sweep must know which versions already have a live monitor, or it will double-attach. Monitors
are today fire-and-forget `asyncio.create_task` (`main.py:80`, `process.py`) with no registry.
**Proposed: an in-process registry** — a `set[(process_id, version)]` (module-level in
`process.py`), added synchronously at the top of `monitor_job` *before the first `await`* and
removed in a `finally`. The sweep skips any version in the set. Single-backend deployment (current
prod) makes in-memory sufficient; backend restart empties the set but the startup scan rebuilds the
world from the DB. *(Alternative considered: a `last_monitored_at` heartbeat column — survives
multi-replica and detects hung-but-registered monitors, at the cost of a migration + periodic
writes. Deferred; see Decisions.)*

## Changes

### A. SDK — write a durable process-version-level status marker (`ymerflow_runner/runner.py`)

**New requirement.** On successful completion — after `process_class.run(...)` returns, immediately
before `sys.exit(0)` (`runner.py:149`) — the runner writes a **version-level `info.json`** to the
version root in storage:

```
{storage_base}/processes/{process_id}/{version}/info.json
```

(sibling of the existing `datasets/` prefix; distinct from the per-dataset
`datasets/{dataset_id}/info.json` files). Its **presence is the `DONE` signal.** Minimal content —
a `status: "done"` field plus a completion timestamp; extensible later. It is **not** written on
the failure path (the `except` → `sys.exit(1)` branch, `runner.py:151-155`), so **absence means not
successfully completed.** This converts the ephemeral exit code into a durable, storage-side truth.

**The marker is consulted ONLY on the TTL-404 path (Change C), never on the normal path.** When the
monitor witnesses the job's terminal status directly (K8s reports `succeeded`, i.e. exit 0), it
records `DONE` as today **regardless of whether the marker exists** — it never reads or requires it.
This keeps the change **backwards-compatible with existing environments** whose runner image
predates this requirement: their pods never write the marker, and on the normal path that is
completely invisible. Only their *TTL-404 recovery* is degraded (absent marker → `FAILED`), which is
no worse than today's behavior. The marker only ever *adds* a recovery that currently fails.

Note the file lives in the runner SDK (`deps/Ymerflow-process-sdk`), which the runner image builds
from GitHub — see the stale-deps trap in project memory; push the SDK change, don't just edit a
local clone.

### B. Monitor — never self-fail on a caught exception (`process.py:698-718`)

Replace the catch-all body with: log the error (`exc_info=True`), `await
log_manager.finalize_logs()`, and **return without touching version state.** No fresh-session
re-query, no `update_state(..., FAILED)`. Drop the `INFRA_EXCEPTIONS` tuple and `_is_infra_error`
helper entirely — they are no longer needed. The version stays `queued`/`starting`/`running`; the
sweep re-attaches it.

### C. Monitor — TTL-404 reads the marker instead of blindly failing (`process.py:599`, `:685`)

This path fires **only** when the Job is gone (TTL-reaped before we witnessed its status) — it is
the sole place the marker is consulted. The two `ApiException`/404 paths (initial status check, and
watch-loop re-poll) currently mark `FAILED`. Replace with: **scan storage for the version-level
`info.json`:**

- **present** → the job succeeded (and was TTL-reaped before we witnessed it) → run the normal
  completion path (`_handle_job_completion(..., "succeeded")`, which records outputs via
  `_create_outputs` and sets `DONE`).
- **absent** → not successfully completed → `FAILED`, as today.

This recovers the 11-06 "completed-but-unrecorded" jobs and removes the last place the monitor
terminalizes on a non-authoritative (ephemeral) signal.

### D. The orphan sweep — recover non-terminal versions; reap terminal-but-live jobs

1. Factor the startup resume block (`main.py:66-80`) into a reusable coroutine, e.g.
   `ProcessVersion.resume_orphaned_monitors()`, with two rules:
   - **Recover:** select versions in `QUEUED`/`STARTING`/`RUNNING`, skip any in the liveness
     registry, `asyncio.create_task(monitor_job(...))` for the rest. (`monitor_job` then reconciles
     against K8s — including the TTL-404-marker path in C — so even a version whose Job was already
     reaped resolves to `DONE`/`FAILED` instead of stranding.)
   - **Reap:** enumerate live K8s Jobs across clusters; for any whose version is already terminal
     (`DONE`/`FAILED`) and which has no live monitor, `kc.delete_job(job_name)` (404-tolerant). This
     releases pods/Kueue `Workload`s left by past incidents or crash-before-delete races (#86).
2. Call it from `startup_event` (replacing the inline loop) **and** from a periodic background task
   (`while True: await resume_orphaned_monitors(); await asyncio.sleep(SWEEP_INTERVAL)`), started in
   `startup_event` and cancelled in `shutdown_event`.
3. Align the state filter: `STARTING` must be included (it was a stranded state on 11-06); the
   current startup scan (`main.py:69`) uses only `QUEUED`/`RUNNING`.

**Primary reaping is inline, not the sweep.** Whenever the monitor sets a terminal state on a path
where the Job may still exist (the genuine-failure paths — `_wait_for_pod:767`/`:794`,
`_handle_job_completion:884`, and the DONE path), call `kc.delete_job(job_name)` right there (the
same helper the cancel path uses, `routers/processes.py:524`; tolerate 404). The pod has already
exited (`backoff_limit=0`), so nothing running is harmed; this frees Kueue quota immediately rather
than waiting out the TTL. The sweep's reap rule (1·Reap) is the backstop for leftovers and
historical FAILED-with-live-job versions.

## Decisions needed

*(All resolved 2026-11-09; chosen option in **bold** per item.)*

1. **Liveness tracking → `last_monitored_at` heartbeat column.** Chosen over the in-memory registry:
   survives a multi-replica backend and detects hung-but-registered monitors. `monitor_job`
   refreshes it each loop iteration (initial write before the first K8s call, then in the
   wait/watch loops); the sweep treats NULL-or-older-than-`monitor_stale_seconds` as "no live
   monitor". Startup passes `respect_heartbeat=False` so the possibly-recent heartbeats left by
   now-dead monitors don't block re-attach.
2. **`SWEEP_INTERVAL` → 300 s** (`monitor_sweep_interval_seconds`). Lighter periodic load; worst-case
   orphan recovery is ~one interval after the heartbeat goes stale.
3. **Reap scope → inline delete-on-terminal + sweep backstop, no historical reconcile.** `_reap_job`
   fires inline on every terminal path (`_wait_for_pod` failures, `_handle_job_completion`); the
   sweep's reap pass enumerates *live* K8s Jobs and deletes any behind a terminal, unmonitored
   version. It does **not** add a separate DB scan over already-FAILED rows — a past incident's pods
   are long TTL-gone, so "enumerate live jobs" naturally catches only recent leftovers.
4. **Marker → `info.json` at the version root, minimal `{status, completed_at}`.** As requested in
   Change A; no embedded dataset ids (`_create_outputs` already discovers those from storage).

**Decided (not open):** the marker is the **TTL-404 fallback only**, never the primary success
signal. The normal exit-code-0 path records `DONE` without consulting it, so the change is
backwards-compatible with existing runner images (see Change A). Making storage the single source of
truth on the normal path too is a larger, separate change — explicitly out of scope here.

## Testing

- Extend `backend/stress/stress_pool.py` (ask 1's test only bursts fast-failing imports) with a
  scenario that **holds jobs in the wait-for-pod loop** (mock slow pod start) under a burst, so the
  monitor-exception path is actually exercised — the 11-06 load never hit it. Assert **no version is
  marked `FAILED`** by the burst and all are re-attached.
- Unit: a monitor that raises an arbitrary exception leaves version state unchanged and returns; the
  registry entry is removed in `finally`.
- Unit/integration: `resume_orphaned_monitors` re-attaches a non-terminal version with no live
  monitor; a re-attached monitor that finds a completed-while-orphaned job records outputs (test
  with `state` left at `queued`/`starting`, not only `running`).
- Unit/integration: **TTL-404 with marker present → `DONE` + outputs recorded; marker absent →
  `FAILED`.**
- Unit/integration: a terminal version with a live Job is reaped (inline on the failure path, and by
  the sweep's reap pass).
- SDK: the runner writes the version-level `info.json` on success and does **not** on the
  `sys.exit(1)` path.
- Done-when (from #160): a burst of 50 node-waiting jobs completes with **no `Job monitoring
  failed`** in any log and every version ends `done`/`failed` with outputs recorded.

## Risks / edges

- **Marker present but outputs incomplete.** The marker is written after `run()` returns, so if a
  process writes datasets *then* the marker, presence implies writes finished. Ensure the runner
  writes the marker **last** (after all dataset `info.json`s), so marker-present never races ahead
  of the outputs it attests to.
- **Succeeded-with-no-outputs.** A process may legitimately produce zero datasets
  (`_create_outputs` treats a missing prefix as "fine"). The version-level marker disambiguates this
  from failure — that is exactly why it is a separate file, not inferred from the `datasets/` prefix.
- **Double-attach race** between the periodic sweep and a just-started monitor — the registry add
  must happen synchronously at the very top of `monitor_job`, before the first `await`.
- **Registry leak** if a monitor task is cancelled without running its `finally` — use
  `try/finally`; on backend restart the registry is empty and the startup scan rebuilds it.
- **Reaping a DONE Job removes its K8s logs/events within the TTL window.** Logs are finalized to
  storage at completion (`finalize_logs`), so this should be safe; confirm nothing re-fetches pod
  logs/events from K8s after `DONE` before enabling inline reap on the success path.

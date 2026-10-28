# Bug: Backend DB connection pool is exhausted at ~a dozen concurrent jobs

## Severity

**High** — a hard scaling ceiling that caps the whole platform at roughly a dozen
concurrent jobs *regardless of cluster size*, and that takes the HTTP API (both the web
app and the MCP server) down with it while it is saturated. Jobs are marked `failed` at
start even though their pods run fine, and in-flight API calls (including edit saves)
return 500. The ceiling is fixed by the SQLAlchemy connection pool, so it is the same on a
27-CPU workstation and on a large Azure node.

## Symptoms

When enough single-CPU jobs run at once on one cluster (observed: failures starting around
the 9th concurrent job, ~12 running at the worst point), the backend logs this — in job
logs, and as 500s on the API:

```
TimeoutError: QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00
```

The pool is `5 + 10 = 15` connections (SQLAlchemy async defaults — see Root cause). Once
all 15 are checked out, any further attempt to get a connection blocks for the 30 s
`pool_timeout` and then raises.

Observed effects on individual jobs, by where the job was in its lifecycle when the pool ran dry:

| Job state when pool exhausted | What happened |
|---|---|
| Finished the real work, writing final outputs | Last log lines are the output writes, then `Job monitoring failed: TimeoutError: QueuePool limit ...`. Marked **failed**, **no outputs registered** — work was done but thrown away. |
| Pod just started | `Job monitoring failed: TimeoutError: QueuePool ...` seconds into the run. Marked **failed** immediately. |
| Pod scheduled, container started | Stuck in `starting` for hours with no further log lines — the monitor could never attach. |
| Still queued | Stuck `queued` for hours; no K8s job ever created, no logs. |
| Already running and streaming | `WARNING: Log stream interrupted: QueuePool limit ...`, then the job **carries on** — an already-attached stream survives a single interruption. |

API effects during the same window:

- `POST .../process` (create) returned 500 for some calls — **those processes were never created**.
- `GET .../processes` (list) and `GET .../process/{id}` (get) returned 500 for a few
  minutes, then recovered as connections freed up.
- Because the web app and MCP server use the same API, **edit saves in that window would
  have failed too**.

The pattern is diagnostic: already-attached work (a running log stream) survives, but
anything that needs a *fresh* connection — a monitor attaching at job start, or any API
request — fails. That points straight at pool exhaustion rather than a crash or a DB
outage.

## Root cause

**A DB session (and, within it, an open transaction) is held for the entire lifetime of a
job, by two independent long-running background tasks per job. So each running job pins up
to two of the pool's 15 connections for its whole duration, and API requests compete for
whatever is left.**

The async engine is created with no pool arguments, so it uses SQLAlchemy's async defaults
— `AsyncAdaptedQueuePool`, `pool_size=5`, `max_overflow=10`, `pool_timeout=30` — exactly
the `size 5 overflow 10 ... timeout 30.00` in the error:

```python
# backend/database.py:14-18
engine = create_async_engine(
    database_url,
    echo=False,
    future=True
)
```

There is a single engine, so request handlers (`get_db`) and background job tasks all draw
from the same 15-connection pool.

### Site 1 — the job monitor holds a connection for the job's whole run

`ProcessVersion.monitor_job` opens one session and does *everything* inside it, including
the completion-watch loop that runs until the job terminates:

```python
# backend/models/process.py:540  — session opened here...
async with async_session_maker() as db:
    ...
    # backend/models/process.py:613 — refresh issues a SELECT, (re)opening a transaction
    await db.refresh(process_version)
    ...
    # backend/models/process.py:641-678 — ...and held across the ENTIRE watch loop,
    # which runs for the full duration of the job:
    while True:
        async for job in k8s_client.watch_job(job_name, timeout_seconds=300):
            ...            # minutes-to-hours of blocking k8s I/O, no DB work
```

The `db.refresh` at line 613 starts a transaction, and nothing commits that session before
the watch loop, so the connection is pinned *idle-in-transaction* for the life of the job.
One monitor task exists per running job (created at submission, `process.py:1065`, and on
restart, `main.py:80`).

### Site 2 — the log streamer holds a second connection for the pod's whole run

`LogManager._stream_logs` opens a session and holds it across the entire log stream:

```python
# backend/services/log_manager.py:169  — session opened here...
async with async_session_maker() as db:
    pv = await self._get_process_version(db)
    # backend/services/log_manager.py:172 — ...and held across the whole stream loop:
    async for line in log_stream.content:
        ...
        if self._should_checkpoint():   # commit only every 10 logs / 5 s
            await db.commit()
```

Between checkpoints a transaction is open, and for a job that logs steadily the connection
is effectively pinned for the whole run. This task runs concurrently with the monitor
(`asyncio.create_task`, `log_manager.py:147`), so it is a *second* pinned connection per
job.

### The arithmetic

Up to **2 connections per running job**, pool of **15** ⇒ ceiling of roughly **7–12
concurrent jobs** before the pool is dry — matching the observed "failures from ~the 9th
job, 12 running at the worst point". After that, every new monitor (job start) and every
API request blocks 30 s and then 500s. The ceiling is set by the pool, not the cluster, so
adding CPUs or nodes does not raise it.

### Restart amplification

On backend startup, `main.py:77-80` fires a `monitor_job` task for **every** active job at
once:

```python
# backend/main.py:77-80
for pv in active_processes:
    asyncio.create_task(ProcessVersion.monitor_job(pv.process_id, pv.version))
```

If more than ~15 jobs were running at restart, they stampede the pool instantly and a share
of them are marked failed before the API can serve a single request.

## Why it matters

One connection-per-job (here, two) means the platform stops scaling at ~15 jobs *whatever
the cluster size*. A workstation with 27 CPUs can only run about a dozen single-CPU jobs
through the platform; the rest have to be run off-platform. The same ceiling applies on a
large cloud node. And because the job tasks and the API share one pool, saturation doesn't
just stall jobs — it 500s the web app and MCP API for everyone on the deployment, including
users doing unrelated editing work, until enough jobs finish to free connections.

## Fix options (for discussion — not yet decided)

Per repo workflow, the concrete fix belongs in a plan; recording the option space here.

1. **Stop holding a session across K8s I/O waits (the real fix).** Rework `monitor_job`
   and `_stream_logs` so a session is acquired *per DB operation* — open, read/write,
   commit, close — and **no session is held while blocked in `watch_job` or the log
   stream**. Concretely: the watch loop should hold no session while waiting on
   `k8s_client.watch_job`; open a short-lived session only when a terminal event arrives
   (to run `_handle_job_completion`) or when state must change. In `_stream_logs`, buffer
   lines and open a short session per checkpoint flush instead of keeping one open across
   the whole `async for`. This makes connection usage proportional to *active DB work*, not
   to the number of running jobs — the platform then scales to as many jobs as the node's
   CPUs allow, independent of pool size. This is the only option that removes the ceiling
   rather than moving it.

2. **Make the pool size configurable and raise it (stopgap).** Add `pool_size` /
   `max_overflow` / `pool_timeout` settings (config.env) and pass them to
   `create_async_engine`; also consider `pool_pre_ping=True`. At ~2 connections/job a pool
   of, say, 20 + 40 buys ~30 concurrent jobs — enough to clear the immediate target — but
   it only moves the ceiling and will break again at larger scale. Useful as an **immediate
   mitigation while option 1 is built**, not as the fix.

3. **Separate pools for the API and for background tasks.** Give request handlers
   (`get_db`) and the monitor/stream background tasks their own engines/pools, so a flood of
   job monitors can never starve API requests. This directly protects the "the API answers
   normally the whole time" requirement and composes with options 1 and 2.

A realistic plan is likely **1 + 3**, with **2** applied first as a same-day mitigation.

## Done means

- 25 single-CPU jobs run at once on one cluster with **none marked `failed` at start** and
  **no monitor-attach `TimeoutError`s**.
- The HTTP API (web app and MCP) answers normally the whole time jobs are running — no 500s
  on create/list/get, no lost process creations, no failed edit saves.
- A backend restart with 25+ active jobs resumes monitoring for all of them without a pool
  stampede.

## Notes / unknowns

- It is not confirmed whether the pods of the jobs marked failed-at-start kept running on
  the node after the platform stopped tracking them. `kubectl -n ymerflow-jobs get pods`
  would tell; orphaned pods would also mean orphaned work and wasted CPU.
- The per-job-session coupling is the same mechanism behind both the job failures *and* the
  API 500s — a single fix (option 1) addresses both.

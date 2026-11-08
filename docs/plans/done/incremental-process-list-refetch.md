# Incremental process-list refetch — poll only versions past the active watermark

## Status

**Implemented (2026-11-08).** Server `created_after` filter + `ix_process_versions_created_at`
migration (`1332fe39b1da`) + `created_at` added to the verbose version dict; client watermark /
incremental-merge in `useProcesses` + full-reload-on-reconnect in `ProcessContext`. Design agreed
interactively with the operator. Follow-up to the
connection-pool work in `docs/plans/done/db-pool-commit-before-k8s-io.md` (which removed the
per-request *connection-hold*); this plan removes the *demand* that still pressures the pool —
the full project-history refetch on every state change. Related, not overlapping:
`docs/plans/process-overview-time-filter.md` (a user-facing date filter UI) and
`docs/plans/done/stub-process-timestamps.md` (which added the `created_at` field this plan
relies on).

## Problem

`GET /projects/{id}/processes?verbose=true` (`list_processes`) returns **every process with
all of its versions** — the project's entire run history. The frontend's `useProcesses`
holds this list and refetches the whole thing whenever the `/ws/state` signal invalidates the
query, which happens on **every** state transition of **every** running job. During a large
run that is: one state change → N connected clients each re-pull the full history.

Measured on the busy project `3329e10d` (the one that drove the 2026-11-06/07 incident):

| processes | versions | datasets | parameters (sum) | version rows (sum) |
|---|---|---|---|---|
| 345 | 594 | 731 | 459 kB | 830 kB |

So each poll materializes ~1,670 ORM objects and serializes a ~1–3 MB JSON. At the time of
writing the project is **468 DONE + 126 FAILED + 0 active** — i.e. *everything* the poll pulls
is immutable, finished history. The connection-hold is already fixed by the committed
`db.commit()` sweep, but the query + serialize + transmit cost still scales with total history
and is paid on every poll by every client.

## Key invariant (why the design is correct)

Define the **watermark** = the minimum `created_at` among the process versions that are
currently in an active state (`QUEUED`, `STARTING`, `RUNNING`). Terminal states are `DONE` and
`FAILED` (`ProcessState`, `backend/models/process.py`). Then:

> **Every version created before the watermark is terminal, hence immutable.**

If a pre-watermark version were still active, it would *be* the watermark. So a filter of
`created_at >= watermark` is guaranteed to include every version that can still change —
there is nothing live below the line. All state transitions funnel through
`ProcessVersion.update_state` (`backend/models/process.py:472`); the only other state write is
the initial `QUEUED` at creation (`:299`) — both produce versions whose `created_at >=`
whatever the watermark was, so nothing live is ever missed.

This gives three properties from one filter, by **creation** time (not state):
- **Active versions** — all have `created_at >= watermark`, included.
- **Active→terminal transitions** — the version stays in the window when it flips (it did not
  change `created_at`), so the next poll delivers its final state. No drop-out reconcile, no
  per-id follow-up, no grace window.
- **New work** (new versions, and other users' new processes) — created at `now > watermark`,
  included.

## Design

### Server — `list_processes` gains an optional `created_after` filter

Add a query param (`created_after`, ISO-8601, optional). When present, filter **inside** the
eager-load so only post-watermark versions are materialized (filtering in Python would
re-load every version of each matched process and defeat the point):

```python
conds = [Process.project_id == access.project.id]
ver_filter = ProcessVersion.created_at >= created_after if created_after else None
if ver_filter is not None:
    conds.append(Process.versions.any(ver_filter))   # only processes with a post-wm version
vopt = Process.versions.and_(ver_filter) if ver_filter is not None else Process.versions
stmt = select(Process).where(*conds).options(
    selectinload(vopt).selectinload(ProcessVersion.datasets),
    selectinload(vopt).selectinload(ProcessVersion.tags),
    selectinload(vopt).selectinload(ProcessVersion.cluster),
    selectinload(vopt).selectinload(ProcessVersion.environment),
)
```

`relationship.and_()` filters the loaded collection, so `to_dict(verbose=True)` is unchanged —
`self.versions` already contains only the post-watermark versions. **Response shape is
identical** (process-grouped, `versions[]`); only which versions appear differs. With no
`created_after` it is exactly today's query (full load). Access control is unchanged — same
`resolve_project_for_read` + `redact_project_id` path (this is the whole reason it avoids the
access-control problems that sank server-push deltas).

Keep the `await db.commit()` added by the pool sweep after the read.

### Client — load once, then merge post-watermark slices

In `useProcesses` / `ProcessContext` / `getProcesses`:

1. **Initial load**: full `?verbose=true` (no `created_after`) → the process map, as today.
2. **Track the watermark**: `min(created_at)` over versions the client holds whose state ∈
   {`queued`,`starting`,`running`}. If none are active, watermark = the latest `created_at`
   the client has seen (so polls return only genuinely new versions ≈ nothing).
3. **On invalidation / the `/ws/state` signal**: fetch `?verbose=true&created_after=<watermark>`,
   **merge** each returned process's versions into the existing map by `(process_id, version)`,
   and insert brand-new processes (the payload already carries the process-level fields
   `id`/`name`/`project_id`/`flow_x`/`flow_y`).
4. **Recompute the watermark** whenever a tracked version transitions to terminal (it moves
   forward as old active work finishes).

TanStack note: the incremental `queryFn` must merge onto the previously cached data (read it via
`queryClient.getQueryData`, or keep the map in `ProcessContext` and let the query drive merges)
rather than replacing the query data wholesale.

### Index

There is **no index on `process_versions.created_at`** today (existing: `state`, `process_id`,
`created_by`, `environment_id`). Add `ix_process_versions_created_at` in the same change — a
one-line Alembic migration. Trivial at 594 rows, matters at scale. (Generate the revision id
with real entropy per repo rule 9.)

## Trade-off: a long straggler pins the watermark

The window is "since the oldest still-active version", not "only active". One long-running
version (e.g. a 3-hour inversion) holds the watermark back, so each poll re-pulls the *terminal*
versions created after it. Worst case ≈ a wave's worth of completed jobs — still bounded by
"since oldest active", never the full all-time history, and vastly smaller than today.

If that proves costly in practice, the schema-free refinement (deliberately **out of scope** for
v1) is to split the two needs: discover **new work** with `created_after = last_poll_time`
(tiny) and refresh **state** by fetching the specific ids the client still tracks as active
(tiny). Ship the single-watermark version first; add the split only if measurements show the
straggler case hurting.

## Edge cases / decisions

- **Boundary**: use `>=` and order by `(created_at, id)` so a tie at the watermark can't be
  skipped; re-returning the watermark version is harmless after merge.
- **Clock/ordering**: `created_at` is the DB/app creation stamp; `>=` + the id tiebreak covers
  near-simultaneous creates.
- **Non-state edits to terminal processes** (rename, retag, `flow_x/flow_y` move): NOT caught by
  a creation-time window, since those rows are below the watermark. **Decided (operator,
  2026-11-08): accept for v1.** Other users' tag/rename/move edits on terminal processes
  propagate only on a page reload (full reload). These edits are rare and are already visible to
  the acting client locally; no extra "full reload" signal is emitted in v1. Revisit only if it
  becomes a real annoyance.
- **Reconnect**: a websocket reconnect should trigger a full reload (watermark reset), as the
  client may have missed signals while disconnected.

## Affected files

- `backend/routers/processes.py` — `list_processes`: add `created_after` param + filtered
  eager-load (keep the existing `await db.commit()`).
- `backend/alembic/versions/<new>.py` — add `ix_process_versions_created_at`.
- `frontend/src/datamodel/api.js` (or wherever `getProcesses` lives) — pass `created_after`.
- `frontend/src/datamodel/useQueries.js` — `useProcesses` incremental merge.
- `frontend/src/ProcessContext.js` — watermark state, merge-on-signal, recompute-on-terminal,
  full-reload-on-reconnect.

## Validation

- **Full load unchanged**: no `created_after` → byte-identical payload to today.
- **Incremental correctness**: with a project holding active + terminal versions, poll with the
  watermark and assert (a) every active version present, (b) a version that transitions to
  terminal between polls is delivered with its final state, (c) a newly created version/process
  appears, (d) nothing below the watermark is returned.
- **Payload drop**: measure response size full vs. incremental during a run (expect 20–50×; ∞ at
  idle — 0 active → near-empty incremental).
- **No pool regression**: the incremental query holds a connection only briefly (small result +
  the committed read-txn release).

## Not doing

- **Server-push deltas** — the access-control re-derivation at push time is exactly what made the
  previous delta-push attempt hard; the pull-through-the-existing-endpoint design avoids it.
- **Server-side response cache** — obviated; the incremental query is small enough to just run.
- **The new-work / state-refresh split** — deferred refinement, only if the straggler case bites.
- **Changing `to_dict` / the response shape** — unchanged by design.

# Fix DB pool exhaustion — commit before blocking on K8s/storage I/O

## Status

Plan for the bug in
[`docs/bugs/db-connection-pool-exhausted-by-concurrent-jobs.md`](../bugs/db-connection-pool-exhausted-by-concurrent-jobs.md).
Design agreed with the operator before writing. Scope was widened after a codebase-wide audit
(see "Audit"): this plan now covers **every** site that holds a DB transaction across blocking
I/O, not just the job-monitoring path. **Not yet implemented.**

## Root cause (recap)

The platform jams at ~7–12 concurrent jobs — and the API 500s alongside — because code keeps a
DB **transaction open** across blocking K8s/storage I/O. A SQLAlchemy session holds a pooled
connection only while a transaction is open, so a parked transaction = a parked connection for
the whole wait. Against a `5 + 10 = 15` pool, enough of these at once drains the pool; every
further `get_db` request and every job monitor then blocks 30 s and 500s.

The DB *work* is trivial and bursty. The connections are not busy — they are **parked
idle-in-transaction across I/O waits**.

## The fix — one invariant, one mechanism, everywhere

**Invariant: no DB transaction may be open while awaiting K8s, storage/object-store, or other
blocking I/O. Immediately before any such wait, end the current transaction —
`commit()` if it wrote, `rollback()` if it only read.**

Key fact that makes this uniform and cheap: **a pooled connection is tied to the transaction,
not to the `Session` object's lifetime or to a request's response lifetime.** After
`commit()`/`rollback()` the session holds no connection until the next SQL statement. So:

- A long-lived per-job session (monitor) can keep its ORM objects and just commit before each
  wait — **session object unchanged**.
- A `get_db` request session that reads storage can commit/rollback before the read (and before
  returning a `StreamingResponse`) and the connection is freed for the rest of the request even
  though the session object lives to end-of-request — **no re-scoping of `get_db` needed**.

With `expire_on_commit=False` (already set) in-memory ORM attributes stay readable after a
commit with no new query. Connection usage becomes proportional to *active DB work*, not to the
number of concurrent jobs/requests, so the pool of 15 is ample. **No lock, no queue, no shared
session, no second engine, no pool-size change.**

`update_state` (`process.py:488`) and `add_log_entry` (`process.py:508`) already commit
internally, so write paths through them already comply; the work is the *read-only* and
*not-yet-committed* spots that park a transaction across the next I/O wait.

---

## Changes — Group A: job monitoring path

Each is "end the transaction before a blocking wait." Line numbers are current.

### A1. `monitor_job` (`backend/models/process.py:514-700`)
- End the preamble read transaction (fetch pv `:551`, `get_cluster_for_process_version` `:577`)
  before the first K8s call `get_job_status` (`:582`).
- The `db.refresh(process_version)` at `:613` opens a transaction — commit/rollback it before
  `get_job_status` (`:617`). (The refresh-then-watch is the primary offender in the bug doc.)
- Before the watch loop (`:641`), each re-poll (`:661`), and each re-watch, ensure no
  transaction is open. The `async for job in watch_job(...)` body emits no SQL; terminal/TTL
  paths go through `_handle_job_completion` / `update_state` / `add_log_entry`, which commit.

### A2. `_wait_for_pod` (`backend/models/process.py:721-789`)
No transaction open across `asyncio.sleep(5)` (`:789`) or the top-of-loop K8s calls
(`get_job_status` `:723`, `get_pod_for_job` `:729`, `get_job_error_status` `:768`). The
event-retrieval helpers and `update_state`/`add_log_entry` already commit; end any bare
read-only status-check transaction before looping.

### A3. `_handle_job_completion` (`backend/models/process.py:792-859`)
The one K8s call (`get_job_error_status`, `:823`) precedes any DB write here, so given a clean
entry (A1) it complies. Confirm no open transaction on entry. (Side benefit: completion no
longer rides a session the pool can kill mid-way — the bug doc's lost-outputs case.)

### A4. `_create_outputs` (`backend/models/process.py:1087-1216`)
Reached from `_handle_job_completion` (`:839`) under the per-job session. Transaction from
`get_storage_base_url` (`:1107`) + `get_fsspec_storage_options` (`:1113`) is held across
`fs.ls` (`:1125`) and the per-dataset `fs.open(...info.json)` loop (`:1144`) until the commit at
`:1216`. Commit/rollback the read transaction before the storage calls; reopen for the writes.
(These fs calls are *synchronous* — the event-loop-blocking half is the separate sync-fsspec
plan; here we only move the commit.)

---

## Changes — Group B: job submission & background services

### B1. `run_task` submission path (`backend/models/process.py:861-1062`)
SELECTs (`project` `:952`, `storage_backend` `:961`, `registry_backend` `:1013`, `environment`
`:1027`) leave read transactions open across the submission's blocking waits. End the
transaction before each of: `ensure_ready(db, project)` (`:959`, + B2), `strategy.mint` via
`asyncio.to_thread` (`:990`), `registry_handler.pull_credentials` (`:1022`), `create_job(...)`
(`:1040`, pure K8s, no `db`).

### B2. `ensure_ready` (`backend/services/storage_credentials.py:77-118`)
Bug in **both** paths: the SELECT at `:96` opens a transaction; the fast path (`:105-106`)
returns **without committing** (leaks it to the caller), and the slow path parks it across
`provision` (`:109`, storage I/O in a thread) until `:117`. `rollback` after the `:96` fetch
(`backend`/`project` stay usable under `expire_on_commit=False`) so the fast path returns clean
and `provision` runs with no transaction open; the write block (`:114-117`) autobegins/commits.

### B3. `run_export` (`backend/services/project_export_service.py:188-237`)
Session at `:188`; the `_build_manifest` SELECTs (first `:56`, reached `:201`) open a
transaction after the `:198` commit that is held across `fs.ls` (`:153`) and the
`asyncio.to_thread(_build_and_upload_zip)` (`:232`) until `:237`. Commit/rollback before
`_build_manifest`'s storage access and before the zip build/upload.

### B4. `run_import` (`backend/services/project_import_service.py:313-341`)
Session at `:313`; after the `:323` commit, SELECTs (`Upload` `:326`, `resolve_bucket` `:331`,
`get_fsspec_storage_options` `:332`) open a transaction held across
`asyncio.to_thread(_read_zip_bytes)` (`:337`, reads the whole export zip) and then into
`_do_import` (`:341`) until its commit (`:295`). End the transaction before the zip read; ensure
`_do_import` doesn't re-park one across its own waits (its `_copy_blobs` at `:305` already
commits first at `:295`, and `ensure_ready` is B2).

### B5. `cluster_register_callback` (`backend/routers/admin.py:252-300`)
`SELECT Cluster` (`:252`) then `db.add(cluster)` (`:265`) open a transaction held across
`provider.test_connection` (`:270`) and `provider.connect(...)` + `ensure_cluster_job_ready`
(`:285-289`) — the latter runs `asyncio.sleep` polling loops
(`cluster_job_provisioning.py:281/294/321`) — until the commit at `:300`. Commit the pending
write before the provisioning waits, then update/commit cluster state after. (Sibling
`admin_create_cluster` `:120` is fine — no SQL before `ensure_cluster_job_ready`.)

### B6. `compute_dataset_content_hash` (`backend/services/plugin_registration.py:30-41`)
Transaction from `get_storage_base_url` (`:30`) held across `fs.find(base)` (`:38`) and the
`fs.open(f).read()` hash loop (`:40-41`) until `register_built_plugin`'s commit (`:108`).
Commit/rollback before the storage traversal.

### B7. `refresh_storage_credentials` (`backend/routers/internal.py:56-79`)
SELECTs (`ProcessVersion` `:56`, `Project` `:67`, `StorageBackend` `:73`) held across
`asyncio.to_thread(strategy.mint, ...)` (`:79`). Read-only endpoint called by **every running
job's runner on a recurring backoff** — brief each, high aggregate. `rollback` before the mint.

---

## Changes — Group C: request-path storage endpoints (`get_db`)

Same mechanism: resolve the DB-derived inputs (model row, `resolve_bucket`,
`get_fsspec_storage_options`/`get_storage_base_url`), then `rollback` (reads) / `commit`
(writes) **before** the storage I/O — and, for streaming responses, **before**
`return StreamingResponse(...)`. These are mostly GETs that never commit today, so the
transaction currently lives for the whole response.

- **C1. `routers/uploads.py` `_stream_upload` (`:58-89`)** — txn `:66-67`; held across the S3
  multipart open (`:69`), `async for chunk in request.stream()` (`:73`) + `to_thread(fh.write)`
  (`:75`), until `_create_upload_record` commits (`:34`, via `:89`). **Highest-severity**:
  unbounded large-file upload, connection pinned for the entire client→S3 transfer. End the
  read transaction before the stream; record the upload row in a fresh short transaction after.
- **C2. `routers/datasets.py` `get_file` (`:365/:388` → read `:391-394`)** — the primary,
  auth-free file endpoint (frontend + curl for every dataset/upload); highest concurrency.
- **C3. `routers/datasets.py` `get_dataset_part_data` (`:205`) / `get_dataset_part_geography`
  (`:269`)** — full-file `to_thread(_read)` under the open txn (`:154-155/:201`, `:221-222/:265`).
- **C4. `routers/uploads.py` `download_file` (`:213`)** — txn `:193/:205/:208`; `to_thread(_read)`.
- **C5. `routers/uploads.py` `_write_upload_bytes` (`:53`)** — txn `:47-48`; `to_thread` S3 write;
  commit `:34`. Bounded (≤25 MB) but same pattern.
- **C6. `routers/plugins.py` asset serving (`:297-325`)** — txn `:297-298/:306/:311`; `fs.exists`
  (`:316`) and the returned `StreamingResponse` (`:325`) hold it for the whole asset download.
  Commit/rollback before returning the response.
- **C7. `routers/systems.py` `create_system` (`:85/:97`)** — txn `:74-75/:80`; `to_thread(_read)`
  the .gex then `to_thread(_parse)`.
- **C8. `routers/workspaces.py` `complete_column_path` (`:790/:801`)** — txn `:781-782`; held
  across a **per-dataset** loop of `_dataset_columns` → `to_thread(_read)` (`:667`). End the
  transaction before the loop (re-open only if a later write is needed).
- **C9. `routers/processes.py` `process_logs_websocket` historical dump (`:572-583`)** — low
  severity; `SELECT ProcessLog` (`:578`) held across the `await websocket.send_json(...)` loop
  (`:582`) during the initial dump. End it before streaming to the socket.

---

## Cross-cutting notes

- **Prefer `rollback()` for a purely-read transaction** (no accidental flush), `commit()` after
  writes; both free the connection.
- **Relationships read after a commit/rollback must stay eager-loaded** (`selectinload` is used
  on the job path). An accidental lazy load after the transaction ends raises `MissingGreenlet`
  in async SQLAlchemy — a *loud* failure, acceptable as a backstop but should not happen.
- **`expire_on_commit=False` staleness is unchanged from today.**
- **No lock** means background/requests may briefly use more than one connection when several
  commit at the same instant — each released immediately, so usage tracks active DB work and
  stays far below 15. The restart-resume fan-out (`main.py:77-80`) needs no gate for the same
  reason.
- **Enforcement is by discipline.** The gate is the stress test below; run it watching
  `pg_stat_activity` for `idle in transaction` backends (there should be none tied to a wait).
  Optionally `echo_pool="debug"` in dev.

## Audit

The site list came from a backend-wide sweep for "transaction open across blocking I/O." The
following lookalikes were checked and are **fine** (commit-then-`create_task`, I/O-before-first-
SQL, or broadcast-after-commit): `main.py` startup (`:67-82`), `admin_create_cluster` (`:120`),
the project invite-email flow (`routers/projects.py:408`), `_setup_storage_background`
(`:28`), and the project create/import/export *endpoints* (commit then `create_task`).

## Out of scope — tracked separately

Many of these sites also use **synchronous** fsspec (`fs.ls`/`fs.exists`/`fs.open`/`fs.find`
with no `to_thread`), which blocks the whole event loop — a distinct bug with a distinct fix.
That is a **separate plan**
([`stub-sync-fsspec-blocks-event-loop.md`](stub-sync-fsspec-blocks-event-loop.md)); this plan
touches only the DB-transaction placement, even where it edits the same lines.

## Local validation — real end-to-end stress test

The gate is a **real end-to-end stress test against a live local deployment**, not a unit test
in a fake environment. Genuine **red → green**: reproduces on today's code, passes after.

### Preconditions (critical)
- **Postgres-backed deployment.** The `QueuePool ... timeout` failure is Postgres-specific; the
  dev default `sqlite:///` (`backend/config.py:13`) uses a different async pool and will **not**
  reproduce it. Run against the minikube/prod-like deployment (or point `DATABASE_URL` at
  Postgres) with the same `5 + 10` pool as prod.
- Full local stack up (`./runall.sh`, minikube running). A small node is fine — the pool jams on
  monitor/request count, not pod count.

### The job driver — XYZ import with throwaway input
Use the existing **XYZ import** process type, fanned out 25×, pointed at garbage/empty input.
**No valid file needed** — the jobs will fail, which is fine: a failing job still drives
`run_task → monitor_job → _wait_for_pod → _handle_job_completion(failed)` + the log stream and
still emits logs, exercising the Group A/B connection-holding paths with no new process type and
no dataset upload (and covering the error branches better). Burst the 25 creates so the monitors
coexist.

### The request-path driver — concurrent storage reads
To exercise Group C, concurrently (during the job burst) hammer the file endpoints: N parallel
`GET /projects/{id}/dataset/{id}` / upload `download_file` / `get_dataset_part_data` requests in
a loop (use any existing dataset/upload, or one uploaded once). Assert none 500 / time out and
that they don't themselves drain the pool.

### Driver (`backend/stress/stress_pool.py`, requests/httpx or `mcp__clusteredinv__*`)
1. Create/select a project + environment.
2. **Burst-create 25+ XYZ imports** (bad input), recording any create that 500s / times out.
3. **Concurrently, whole run:** loop `GET /processes`, `GET /process/{id}`, a process **edit
   save**, **and the Group-C file reads** — asserting zero 500s / timeouts, logging latency.
4. **Poll to terminal**, then check the failure *mode* (below).

### Pass / fail — the failure *mode* is the signal
Every job is expected to end `failed` (bad input). The bug is not that jobs fail — it's *how*:
- **GOOD:** each job reaches `failed` with a log explaining the *input* problem, via the normal
  path; every API/file request succeeds.
- **BAD (must disappear after the fix):** any `QueuePool limit ... TimeoutError` /
  `Job monitoring failed: ... QueuePool` in any job or backend log; any create or API/file
  request returning **500 / timeout** during the burst; any job stuck `queued`/`starting`; any
  orphaned pod after its job is terminal.

Mapped to the bug doc's "Done means":
1. **25+ jobs at once** → zero `QueuePool`/`Job monitoring failed` anywhere; each fails for its
   input, promptly, via the normal path. Bump to 30–40 after the fix for headroom.
2. **API + file endpoints stay up throughout** → every list/get/create, edit save, and Group-C
   file read succeeds (no 500s, no lost creations).
3. **Restart with 20+ active** → restart the backend mid-run; all resume to terminal, no boot
   stampede `TimeoutError` (`main.py:77-80`).
4. **No orphaned pods** → `kubectl -n ymerflow-jobs get pods` clean after jobs are terminal.
5. **No parked connections** → `SELECT state,count(*) FROM pg_stat_activity GROUP BY state`
   shows no growing `idle in transaction` set tied to waiting jobs/requests.
6. **Log integrity** → each job's failure logs are retrieved completely (exercises
   `_stream_logs` / historical retrieval after the buffer-flush change).

### Procedure
1. On **today's code**, run the driver → red (create 500s, `QueuePool` monitoring TimeoutErrors,
   stuck/orphaned jobs; file reads 500 under load). Confirms the test reproduces the bug.
2. Apply the fix; re-run → green (jobs still fail on input, cleanly; no pool/API errors). Re-run
   the restart variant and the 30–40 headroom run.

## Changes — special-casing for `_stream_logs`

`_stream_logs` (`log_manager.py:151-211`) commits only every 10 logs / 5 s (`:190-193`), so a
transaction is open while awaiting the next line. **Session unchanged:** buffer decoded lines in
a Python list, touch `db` **only** at checkpoint (insert the batch, update
`log_stream_position`/`log_last_timestamp`, `commit`, clear), so no transaction is open while
the `async for` waits. Final flush on stream-end (`:195-198`) and error (`:205-211`). Cadence
preserved; only *when SQL is emitted* changes. The `_retrieve_*` / `start_retrieval` /
`_resume_streaming` / `finalize_logs` helpers each fetch from K8s then write+commit — ensure no
read transaction is held across the K8s fetch.

## Affected files

- `backend/models/process.py` — `monitor_job` (`:514-700`), `_wait_for_pod` (`:721-789`),
  `_handle_job_completion` (`:792-859`), `_create_outputs` (`:1087-1216`), `run_task`
  (`:861-1062`).
- `backend/services/log_manager.py` — `_stream_logs` buffer+flush (`:151-211`) and the
  `_retrieve_*`/`start_retrieval`/`_resume_streaming`/`finalize_logs` helpers.
- `backend/services/storage_credentials.py:77-118` — `ensure_ready`.
- `backend/services/project_export_service.py:188-237` — `run_export`.
- `backend/services/project_import_service.py:313-341` — `run_import`.
- `backend/services/plugin_registration.py:30-41` — `compute_dataset_content_hash`.
- `backend/routers/admin.py:252-300` — `cluster_register_callback`.
- `backend/routers/internal.py:56-79` — `refresh_storage_credentials`.
- `backend/routers/datasets.py` — `get_file` (`:316-394`), `get_dataset_part_data` (`:205`),
  `get_dataset_part_geography` (`:269`).
- `backend/routers/uploads.py` — `_stream_upload` (`:58-89`), `_write_upload_bytes` (`:53`),
  `download_file` (`:213`).
- `backend/routers/plugins.py:297-325` — asset serving.
- `backend/routers/systems.py:74-97` — `create_system`.
- `backend/routers/workspaces.py:781-801` — `complete_column_path` (`_dataset_columns` `:667`).
- `backend/routers/processes.py:572-583` — `process_logs_websocket` historical dump.
- `backend/stress/stress_pool.py` (new) — the end-to-end stress driver (job burst + API/file
  hammer + failure-mode assertions).

## Not doing

- No change to `backend/database.py` (no pool sizing, no second engine, no lock).
- No session re-scoping on the job path; no `merge()`/re-fetch. (Request handlers keep `get_db`;
  we only add a commit/rollback before storage I/O.)
- No restart-resume throttle/semaphore.
- **Sync fsspec → event-loop blocking is a separate plan**, even on shared lines.

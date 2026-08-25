# Cluster Queue State Fixes — Plan

## Context

Two state-reporting bugs surfaced on prod (`griffon@192.168.1.206`) after the Cluster Queue
widget (`docs/plans/done/cluster-queue-widget.md`) shipped. Both trace to conflating **Kueue
admission** with the actual per-process lifecycle:

1. **Failed/finished jobs show as "running"** in the widget. A Kueue `Workload` for a terminated
   Job keeps `.status.admission` set (plus a `Finished` condition), and the widget's
   `state = "running" if admitted else "waiting"` never checks `Finished`. Confirmed live: two
   `Error` pods whose Workloads carry `('Finished','True')` still render as running. Kueue's own
   accounting already excludes them — the ClusterQueue reported `reservingWorkloads: 1` /
   `admittedWorkloads: 1` for **3** Workload objects (2 `Finished`, 1 live), and released their
   quota (`flavorsUsage` back to full). A `Finished` Workload holds no quota and does **not** block
   new admissions.

2. **Image-pulling jobs show inconsistently.** A Kueue-admitted job whose pod is still
   `Pending`/`ContainerCreating`/pulling shows "Queued" in FlowView but "running" in the widget.
   The **correct** state is *running-ish* — the job holds a slot and its pod is coming up — so the
   DB/FlowView is the wrong side: it stays `QUEUED` until `is_pod_container_running` is true
   (`backend/models/process.py:643-644`). Rather than paper over this, we introduce a distinct
   **`STARTING`** lifecycle state for "admitted, pod coming up, container not yet running", applied
   **globally** (FlowView, widget, everywhere), and make **billing count runtime from the
   `STARTING` transition** instead of from submission.

## Current state (confirmed by reading the code)

- **`ProcessState`** (`backend/models/process.py:13-17`): `QUEUED / RUNNING / DONE / FAILED`.
  Stored as a **native Postgres enum** `processstate` using the enum **member names**
  (`sa.Enum('QUEUED','RUNNING','DONE','FAILED', name='processstate')`, initial schema
  `backend/alembic/versions/59e0619beed9_initial_schema.py:146`). `.value` is the lowercase form
  used in websocket broadcasts (`process.py:364`).
- **RUNNING transition** happens only once the container is actually running
  (`process.py:642-646`, gated on `is_pod_container_running`). While the pod exists but the
  container isn't up, the row stays `QUEUED`.
- **`started_at`** is set at **job submission** (`process.py:918`, right before `create_job`), and
  is otherwise redundant with `created_at`. Billing computes
  `runtime_seconds = completed_at - started_at` (`process.py:697-701`, already guards
  `started_at is None → 0`) and charges via `hooks.run_async.job_completed(...)` →
  `plugins/billing/billing/__init__.py:156` → `BillingEngine.post_run(...)`. The **hold** is placed
  at submission (worst-case, from `deadline_seconds`) and is independent of `started_at`; only the
  **actual charge** uses `runtime_seconds`. Nothing else keys off the *timing* of the RUNNING
  transition.
- **Widget endpoint** `/utilities/cluster-queues`
  (`backend/routers/utilities.py`) + `classify_workload` (`backend/services/k8s_client.py`) derive
  `admitted` from `.status.admission` / `Admitted`/`QuotaReserved` conditions but ignore `Finished`
  and never look at the pod. `state = "running" if admitted else "waiting"`. The backend Role
  already grants `pods [get,list,watch]` (`cluster_job_provisioning.py:469`), and
  `get_pod_for_job` (`k8s_client.py:141`, label `job-name=<job>`) shows the pod-listing pattern —
  so reading pod state in the endpoint needs no new RBAC.
- **`StateBadge`** (`frontend/src/widgets/FlowView/StateBadge.jsx`) maps
  `queued→bg-warning "Queued"`, `waiting→bg-warning "Waiting"`, `running→bg-primary "Running"`,
  `done→bg-success "Done"`. No `starting`. Consumed by `ProcessNode` (FlowView) and `QueueCard`
  (widget).

## Design decisions

### Decision 1 — Add a global `STARTING` state — **chosen**
New lifecycle: `QUEUED → STARTING → RUNNING → DONE/FAILED` (with `FAILED` reachable from any
non-terminal state).
- `QUEUED`: submitted; Kueue has not admitted / no pod yet (suspended, waiting for quota).
- `STARTING`: pod exists (scheduled / pulling image / `ContainerCreating`), container not yet
  running. Set in `wait_for_pod_and_get_name` the first time a pod is observed with no pod-level
  error, before the container-running check. Loop still continues until the container is up before
  returning `pod_name` (log streaming unaffected).
- `RUNNING`: container running (unchanged trigger).

This is a **native-enum change** → migration required (Decision 4).

### Decision 2 — Billing counts runtime from `STARTING` — **chosen**
Move the `started_at = datetime.utcnow()` assignment **from submission (`process.py:918`) to the
`STARTING` transition** (set once, guarded by `if not process_version.started_at`). Then
`runtime_seconds = completed_at - started_at` measures from when the pod started coming up, not
from time spent queued waiting for quota. A job that fails **before any pod exists** never sets
`started_at` → `runtime_seconds = 0` (existing guard) → billed ~0 for the actual charge, which is
the desired "don't charge for queue time" behavior. The submission-time hold is unchanged, so
budget reservation still happens up front.

`started_at` is otherwise only read by the cluster-queues admitted-tie-break
(`utilities.py:132`), which remains correct (still a monotonic per-job start marker).

### Decision 3 — `classify_workload` computes the same lifecycle states as the monitor, from the live pod — **chosen**
Rather than approximate from Kueue admission (or read the DB), `classify_workload` computes the
**same states `wait_for_pod_and_get_name` sets** — `QUEUED / STARTING / RUNNING` (plus terminal
`DONE`/`FAILED`, which are dropped) — from the live Kueue `Workload` **and its pod**. This makes the
widget's per-row state identical to the monitor's DB transitions by construction, for member and
foreign workloads alike (no DB-state read for the badge; the DB row is used only for identity +
resource/deadline).
- The endpoint lists pods once per cluster (`list_pods`, below) and indexes them by the pod's
  `job-name` label; `classify_workload(wl, pod)` receives the matching pod (or `None`).
- **State discriminator mirrors the monitor** (`process.py:618-646` / `is_pod_container_running` /
  `get_pod_error_status`):
  - `pod is None` → `QUEUED` (Job suspended / not admitted / pod not yet created). A `Finished`
    Workload with no pod is terminal → dropped.
  - pod phase `Succeeded` → `DONE` (drop); phase `Failed`, or a terminated/errored container →
    `FAILED` (drop).
  - a container is running → `RUNNING`.
  - otherwise (pod `Pending` / `ContainerCreating` / image pull) → `STARTING`.
- **Drop terminal states** (`DONE`/`FAILED`, incl. any `Finished` Workload) — they hold no quota
  and are out of Kueue's live queue. Fixes bug #1.
- **Widget shows `QUEUED` / `STARTING` / `RUNNING`** — the real `ProcessState` names (not the old
  `waiting` alias). `classify_workload` also still returns `admitted` (Kueue) for **ordering only**.
- **Ordering unchanged**: admitted-first (Kueue), then pending by `(−priority, creationTimestamp)`.
  Admission drives *order*; the live pod drives the *badge*.

`classify_workload` still returns `owner_job_name`, `created_at`, `priority`, `pod_resources`, and
`admitted`; it gains a `state` field (and takes the `pod` arg). No `finished` boolean is needed
separately — `Finished`/terminal folds into `state`.

### Decision 4 — Enum migration, dialect-guarded — **chosen**
Hand-authored Alembic migration (revision id from real entropy per CLAUDE.md rule 9):
- **Postgres**: `ALTER TYPE processstate ADD VALUE IF NOT EXISTS 'STARTING'`.
  `ADD VALUE` is allowed inside Alembic's transaction on PG 12+ as long as the value isn't *used*
  in the same transaction (we only add it). No data backfill — existing rows keep their states.
- **SQLite** (dev): the enum is a `VARCHAR` + `CHECK` constraint; guard on
  `op.get_bind().dialect.name == 'postgresql'` and no-op elsewhere (dev DBs that predate this and
  enforce the CHECK are simply recreated — note in the migration docstring). Downgrade is a no-op
  (PG cannot drop an enum value without recreating the type; not worth the risk for a widened enum).

### Decision 5 — `StateBadge` gains `starting`; widget uses real state names — **chosen**
Add `starting → bg-info "Starting"` to the single `STATE_BADGES` map in
`frontend/src/widgets/FlowView/StateBadge.jsx`. Both FlowView and the widget pick it up for free.
(`bg-info` = a distinct cyan sitting visually between the warning-yellow of queued and the
primary-blue of running.) The widget now receives `state ∈ {queued, starting, running}` — the real
`ProcessState` names — so `queued→bg-warning "Queued"` and `running→bg-primary "Running"` are
reused directly. The legacy `waiting` alias (added by the original widget plan) is no longer emitted
by the endpoint; leave it in the map for back-compat or remove it — either is fine.

## Backend changes

- **`backend/models/process.py`**
  - `ProcessState`: add `STARTING = "starting"`.
  - `wait_for_pod_and_get_name` (~`:618-646`): when a pod is first observed and `get_pod_error_status`
    is clean, `update_state(db, ProcessState.STARTING, ...)` and set
    `process_version.started_at = datetime.utcnow()` **once** (`if not process_version.started_at`)
    before the `is_pod_container_running` check. Keep the existing `RUNNING` transition + return.
  - Remove the submission-time `started_at` assignment (`:918`).
  - Grep for any other pod-appearance / recovery path that should honor `STARTING`
    (e.g. the reconciliation loop around `:440-520`) and update consistently — a version whose pod
    exists but container isn't running should read `STARTING`, not `QUEUED`.
- **`backend/services/k8s_client.py`**
  - Add `list_pods()` — `core_api.list_namespaced_pod(self.namespace, ...)` returning all pods in
    the jobs namespace (pods are already in the backend Role: `pods [get,list,watch]`, so **no new
    RBAC**). Does not swallow errors (rule 8).
  - `classify_workload(wl, pod)`: gains the `pod` arg and a computed `state` field
    (`queued/starting/running/done/failed`, Decision 3), reusing the same pod checks as
    `is_pod_container_running` / `get_pod_error_status`. Keeps `owner_job_name`, `created_at`,
    `priority`, `pod_resources`, `admitted`.
- **`backend/routers/utilities.py`** — `cluster_queues`: per cluster, `list_workloads()` **and**
  `list_pods()` (both inside the existing per-cluster try/except → `queue_error` on failure); index
  pods by `job-name` label; `classify_workload(wl, pod)` each; **drop** rows whose `state` is
  `done`/`failed`; assign the remaining `queued/starting/running` as the entry `state`. Identity
  redaction by membership and resource/deadline sourcing are unchanged. Ordering unchanged.
- **`backend/alembic/versions/<real-id>_add_starting_process_state.py`** — Decision 4.

## Frontend changes

- **`frontend/src/widgets/FlowView/StateBadge.jsx`** — add the `starting` entry (Decision 5).
- No other frontend change required: `ProcessNode` and `QueueCard` already render whatever
  `state` string the API/DB provides through `StateBadge`.

## Migration / compatibility

- **DB migration** adds one enum value; no backfill, no downgrade data change.
- **Existing in-flight rows**: a job currently `QUEUED` with a live pod will move to `STARTING` on
  the next monitor observation — no manual intervention.
- **Billing**: charges drop by the (usually small) queue-wait interval that used to be billed;
  jobs that never start are now billed ~0 actual. Holds unchanged. Call this out to the operator.
- **Widget on a not-yet-repatched RBAC cluster**: unchanged — still returns `queue_error`.

## Implementation order

1. `ProcessState.STARTING` + migration (additive, safe).
2. Monitor: set `STARTING` + move `started_at`; sweep other pod-appearance paths.
3. `StateBadge` `starting` entry.
4. `K8sClient.list_pods` + `classify_workload(wl, pod)` → `state`; endpoint lists pods, classifies,
   drops terminal, emits `queued/starting/running`.
5. Verify billing runtime now measured from `STARTING`.

## Verification

- **Backend unit test** (extend `backend/test_cluster_queues.py`, whose `_FakeClient` now also
  stubs `list_pods`): cover one workload per state — no pod (`queued`), `Pending` pod (`starting`),
  running-container pod (`running`), and `Failed`/`Succeeded` pod (dropped). Assert the terminal
  ones are **absent** from `queue`, the others carry `state ∈ {queued, starting, running}`
  matching their pod, admission still drives ordering, and this holds for both a member and a
  foreign workload (state is pod-derived, not DB-derived).
- **Billing unit/manual check**: a job that sits queued then runs is charged from the `STARTING`
  timestamp, not submission; a job that fails before any pod exists is charged ~0 actual (hold
  released). Confirm `job_completed` receives the smaller `runtime_seconds`.
- **Manual (prod, servers already running):** submit a job; watch FlowView show
  `Queued → Starting → Running → Done`. During image pull, confirm FlowView **and** the widget both
  show `Starting`. Fail a job (bad image / bad params) and confirm it **drops out** of the widget
  (no longer "running") while FlowView shows `Failed`. Reload to confirm finished/failed entries
  are gone.
- **Regression:** FlowView nodes still render correctly for all states; the `bg-info` Starting
  badge is visually distinct from Queued/Running.

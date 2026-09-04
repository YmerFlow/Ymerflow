# Cluster Queue Widget — Plan

## Context

Users currently have no way to see the live scheduling picture of a cluster: which
processes are running, which are waiting, and where the jobs from their projects sit in line. Jobs are
submitted as Kueue-admitted, suspended Kubernetes Jobs (`job_orchestrator.create_job_manifest`,
label `kueue.x-k8s.io/queue-name: ymerflow-queue`, `spec.suspend=True`), and Kueue decides
admission order. Today the backend never reads Kueue's own queue state — running/waiting is
inferred from the app DB (`ProcessState`), and no endpoint spans users/projects for a cluster.

This plan adds a **Cluster Queue** frontend widget that, for each cluster the user can access,
shows the current queue — running processes plus waiting ones — **in Kueue's actual (future)
execution order, first-to-run first**. Jobs from projects the user is **not** a member of are shown
with resource requirements only (CPU, RAM, max run length) plus queue position and state; jobs from
**any project the user is a member of** additionally show project name, process name/version, type,
and tags — the **same access-control model as FlowView** and every other process view (visibility is
by project membership, never by who created/started the process). Styling reuses the FlowView process card.

### Decisions settled with the user
- **Execution order source: live Kueue `Workload` objects** (true admission state), not a DB
  creation-time approximation. Requires a new K8s read (list workloads) + one RBAC verb.
- **Refresh: a manual reload button.** No polling, no WebSocket subscription.
- **Rows from non-member projects: resources + position + state.** CPU / RAM / max-run-length, a queue
  position number, and a Running/Waiting badge. No identity, no project/name/type/tags. The
  process-name slot shows a greyed-out placeholder title `Process` so the card keeps the same
  shape as full (member-project) cards without leaking anything. "Member-project" here means the
  same membership check FlowView uses — not "started by this user".
- **Capacity line on by default** (`include_limits=true`) — each cluster shows its Kueue max
  CPU / RAM. The extra live read per cluster only happens on a manual reload.
- **One cluster at a time, selected via tabs** — the widget shows a `nav nav-tabs` bar (one tab per
  accessible cluster) and renders only the active cluster's queue. The active cluster is **persisted
  in the widget's own layout-node config** (survives reload / workspace save). A cluster with an
  empty queue renders "No jobs queued"; a cluster whose Kueue read failed renders its `queue_error`
  inline. Every accessible cluster still has a tab (nothing hidden), but only one queue renders.

## Background — current state (confirmed by reading the code)

- **Cluster access:** `get_allowed_clusters(db, user, project_id=None, resource_requests=None)`
  (`backend/models/cluster.py:55-69`) returns the clusters a user may use; with `project_id=None`
  it returns all active clusters (or `select_clusters`-hook-filtered), sorted by `sort_order`.
  `DEFAULT_CLUSTER_ID` is defined at `backend/models/cluster.py:8`.
- **Job identity:** `create_job_manifest` builds `job_name = f"process-{process_id}-v{version}"`
  (`backend/services/job_orchestrator.py:57`), stored on `ProcessVersion.k8s_job_name`
  (`backend/models/process.py:272`, set at `process.py:936`). Deterministic and unique.
- **Process rows:** `ProcessVersion` (`backend/models/process.py:257`) has `state` (indexed:
  `QUEUED`/`RUNNING`/`DONE`/`FAILED`), `resource_requests` (JSON), `deadline_seconds`,
  `k8s_cluster_id` (FK, nullable → legacy rows resolve to `DEFAULT_CLUSTER_ID`), `k8s_job_name`,
  `created_at`, `started_at`. Relationships: `process` → `Process` (has `project`, `type`, `name`),
  `tags`, `cluster`.
- **Ownership:** `ProjectMember` (`backend/models/project.py:39`), composite PK
  `(project_id, user_id)`. A user owns a process iff `process.project_id` is one of their
  member project ids.
- **Existing Kueue read:** `K8sClient.get_cluster_queue_limits()` (`backend/services/k8s_client.py:315-346`)
  reads a ClusterQueue's `nominalQuota` via async `CustomObjectsApi.get_cluster_custom_object`
  (group `kueue.x-k8s.io`, version `v1beta2`). There is **no** `Workload` list anywhere yet.
- **RBAC:** `_apply_backend_rbac` (`backend/services/cluster_job_provisioning.py:456-510`) grants
  the backend SA a namespaced `Role` (`backend/services/cluster_job_provisioning.py:464-473`, jobs/
  pods/secrets/events in the jobs namespace) and a cluster-scoped `ClusterRole`
  (`...:491-495`) with only `get` on `clusterqueues`. **Listing workloads is not permitted today.**
- **Per-cluster client:** `K8sClientRegistry` / module singleton `k8s_clients`
  (`backend/services/k8s_client.py:396-412`); each client carries `self.namespace`
  (`k8s_client.py:45`, default `ymerflow-jobs`).
- **Closest existing endpoint pattern:** `GET /projects/{project_id}/utilities/available-clusters`
  (`backend/routers/utilities.py:20-48`) merges `cluster.to_dict()` with live Kueue limits and a
  `DEFAULT_QUEUE_LIMITS` fallback (`utilities.py:17`). Router registered in `backend/main.py:85`.
- **Frontend:** `FlowView/ProcessNode.jsx` renders the process card — root Bootstrap `card` with
  inline styles (`ProcessNode.jsx:55-67`, `minWidth:150`), header block (`:130-162`):
  `<strong>{process.name}</strong>`, a version `<select>`, a state badge (`:155-157`:
  `badge bg-warning`=Queued / `bg-primary`=Running / `bg-success`=Done), `type` as
  `text-muted small`, tags via `<TagSelector>`. `TagBadge.jsx` + exported `contrastColor` are pure
  presentational and reusable. It does **not** display a project name today. Data hooks live in
  `frontend/src/datamodel/useQueries.js` (keys ~`:59-65`); fetch fns in `frontend/src/datamodel/api.js`;
  widgets registered in `frontend/src/App.jsx`.

## Design decisions

### Security invariant — redaction is server-side, non-negotiable
**The API MUST NOT send details of a process to a client that is not entitled to see them.** Redaction
happens **on the backend, before serialization**: for any process whose project the requesting user is
not a member of, the response omits every identifying/detail field (`project_name`, `process_id`,
`process_name`, `version`, `process_type`, `tags`) — these fields are **never present in the JSON**,
not nulled, not sent-and-hidden. This is a hard authorization boundary enforced by the endpoint
(Decision 3), **not** a frontend concern: the frontend renders whatever it receives and has no
filtering responsibility, so a bug or malicious client inspecting the raw HTTP response can never
recover hidden details because they were never transmitted. Any implementation or test that relies on
the client to hide fields is wrong.

### Decision 1 — Order comes from live Kueue `Workload` objects — **chosen**
Per cluster, the backend lists `workloads.kueue.x-k8s.io` in the cluster's jobs namespace and derives
order from Kueue's own state:
- **Admitted/running first**, then **pending**, sorted by Kueue's queue order.
- A workload is admitted when `.status.admission` is set (equivalently a `.status.conditions`
  entry `type: Admitted`/`QuotaReserved`, `status: True`). Pending workloads lack admission.
- Pending sort key mirrors Kueue: `priority` desc, then workload `metadata.creationTimestamp` asc.
  No `WorkloadPriorityClass` is set anywhere, so this is effectively creation-time FIFO — but read
  from Kueue, so it reflects real admission decisions (including BestEffortFIFO reordering when a
  large head-of-line workload doesn't fit), which a pure DB `created_at` sort cannot.

**Rejected:** DB-only ordering by `ProcessVersion.created_at`. Simpler and needs no RBAC, but only
approximates Kueue and can't show true admitted-vs-pending state. The user explicitly chose live Kueue.

### Decision 2 — Map workloads to processes via owner Job name — **chosen**
Each Kueue `Workload` for a Job carries `metadata.ownerReferences[] {kind: Job, name: <jobName>}`.
`jobName == ProcessVersion.k8s_job_name` (`process-{id}-v{version}`). The backend collects the owner
job names from the workload list and does **one** DB query
(`ProcessVersion ... where k8s_job_name in (...)`, eager-loading `process→project` + `tags`) to
enrich each entry. Workloads with no matching row (foreign jobs) are still shown as redacted rows
using resources read from the workload `podSets` (`member:false`, no deadline).

### Decision 3 — Redact server-side by project membership (same model as FlowView) — **chosen**
Visibility is decided **purely by project membership**, exactly as FlowView and every other process
view: a user sees full details for a process iff they are a member of that process's project —
**regardless of who created or started it**. `member = pv.process.project_id in member_ids`, where
`member_ids` comes from `select(ProjectMember.project_id).where(ProjectMember.user_id == auth.user.id)`.
The response field is named `member` (not `owned`) to avoid implying creator-ownership. Redacted
entries (`member:false`) serialize **only** `position`, `state`, `member:false`, `resource_requests`
(cpu/memory), `deadline_seconds`. Full entries (`member:true`) add `project_name`, `process_id`,
`process_name`, `version`, `process_type`, `tags`. Redacted fields are never serialized (not nulled)
so no identity leaks — see the **Security invariant** above: this redaction is the authorization
boundary and lives entirely in the endpoint; the frontend never receives, and therefore cannot leak,
hidden details. The two branches build **different dicts** (the redacted branch simply never adds the
detail keys) — do not build a full dict and delete keys, which risks a field slipping through.

### Decision 4 — Add `workloads` list to the namespaced Role — **chosen**
Add one rule to the backend's namespaced `Role` (not the ClusterRole — workloads are namespaced and
live in the jobs namespace, keeping least privilege):
`V1PolicyRule(api_groups=[KUEUE_GROUP], resources=["workloads"], verbs=["get", "list"])`.
Because RBAC is applied at provisioning time, **already-provisioned clusters need re-provisioning**
(re-run `ensure_cluster_job_ready`, which is idempotent and patches the Role) or a one-off
`kubectl` patch. The endpoint must **degrade gracefully per cluster**: if listing workloads fails
(e.g. 403 on a not-yet-repatched cluster), that cluster returns an empty `queue` plus a
`queue_error` string rather than failing the whole request — surfaced, not silently swallowed.

### Decision 5 — Lean read-only card + shared state badge, not a ProcessNode refactor — **chosen**
`ProcessNode` is entangled with ReactFlow `Handle`s, an editable version `<select>`, and drag
positioning; extracting it wholesale is riskier than this feature warrants. Instead build a lean
read-only `QueueCard` that reproduces ProcessNode's card styling, and do one small safe extraction:
a shared `StateBadge` component consumed by both `ProcessNode` (replacing `:155-157`) and `QueueCard`
so the badge stays in sync. Reuse `TagBadge` directly (read-only, no `onClick`/`onRemove`); do **not**
use `TagSelector` (it's a `ProcessContext`-bound editor).

### Decision 6 — Manual reload, no polling/WS — **chosen**
The query hook uses no `refetchInterval` and no WebSocket. The widget renders a reload button that
calls the query's `refetch()`. `staleTime: Infinity` so it only refetches on demand.

### Decision 7 — One cluster at a time via tabs, active cluster persisted in the layout node — **chosen**
The endpoint still returns **all** accessible clusters (so the tab bar can be built without an extra
request), but the widget body renders only the active cluster's queue. The active cluster is stored
as a field on the widget's own layout node, using the same mechanism as flexout's `TabSet.activeTab`
(`frontend/src/flexout/components/TabSet.jsx:147-152`) and FlowView's `selectedFilterTagIds`
(`frontend/src/widgets/FlowView/index.jsx:171,313-318`):
- flexout's `Pane` spreads the entire node object onto the widget and passes `parentUpdate` + `id`
  (`frontend/src/flexout/components/Pane.jsx:270-273`); config fields live **flat on the node**, not
  in a nested object.
- **Read:** the widget destructures `activeClusterId` from props (default `undefined`).
- **Write:** on tab click, `parentUpdate('replace', id, { ...nodeProps, activeClusterId })`. Because
  the node lives in the `LayoutContext` tree that WorkspaceMenu saves, this persists on
  workspace/version save and is restored via `initial_layout` on reload — no extra plumbing.
- **Resolution:** the rendered cluster is the first of: saved `activeClusterId` if it's still in the
  returned clusters, else the first cluster. (Guards against a saved id whose cluster access was
  revoked, or a not-yet-loaded list.)

**Rejected:** local `useState` for the active tab — simpler, but wouldn't survive reload, which the
user explicitly requires.

## Backend

### `backend/services/cluster_job_provisioning.py` — RBAC (Decision 4)
Add to the `Role.rules` list (`:467-473`):
```python
client.V1PolicyRule(api_groups=[KUEUE_GROUP], resources=["workloads"], verbs=["get", "list"]),
```
`KUEUE_GROUP` is already imported/defined in this module.

### `backend/services/k8s_client.py` — new `list_workloads`
Add an async method mirroring `get_cluster_queue_limits`'s style:
```python
async def list_workloads(self) -> list[dict]:
    """List Kueue Workload objects in this client's jobs namespace (raw dicts)."""
    await self._ensure_initialized()
    custom_api = client.CustomObjectsApi()
    resp = await custom_api.list_namespaced_custom_object(
        group="kueue.x-k8s.io", version="v1beta2",
        namespace=self.namespace, plural="workloads",
        _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
    )
    return resp.get("items", [])
```
Do **not** wrap in a bare `except` (rule 8) — let the caller decide per-cluster degradation
(Decision 4). A small helper to classify a workload (`admitted: bool`, `owner_job_name: str|None`,
`created_at`, `priority`, `pod_resources`) can live here or in the router.

### `backend/routers/utilities.py` — new endpoint
Non-project-scoped (this is a cross-project per-user view; anonymous/publication access is
intentionally excluded — use `get_current_user`, not `resolve_project_for_read`):
```python
@router.get("/utilities/cluster-queues")
async def cluster_queues(
    include_limits: bool = True,
    auth = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
```
Assembly:
1. `member_ids = set(await db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == auth.user.id)))`.
2. `clusters = await get_allowed_clusters(db, auth.user, None)`.
3. For each cluster: `wls = await k8s_clients.get(cluster).list_workloads()` wrapped in try/except
   that, on failure, emits the cluster with `queue: []` and `queue_error: str(e)` and continues.
4. Classify each workload → admitted vs pending; collect owner job names.
5. One DB query enriching by job name (eager-load `process→project`, `tags`), keyed by `k8s_job_name`.
6. **Order:** admitted first (tie-break `started_at`/admission time asc), then pending by
   `(−priority, workload creationTimestamp asc)`. Assign `position` after sorting.
7. Build each entry: full dict if `member`, else redacted dict (Decision 3) — the redacted branch
   constructs a fresh dict without the detail keys (never a full dict with keys deleted). This step
   is the authorization boundary (see **Security invariant**); no detail field for a non-member
   process may reach the response. `state` =
   `"running"` if admitted else `"waiting"`. Resource/deadline from the matched `ProcessVersion`
   when present, else from the workload `podSets` (deadline omitted when no match).
8. `limits`: if `include_limits`, `await ...get_cluster_queue_limits()` per cluster with
   `DEFAULT_QUEUE_LIMITS` fallback (reuse existing constant).

Imports to add: `ProcessVersion, Process` from `backend.models.process`, `ProjectMember` from
`backend.models.project`, `selectinload`, `select`. No new model, **no Alembic migration**.

Response shape:
```jsonc
[
  {
    "id": "cluster-uuid", "name": "Prod GPU", "namespace": "ymerflow-jobs", "sort_order": 0,
    "limits": { "max_cpu_cores": 8.0, "max_memory_gb": 32.0 },   // null if include_limits=false
    "queue_error": null,                                          // or a string if the k8s read failed
    "queue": [
      { "position": 0, "state": "running", "member": true,
        "resource_requests": {"cpu":"1000m","memory":"2Gi","ephemeral-storage":"10Gi"},
        "deadline_seconds": 3600, "project_name": "My Survey",
        "process_id": "proc-uuid", "process_name": "invert_aem", "version": 3,
        "process_type": "aem_inversion",
        "tags": [ {"id":"...","name":"prod","color":"#28a745"} ] },
      { "position": 1, "state": "waiting", "member": false,
        "resource_requests": {"cpu":"4000m","memory":"16Gi"}, "deadline_seconds": 7200 }
    ]
  }
]
```

## Frontend

- **`frontend/src/datamodel/api.js`** — add `getClusterQueues()` → `apiClient.get('/utilities/cluster-queues')`.
- **`frontend/src/datamodel/useQueries.js`** — add `queryKeys.clusterQueues = ['clusterQueues']` and:
  ```js
  export function useClusterQueues() {
    const { isAuthenticated } = useContext(AuthContext);
    return useQuery({
      queryKey: queryKeys.clusterQueues,
      queryFn: getClusterQueues,
      enabled: isAuthenticated,
      staleTime: Infinity,   // manual reload only (Decision 6)
    });
  }
  ```
- **`frontend/src/widgets/FlowView/StateBadge.jsx`** (new) — the badge mapping extracted from
  `ProcessNode.jsx:155-157` (`queued→bg-warning`, `running→bg-primary`, `done→bg-success`;
  add a `waiting` alias → `bg-warning "Waiting"`). Refactor `ProcessNode.jsx` to consume it.
- **`frontend/src/widgets/ClusterQueueView/index.jsx`** (new) — signature
  `export default function ClusterQueueView({ parentUpdate, id, activeClusterId, ...nodeProps })`.
  Uses `useClusterQueues()`. Renders:
  - a **`nav nav-tabs` bar** (reuse TabSet's markup/classes: `nav nav-tabs`, `nav-link active`) with
    one tab per cluster from the response; clicking a tab calls
    `parentUpdate('replace', id, { ...nodeProps, activeClusterId: cluster.id })` (Decision 7);
  - a **reload button** (`refetch()`, disabled while `isFetching`);
  - the **active cluster's** panel only — resolve the active cluster as saved `activeClusterId` if
    present in the list, else the first cluster. Panel shows the capacity line from `limits`
    (CPU / RAM), the `queue_error` inline when present, a "No jobs queued" note when the queue is
    empty, else the ordered list of `QueueCard`s.
  - Static `title = 'Cluster Queue'`.
- **`frontend/src/widgets/ClusterQueueView/QueueCard.jsx`** (new) — reproduces ProcessNode's `card`
  styling. Always shows position, `StateBadge`, and a resource line (CPU cores / RAM / max run
  length from `deadline_seconds`). When `entry.member`: also `<strong>{process_name}</strong>`,
  `v{version}` (plain text), project name line, `process_type` as `text-muted small`, and tags via
  read-only `TagBadge`. When not a member: the name slot shows a greyed-out placeholder
  `<strong className="text-muted">Process</strong>` (so card height/shape matches full cards),
  and the body is just position + state + resources — no version, project, type, or tags.
- **`frontend/src/App.jsx`** — import and register `ClusterQueueView` in the `widgets` object.

## Migration / compatibility

- **RBAC:** new `workloads` verb reaches a cluster only after re-provisioning (`ensure_cluster_job_ready`,
  idempotent) or a manual Role patch. Until then that cluster returns `queue_error` and an empty
  queue — the widget shows the cluster with a clear error, not a crash. Document the re-provision step.
- **No DB migration** — read-only over existing columns.
- **Legacy `k8s_cluster_id IS NULL` rows:** irrelevant to ordering here, since the queue is built
  from live workloads on each cluster's namespace, then mapped to processes by job name.

## Implementation order

1. Backend RBAC rule + `K8sClient.list_workloads` (additive, safe).
2. `/utilities/cluster-queues` endpoint + workload→process mapping/redaction, with per-cluster
   graceful degradation.
3. Frontend api + hook.
4. `StateBadge` extraction (refactor ProcessNode to use it — verify FlowView unchanged visually).
5. `QueueCard` + `ClusterQueueView` (tab bar + active-cluster persistence via `parentUpdate`) +
   widget registration.

## Verification

- **Backend unit test** (seed DB + a faked `list_workloads`): two users, two projects, several
  `ProcessVersion` rows (QUEUED/RUNNING) across two clusters, with a stub returning admitted +
  pending workloads. Include a process **created by user B but in a project user A is also a member
  of**, and assert user A sees it in **full** (proving membership — not creator — drives visibility).
  Assert: (a) admitted-before-pending, pending by creation-time asc, correct
  `position`; (b) `state` reflects admission; (c) member-project entries carry full fields,
  non-member entries carry only `position`/`state`/`resource_requests`/`deadline_seconds` and no
  `process_id`/identity — assert this on the **serialized response body** (e.g. the detail keys are
  absent from the dict / JSON payload the endpoint returns), proving redaction happened server-side
  and not via a frontend filter;
  (d) clusters outside `get_allowed_clusters` excluded; (e) a cluster whose `list_workloads` raises
  yields `queue_error` + empty `queue` and does not fail the request; (f) no forbidden RBAC verb.
- **Manual (real cluster, servers already running):** re-provision a cluster so the workloads verb
  applies. Submit jobs as user A and user B on the same cluster; open the widget as A. Confirm cards
  for processes in A's **member projects** (including any B started in a project A also belongs to)
  show project/name/version/type/tags, jobs from projects A is **not** a member of show only
  position/state/CPU/RAM/max-run-length, and
  order matches Kueue admission (running on top). Click reload after a job transitions
  QUEUED→RUNNING→DONE and confirm the list updates (DONE drops off). Confirm badge styling matches
  FlowView.
- **Tabs + persistence:** with ≥2 accessible clusters, confirm only one cluster's queue renders,
  switching tabs changes the panel, and after selecting a non-default cluster, saving the workspace
  version and reloading restores that same active cluster (the `activeClusterId` round-trips through
  the layout tree). Confirm a saved `activeClusterId` no longer in the list falls back to the first
  cluster without error.
- **Regression:** open FlowView and confirm the `StateBadge` extraction left process nodes visually
  identical.

## Resolved design questions

All previously-open questions are settled (see also "Decisions settled with the user" in Context):

- **Redacted-row label** → the process-name slot shows a greyed-out placeholder title `Process`
  (`<strong className="text-muted">Process</strong>`); no other caption, no identity.
- **`include_limits` default** → **on**. The per-cluster capacity line is shown by default; the
  extra live Kueue read per cluster is only incurred on manual reload.
- **Empty / error state** → **always show every accessible cluster's header.** Empty queue →
  "No jobs queued" note; failed Kueue read → `queue_error` shown inline. Nothing is collapsed.

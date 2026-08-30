# Single-Node Task-Size Accounting — Plan

## Goal

Stop accepting process tasks that can never be scheduled. Today the per-task CPU/RAM ceiling shown
to the user and enforced on submit comes from the Kueue `ClusterQueue` `nominalQuota` — a
**cluster-wide aggregate**. A Kubernetes pod is atomic: it must fit on **one** node. So a task
requesting more than any single node's allocatable capacity (but less than the cluster-wide
aggregate) passes validation, is admitted by Kueue (aggregate quota is free), and then its pod is
**unschedulable forever** — no single node can hold it.

The fix separates two limits that are currently conflated into the one `get_cluster_queue_limits()`
number:

1. **Aggregate quota** (Kueue `ClusterQueue` `nominalQuota`) — should reflect the pool's
   **autoscaled ceiling** (e.g. `max_count × node_allocatable`, or a provider-supplied logical
   ceiling), so many small tasks can queue and drive the autoscaler up. Fix `_resolve_quota` so it
   does **not** collapse to near-zero on a scale-to-zero pool.
2. **Per-task max size** exposed to the user (`available-clusters`) and enforced at submit
   (`process.py`) — should be **one node's allocatable capacity**, since a pod can't span nodes.
   This is the actual bug fix.

## Background — current state

(Confirmed by re-reading the implemented code, not just prior plan docs.)

- **Aggregate quota is the only number today.** `K8sClient.get_cluster_queue_limits()`
  (`backend/services/k8s_client.py:481`) reads the Kueue `ClusterQueue` `nominalQuota` and returns
  `{"max_cpu_cores", "max_memory_gb"}`. That `ClusterQueue` is cluster-scoped and its quota is the
  **sum** across the flavor's resources — an aggregate, not a per-node figure.
- **The endpoint surfaces the aggregate as the slider bound.**
  `GET /projects/{project_id}/utilities/available-clusters`
  (`backend/routers/utilities.py:24`, `available_clusters`) calls `get_cluster_queue_limits()` per
  allowed cluster and returns `{**cluster.to_dict(), "max_cpu_cores", "max_memory_gb"}`
  (falling back to `DEFAULT_QUEUE_LIMITS = {8.0, 32.0}` when the ClusterQueue can't be read).
- **The frontend slider binds to it.** `frontend/src/widgets/ProcessEditor.jsx:81-82` sets
  `maxCpu = selectedCluster?.max_cpu_cores ?? 8` and `maxMemory = selectedCluster?.max_memory_gb ??
  32`; these drive the CPU/memory slider ceilings (`useAvailableClusters` in
  `frontend/src/datamodel/useQueries.js:273`).
- **Server-side validation uses the same aggregate.** `backend/models/process.py:245-256` re-reads
  `get_cluster_queue_limits()` and rejects only `requested_cpu > limits["max_cpu_cores"]` /
  `requested_memory > limits["max_memory_gb"]` — i.e. it rejects tasks bigger than the whole
  cluster, but happily accepts a task bigger than any one node.
- **The pod is atomic and admission is quota-based.**
  `backend/services/job_orchestrator.py:171-174` sets `requests == limits == resource_requests`, and
  `:244` sets `spec.suspend = True` so Kueue's admission controller unsuspends the Job once
  **aggregate** quota is free. Kueue admits on aggregate; the scheduler then can't place the atomic
  pod on any node → `Unschedulable` indefinitely. (The `active_deadline_seconds` on the Job
  eventually fails it, but only after the deadline burns — the user's task simply never runs.)
- **Quota sizing today collapses on scale-to-zero.**
  `backend/services/cluster_job_provisioning.py` `_resolve_quota` (lines 307-326) **sums**
  `node.status.allocatable` over **currently-present** nodes, minus a 1-core/1-GiB headroom, floored
  at 1/1. On a scale-to-zero pool with zero nodes present this yields the 1-core/1-GiB floor →
  effectively nothing can be admitted → the autoscaler is never triggered → deadlock. `_resolve_quota`
  is bypassed entirely when `ensure_cluster_job_ready(..., quota_config=...)` is called with an
  explicit `{"cpu_cores", "memory_gb"}` override — which is how the Azure plugin's setup sizes quota
  (`per-node SKU × MAX_COUNT`) and GCP's (one fixed node). So the collapse only bites a
  scale-to-zero cluster provisioned **without** an explicit `quota_config`.
- **No per-node figure is stored or queryable anywhere today.** `Cluster.to_dict()`
  (`backend/models/cluster.py:42-52`) emits `sort_order/active/max_runtime_seconds/
  provisioning_status` but no capacity. `ClusterProvider` (`backend/services/cluster_providers/
  __init__.py`) has no method that reports node/SKU capacity.
- **Where a per-node figure could come from.** For `same-as-backend`/minikube there is always ≥1
  live node, so `list_node()` allocatable is readable. For GKE/AKS with a scale-to-zero node pool
  there may be **zero** nodes at query time, so the per-node figure must come from **provider
  config** (machine type / VM SKU) — the same knowledge the Azure/GCP setup scripts already encode
  to size their aggregate quota.

## Design decisions (settled)

- **Two distinct numbers, two distinct jobs.** Keep the existing field names
  `max_cpu_cores`/`max_memory_gb` meaning **the number that actually bounds one pod** (single-node
  allocatable) — because that is what the slider and the submit-validation must use, and both
  already read those exact keys, so repointing the *source* of those keys fixes the bug with zero
  frontend field-plumbing. Add **new** `aggregate_max_cpu_cores`/`aggregate_max_memory_gb` keys
  carrying the cluster-wide ceiling, for display only.
- **`node_capacity()` = the largest single instance the jobs pool may create.** Semantics are fixed:
  the value is **the largest single pod this cluster's jobs pool could ever admit** — i.e. one
  node's allocatable capacity, never a sum/aggregate. This is exactly the user's slider max and the
  submit-validation ceiling. Add
  `async def node_capacity(self, k8s_client, provider_config) -> dict` returning
  `{"max_cpu_cores": float, "max_memory_gb": float}`.
  - **Default implementation** reads live nodes (`list_node()`) and returns the **max** allocatable
    over present nodes (max, not sum — a pod lands on one node). Covers `same-as-backend`/minikube
    (always ≥1 node) with no per-provider work.
  - **Scale-to-zero providers (GKE/AKS) override** it to return the SKU/machine-type allocatable
    derived from `provider_config` — the value they already know from sizing their aggregate quota,
    correct even when zero nodes are currently present. Must never return the *sum*.
- **It is a live provider method — no stored column, no migration.** Capacity is provider knowledge,
  fetched live per call exactly like `get_cluster_queue_limits()` already is; there is no
  `Cluster` column and no Alembic migration. Trade-off (accepted): one extra `list_node()` per
  cluster per `available-clusters` call on the default path — that endpoint already does a live
  `get_cluster_queue_limits()` per cluster, so it's one more call of the same shape.
- **A provider that can't report capacity is a bug — fail hard, never guess.** `node_capacity()`
  must always return a real figure; a provider that cannot (default impl finds zero nodes on a
  cluster type that never scales to zero, or a scale-to-zero provider that failed to implement the
  override) **raises**, and the error propagates to the caller (CLAUDE.md rule 8). There is **no**
  `8/32` conservative single-node fallback — an unanswerable provider is a code defect to fix, not a
  friendly default to paper over. (This is distinct from the pre-existing aggregate
  `DEFAULT_QUEUE_LIMITS` fallback in `get_cluster_queue_limits()`, which is unchanged.)
- **Aggregate quota sizing = autoscaled ceiling, sourced from the provider.** `_resolve_quota`
  should prefer a provider-supplied logical ceiling over summing currently-present nodes, so a
  scale-to-zero pool advertises its *full autoscaled* aggregate (`node_capacity × max_count`) rather
  than collapsing to the 1/1 floor. Concretely: add a companion `ClusterProvider` method
  `async def aggregate_capacity(self, k8s_client, provider_config) -> dict | None`; when it returns a
  value, `ensure_cluster_job_ready` uses it as the `quota_config` (this is what the Azure/GCP
  scripts pass explicitly today, now funnelled through the provider abstraction); when it returns
  `None`, keep today's node-sum behavior (correct for the always-on single-node case). `None` here
  is a legitimate "decline, use node-sum," unlike `node_capacity()` which must never decline.
- **Node-pool eligibility is out of scope.** `node_capacity()` reports the largest pod the jobs pool
  could admit, full stop; there are no GPU resource requests and no per-pool task-eligibility
  modelling to do. Pod steering is **unchanged from today**: the system pool's `CriticalAddonsOnly`
  taint keeps job pods off it, and this plan makes **no** host-side Job-spec change (no added
  tolerations / `nodeSelector` in `job_orchestrator.py`).

## Cross-repo dependency / interface contract

This introduces a contract the cloud-provider plugins must satisfy — call it out explicitly to the
GCP and Azure NAP plans being written separately:

- Each plugin's `ClusterProvider` for a **scale-to-zero** cluster type MUST implement
  `node_capacity(k8s_client, provider_config)` returning the single-node allocatable
  (`{"max_cpu_cores", "max_memory_gb"}`) derived from its machine type / VM SKU in
  `provider_config`. There is no fallback: a scale-to-zero provider that omits this override and has
  zero live nodes will **raise** (the default impl finds nothing to report), which surfaces as a
  loud error rather than a mis-sized ceiling — so implementing it is mandatory, not optional.
- Each plugin SHOULD implement `aggregate_capacity(...)` returning `node_capacity × max_count`, and
  its setup path should route that through `ensure_cluster_job_ready`'s `quota_config` (replacing the
  hand-rolled `per-node SKU × MAX_COUNT` sizing) so aggregate quota and single-node ceiling are
  derived from one source of truth.
- Core ships the method signatures + default (live-node) implementation on the base
  `ClusterProvider`, so a plugin that does nothing still gets correct behavior **iff** its clusters
  always have ≥1 live node; only scale-to-zero pools strictly require the override.

---

## Phase 1 — `ClusterProvider` capacity methods (core)

`backend/services/cluster_providers/__init__.py`:

- Add `async def node_capacity(self, k8s_client, provider_config) -> dict` with a default
  implementation that calls `k8s_client.list_node()` (or the existing node-listing path) and returns
  the **max** (never the sum) over present nodes' `status.allocatable`:
  `{"max_cpu_cores": max(_parse_cpu_cores(...)), "max_memory_gb": max(_parse_memory_gb(...))}`.
  Reuse `_parse_cpu_cores` / `_parse_memory_gb` from `k8s_client.py` (already imported in
  `cluster_job_provisioning.py`). If there are **zero** nodes to read, the default impl **raises**
  (it cannot answer) — it does not return `None` and does not guess a default; a scale-to-zero
  provider is expected to have overridden this method so the zero-node path is never reached.
- Add `async def aggregate_capacity(self, k8s_client, provider_config) -> dict | None` returning
  `None` by default (core providers keep today's node-sum aggregate sizing). Here `None` is a
  legitimate "decline, fall through to node-sum" — the one place a `None` return is meaningful.
- `node_capacity()` never swallows and never guesses (raise on can't-answer); `aggregate_capacity()`
  distinguishes decline (`None`) from failure (raise). Both mirror the existing method docstrings'
  loud-failure stance.

No `Cluster` model change and no migration — capacity is served live from the provider method.

## Phase 2 — Aggregate quota sizing uses the provider ceiling

`backend/services/cluster_job_provisioning.py`:

- In `ensure_cluster_job_ready`, before `_resolve_quota`, consult
  `provider.aggregate_capacity(k8s_client, provider_config)`; if it returns a value and no explicit
  `quota_config` was passed, use it as the `quota_config`. (Provider is resolvable from the
  `Cluster.cluster_type` via `get_cluster_provider`; thread it in where this routine is invoked —
  `admin_create_cluster`, `register-callback`, and the seed migration — or pass the already-resolved
  provider/config down.)
- Leave the node-sum path in `_resolve_quota` as the final fallback for the always-on single-node
  case (correct today), so `same-as-backend`/minikube behavior is unchanged.
- Net effect: a scale-to-zero pool provisioned through a provider that implements
  `aggregate_capacity` advertises its full autoscaled ceiling instead of the 1/1 floor — fixing the
  "nothing admitted → autoscaler never triggers" deadlock without touching the Azure/GCP explicit
  `quota_config` path (which continues to work, now as one instance of the same mechanism).

## Phase 3 — `available-clusters` returns both numbers

`backend/routers/utilities.py` (`available_clusters`):

- Keep the existing `get_cluster_queue_limits()` call and surface it as the **aggregate**:
  `aggregate_max_cpu_cores` / `aggregate_max_memory_gb`.
- Add a per-cluster single-node lookup: resolve the provider
  (`get_cluster_provider(cluster.cluster_type)`), call
  `node_capacity(k8s_clients.get(cluster), cluster.provider_config)`, and emit its result as
  `max_cpu_cores` / `max_memory_gb` (the slider-bounding keys). There is no `8/32` fallback: if the
  provider can't report capacity it raises, and that error propagates (a real misconfiguration to
  fix, not a guessed ceiling to serve).
- Response shape per cluster becomes:
  `{**cluster.to_dict(), "max_cpu_cores"(single-node), "max_memory_gb"(single-node),
  "aggregate_max_cpu_cores", "aggregate_max_memory_gb"}`.
- The same combined endpoint is already MCP-exposed (tagged `"Processes"`); the added keys are
  additive. Update `docs/mcp-tools.md` if it documents this response's fields.

## Phase 4 — Submit-time validation uses single-node capacity

`backend/models/process.py` (~245-256):

- Replace the `get_cluster_queue_limits()` lookup used for the CPU/RAM ceiling with the provider's
  `node_capacity(...)` result (no `8/32` fallback — a provider that can't answer raises, same as
  Phase 3). Reject
  `requested_cpu > single_node["max_cpu_cores"]` / `requested_memory > single_node["max_memory_gb"]`
  with the existing `HTTPException(400, ...)` messages, reworded to "exceeds single-node capacity"
  so the failure is self-explanatory.
- Deadline validation against `cluster.max_runtime_seconds` is unchanged.
- This is the load-bearing bug fix: an unschedulable task is now rejected at submit instead of
  hanging until its deadline.

## Phase 5 — Frontend: bound the slider to single-node, show aggregate as info

`frontend/src/widgets/ProcessEditor.jsx`:

- No change needed to the slider-bounding lines (`maxCpu`/`maxMemory` already read
  `max_cpu_cores`/`max_memory_gb`, which now carry the single-node number) — this is the reason
  Design decision 1 keeps those key names.
- Add a small info line under the cluster dropdown / sliders showing the aggregate ("This cluster
  can queue up to `aggregate_max_cpu_cores` cores / `aggregate_max_memory_gb` GiB in total across
  autoscaled nodes; a single task can request at most `max_cpu_cores` / `max_memory_gb`."), so the
  user understands why the per-task ceiling is lower than the cluster's headline capacity.
- `handleClusterChange` re-clamp logic (lines 99-104) is unchanged — it already clamps to
  `max_cpu_cores`/`max_memory_gb`.

## Implementation Order

1. **Phase 1** — provider methods + default impl; no behavior change on its own (nobody calls them
   yet).
2. **Phase 3 + Phase 4 together** — endpoint returns both numbers and validation switches to
   single-node, so the API contract and the enforcement land atomically (avoids a window where the
   slider is bounded one way and the server another).
3. **Phase 5** — frontend info line; purely additive display.
4. **Phase 2** — aggregate-sizing fix; independent of 3-5, can land any time after Phase 1. Ordered
   last here because it's the autoscaler-deadlock half, separable from the unschedulable-task half,
   and its real value only shows once a scale-to-zero cloud provider implements `aggregate_capacity`
   (plugin work).

For existing single-node/minikube deployments this is a no-op in practice: the single node's
allocatable and the aggregate are the same one node, so slider and validation land on the same
number they do today.

## Open Questions

- **Interaction with `detect-cpu-availability`.** `docs/plans/done/detect-cpu-availability.md`
  already exposes the pod's own CPU limit to the runner. This plan is upstream of that (it governs
  what limit a pod is *allowed* to request); no conflict, but worth confirming the two ceilings
  (single-node allocatable here, in-pod `CPU_LIMIT` there) stay consistent.
- **Aggregate ceiling for `same-as-backend`/minikube.** These keep the node-sum aggregate (one
  node), so their aggregate and single-node numbers are identical — confirm the frontend info line
  degrades gracefully (don't show a confusing "aggregate vs per-task" split when they're equal).

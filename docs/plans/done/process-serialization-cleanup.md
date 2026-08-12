# Cleanup: server-side environment/cluster resolution, one Ref shape for read and write

## Goal

Stop resolving `environment_id`/`cluster_id` → display name on the client, and stop maintaining a
separate flat-id shape for writes (`POST /process`, clone) from the nested shape returned by reads
(`GET /processes`, `GET /process/{id}`). One shape, both directions: `environment: {id, name}`,
`cluster: {id, name}`. `Process.to_dict()` / `ProcessVersion.to_dict()` return these resolved
objects directly (replacing `ProcessInfo.jsx`'s current client-side join against a separately
-fetched `useEnvironments()` list), and `ProcessCreate`/`CloneRequest` *accept* the same
`{id, name}` shape (only `.id` is read server-side — `name`, if present, is surplus and ignored,
never validated against). This means a value read from `GET /process/{id}` can be forwarded
verbatim into the next `POST /process` body with no field-renaming translation layer in between —
`ProcessInfo`, `ProcessEditor`, and `SaveModelDialog` all read and write `process.environment` /
`versionObj.cluster` as the same object shape, never `environment_id`/`cluster_id` strings.

`ProcessInfo` already reads its `process`/`versionObj` from the exact same `processes` data
(`ProcessContext`/`useProcesses`) that `ProcessEditor` reads — there is no second copy of the data
to unify. The only thing that needs to change in `ProcessInfo` is: stop building a hand-picked
`config` object (a field whitelist) and instead serialize the real, already-server-resolved object
to YAML directly.

## Current state (confirmed by reading the code, not the earlier plan docs)

- `Process.to_dict()` (`backend/models/process.py:61-72`) returns flat `environment_id`.
  `ProcessVersion.to_dict()` (`process.py:295-322`) returns flat `cluster_id` (line 320).
- A `Process.environment` relationship **already exists** (`process.py:56`,
  `back_populates="processes"` on `Environment.processes`, `environment.py:21`) but is unused by
  `to_dict()` and never eager-loaded by the routers.
- **No** `ProcessVersion.cluster` relationship exists — `k8s_cluster_id` (`process.py:267`) is a
  bare FK column. The only existing resolution path is the imperative async helper
  `get_cluster_for_process_version(db, process_version)` (`backend/models/cluster.py:72-84`), used
  today only in execution-path code (job orchestration, cancel), never in list serialization.
- `GET /processes` and `GET /process/{id}` (`backend/routers/processes.py:150-153`, `203-206`)
  already eager-load nested collections via chained `selectinload`:
  ```python
  selectinload(Process.versions).selectinload(ProcessVersion.datasets),
  selectinload(Process.versions).selectinload(ProcessVersion.tags),
  ```
  Adding `selectinload(Process.environment)` is a one-line addition to both. Adding cluster
  eager-loading needs the new relationship from Phase 1 first.
- `ProcessInfo.jsx` (`frontend/src/widgets/ProcessInfo.jsx:80-92`) builds a hand-picked `config`
  object (whitelist of field names) and hand-serializes it via a bespoke `toYaml()` (lines 7-35) +
  `renderYamlWithLinks()` (37-57). It resolves `environment` itself via `useEnvironments()` — this
  is the exact client-side join this plan removes. It has no `cluster` field at all today.
- `ProcessEditor.jsx`'s "Resource Configuration" card (`ProcessEditor.jsx:262-281`) shows
  `selectedCluster?.name` resolved from `useAvailableClusters(currentProject, {cpu, memory})`
  (line 62-67) — a **live availability/fitting** query (calls Kueue per cluster,
  `backend/routers/utilities.py:36-39`), not a plain id→name lookup. For an existing, already-saved
  process version this is the wrong source for "what cluster is this actually on": a since-retired
  or no-longer-fitting cluster silently disappears from `clusters`, and `selectedCluster` falls
  through to `clusters[0]` (a different, wrong cluster) or `null` — see `ProcessEditor.jsx:67`.
- Both edit-state syncs read the flat ids directly:
  `ProcessEditor.jsx:110` — `setLocalEnvironment(process.environment_id)`
  `ProcessEditor.jsx:120` — `setClusterId(versionObj.cluster_id ?? null)`
  `SaveModelDialog.jsx:32` — `fullSourceProcess?.environment_id || selectedEnvironment || ''`
- Submit payloads (`ProcessEditor.jsx:165,181,167,183`, `SaveModelDialog.jsx:90`) send flat
  `environment_id`/`cluster_id` to `POST /process`, matching the independent `ProcessCreate`/
  `CloneRequest` Pydantic request models (`processes.py:27-37,270-274`). `ProcessCreate` has
  `model_config = {"extra": "allow", ...}` already, and its `Field(..., description=...)` strings
  double as the tool schema/docs for MCP callers (`mcp__nagelfluh__create_process_process_post`) —
  any request-shape change here is also a change to what an LLM tool caller sees and sends.
  `create_process()` (`processes.py:99-113`) reads `proc.environment_id` directly and threads it
  through to `Process.create_queued(..., environment_id=...)`; `Process.create_queued()`
  (`process.py:116-245`) separately reads `proc.get("cluster_id")` out of the dumped dict
  (`proc.model_dump(by_alias=True, exclude_none=True)`, `processes.py:107`) for cluster resolution.
  These are the two places a shape change on the request side has to land.
- Legacy rows: `ProcessVersion.k8s_cluster_id` is nullable (predates multi-cluster support).
  `get_cluster_for_process_version()` treats `NULL` as "the bootstrap default cluster, which is
  exactly the single cluster they actually ran on" (`cluster.py:75-78`, `DEFAULT_CLUSTER_ID`
  constant at `cluster.py:8`). Naively eager-loading a `ProcessVersion.cluster` relationship off the
  raw FK would **not** apply this fallback — a legacy row's relationship would just resolve to
  `None`, understating what actually happened.

## Design decisions (settled in discussion)

1. **Replace, don't duplicate.** `to_dict()` drops `environment_id`/`cluster_id` entirely and
   returns only the nested `environment`/`cluster` objects. No flat id kept alongside. Any other
   consumer of these response shapes (MCP tools, `docs/mcp-tools.md`) gets updated in Phase 4.

2. **Legacy NULL cluster → `cluster: null`, no fallback resolution.** `to_dict()` stays
   synchronous and argument-free — no `default_cluster` parameter threaded through it. The frontend
   shows a plain placeholder (e.g. "—") for these old rows. This intentionally diverges from
   `get_cluster_for_process_version()`'s runtime behavior (which resolves NULL to the bootstrap
   default cluster for job execution) — that function is unchanged and keeps doing its own
   fallback for execution; only *display* skips it, since these rows are rare/old (the system was
   single-cluster before multi-cluster support existed).

3. **`ProcessEditor`'s Resource Configuration card gets fixed too.** Source the displayed cluster
   name from `versionObj.cluster?.name` (the actual saved value) while unedited, falling back to
   the live `clusters` (`useAvailableClusters`) list only once the user opens the edit modal and is
   actively picking a different cluster. `useAvailableClusters` is otherwise unchanged — still used
   to populate edit-mode options and bound the sliders.

4. **Request shape adopts the same `{id, name}` ref shape as the response — no flat/nested split.**
   Maintaining a hand-picked flat-field request model (`environment_id`, `cluster_id`) alongside a
   server-resolved nested response model is exactly the kind of per-direction field whitelisting
   this plan is otherwise removing from `ProcessInfo` — one bespoke shape per call site instead of
   one shape used everywhere. Instead: a single small `Ref` model, `{id: str, name: Optional[str] =
   None}` with `extra="ignore"`, is used for *both* directions. `to_dict()` emits it; `ProcessCreate`
   and `CloneRequest` accept it in place of `environment_id`/`cluster_id`. Only `.id` is ever read
   server-side — a `name` present on a POST body (e.g. because the frontend forwarded a value it got
   from a prior GET verbatim) is surplus and silently ignored, never validated against the id. This
   means:
   - The frontend needs no field-renaming translation code at all — `process.environment` (from a
     GET) is exactly what gets embedded, unmodified, as `environment` in a subsequent POST body.
   - A brand-new selection (user picking from a dropdown, no prior GET to round-trip) is just
     `{id: selectedId}` — `name` is optional, not required, so this costs nothing over today's flat
     `environment_id: selectedId`.
   - The MCP tool schema for `create_process`/`clone_process_version` changes from
     `environment_id: "<uuid>"` to `environment: {"id": "<uuid>"}` — a minor shape change for LLM
     callers, updated in the `Field` descriptions and `docs/mcp-tools.md` (Phase 4). `list_environments`
     already returns full `{id, name, ...}` objects, so a caller that just read that list can pass
     one straight through.

---

## Phase 1 — Backend: resolve environment/cluster server-side

### 1.1 `ProcessVersion.cluster` relationship

**`backend/models/process.py`**, add to `ProcessVersion` relationships (near line 283-285):
```python
cluster = relationship("Cluster", foreign_keys=[k8s_cluster_id], viewonly=True)
```
`viewonly=True` since nothing should mutate cluster assignment through this relationship —
`k8s_cluster_id` stays the column that's actually written.

### 1.2 Eager-load in both process routers

**`backend/routers/processes.py:150-153` and `:203-206`**, add:
```python
selectinload(Process.environment),
selectinload(Process.versions).selectinload(ProcessVersion.cluster),
```
Both are single batched queries added to the existing statement — not per-row, no N+1.

### 1.3 `to_dict()` changes

**`backend/models/process.py`**, `Process.to_dict()` (61-72): replace `"environment_id":
self.environment_id` with `"environment": self.environment.to_dict() if self.environment else
None`.

`ProcessVersion.to_dict()` (295-322): replace `"cluster_id": self.k8s_cluster_id` with
`"cluster": self.cluster.to_dict() if self.cluster else None`. No fallback resolution for legacy
NULL rows — `to_dict()` stays synchronous and argument-free, per decision 2.

### 1.4 Other `to_dict()` call sites

Grep every call site of `Process.to_dict()` / `ProcessVersion.to_dict()` (clone endpoint,
`processes.py:356` builds its own dict already so unaffected; any WebSocket state-push code) to
confirm none of them special-case the flat `environment_id`/`cluster_id` keys in a way that breaks
silently — update any that do.

### 1.5 Shared `Ref` model, requests accept the same shape as responses

**`backend/routers/processes.py`**, alongside `ResourceRequests` (line 19-24), add:
```python
class Ref(BaseModel):
    id: str = Field(..., description="ID of the referenced object.")
    name: Optional[str] = Field(None, description="Ignored on input — present only because this is the same shape returned by GET.")

    model_config = {"extra": "ignore"}
```
This is the one place the ref shape is defined; `ProcessCreate`, `CloneRequest`, and any future
request model that references an environment/cluster/similar object all import it rather than each
inventing their own flat-id field.

**`ProcessCreate`** (line 27-37): replace `environment_id: str = Field(...)` with
`environment: Ref = Field(..., description="Environment this job runs in — {id, [name]}. Obtain
from list_environments (pass the object straight through, or just {\"id\": ...}).")`. Replace
`cluster_id: Optional[str] = Field(None, ...)` with `cluster: Optional[Ref] = Field(None,
description="Cluster to run this job on — {id, [name]}. Obtain from available_clusters. If
omitted, the first cluster allowed for this request (by sort_order) is used automatically.")`.

**`CloneRequest`** (line 270-274): replace `cluster_id: Optional[str] = Field(None, ...)` with
`cluster: Optional[Ref] = Field(None, description="Override the cluster for the cloned run —
{id, [name]}. ...")` (same description content as today, ref-shaped).

**`create_process()`** (`processes.py:99-113`): `environment_id = proc.environment_id` becomes
`environment_id = proc.environment.id`. The rest of the function (environment lookup, `model_dump`,
call to `create_queued`) is unchanged — `model_dump(by_alias=True, exclude_none=True)` on a
`Ref`-typed field just produces `{"id": ..., "name": ...}` (or omits the key entirely if the
optional `cluster` was never set, same as today's `None` omission).

**`Process.create_queued()`** (`backend/models/process.py:116-245`): the one read of
`proc.get("cluster_id")` (line 197) becomes:
```python
cluster_ref = proc.get("cluster")
cluster_id = cluster_ref["id"] if cluster_ref else None
```
`environment_id` stays a plain string parameter here — it's already extracted to an id by the
router before this function is called (decision: the *ORM-facing* internal contract stays
id-only; only the *client-facing* request/response models carry the `{id, name}` ref shape).

**Clone endpoint** (`processes.py:277+`, not fully shown above — locate the read of
`request.cluster_id` in the clone handler body and change it to `request.cluster.id if
request.cluster else None`, mirroring the `create_queued` change).

---

## Phase 2 — Frontend: `ProcessInfo` stops whitelisting fields

**`frontend/src/widgets/ProcessInfo.jsx`**:
- Delete the `useEnvironments()` call and the manual `environment` lookup (lines 61, 81) — the
  resolved `environment`/`cluster` objects now come straight from `process`/`versionObj`, the exact
  same objects `ProcessEditor` already reads from the same `processes` query data.
- Replace the hand-picked `config` object (82-92): instead of listing fields in one-by-one, take
  the real `process` object (excluding `versions`, and excluding pure-UI-layout fields
  `flow_x`/`flow_y`) merged with the found `versionObj`, and serialize *that* to YAML. This becomes
  an **exclude-list** (a fixed, small set of fields that are genuinely not meaningful to show), not
  an include-list — new backend fields appear automatically instead of requiring a frontend change
  to surface them, which is the actual bug being fixed.
- Keep `toYaml()`/`renderYamlWithLinks()` (lines 7-57) as local, private implementation detail of
  this one widget — it's just "how ProcessInfo happens to pretty-print an object," not something any
  other widget needs to import or agree with. No new shared module.

---

## Phase 3 — Frontend: `ProcessEditor` reads and writes the same nested shape

**`frontend/src/widgets/ProcessEditor.jsx`**:
- Edit-state-sync reads (`:110`, `:120`) match the new response shape:
  `setLocalEnvironment(process.environment_id)` → `setLocalEnvironment(process.environment?.id)`;
  `setClusterId(versionObj.cluster_id ?? null)` → `setClusterId(versionObj.cluster?.id ?? null)`.
  Local state (`localEnvironment`, `clusterId`) stays a bare id string — that's what the
  `<select>`s and `useAvailableClusters`/`useEnvironmentProcessTypes` hooks need — the ref shape is
  only at the request/response boundary, not threaded through component state.
- Submit payloads (`handleSubmit`, both branches, `:161-197`) change `environment_id: localEnvironment`
  → `environment: {id: localEnvironment}`, and `cluster_id: clusterId` → `cluster: clusterId ? {id:
  clusterId} : null`.
- Resource Configuration card (262-281): source `Cluster:` display from `versionObj.cluster?.name`
  when unedited, falling back to the live `clusters`/`selectedCluster` lookup once the user is
  actively picking a new one in the edit modal.
- **`useAvailableClusters` stays** — it's still required to populate the edit-modal `<select>`
  options and to bound the CPU/memory/deadline sliders/limits. This plan only removes it as the
  source for **display of the already-saved value**, not as the source of editable options.

**`frontend/src/widgets/AEMModelSimulator/SaveModelDialog.jsx`**:
- `:32` — `fullSourceProcess?.environment_id || selectedEnvironment || ''` →
  `fullSourceProcess?.environment?.id || selectedEnvironment || ''`. Local `environment` state stays
  a bare id (same reasoning as above — it drives a plain `<select>`).
- `:90` — `environment_id: environment` → `environment: {id: environment}` in the constructed `proc`
  object.

---

## Phase 4 — Docs / MCP

Update `docs/mcp-tools.md` (and any other doc quoting the `environment_id`/`cluster_id` shape) to
reflect the new nested `environment`/`cluster` ref objects — on **both** the response shape
(`GET /processes`, `GET /process/{id}`) and the request shape (`POST /process`'s `environment`/
`cluster` fields, `clone`'s `cluster` field). Call out explicitly that a value obtained from
`list_environments`/`available_clusters`/a prior `get_process` can be passed straight through as
the `environment`/`cluster` field — no extraction step needed — since that's the actual ergonomic
win for MCP/LLM callers motivating decision 4.

---

## Verification

- `GET /processes` and `GET /process/{id}` return `environment`/`cluster` nested objects, no N+1
  (check query count/logs during a list call with several processes).
- `ProcessInfo` shows cluster name for a process created after multi-cluster support landed.
- `ProcessInfo` shows `cluster: null` (rendered as a plain placeholder) for a pre-multi-cluster
  legacy process version, if one still exists in dev data — not an error, not a crash.
- `ProcessEditor`'s Resource Configuration card shows the correct cluster name for an existing
  process even when that process's cluster is deactivated or no longer resource-fitting (i.e. would
  have disappeared from the old `useAvailableClusters`-only lookup) — this is the regression test
  for the bug that motivated this cleanup.
- Editing still works: opening the resource modal still lists live-fitting clusters and lets you
  reassign; submitting posts `environment: {id}`/`cluster: {id}` (request shape now matches
  response shape, per decision 4).
- `POST /process` accepts a value forwarded verbatim from a prior `GET /process/{id}`'s `environment`
  field (i.e. `{id, name}`, not just `{id}`) — the surplus `name` is ignored, not rejected.
- `POST /process` and clone still work when only `{"id": "..."}` is sent (no `name`) — the
  brand-new-selection path (dropdown, MCP caller building the ref by hand) isn't penalized.
- MCP tool schema for `create_process`/`clone_process_version` shows the new `environment`/`cluster`
  object shape (check via `get_process_type_schema`-equivalent introspection or the tool's rendered
  schema), and `docs/mcp-tools.md` matches.

# User-Selectable Storage Backend at Project Creation — Plan

## Goal

Add a storage-backend dropdown to the "Create New Project" dialog, mirroring how
[multi-cluster-selection.md](done/multi-cluster-selection.md) turned cluster choice into a
user-facing, plan-gated decision instead of a silent server-side pick. Concretely:

- `select_storage` (singular, `hooks.run_first`, one winner) is replaced by **`select_storage_backends`**
  (plural, `hooks.run`, union-of-allowed) — the same hook-semantics shift the cluster plan made, so a
  billing plugin can limit which storage backends a user's plan allows, exactly like `select_clusters`
  already limits clusters by plan.
- A new `GET /utilities/available-storage-backends` endpoint lists the backends the current user may
  provision a project against.
- `ProjectModal.jsx` shows those as a dropdown; the user's pick is submitted as a **required**
  `storage_backend_id` on `POST /projects`.
- `create_project` re-derives the allowed set server-side and validates the submitted id against it —
  never trusts the client blindly, same as `POST /process` does for `cluster_id` today.

**Deliberate difference from clusters**: `storage_backend_id` has **no server-side default**.
`POST /projects` rejects a request that omits it (`400`), rather than falling back to
`allowed[0]` the way `POST /process` falls back for an omitted `cluster_id`. See Design decisions.

## Background — current state (confirmed by reading the code)

- `frontend/src/ProjectModal.jsx:4-51` — the create-project dialog has exactly one field (name). No
  storage-related state, prop, or field anywhere in it.
- `frontend/src/datamodel/api.js:211-214` — `createProject(name)` posts `{ name }` only.
- `backend/routers/projects.py:66-104` (`create_project`, `POST /projects`) — body is `{"name": ...}`
  only; the backend is chosen entirely server-side:
  ```python
  proj.storage_backend_id = hooks.run_first.select_storage(
      await get_default_storage_backend_id(db), db, auth.user, proj
  )
  ```
  `hooks.run_first` = first registered plugin's non-`None` answer wins, default otherwise
  (`backend/hooks.py:49-61`). No plugin in this repo registers `select_storage` today (confirmed by
  grep across `plugins/*`) — it always resolves to `get_default_storage_backend_id(db)`.
- `backend/models/storage_backend.py:40-49` — `get_default_storage_backend_id(db)`: first `active`
  `StorageBackend` ordered by `sort_order`; raises `RuntimeError` if none are active. Used **only**
  from `projects.py` (confirmed by repo-wide grep) — safe to remove once `create_project` no longer
  needs a default.
- `backend/models/storage_backend.py:10-37` — `StorageBackend.to_dict()` already returns only
  `id/name/protocol/endpoint/bucket_prefix/credential_strategy/created_at/sort_order/active` — it
  never included the sensitive `config` blob (that's added separately, and masked, only by the admin
  router's `_storage_backend_admin_dict`). This shape is already safe to hand to non-admin users
  as-is, exactly like `Cluster.to_dict()` (`backend/models/cluster.py:42-52`) already omits
  `kubeconfig`/`registry_auth`.
- `GET /admin/storage-backends` (`backend/routers/admin.py:197-200`) is the only existing
  list-backends endpoint, gated by `require_admin` — not usable by an ordinary project-creating user.
- The direct precedent this plan mirrors, confirmed in the sibling `Cluster` implementation:
  - `backend/hooks.py:90-101` — `hooks.run` (collect-from-every-plugin, flatten) and
    `hooks.any_registered(name)` (distinguishes "no plugins" from "plugins answered empty") already
    exist as generic infrastructure — no hook-runner changes needed, only a new hook *name*.
  - `backend/models/cluster.py:55-69` — `get_allowed_clusters(db, user, project_id, resource_requests)`
    is the exact shape to mirror for storage backends (minus the `resource_requests` concept, which
    doesn't apply to storage).
  - `backend/routers/utilities.py:19-47` — `GET /utilities/available-clusters` is the exact shape to
    mirror for `GET /utilities/available-storage-backends`.
  - `backend/routers/processes.py` / `backend/models/process.py:189-220` — where `cluster_id` is
    validated against `get_allowed_clusters()` at creation time is the exact shape to mirror in
    `create_project`, **except** for the required-vs-optional difference (see below).
  - `frontend/src/widgets/ProcessEditor.jsx:56-91` — the cluster `<select>` + auto-select-first-once-
    loaded `useEffect` is the exact shape to mirror in `ProjectModal.jsx`.
- No plugin in this repo currently implements `select_clusters` or `select_storage` (confirmed by
  grep) — this plan wires the mechanism, not a concrete billing policy; `plugins/billing` gains a real
  place to hook in later, same as it has for clusters today.

## Design decisions (settled in discussion)

- **Mirror the cluster pattern's shape exactly**: plural hook name, `hooks.run` union semantics, a
  `get_allowed_storage_backends()` resolver used by both the listing endpoint and creation-time
  validation, a dropdown that defaults to the first allowed entry once loaded. This is a deliberate
  reuse of an already-reviewed pattern, not a new design.
- **Hook rename: `select_storage` → `select_storage_backends`.** Since no plugin implements the old
  hook, this is a clean replacement, not a deprecation shim. Signature:
  `select_storage_backends(db, user) -> list[str]` (backend ids). No `project` argument — unlike
  `select_clusters` (called at process-creation time, when a project already exists),
  `select_storage_backends` runs at *project*-creation time, before any project row exists, so there
  is no project to pass. (A future plan could add project-scoped storage routing if a real need
  arises; out of scope here — matches `per-project-storage-routing.md`'s existing "moving a project
  between backends stays out of scope" stance.)
- **Fallback semantics, same as clusters**: no `select_storage_backends` plugin registered ⇒ every
  active `StorageBackend` is allowed. Plugins registered ⇒ union of their answers is the allowed set;
  an empty union is a genuine "no backends allowed for this user" result, not a fallback.
- **`storage_backend_id` is required on `POST /projects` — no server-side default.** This is the one
  deliberate divergence from the cluster precedent (`cluster_id` is optional there, falling back to
  `allowed[0]`, specifically to keep pre-existing MCP/script callers of `POST /process` working
  unchanged — see `multi-cluster-selection.md` Design decisions). That backward-compat concern does
  not apply here: `POST /projects` is tagged `"Projects"`, which is not in `main.py`'s MCP
  `include_tags` list (`backend/main.py:140`), so it is not an MCP tool and has exactly one caller in
  the whole repo — `frontend/src/datamodel/api.js:211-214`. There is no legacy client whose omission
  of the field needs to keep working. Making the choice explicit and mandatory also fits the project's
  actual weight: storage backend is a creation-time-only, effectively permanent choice
  (`per-project-storage-routing.md`: "moving a project between backends stays out of scope"), so
  silently defaulting a user into a possibly-wrong (e.g. paid-tier) backend is worse than a hard
  error demanding an explicit pick.
- **Endpoint placement**: `GET /utilities/available-storage-backends`, alongside
  `available-clusters` — both are "what am I allowed to pick from, right now, given who I am"
  endpoints, not really project- or admin-resource-scoped, so `utilities.py` is the right home
  (matches the existing precedent instead of adding a new router or bolting onto `projects.py`).
- **Response shape**: reuse `StorageBackend.to_dict()` verbatim (id/name/protocol/endpoint/
  bucket_prefix/credential_strategy/created_at/sort_order/active) — already non-admin-safe (see
  Background), no new masking logic needed. The frontend dropdown displays `name` (falling back to
  `protocol` if a backend was ever created with an empty name, matching how the admin table already
  treats these fields).
- **Not in scope**: no MCP exposure for the new endpoint (unlike `available-clusters`, which is
  tagged `"Processes"` specifically because process creation is MCP-exposed; project creation is
  not). No changes to `StorageBackendsAdminPanel.jsx` or any admin-side storage-backend CRUD. No
  changes to `ensure_ready`/`storage_credentials.py` provisioning — only *which* backend id ends up
  on `Project.storage_backend_id` changes, not what happens once it's set.

## Phase 1 — `select_storage_backends` hook + allowed-backends resolver

### 1.1 `backend/models/storage_backend.py`

Add, next to `StorageBackend`:

```python
from backend.hooks import hooks

async def get_allowed_storage_backends(db, user) -> list["StorageBackend"]:
    """Resolve the set of StorageBackends `user` is allowed to create a project against, sorted
    by sort_order. Mirrors get_allowed_clusters() (backend/models/cluster.py).

    If no select_storage_backends plugins are registered, every active backend is allowed. If
    plugins are registered, their union of allowed backend ids is the allowed set — an empty
    union means no backends are allowed, not a fallback to "all active".
    """
    if hooks.any_registered("select_storage_backends"):
        allowed_ids = set(hooks.run.select_storage_backends(db, user))
        stmt = select(StorageBackend).where(StorageBackend.id.in_(allowed_ids), StorageBackend.active == True)
    else:
        stmt = select(StorageBackend).where(StorageBackend.active == True)
    stmt = stmt.order_by(StorageBackend.sort_order)
    result = await db.execute(stmt)
    return result.scalars().all()
```

Remove `get_default_storage_backend_id()` (`storage_backend.py:40-49`) — its only caller
(`projects.py`) is being replaced in Phase 3. Leave `DEFAULT_STORAGE_BACKEND_ID` (the module-level
constant, `storage_backend.py:7`) untouched — it's used only by the bootstrap seed migrations
(`a6b7c8d9e0f1_seed_default_storage_backend.py`, `9623bab8493d_generic_seed_default_storage_backend.py`,
`182d880e84c7_backfill_default_storage_backend_config.py`), an unrelated concern.

## Phase 2 — Available-storage-backends endpoint

**`backend/routers/utilities.py`**, alongside `available_clusters`:

```python
from backend.models.storage_backend import get_allowed_storage_backends

@router.get("/available-storage-backends")
async def available_storage_backends(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the storage backends the current user may create a project against.

    Mirrors /utilities/available-clusters: select_storage_backends hook's allowed-backend set,
    sorted by sort_order — the same order the project-creation dropdown presents.
    """
    backends = await get_allowed_storage_backends(db, auth.user)
    return [b.to_dict() for b in backends]
```

No live per-backend "limits" lookup (unlike clusters' Kueue query) — storage backends have no
analogous live-queryable quota, so the endpoint is a plain list.

## Phase 3 — `POST /projects` requires and validates `storage_backend_id`

**`backend/routers/projects.py`**:

```python
from backend.models.storage_backend import get_allowed_storage_backends

@router.post("", summary="Create a new project")
async def create_project(
    project: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new project and provision its storage bucket.

    Body: { "name": "My Project", "storage_backend_id": "<id>" }. storage_backend_id is
    required — call GET /utilities/available-storage-backends first to get the allowed set.

    Returns the new project record including its id. Storage setup runs
    asynchronously; the project is immediately usable for submitting jobs.
    """
    storage_backend_id = project.get("storage_backend_id")
    if not storage_backend_id:
        raise HTTPException(status_code=400, detail="storage_backend_id is required")

    allowed = await get_allowed_storage_backends(db, auth.user)
    backend = next((b for b in allowed if b.id == storage_backend_id), None)
    if backend is None:
        raise HTTPException(status_code=400, detail=f"Storage backend {storage_backend_id} is not allowed for this request.")

    project_id = str(uuid.uuid4())
    proj = Project(
        id=project_id,
        name=project.get("name", "Unnamed Project"),
        created_at=datetime.utcnow(),
        storage_status="pending",
        storage_backend_id=backend.id,
    )
    db.add(proj)

    member = ProjectMember(
        project_id=project_id,
        user_id=auth.user.id,
        joined_at=datetime.utcnow()
    )
    db.add(member)
    await db.commit()
    await db.refresh(proj)

    asyncio.create_task(_setup_storage_background(project_id))
    return proj.to_dict()
```

Notes on the diff from today's implementation:
- Drops the `await db.flush()` / post-flush `proj.storage_backend_id = ...` two-step (it existed only
  because the hook needed `proj` as an argument to `select_storage`; the new hook takes only
  `db, user`, so `storage_backend_id` can be set on construction like every other field).
- Drops the `hooks` and `get_default_storage_backend_id` imports (`projects.py:14,19`), adds
  `get_allowed_storage_backends`.
- `HTTPException` is already imported (`projects.py:1`) — no new import needed there.

## Phase 4 — Frontend: storage-backend dropdown in `ProjectModal`

### 4.1 `frontend/src/datamodel/api.js`

```javascript
export async function getAvailableStorageBackends() {
  const response = await apiClient.get('/utilities/available-storage-backends');
  return response.data;
}

export async function createProject(name, storageBackendId) {
  const response = await apiClient.post('/projects', { name, storage_backend_id: storageBackendId });
  return response.data;
}
```

### 4.2 `frontend/src/datamodel/useQueries.js`

Add a query key and hook next to `availableClusters`/`useAvailableClusters`:

```javascript
// in queryKeys:
availableStorageBackends: ['availableStorageBackends'],

// hook:
export function useAvailableStorageBackends() {
  return useQuery({
    queryKey: queryKeys.availableStorageBackends,
    queryFn: getAvailableStorageBackends,
    staleTime: 5 * 60 * 1000, // 5 minutes — unlike cluster limits, nothing here is live/quota-based
  });
}
```

`useCreateProject`'s `mutationFn` becomes `({ name, storageBackendId }) => createProject(name, storageBackendId)`
(currently `mutationFn: createProject` at `useQueries.js:68` — the single-string-arg shape changes to
match `ProjectDropdown.jsx`'s call site update below).

### 4.3 `frontend/src/ProjectModal.jsx`

Add a backend `<Form.Select>`, mirroring `ProcessEditor.jsx`'s cluster select
(`ProcessEditor.jsx:56-91,305-313`):

```jsx
import React, { useState, useEffect } from 'react'; // add useEffect to the existing import
import { useAvailableStorageBackends } from './datamodel/useQueries';

function ProjectModal({ show, onHide, onSubmit }) {
  const [name, setName] = useState('');
  const [storageBackendId, setStorageBackendId] = useState(null);
  const { data: backends = [] } = useAvailableStorageBackends();

  useEffect(() => {
    if (backends.length > 0 && !backends.some(b => b.id === storageBackendId)) {
      setStorageBackendId(backends[0].id);
    }
  }, [backends, storageBackendId]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (name.trim() && storageBackendId) {
      onSubmit(name.trim(), storageBackendId);
      setName('');
    }
  };
  // ... handleHide also resets storageBackendId to null

  // in the form, after the Project Name Form.Group:
  <Form.Group className="mt-3">
    <Form.Label>Storage Backend</Form.Label>
    <Form.Select
      value={storageBackendId || ''}
      onChange={(e) => setStorageBackendId(e.target.value)}
    >
      {backends.map(b => (
        <option key={b.id} value={b.id}>{b.name || b.protocol}</option>
      ))}
    </Form.Select>
  </Form.Group>

  // Create button disabled condition becomes: !name.trim() || !storageBackendId
```

If `backends.length === 1`, the select still renders (with one option) rather than being hidden —
consistent with how the cluster dropdown in `ProcessEditor` behaves, and it keeps the control's
presence/position stable regardless of how many backends exist.

### 4.4 `frontend/src/ProjectDropdown.jsx`

`handleCreateProject` (`ProjectDropdown.jsx:26-34`) changes from `(name) =>
createProjectMutation.mutateAsync(name)` to `(name, storageBackendId) =>
createProjectMutation.mutateAsync({ name, storageBackendId })`, matching the mutation shape from 4.2.

## Implementation Order

1. **Phase 1** — hook + resolver. With zero plugins installed this still resolves to "all active
   backends," so no behavior change yet.
2. **Phase 2** — new endpoint, additive, no behavior change.
3. **Phase 3** — `POST /projects` now requires `storage_backend_id`. This is the phase that actually
   breaks the old `{ name }`-only contract — land it together with Phase 4 so the API and UI change
   atomically (today's only caller is the frontend, so there's no intermediate broken state to manage
   across a deploy boundary beyond the usual frontend/backend redeploy).
4. **Phase 4** — frontend dropdown + updated mutation shape.

## Manual verification

- With no `select_storage_backends` plugin registered and the default single MinIO backend: creating
  a project shows a one-option dropdown pre-filled with that backend, and the created project's
  `storage_backend_id` matches it (same effective behavior as today).
- Add a second `active` `StorageBackend` row (e.g. via the admin panel) with a higher `sort_order`:
  the dropdown lists both, defaults to the lower-`sort_order` one, and picking the other correctly
  sets `Project.storage_backend_id` on creation.
- Set a backend's `active=False`: confirm it disappears from the dropdown and a `POST /projects` with
  its id returns `400`.
- Omit `storage_backend_id` from a raw `POST /projects` call (e.g. via curl): confirm `400
  "storage_backend_id is required"`, not a silent default.
- `GET /utilities/available-storage-backends` returns `403`/`401` unauthenticated (via
  `get_current_user`), consistent with every other authenticated endpoint.

## Open Questions

- **No admin-facing way to scope `select_storage_backends` plugin policy in this repo** — same
  standing gap as `select_clusters`: the hook is real infrastructure, but no plugin (including
  `plugins/billing`) implements it yet. A future billing-plan plugin would register this hook the same
  way `plugins/billing` registers `job_pre_run` today.
- **Hiding the dropdown when there's exactly one backend** was considered and rejected in favor of
  always showing it (see Phase 4.3) for UI stability; revisit if user feedback says otherwise.

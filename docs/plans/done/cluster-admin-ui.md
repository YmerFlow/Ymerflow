# Cluster Admin UI — Plan

## Goal

Give admins a way to create, edit, and retire `Cluster` rows from the Admin page instead of
direct DB access. This was explicitly deferred by both prior cluster plans as "a separate plan" —
see Background below. Scope is CRUD on the `Cluster` table, **plus** a pluggable "how do we
connect to this cluster" mechanism — different cluster types need genuinely different connection
parameters (a pasted kubeconfig vs. a future GKE project/zone/cluster-name + service-account key
are not the same shape), so registering a cluster type must be extensible the same way process
types and storage protocols already are, not one hard-coded form.

It does not touch `select_clusters` hook behavior, job execution, or the `StorageBackend` table (a
parallel admin-UI gap, tracked separately, not in scope here).

## Supersedes / modifies

Nothing landed — this is new surface area. It depends on and does not change the job-execution
behavior landed by [multi-cluster-execution.md](done/multi-cluster-execution.md) and
[multi-cluster-selection.md](done/multi-cluster-selection.md), though it does change the shape of
`Cluster`'s connection columns (Phase 1).

## Background — current state

(Confirmed by reading the implemented code, not just the plans.)

- `backend/models/cluster.py` — `Cluster` has `id, name, kubeconfig, registry_url, registry_auth,
  namespace, created_at, sort_order, active, max_runtime_seconds`. `kubeconfig` is a JSON column
  holding a full parsed kubeconfig dict (or `NULL` for auto-detect); there's no discriminator for
  *how* a cluster's connection is configured, because today there's only ever been one way.
- There is **no route anywhere that lists all `Cluster` rows including inactive ones**, and **no
  route that creates, updates, or retires one**. Clusters exist purely via the bootstrap migration
  (`multi-cluster-execution.md` Phase 1.2, seeds one "Default Cluster" row with `kubeconfig=NULL`)
  or direct DB writes.
- `kubeconfig` is consumed in exactly one place —
  `K8sClientRegistry.get()` (`backend/services/k8s_client.py:399-405`) — which passes
  `cluster.kubeconfig` straight into `K8sClient(kubeconfig=...)`;
  `K8sClient._ensure_initialized()` (`k8s_client.py:55-67`) calls
  `config.load_kube_config_from_dict()` when a dict is given, or auto-detects (in-cluster config,
  then local kubeconfig) when `None`. This is the only call site that needs to change to route
  through a pluggable provider (Phase 2).
- **This codebase already has the exact precedent for "admin-managed resource with a pluggable
  per-type connection mechanism"**: `StorageBackend` (`backend/models/storage_backend.py`) has a
  `protocol` discriminator column (`s3`/`gcs`/`minio`) and an opaque `config` JSON column, and
  `backend/services/storage_protocols/__init__.py` dispatches `protocol` to a
  `StorageProtocolHandler` class via a `storage_protocol_handlers` fan-out hook
  (`nagelfluh.hooks` entry-point group, registered in `setup.py`). Crucially, **core registers its
  own built-in handlers (minio/gcs/s3) through the identical hook channel a plugin would use** —
  "core has no special precedence over plugins" is stated explicitly in that file's docstring.
  This plan gives `Cluster` the same treatment.
- The frontend has the matching precedent for type-dispatched **components**, not just backend
  classes: `frontend/src/App.jsx` self-registers core's built-in dataset types and widgets through
  the same generic hook mechanism plugins use —
  `registerHook('dataset_types', () => [{ mimeType, cls }, ...])` and
  `registerHook('widgets', () => [{ name, component }, ...])` (`App.jsx:49-68`). This plan adds a
  third: `registerHook('cluster_provider_forms', () => [{ type, title, Component }, ...])`.
- `frontend/src/AdminPage.jsx` renders one built-in tab (`users`) plus tabs contributed via the
  `admin_tabs` hook, through the shared `TabbedPage` component
  (`frontend/src/TabbedPage.jsx`, established by
  [admin-page-and-url-routed-tabs.md](done/admin-page-and-url-routed-tabs.md)). Adding a
  `Clusters` tab is one more entry in `builtinTabs` — no new page/routing infrastructure needed.
- `backend/routers/auth.py:362-366` defines `require_admin` (checks `auth.user.is_admin`, raises
  403) and uses it for the two existing `/admin/users` routes. It is private to `auth.py` today —
  no other router imports it.
- Precedent for the admin list/mutate pair already exists: `GET /admin/users`
  (`admin_list_users`) and `PUT /admin/users/{username}/admin` (`admin_set_user_admin`)
  (`auth.py:368-404`), consumed by `useAdminUsers`/`useSetUserAdmin` in
  `frontend/src/datamodel/useAuthQueries.js`. The new cluster admin endpoints and hooks follow the
  same shape.
- `frontend/src/jsoneditor/DatasetSelector.jsx` establishes the controlled-component contract used
  throughout this codebase for custom form fields: `{ value, onChange, ... }`. The new
  per-cluster-type form components (Phase 4) use the same contract.

## Design decisions (settled in discussion)

- **Cluster types shipped in this plan: `same-as-backend` and `kubeconfig` only.** These cover
  everything the app supports today (the bootstrap default, and any cluster reachable via a pasted
  kubeconfig, which includes real managed clusters like GKE/EKS if the admin generates a kubeconfig
  for them out-of-band with `gcloud`/`aws` CLI). `same-as-backend` means exactly what its name
  says — not a mysterious "figure it out" mode, but specifically "run jobs on the very cluster the
  backend process itself is running in" (or, in local dev, whatever cluster the backend's local
  kubeconfig points to). Mechanically it's implemented by passing no kubeconfig at all and letting
  `K8sClient` fall back to its existing in-cluster/local-kubeconfig detection (see Background) —
  but the *type name* describes the admin-facing meaning, not the implementation mechanism, so
  it isn't confused for some kind of automatic multi-cluster discovery. A dedicated `gke`/`eks`/`aks`
  provider with
  cloud-native credential entry (service-account key, IAM role, etc.) is explicitly **out of
  scope** — future work, added later as its own provider registration exactly like a new
  `StorageProtocolHandler` would be, with no changes needed to the registry/dispatch mechanism this
  plan builds.
- **Per-type connection form: bespoke React component, not a generic JSON-schema form.** Unlike
  process-type parameters (rendered generically via `frontend/src/jsoneditor/`), cluster connection
  UX benefits from type-specific behavior a generic schema renderer can't express well (e.g. a
  kubeconfig textarea with paste-and-validate feedback; a future GKE provider might want a
  "sign in with Google" flow, a project picker populated from an API call, etc.) — a generic form
  wouldn't extend to that without escape hatches. This does mean a provider that only needs plain
  fields still writes a small React component, which is more code than a JSON-schema declaration —
  accepted as the right trade for UX headroom.
- **Connection is tested before saving.** Every provider implements a `test_connection()` that
  attempts a real, timeout-bounded connection and raises a clear error on failure. Both the
  "Test Connection" button (client-triggered, for fast feedback while filling the form) and the
  `POST`/`PATCH` admin routes themselves (server-side, authoritative) run it — the server never
  trusts the client to have tested. This replaces the previous "no connectivity check" stance,
  which is no longer appropriate now that connection setup is genuinely more error-prone across
  types.
- **Schema mirrors `StorageBackend`**: `Cluster` gets a `cluster_type` discriminator column
  (parallel to `StorageBackend.protocol`) and an opaque `provider_config` JSON column (parallel to
  `StorageBackend.config`), replacing the flat `kubeconfig` column. `registry_url`/`registry_auth`
  stay as plain generic columns, independent of `cluster_type` — which container registry a
  cluster's jobs pull images from is an orthogonal concern from how the k8s API is reached, and
  every type needs it, so it isn't provider-scoped.
  - `cluster_type='kubeconfig'` → `provider_config = {"kubeconfig": {...parsed dict...}}`.
  - `cluster_type='same-as-backend'` → `provider_config = {}`.
- **Secrets never round-trip to the browser.** List/get responses omit `provider_config`,
  `registry_auth` entirely, replaced with booleans (`has_provider_config`, `has_registry_auth`).
  Every per-type form component's initial value is empty/default on edit (write-only), with a
  "(currently set)" hint driven by `has_provider_config`. **Switching `cluster_type` on an edit
  always requires re-entering connection config from scratch for the new type** — there is no
  cross-type config carryover (switching from `kubeconfig` to a hypothetical future `gke` doesn't
  try to reuse the old kubeconfig blob).
  - Mechanically: the frontend only includes `cluster_type`+`provider_config` in the PATCH body if
    the admin actually interacted with the type form (tracked via a `configTouched` flag set by
    the form component's `onChange`, not just "is the field non-empty" — an admin re-opening the
    same type shouldn't accidentally wipe/retest an unrelated field edit). Leaving the type form
    untouched during an edit (e.g. an admin only changing `sort_order`) omits both keys, and the
    backend leaves the stored connection untouched **and skips re-running `test_connection`** —
    editing unrelated fields must not fail because the cluster is momentarily unreachable.
- **Retiring, not deleting**: no DELETE route, same as before. "Retire" = `PATCH` with
  `{"active": false}`. Retired clusters stay listed (visually distinguished) in the admin table so
  they can be reactivated; historical `ProcessVersion.k8s_cluster_id` references stay intact.
- **New admin router, not folded into `utilities.py` or `auth.py`**: `backend/routers/admin.py`,
  registered in `main.py`, **not** added to the MCP `include_tags` allowlist — cluster
  administration (kubeconfig entry, connection testing) is deliberately UI-only, same as
  `/admin/users` today.
- **`require_admin` extraction**: moved out of `auth.py` into a small shared
  `backend/auth_deps.py` so both `auth.py` and the new `admin.py` import it from one place, instead
  of one router importing a dependency out of another router module.

---

## Phase 1 — `Cluster` schema: `cluster_type` + `provider_config`

### 1.1 Model changes

**`backend/models/cluster.py`**:

```python
cluster_type = Column(String(32), nullable=False, default="kubeconfig")
provider_config = Column(JSON, nullable=False, default=dict)
# kubeconfig column removed — superseded by provider_config.
```

`to_dict()` drops any `kubeconfig` reference (it never included it) and stays otherwise the same;
the admin-only dict (Phase 3) is what adds `cluster_type`/`has_provider_config`.

### 1.2 Migration

One migration, off the current head:

1. `batch_alter_table('clusters')`: add `cluster_type` (`server_default='kubeconfig'`), add
   `provider_config` (`server_default='{}'`).
2. Data pass, using a reflected `sa.Table`/lightweight `sa.table()` construct (not raw string
   interpolation) so the JSON column's bind/result processing is handled correctly on both SQLite
   and Postgres: for every row, if the old `kubeconfig` value is `NULL`, set
   `cluster_type='same-as-backend'`, `provider_config={}`; otherwise set `cluster_type='kubeconfig'`,
   `provider_config={"kubeconfig": <old value>}`.
3. `batch_alter_table('clusters')`: drop `kubeconfig`.

The existing "Default Cluster" bootstrap row (`kubeconfig=NULL`) becomes
`cluster_type='same-as-backend', provider_config={}` — behaviorally identical to today, verified by
Phase 2's provider implementation returning `None` for `same-as-backend`, exactly what
`K8sClient(kubeconfig=None)` already auto-detects on.

---

## Phase 2 — Backend: pluggable cluster connection providers

### 2.1 Provider base class + registry

New `backend/services/cluster_providers/__init__.py`, mirroring
`backend/services/storage_protocols/__init__.py` structurally:

```python
import asyncio
from backend.hooks import hooks


class ClusterProvider:
    def connect(self, provider_config: dict):
        """Return a kubeconfig dict for K8sClient, or None to auto-detect."""
        raise NotImplementedError

    async def test_connection(self, provider_config: dict) -> None:
        """Raise a clear exception if this config can't actually reach a cluster.
        Default: resolve a kubeconfig via connect(), then a cheap, timeout-bounded
        list-namespaces call. Override for providers that can validate more cheaply/
        differently (e.g. before even attempting a network call)."""
        from backend.services.k8s_client import K8sClient
        client = K8sClient(namespace="default", kubeconfig=self.connect(provider_config))
        await client._ensure_initialized()
        await asyncio.wait_for(
            client.core_api.list_namespace(limit=1, _request_timeout=10), timeout=15
        )


def cluster_provider_handlers():
    from backend.services.cluster_providers.same_as_backend import SameAsBackendClusterProvider
    from backend.services.cluster_providers.kubeconfig import KubeconfigClusterProvider
    return [
        ("same-as-backend", SameAsBackendClusterProvider),
        ("kubeconfig", KubeconfigClusterProvider),
    ]


_registry = None

def get_cluster_provider(cluster_type: str) -> ClusterProvider:
    global _registry
    if _registry is None:
        registry = {}
        for name, cls in hooks.run.cluster_provider_handlers():
            if name in registry:
                raise ValueError(f"duplicate cluster_provider_handlers registration for {name!r}")
            registry[name] = cls
        _registry = registry
    if cluster_type not in _registry:
        raise ValueError(f"unknown cluster_type {cluster_type!r}")
    return _registry[cluster_type]()
```

`backend/services/cluster_providers/same_as_backend.py`:

```python
from backend.services.cluster_providers import ClusterProvider

class SameAsBackendClusterProvider(ClusterProvider):
    def connect(self, provider_config):
        return None
```

`backend/services/cluster_providers/kubeconfig.py`:

```python
from backend.services.cluster_providers import ClusterProvider

class KubeconfigClusterProvider(ClusterProvider):
    def connect(self, provider_config):
        return provider_config["kubeconfig"]
```

`setup.py`: add to the `nagelfluh.hooks` entry-point group, alongside
`storage_protocol_handlers`:

```python
'cluster_provider_handlers = backend.services.cluster_providers:cluster_provider_handlers',
```

### 2.2 `K8sClientRegistry` routes through the provider

**`backend/services/k8s_client.py:399-405`**, `K8sClientRegistry.get()` changes from reading
`cluster.kubeconfig` directly to:

```python
from backend.services.cluster_providers import get_cluster_provider
...
    def get(self, cluster) -> K8sClient:
        if cluster.id not in self._clients:
            provider = get_cluster_provider(cluster.cluster_type)
            self._clients[cluster.id] = K8sClient(
                namespace=cluster.namespace,
                kubeconfig=provider.connect(cluster.provider_config),
            )
        return self._clients[cluster.id]
```

This is the only production call site that needed to change — confirmed by the Background grep
for `.kubeconfig` usage.

---

## Phase 3 — Backend: admin routes

### 3.1 Extract `require_admin`

New `backend/auth_deps.py`:

```python
from fastapi import Depends, HTTPException
from backend.services.auth_service import get_current_user, AuthContext

async def require_admin(auth: AuthContext = Depends(get_current_user)) -> AuthContext:
    if not auth.user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return auth
```

`backend/routers/auth.py` deletes its local definition, imports from `backend.auth_deps` instead;
its two `/admin/users` routes are otherwise unchanged.

### 3.2 `backend/routers/admin.py` (new)

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Dict

from backend.database import get_db
from backend.auth_deps import require_admin
from backend.models.cluster import Cluster
from backend.services.cluster_providers import get_cluster_provider

router = APIRouter(tags=["Admin"])


def _cluster_admin_dict(cluster: Cluster) -> Dict:
    d = cluster.to_dict()
    d["cluster_type"] = cluster.cluster_type
    d["has_provider_config"] = bool(cluster.provider_config)
    d["has_registry_auth"] = bool(cluster.registry_auth)
    return d


async def _test_and_apply_connection(cluster: Cluster, body: Dict) -> None:
    """Only touches cluster_type/provider_config if the caller actually sent them,
    and only re-tests the connection in that case (see Design decisions)."""
    if "cluster_type" in body or "provider_config" in body:
        cluster_type = body.get("cluster_type", cluster.cluster_type)
        provider_config = body.get("provider_config", {})
        provider = get_cluster_provider(cluster_type)
        try:
            await provider.test_connection(provider_config)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
        cluster.cluster_type = cluster_type
        cluster.provider_config = provider_config


@router.get("/admin/clusters")
async def admin_list_clusters(auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Cluster).order_by(Cluster.sort_order))
    return [_cluster_admin_dict(c) for c in result.scalars().all()]


@router.post("/admin/clusters")
async def admin_create_cluster(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if not body.get("name", "").strip():
        raise HTTPException(status_code=400, detail="name is required")
    cluster = Cluster(name=body["name"].strip(), namespace=body.get("namespace") or "nagelfluh-jobs")
    await _test_and_apply_connection(cluster, body)
    _apply_generic_fields(cluster, body)
    db.add(cluster)
    await db.commit()
    return _cluster_admin_dict(cluster)


@router.patch("/admin/clusters/{cluster_id}")
async def admin_update_cluster(cluster_id: str, body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    cluster = await db.get(Cluster, cluster_id)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    await _test_and_apply_connection(cluster, body)
    _apply_generic_fields(cluster, body)
    await db.commit()
    return _cluster_admin_dict(cluster)


@router.post("/admin/clusters/test-connection")
async def admin_test_cluster_connection(body: Dict, auth=Depends(require_admin)):
    """Stateless test for the 'Test Connection' button — no cluster row required, so it
    works while filling out the create form before anything is saved."""
    provider = get_cluster_provider(body.get("cluster_type"))
    try:
        await provider.test_connection(body.get("provider_config") or {})
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
    return {"ok": True}
```

`_apply_generic_fields(cluster, body)` — only touches a column if its key is present in `body`:
`name`, `namespace`, `registry_url` (strings), `sort_order` (int), `active` (bool),
`max_runtime_seconds` (`None` or positive int, else 400), `registry_auth` (non-empty string only —
same write-only-if-provided rule as before; there's no product need to explicitly clear it, same
reasoning as the original draft).

### 3.3 Register router

`backend/main.py`: `from backend.routers.admin import router as admin_router`;
`app.include_router(admin_router)`; not added to MCP `include_tags`.

---

## Phase 4 — Frontend: pluggable per-type connection forms

### 4.1 Form components

New `frontend/src/clusterProviders/SameAsBackendClusterForm.jsx`:

```jsx
export default function SameAsBackendClusterForm({ value, onChange }) {
  return <p className="text-muted">No configuration needed — jobs run on the same cluster the backend itself is running in (or, in local dev, whatever cluster your local kubeconfig points to).</p>;
}
```

New `frontend/src/clusterProviders/KubeconfigClusterForm.jsx`:

```jsx
export default function KubeconfigClusterForm({ value, onChange, hasExisting }) {
  return (
    <Form.Group>
      <Form.Label>Kubeconfig (YAML or JSON)</Form.Label>
      <Form.Control
        as="textarea" rows={8}
        placeholder={hasExisting ? '(unchanged — paste to replace)' : 'apiVersion: v1\nclusters:\n...'}
        value={value.kubeconfigText || ''}
        onChange={e => onChange({ kubeconfigText: e.target.value })}
      />
    </Form.Group>
  );
}
```

`kubeconfigText` stays a raw string in frontend state; parsing YAML/JSON into the dict
`provider_config.kubeconfig` needs to happen somewhere — client-side (needs a `js-yaml` dependency,
ask for approval per CLAUDE.md rule 4) or server-side (submit the raw string, let
`KubeconfigClusterProvider` parse it with `PyYAML`). **Decision: server-side parsing**, to avoid an
extra frontend dependency for a low-frequency admin action and to have one source of truth for
"is this valid" (the same code path `test_connection` exercises). `KubeconfigClusterProvider`
becomes:

```python
import yaml

class KubeconfigClusterProvider(ClusterProvider):
    def connect(self, provider_config):
        return provider_config["kubeconfig"]

    async def test_connection(self, provider_config):
        raw = provider_config.get("kubeconfig")
        if isinstance(raw, str):
            try:
                parsed = yaml.safe_load(raw)
            except yaml.YAMLError as e:
                raise ValueError(f"invalid kubeconfig YAML/JSON: {e}")
            if not isinstance(parsed, dict):
                raise ValueError("kubeconfig must be a YAML/JSON mapping")
            provider_config["kubeconfig"] = parsed
        await super().test_connection(provider_config)
```

So the frontend always submits `provider_config = {"kubeconfig": <raw text>}`; the provider
normalizes it to a parsed dict the first time `test_connection` (always called by both the button
and create/update routes) runs, and that's what ends up persisted. Add `PyYAML` explicitly to
`setup.py`'s `install_requires` (ask for approval — already present transitively via
`kubernetes-asyncio`, so `pip install -e .` should be a no-op).

### 4.2 Registration

**`frontend/src/App.jsx`**, alongside the existing `dataset_types`/`widgets` registration:

```javascript
import SameAsBackendClusterForm from './clusterProviders/SameAsBackendClusterForm';
import KubeconfigClusterForm from './clusterProviders/KubeconfigClusterForm';

registerHook('cluster_provider_forms', () => [
  { type: 'same-as-backend', title: 'Same cluster as backend', Component: SameAsBackendClusterForm },
  { type: 'kubeconfig',      title: 'Kubeconfig',               Component: KubeconfigClusterForm },
]);
```

A future GKE provider (separate plan) would add its own `GkeClusterForm` here, plus its own
`GkeClusterProvider` in `setup.py` — no changes to the registry/dispatch mechanism itself.

---

## Phase 5 — Frontend: data hooks

**`frontend/src/datamodel/api.js`** (follow the existing `listAdminUsers`/`setUserAdmin` pattern
exactly): `listAdminClusters()`, `createAdminCluster(body)`, `updateAdminCluster(id, body)`,
`testAdminClusterConnection(body)`.

**`frontend/src/datamodel/useAuthQueries.js`** (or a new `useAdminQueries.js` — decide during
implementation based on how auth-specific that file already reads):

```javascript
export function useAdminClusters() {
  return useQuery({ queryKey: ['adminClusters'], queryFn: listAdminClusters });
}
export function useCreateAdminCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminCluster,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminClusters'] }),
  });
}
export function useUpdateAdminCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, body }) => updateAdminCluster(clusterId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminClusters'] }),
  });
}
export function useTestAdminClusterConnection() {
  return useMutation({ mutationFn: testAdminClusterConnection });
}
```

Per CLAUDE.md, this is plain TanStack Query for an **admin-only** resource — cluster rows have
nothing to do with process/dataset caching, so the `ProcessContext`/`invalidateProject` rule (which
governs process/dataset data specifically) doesn't apply; invalidating the local `adminClusters`
query key is sufficient.

---

## Phase 6 — Frontend: `Clusters` admin tab

New `frontend/src/ClustersAdminPanel.jsx` (mirrors `UsersAdminPanel`'s shape):

- Table of all clusters (including inactive, visually distinguished), columns: Name, Type,
  Namespace, Registry URL, Sort Order, Max Runtime, Active, Edit button.
- "Add Cluster" / edit form (modal, matching whatever pattern `ProcessEditor`'s resource-request
  modal uses for consistency): generic fields (Name, Namespace, Registry URL, Registry Auth,
  Sort Order, Max Runtime Seconds + "unbounded" checkbox, Active — the last only on edit) plus a
  **Cluster Type** `<select>` populated from `hooks.run.cluster_provider_forms()`. Selecting a type
  renders that entry's `Component` with `{ value: providerConfigState, onChange, hasExisting:
  has_provider_config }`; switching the type resets `providerConfigState` to `{}` (no cross-type
  carryover, per Design decisions).
- **Test Connection** button next to the type form, calling `useTestAdminClusterConnection` with
  the current `{ cluster_type, provider_config }` — shows a spinner then a clear pass/fail message.
  Not a precondition for Save (Save re-tests authoritatively server-side regardless, per Design
  decisions), just faster feedback.
- Submit calls `useCreateAdminCluster`/`useUpdateAdminCluster`. The body only includes
  `cluster_type`/`provider_config` if the type form was actually touched this session (a
  `configTouched` boolean flipped by the form's `onChange`, initialized `false` on every open of
  the edit modal) — this is what makes "leave the connection alone while editing sort_order" work,
  and what avoids re-running `test_connection` for unrelated edits.

**`frontend/src/AdminPage.jsx`**: add a second `builtinTabs` entry:

```javascript
{ key: 'clusters', title: 'Clusters', render: () => <ClustersAdminPanel /> },
```

No changes needed to `TabbedPage.jsx`.

---

## Implementation Order

1. **Phase 1** — schema migration (`cluster_type`/`provider_config`, drop `kubeconfig`). Verify the
   bootstrap default cluster still resolves to same-as-backend behavior after migrating.
2. **Phase 2** — provider registry + `K8sClientRegistry` update. No behavior change yet (still one
   `same-as-backend` cluster, resolving exactly as `kubeconfig=None` did before).
3. **Phase 3** — backend admin routes. Verify via `/docs`/`curl` with an admin session before any
   frontend work.
4. **Phase 3.4 (dependency)** — add `PyYAML` to `setup.py` (separate step, needs explicit approval
   before `pip install -e .`).
5. **Phase 4** — frontend provider-form registration, no admin UI consuming it yet.
6. **Phase 5** — frontend query/mutation hooks.
7. **Phase 6** — `ClustersAdminPanel` + `AdminPage.jsx` wiring. Test end-to-end: register a second
   cluster via `kubeconfig` (a real or dummy one — dummy should fail Test Connection with a clear
   error, not hang, per CLAUDE.md's timeout guidance), confirm it appears in the `ProcessEditor`
   cluster dropdown (`useAvailableClusters`) once active and passes the connection test, confirm
   retiring it removes it from that dropdown without breaking the admin table view.

## Open Questions

- **Re-test button on an already-saved, untouched cluster row** (not just inside the edit form) —
  useful for periodically checking a retired-or-flaky cluster is reachable again. Not included in
  Phase 6 above; easy add-on (`test-connection` route already accepts a standalone
  `{cluster_type, provider_config}` body) if wanted.
- **`StorageBackend` has the identical admin-UI gap**, and now also the identical
  "different protocols need different setup UX" shape this plan solves for clusters. Worth a
  follow-up plan reusing the same `provider_config`/registered-form pattern once this lands.
- **GKE provider** (and EKS/AKS) — explicitly deferred (see Design decisions). When it happens, it
  will need to decide its own connection-parameter shape (project id, zone, cluster name,
  service-account key at minimum) and whether `registry_url`/`registry_auth` should get an optional
  "derive from this provider" convenience (e.g. auto-fill GCR/Artifact Registry) — out of scope
  here, noted for whoever picks that up.

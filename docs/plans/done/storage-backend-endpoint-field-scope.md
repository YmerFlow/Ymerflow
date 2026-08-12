# Storage Backend dialog: move `endpoint` out of the core model into MinIO's config

## Goal

Fix a styling/UX bug in Admin > Storage's "Edit/Add Storage Backend" dialog
(`StorageBackendFormModal` in `frontend/src/StorageBackendsAdminPanel.jsx`): the **Endpoint**
field is currently rendered unconditionally, above the protocol selector, for every protocol
(MinIO, GCS, S3). It's only meaningful for MinIO — the model column comment says so explicitly:

```python
endpoint = Column(String(255), nullable=True)  # MinIO URL; empty for real cloud
```

`endpoint` is a MinIO concept, not a generic storage-backend concept — real cloud protocols
(S3, GCS) don't have a customer-facing "endpoint URL," they talk to a fixed provider API.
Confirmed with the user: the fix is not to keep `endpoint` as a shared/core column and merely
change *where* it's rendered — it should stop being a core `StorageBackend` column at all, and
become a MinIO-protocol-owned `config` field, exactly like `admin_access_key`/`admin_secret_key`
already are.

## Not in scope: `bucket_prefix`

`bucket_prefix` (`nullable=False` at the DB level, mandatory for every backend regardless of
protocol) stays as a core column, rendered unconditionally in the parent dialog. Unlike `endpoint`,
it isn't MinIO-specific — the `S3ProtocolHandler`/`GcsProtocolHandler` stub docstrings
(`backend/services/storage_protocols/s3.py`, `gcs.py`) both describe their future `provision()` as
creating "... + a bucket," implying bucket naming is a concern every protocol will need once
implemented, not just MinIO. Confirmed with the user in an earlier round of this discussion.

## Rejected alternative (earlier draft of this plan)

An earlier version of this plan kept `endpoint` as a core `StorageBackend` column and only moved
*rendering* into `MinioStorageForm.jsx` via two new threaded props (`endpoint`/`onEndpointChange`)
alongside the existing `value`/`onChange` for `config`. The user rejected this: `endpoint` being a
MinIO concept means it belongs in MinIO's own `config`, not in the shared model with a special-case
prop pair bolted onto the generic `storage_protocol_forms` contract. This revision does that
instead — a real (if small) schema change, not just a frontend re-render.

## Background — current state (confirmed by reading the code)

- `backend/models/storage_backend.py`: `StorageBackend.endpoint` is a top-level nullable column.
  `to_dict()` includes it unconditionally (`"endpoint": self.endpoint`).
- `plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`: `MinioProtocolHandler.provision()` and
  `.test_connection()` both read `backend.endpoint` directly (not from `backend.config`).
- `backend/services/storage_protocols/__init__.py`: `StorageProtocolHandler` base class has no
  notion of "which config keys are secret" today — masking (below) currently treats the entire
  `config` dict as 100% secret, uniformly, for every protocol.
- `backend/services/secret_masking.py` (`mask_config`/`resolve_config`, from
  `docs/plans/done/storage-cluster-secret-masking.md`): `mask_config(config)` masks **every** key
  in `config` as `"****"` before it's sent to the browser (GET/list responses), because `config` is
  documented as "opaque, assume all-credential" connection material. `resolve_config` restores a
  submitted `"****"` value from the stored row, per key, on Save/Test Connection.
- `backend/routers/admin.py`, the storage-backend admin surface (all confirmed verbatim):
  - `_storage_backend_admin_dict` (137-140): `d["config"] = mask_config(backend.config)` — masks
    unconditionally, no per-protocol awareness.
  - `_apply_storage_generic_fields` (165-194): sets `backend.endpoint = body.get("endpoint") or None`
    (175-176) whenever `"endpoint"` is present in the request body, alongside `name`/`bucket_prefix`/
    `credential_strategy`/`sort_order`/`active`. Its docstring explicitly notes it "must run before
    `_test_and_apply_storage_connection`, since test_connection needs the (possibly just-updated)
    endpoint" — that ordering dependency goes away once endpoint lives in `config`, which
    `_test_and_apply_storage_connection` already owns.
  - `_test_and_apply_storage_connection` (143-161): builds `_TestBackend(backend.endpoint, config)`
    to call `handler.test_connection(...)`.
  - `_TestBackend` (129-134): a `@dataclass` with `.endpoint` and `.config` fields — "a consistent
    `.endpoint`/`.config` shape... whether called against a real ORM row... or a not-yet-created
    one," used by both the PATCH path and the stateless test-connection route.
  - `admin_test_storage_backend_connection` (232-255, stateless `/admin/storage-backends/test-connection`
    route): reads `body.get("endpoint")` directly and passes it into `_TestBackend(...)`.
  - `admin_create_storage_backend` (203-218) / `admin_update_storage_backend` (221-229): both call
    `_apply_storage_generic_fields` then `_test_and_apply_storage_connection`, in that order — no
    other endpoint-specific logic.
  - `admin_list_storage_backends` (197-200): `return [_storage_backend_admin_dict(b) for b in ...]`
    — the admin table's data source is the same masked-dict shape as create/update responses, so
    whatever `_storage_backend_admin_dict` returns for `config` is what the table can render.
- `frontend/src/StorageBackendsAdminPanel.jsx`: `form.endpoint` submitted unconditionally in
  `handleSubmit`'s `body` (`endpoint: form.endpoint || null`) and in `handleTest`'s test-connection
  POST body, regardless of protocol. Admin list table renders `<td>{b.endpoint || '—'}</td>`
  (confirmed this is the only place `b.endpoint` is read in the frontend, besides the form).
- No plugin registers `storage_protocol_forms` or `storage_protocol_handlers` today (confirmed by
  full-repo grep) — this is a self-contained change to core, with no plugin migration required.

## Design decisions (settled in discussion)

- **`endpoint` moves entirely into MinIO's `config` JSON blob** (`config["endpoint"]`), the same
  tier as `admin_access_key`/`admin_secret_key`. It stops being a `StorageBackend` column. This
  also means the `storage_protocol_forms` component contract does **not** need to change —
  `MinioStorageForm` just gains one more `Form.Group` bound to `value.endpoint`/`onChange`, exactly
  like its existing two fields. `GcsStorageForm`/`S3StorageForm` are untouched.
- **`config` masking becomes per-key aware.** `endpoint` is not secret (it's a URL the admin table
  already displays in plaintext today) — masking it along with the real credentials would be a UX
  regression (every edit would show "****" and require re-typing the real endpoint to change
  anything else, and the list table could no longer show it at a glance). `StorageProtocolHandler`
  gains a `SECRET_CONFIG_KEYS` class attribute: `None` (default, for any handler — including
  third-party plugins — that hasn't opted in) means "mask every key," preserving today's
  conservative behavior for `GcsStorageForm`/`S3StorageForm`'s opaque `raw` blob and any future
  protocol that doesn't declare otherwise. `MinioProtocolHandler` sets
  `SECRET_CONFIG_KEYS = frozenset({"admin_access_key", "admin_secret_key"})`, so `endpoint` (an
  unlisted key) passes through in plaintext. `resolve_config` needs no change: it already only acts
  on keys whose *submitted* value equals the `"****"` sentinel, and non-secret keys are never
  masked in the first place, so the client always submits their real edited value for them.
- **Migration: backfill existing `endpoint` values into `config["endpoint"]`, then drop the
  column**, rather than leaving it deprecated-in-place. Matches the two most recent related
  migrations exactly: `182d880e84c7_backfill_default_storage_backend_config.py` (data backfill
  into the `config` JSON column via raw SQL) and `604260b878e3_drop_cluster_registry_columns.py`
  (column drop via `batch_alter_table`, with a reversible `downgrade()`). This one combines both
  patterns in a single migration, with a downgrade that moves the data back out (unlike
  `182d880e84c7`'s `downgrade(): pass`, since here the round trip is lossless).

## Phase 1 — Backend: per-key-aware secret masking

### 1.1 `backend/services/storage_protocols/__init__.py`

Add a class attribute to `StorageProtocolHandler`:

```python
class StorageProtocolHandler:
    """..."""

    # Names of `config` keys that hold credential/secret material and must be masked as "****" in
    # admin API responses. None (the default) means "mask every key" — the conservative default
    # for any handler, including third-party plugins, that hasn't explicitly opted a key out.
    SECRET_CONFIG_KEYS = None

    def provision(self, project, backend) -> dict:
        ...
```

### 1.2 `backend/services/secret_masking.py`

```python
def mask_config(config, secret_keys=None):
    """secret_keys=None masks every key (default, conservative). A protocol handler that declares
    SECRET_CONFIG_KEYS restricts masking to just those keys — other keys (e.g. MinIO's endpoint)
    pass through in plaintext."""
    config = config or {}
    if secret_keys is None:
        return {k: MASKED for k in config}
    return {k: (MASKED if k in secret_keys else v) for k, v in config.items()}
```

`resolve_config`/`resolve_secret` are unchanged — see Design decisions above.

## Phase 2 — Backend: MinIO handler owns `endpoint`

### 2.1 `plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`

```python
class MinioProtocolHandler(StorageProtocolHandler):
    SECRET_CONFIG_KEYS = frozenset({"admin_access_key", "admin_secret_key"})

    def provision(self, project, backend) -> dict:
        return setup_project_storage(
            project.id, backend.config["endpoint"], backend.bucket_prefix,
            backend.config["admin_access_key"], backend.config["admin_secret_key"],
        )

    def mint(self, project, backend) -> dict:
        raise NotImplementedError(...)  # unchanged

    async def test_connection(self, backend) -> None:
        client = get_minio_client_for_backend(
            backend.config["endpoint"], backend.config["admin_access_key"],
            backend.config["admin_secret_key"],
        )
        await asyncio.to_thread(lambda: list(client.list_buckets()))
```

Also update the module docstring (currently says "`provision()`/`test_connection()` are genuinely
per-backend-parametrized: they read `backend.endpoint`/`backend.bucket_prefix`/`backend.config`")
to say `backend.bucket_prefix`/`backend.config` (endpoint is now part of `config`).

## Phase 3 — Migration

New Alembic revision (generate the id per CLAUDE.md rule 9 — `alembic revision -m "..."` or
`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`, verified unique via
`grep -rn "revision = '<id>'" --include=*.py .`; `down_revision` must chain from whatever
`alembic heads` reports as current at implementation time, not necessarily `604260b878e3` — other
migrations may land first):

```python
"""move storage_backends.endpoint into config['endpoint'] (minio-only concept)

Revision ID: <generate>
Revises: <current head at implementation time>
Create Date: <implementation date>
"""
from alembic import op
import sqlalchemy as sa
import json


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, endpoint, config FROM storage_backends")).fetchall()
    for row in rows:
        if not row.endpoint:
            continue
        config = row.config if isinstance(row.config, dict) else json.loads(row.config or "{}")
        config["endpoint"] = row.endpoint
        conn.execute(
            sa.text("UPDATE storage_backends SET config = :config WHERE id = :id"),
            {"id": row.id, "config": json.dumps(config)},
        )
    with op.batch_alter_table("storage_backends") as batch_op:
        batch_op.drop_column("endpoint")


def downgrade() -> None:
    with op.batch_alter_table("storage_backends") as batch_op:
        batch_op.add_column(sa.Column("endpoint", sa.String(255), nullable=True))
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, config FROM storage_backends")).fetchall()
    for row in rows:
        config = row.config if isinstance(row.config, dict) else json.loads(row.config or "{}")
        endpoint = config.pop("endpoint", None)
        if endpoint is None:
            continue
        conn.execute(
            sa.text("UPDATE storage_backends SET endpoint = :endpoint, config = :config WHERE id = :id"),
            {"id": row.id, "endpoint": endpoint, "config": json.dumps(config)},
        )
```

The `isinstance(row.config, dict)` guard handles both possible raw-driver representations of the
JSON column (already-deserialized dict vs. raw text) — verify against whichever DB backend is
actually in use (dev: check `backend/config.py`/`alembic.ini` connection string) when implementing;
`182d880e84c7` treated `config` as a JSON string via `json.dumps`/literal `'{}'` comparison, so this
should hold, but confirm before relying on it.

### 3.1 `backend/models/storage_backend.py`

Remove the `endpoint` column and its `to_dict()` entry:

```python
class StorageBackend(Base):
    __tablename__ = "storage_backends"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    protocol = Column(String(32), nullable=False)          # s3, gcs, az, file
    bucket_prefix = Column(String(255), nullable=False)
    credential_strategy = Column(String(32), nullable=False, default="static-key")
    config = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "protocol": self.protocol,
            "bucket_prefix": self.bucket_prefix,
            "credential_strategy": self.credential_strategy,
            "created_at": self.created_at.isoformat(),
            "sort_order": self.sort_order,
            "active": self.active,
        }
```

## Phase 4 — Backend: admin router cleanup (`backend/routers/admin.py`)

- **`_storage_backend_admin_dict`** (137-140): pass the protocol's secret keys through —
  ```python
  def _storage_backend_admin_dict(backend: StorageBackend) -> Dict:
      d = backend.to_dict()
      handler = get_protocol_handler(backend.protocol)
      d["config"] = mask_config(backend.config, secret_keys=handler.SECRET_CONFIG_KEYS)
      return d
  ```
- **`_apply_storage_generic_fields`** (165-194): delete the `if "endpoint" in body: backend.endpoint
  = body.get("endpoint") or None` block (175-176) entirely, and drop the now-stale part of its
  docstring about needing to run before `_test_and_apply_storage_connection` "since test_connection
  needs the (possibly just-updated) endpoint" — endpoint is now inside `config`, which
  `_test_and_apply_storage_connection` already owns end-to-end; the two functions no longer have
  an endpoint-related ordering dependency (any remaining ordering reasons, if none, should be
  re-examined — confirm at implementation time whether the docstring's ordering justification can
  be removed outright or needs different wording for a different reason).
- **`_TestBackend`** (129-134): drop the `.endpoint` field — only `.config` remains:
  ```python
  @dataclass
  class _TestBackend:
      """Consistent .config shape for test_connection(backend), whether called against a real ORM
      row (update path) or a not-yet-created one (create/standalone-test-button path)."""
      config: Dict
  ```
- **`_test_and_apply_storage_connection`** (143-161): drop `backend.endpoint` from the
  `_TestBackend(...)` call: `await handler.test_connection(_TestBackend(config))`.
- **`admin_test_storage_backend_connection`** (232-255): drop `body.get("endpoint")` from the
  `_TestBackend(...)` call: `await handler.test_connection(_TestBackend(config))`. `protocol`/
  `backend_id`/`config` handling is otherwise unchanged.
- **`admin_create_storage_backend`** / **`admin_update_storage_backend`** (203-229): no changes
  needed beyond what's already covered by the two functions they call.

## Phase 5 — Frontend

### 5.1 `frontend/src/StorageBackendsAdminPanel.jsx`

- `EMPTY_FORM`: remove the `endpoint` key.
- Edit-mode `useEffect` (38-59): remove `endpoint: backend.endpoint || ''` from `setForm(...)` —
  endpoint now arrives through `setConfig(backend.config || {})` like every other MinIO config
  field, no special-casing needed.
- Remove the standalone Endpoint `Form.Group` (134-137) — no replacement in the parent; nothing
  else needs to change at the protocol-component call site (181-186 stays exactly
  `<activeProtocolForm.Component value={config} onChange={handleConfigChange} />`, no new props).
- `handleSubmit`: remove `endpoint: form.endpoint || null` from `body` — no longer a top-level
  field to submit.
- `handleTest`: remove `endpoint: form.endpoint || null` from the test-connection POST body.
- `handleProtocolChange`: no change needed — its existing `setConfig({})` reset already clears
  endpoint along with everything else in `config` when switching protocols (this incidentally
  fixes, for free, the stale-endpoint-on-protocol-switch gap identified in the earlier draft of
  this plan — no separate fix required once endpoint lives inside `config`).
- Admin list table: change `<td>{b.endpoint || <span className="text-muted">—</span>}</td>` to
  `<td>{b.config?.endpoint || <span className="text-muted">—</span>}</td>`. Confirmed this works:
  `admin_list_storage_backends` returns `_storage_backend_admin_dict(b)` per row, whose `config` is
  masked per-key (Phase 1/4) — `endpoint` isn't in MinIO's `SECRET_CONFIG_KEYS`, so it comes back
  in plaintext; for GCS/S3 rows `config.endpoint` is simply absent, so the fallback `—` renders,
  same as today.

### 5.2 `frontend/src/storageProviders/MinioStorageForm.jsx`

Add the Endpoint field ahead of the existing admin key/secret fields, bound to `value`/`onChange`
exactly like they are:

```jsx
export default function MinioStorageForm({ value, onChange }) {
  return (
    <>
      <Form.Group className="mb-3">
        <Form.Label>Endpoint</Form.Label>
        <Form.Control
          value={value.endpoint || ''}
          onChange={e => onChange({ ...value, endpoint: e.target.value })}
        />
      </Form.Group>
      <Form.Group className="mb-3">
        <Form.Label>Admin Access Key</Form.Label>
        ...
```

### 5.3 `frontend/src/storageProviders/GcsStorageForm.jsx`, `S3StorageForm.jsx`

No changes.

## Manual verification

- Run the migration against the dev DB; confirm the existing default MinIO backend's `endpoint`
  ends up at `config.endpoint` and the `endpoint` column is gone
  (`sqlite3`/`psql` inspect, or just confirm via the admin UI below).
- Admin > Storage list table: confirm the Endpoint column still shows the real MinIO URL for the
  existing backend (not masked, not blank).
- Edit that backend: confirm the Endpoint field appears inside the MinIO section (below the
  Protocol dropdown, above Admin Access Key), pre-filled with the real value (not `"****"`), while
  Admin Access Key/Secret Key show `"****"` placeholders.
- Change only Sort Order and Save: confirm endpoint/credentials are unaffected (masked fields
  round-trip correctly via `resolve_config`).
- Add a new backend, default protocol MinIO: confirm Endpoint field appears inside the MinIO
  section; switch to GCS/S3: confirm it disappears entirely (and, per the config-reset behavior,
  any typed-but-unsaved endpoint is cleared — same accepted behavior as today's config fields).
- Test Connection button: confirm it still works end-to-end (validates `_TestBackend(config)` with
  no `.endpoint` field wired through correctly reads `config["endpoint"]` inside
  `MinioProtocolHandler.test_connection`).
- Confirm project creation/provisioning against the default backend still works
  (`MinioProtocolHandler.provision()` reading `backend.config["endpoint"]`).

## Open Questions

- None outstanding — scope (`endpoint` becomes MinIO-config-owned, not a core column;
  `bucket_prefix` stays core), the per-key masking approach, and the migrate-and-drop-column
  approach were all confirmed with the user before writing this revision of the plan.

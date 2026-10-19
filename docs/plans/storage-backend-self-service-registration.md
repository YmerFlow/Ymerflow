# Storage-backend self-service registration — make Save safe (mirror the cluster flow)

## Goal & scope

The "Add Storage Backend" dialog has a Save trap for self-service storage protocols (today: Azure
Blob `az`, by extension GCS). When the admin runs the copy-paste `az` setup command, the plugin's
`POST /admin/azure/blob/register-callback` creates the real `StorageBackend` row **directly**
(`azure_plugin/router.py:195`, `active=True`, full `config` with `tenant_id`/`admin_sp`). By the
time the dialog shows its green "ready" banner, **the backend already exists**. The banner tells
the admin to click **Cancel** — but nothing stops them clicking **Save**, and Save is a trap:

- On "ready" the form calls `onChange({})` (`AzureBlobStorageForm.jsx:46`), which sets the host
  modal's `config = {}` **and** `configTouched = true` (`StorageBackendsAdminPanel.jsx:68`).
- Clicking Save then POSTs `protocol: "az", config: {}` to `admin_create_storage_backend`, which
  tries to create a **second, broken** backend and fails the `az` config validation with
  `az storage config is missing tenant_id, admin_sp` (`storage_protocol.py:79`) — the exact error
  the admin reported.

The cluster "Add Cluster" flow already solved this class of bug generically with
`selfServiceRegistration` (`docs/plans/done/minikube-cluster-registration-ux.md`): for a
self-service provider the dialog **disables Save until the row has been discovered**, and Save is a
**claim** (PATCH the discovered row `active=true`) rather than a **create** (POST). The storage
side never got this treatment — `StorageBackendsAdminPanel.jsx` has no self-service handling at
all, and the `az` `storage_protocol_forms` entry (`azure_plugin/frontend/src/index.jsx:21`) lacks
the `selfServiceRegistration` flag the `aks` `cluster_provider_forms` entry has.

This plan brings storage backends to **parity with clusters**: a self-service storage protocol's
callback creates a **pending (`active=False`)** row keyed by the registration-token hash, the
still-open dialog polls for it, and **Save claims it** (PATCH `active=true`) instead of creating a
duplicate. No separate "click Cancel" instruction, no trap.

**Out of scope:** the Azure provisioning script, the SAS-token minting flow, AKS cluster
registration (already correct), and the actual `az`/container logic in `storage_protocol.py` — all
unchanged. This is purely about *when/whether* the `StorageBackend` row is active and how the
dialog's Save behaves.

## Background — current state

- **`StorageBackend` model** (`backend/models/storage_backend.py:10-37`): columns `id, name,
  protocol, bucket_prefix, credential_strategy, config, created_at, sort_order, active`. **No**
  `registration_token_hash` / `provisioning_status` (unlike `Cluster`, which has both —
  `backend/models/cluster.py:39-40`).
- **Host storage admin panel** (`frontend/src/StorageBackendsAdminPanel.jsx`): generic create/edit
  modal. `handleConfigChange` sets `configTouched = true`; `handleSubmit` always POSTs (create) or
  PATCHes (edit); no `selfServiceRegistration` concept. Footer is always `Cancel` + `Save`.
- **Host cluster admin panel** (`frontend/src/ClustersAdminPanel.jsx`) — the reference
  implementation to mirror:
  - `selectableProviderForms` hides self-service types when editing a different type (`:83-85`).
  - `selfServiceTargetId = isEdit ? cluster?.id : discoveredCluster?.id` (`:107`).
  - `handleSubmit`: `claimingSelfService = !isEdit && activeProviderForm?.selfServiceRegistration`;
    skips `config` in the body for self-service (`:144`), and PATCHes the discovered row with
    `active: true` instead of POSTing (`:152`).
  - `saveDisabled = saving || (!isEdit && selfService && !discoveredCluster)` (`:165`) — Save is
    disabled until the row is discovered.
  - `showTestConnection` gated on having a target id (`:164`).
  - Discovery is driven by polling a **generic host** endpoint
    `GET /admin/clusters/by-registration-token` (`backend/routers/admin.py:102`), keyed by the
    `Cluster.registration_token_hash` column.
- **Azure Blob flow** (`azure_plugin/`):
  - `storage_protocol_forms` registers `{ type: 'az', title, Component: AzureBlobStorageForm }` —
    **no** `selfServiceRegistration` flag (`frontend/src/index.jsx:21`).
  - `AzureBlobStorageForm.jsx` generates a client-side token, shows the `az` command, and **polls
    the plugin's own** `GET /admin/azure/blob/by-registration-token` (`:40`). On `ready` it calls
    `onChange({})` and shows the "click Cancel" banner (`:44-76`).
  - `POST /admin/azure/blob/register-callback` (`router.py:161-218`) creates the `StorageBackend`
    row **active=True directly** and tracks poll state in the plugin-owned `BlobRegistration` model
    (`azure_plugin/models.py`), whose docstring explicitly notes it exists *because* "the host's
    `StorageBackend` model has no registration columns, and adding them would mean editing the host
    repo."
- **GCS (`ymerflow-gcp`)** mirrors the Azure Blob flow and has the **same trap** — it must get the
  same treatment (see Design decision 5 / Phase 5).

## Design decisions to confirm (before implementation)

> Per the workflow rules these are the user's to settle. Decision **1** is the one real fork in the
> road; the rest follow from it.

### 1. Where the registration-token state lives — **the key choice**

**Option A — full parity (recommended): add registration columns to the host `StorageBackend`.**
Add `registration_token_hash` (and, for symmetry with clusters, `provisioning_status`) to
`StorageBackend`, plus a generic `GET /admin/storage-backends/by-registration-token` endpoint. The
plugin callback creates a **pending `StorageBackend`** keyed by the token hash (dropping the
`BlobRegistration` bookkeeping model entirely). `StorageBackendsAdminPanel` polls the generic
endpoint exactly like `ClustersAdminPanel`. This is a **true, line-for-line mirror** of the cluster
flow and makes every future self-service storage plugin (GCS, S3-STS, …) work with zero host
changes.
- *Cost:* one host-model migration (two columns), and it reverses the earlier "don't touch the
  host model" decision that motivated `BlobRegistration`.

**Option B — keep plugin-owned discovery (lighter).** Leave `BlobRegistration` and the plugin's own
poll endpoint in place; the plugin callback creates the row **`active=False`**. The plugin form
keeps polling and, on `ready`, reports the discovered `storage_backend_id` **up to the panel via
`onChange`** (instead of `onChange({})`). The panel's self-service handling disables Save until a
backend id is reported and, on Save, PATCHes **that** id `active=true` (claim) instead of POSTing.
- *Cost:* no host migration, but the discovery/poll contract diverges from clusters (the panel
  doesn't poll generically — it's handed the id by the plugin form), so it's a *behavioral* mirror,
  not a structural one. Each new self-service storage plugin must re-implement its own poll.

**This plan is written for Option A** (the faithful mirror the request asked for). If the user
prefers Option B, Phases 1–2 shrink to "callback creates `active=False` + form reports the id" and
the host migration is dropped; the panel/flag work in Phases 3–4 is nearly identical either way.

### 2. Pending rows are `active=False` (both options)
A callback-created-but-never-claimed row sits inert (`active=False`) and is harmless — identical to
the cluster flow's accepted "unclaimed pending row" gap
(`minikube-cluster-registration-ux.md` Design decision 3). No cleanup job in this plan. Under
Option A, `provisioning_status` carries `pending`/`failed` for display, mirroring clusters.

### 3. Save = claim, never create, for self-service
For a self-service storage form, Save PATCHes the discovered row with the generic fields (Name,
Bucket Prefix, Credential Strategy, Sort Order) **plus `active: true`**, and never sends
`protocol`/`config` (those are backend-owned, filled by the callback). Mirrors
`ClustersAdminPanel.handleSubmit` (`:144`, `:152`) and `admin_update_cluster`'s claim-on-update.
`admin_update_storage_backend` clears `registration_token_hash` on this transition (Option A).

### 4. Name/Bucket Prefix prefill
The callback already stores a `name` (defaults to the storage-account name) and `bucket_prefix`
(the container prefix). On discovery, the form/panel should prefill those into the (still editable)
Name / Bucket Prefix fields so Save has sensible values and the required-field validation passes
without the admin retyping. (Cluster flow uses a placeholder name overwritten on claim; here we can
do better because the real name already exists.)

### 5. GCS parity is in-scope
`ymerflow-gcp`'s GCS storage flow has the identical trap and must get the identical change
(Phase 5). Doing only Azure would leave GCS broken and the two plugins divergent.

## Phase 1 — Host backend: registration columns + pending-aware create (Option A)

- `backend/models/storage_backend.py`: add `registration_token_hash = Column(String(64),
  nullable=True)` and `provisioning_status = Column(String(32), nullable=False,
  default="active")`; include both in `to_dict()`. Document the lazy-create-on-callback lifecycle
  in a comment, mirroring `backend/models/cluster.py:33-40`.
- `backend/routers/admin.py`:
  - New `GET /admin/storage-backends/by-registration-token?token=<raw>` (`require_admin`), hashing
    the token with the same SHA-256 helper the cluster endpoint uses and returning the masked admin
    dict or 404 — a direct copy of `admin_cluster_by_registration_token` (`:102`).
  - `admin_update_storage_backend`: when the PATCH targets a backend whose
    `registration_token_hash` is still set and the body includes `active: true`, clear
    `registration_token_hash` and set `provisioning_status = "active"` as part of the same update
    (claim). Mirror whatever `admin_update_cluster` does so the two stay consistent.

## Phase 2 — Azure plugin: callback creates a pending backend (Option A)

- `azure_plugin/router.py` `blob_register_callback`: instead of creating `StorageBackend(...,
  active=True)` + a `BlobRegistration` row, **find-or-create a `StorageBackend` keyed by the token
  hash**: `active=False`, `provisioning_status="pending"` (or `"failed"` if `test_connection`
  raises), `registration_token_hash=<hash>`, full `config`. A re-paste of the same command updates
  the same row (idempotent), mirroring `cluster_register_callback`.
- Remove the plugin's `GET /admin/azure/blob/by-registration-token` route and the
  `BlobRegistration` model (`azure_plugin/models.py`) — the generic host endpoint + the new column
  replace them. Add an Alembic migration in the plugin's own migration dir **dropping**
  `azure_plugin_blob_registrations` (real-entropy revision id per CLAUDE.md rule 9; verify
  uniqueness across all migration dirs before committing).
- Keep `blob_setup_script` and `register-callback`'s bearer-token auth unchanged.

## Phase 3 — Azure plugin frontend: report discovery instead of "click Cancel"

- `frontend/src/index.jsx`: add `selfServiceRegistration: true` to the `az` `storage_protocol_forms`
  entry, matching the `aks` `cluster_provider_forms` entry.
- `frontend/src/AzureBlobStorageForm.jsx`: poll the **generic host** endpoint
  `GET /admin/storage-backends/by-registration-token?token=…` (Option A) instead of the deleted
  plugin route. On a found row, call `onChange` with the discovered row's identity (e.g.
  `{ __discoveredBackendId, name, bucket_prefix }`) rather than `onChange({})`, and replace the
  "click Cancel / Save would duplicate" banner with a "✓ received — click Save to finish" banner.
  (Option B: keep polling the plugin endpoint and report `storage_backend_id` the same way.)

## Phase 4 — Host storage panel: mirror `ClustersAdminPanel` self-service handling

In `frontend/src/StorageBackendsAdminPanel.jsx`, port the cluster panel's self-service logic:
- `selectableProtocolForms` hides self-service types when editing a different-protocol backend
  (mirror `ClustersAdminPanel.jsx:83-85`).
- Track a `discoveredBackend` (id + prefill fields) reported by the active protocol form's
  `onChange`; derive `selfServiceTargetId`.
- `handleSubmit`: `claimingSelfService = !isEdit && activeProtocolForm?.selfServiceRegistration`;
  **skip `protocol`/`config`** in the body when self-service; PATCH the discovered id with
  `active: true` + generic fields instead of POSTing (mirror `:144`, `:152`).
- `saveDisabled = saving || (!isEdit && selfService && !discoveredBackend)` — Save disabled until
  discovery (mirror `:165`).
- `showTestConnection` gated on a target id for self-service forms (mirror `:164`).
- Prefill Name / Bucket Prefix from the discovered row (Design decision 4).

## Phase 5 — GCS parity (`ymerflow-gcp`)

Apply Phases 2–3 to the GCS plugin: callback creates a pending `StorageBackend` keyed by the token
hash (drop its `GcsRegistration` model + poll route and migrate it away), add
`selfServiceRegistration: true` to its `storage_protocol_forms` entry, and have its storage form
report discovery via `onChange`. No further host changes needed beyond Phases 1 & 4.

## Manual verification

- Fresh "Add Storage Backend" → select **Azure Blob Storage** → the `az` command appears; **Save is
  disabled**.
- Run the command (real `az login` shell) → within a few seconds the dialog shows "received",
  prefills Name / Bucket Prefix, and **enables Save**. Confirm a `StorageBackend` row exists but is
  **`active=False` / pending** in the admin list.
- Click **Save** → the row flips `active=true`, `registration_token_hash` is cleared, and **no
  second row** is created. The former error (`az storage config is missing tenant_id, admin_sp`) no
  longer occurs.
- Verify the claimed backend actually works: create a project against it → a container is
  provisioned and a job can read/write (`storage_protocol.py` path unchanged).
- Re-run the same command twice (idempotency) → updates the same pending row, no duplicate.
- Close the dialog **without** running the command → no row created.
- Close the dialog **after** running the command but **without** Save → an inert `active=False`
  pending row remains and affects nothing.
- Repeat the full happy path for **GCS** (Phase 5).
- Confirm non-self-service protocols (`minio`/`s3`, `file`) create/edit exactly as before — Save
  still POSTs/PATCHes config normally.

## Open questions / follow-ups

- **Decision 1 (Option A vs B)** is the gating choice — settle before implementation; the plan body
  assumes A.
- Whether to add `provisioning_status` to `StorageBackend` (full cluster symmetry) or rely on
  `active` alone under Option A — decide with Decision 1.
- Polling interval reuse: `AzureBlobStorageForm` already polls at `POLL_INTERVAL_MS = 4000`; keep
  it or align with the cluster form's interval.
- Whether `admin_update_storage_backend` can infer "claim" purely from
  "`registration_token_hash` set and `active: true` in body" (as the cluster endpoint does) or needs
  an explicit flag — confirm against `admin_update_cluster` at implementation.
- Cleanup of abandoned pending rows (no delete-storage-backend endpoint exists today, same as
  clusters) — out of scope, flagged for a later pass if stale rows become a nuisance.

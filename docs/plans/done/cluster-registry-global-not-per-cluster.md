# Make the image registry global, not per-cluster — Plan

## Goal

Remove the per-`Cluster` `registry_url` / `registry_auth` columns and make the runner image
registry a single **global** deployment setting, sourced from `backend/config.py`
(`settings.registry_url` / `settings.registry_auth`, already overridden by the k8s ConfigMap in
prod). Per-cluster registry configuration is a bug: the runner images only exist wherever
`docker/build.sh` pushed them, so an arbitrary cluster cannot pull from "its own" registry — every
cluster must reach the one global registry the build published to. A per-cluster field only invites
an admin to point a new cluster at a registry the images were never pushed to, which fails the pull
at job time.

Scope is: drop the two columns (+ migration), route `job_orchestrator` through the existing global
`settings.*`, and strip registry from the admin routes and the Clusters admin form. It does **not**
add any global-settings admin UI (decision below: config/ConfigMap-only), and does not touch the
`cluster_type` / `provider_config` connection mechanism, `namespace`, or `StorageBackend`.

## Supersedes / modifies

Modifies surface landed by [cluster-admin-ui.md](cluster-admin-ui.md) (still in `docs/plans/`, not
yet moved to `done/`) and the registry env-var injection landed by
[multi-cluster-selection.md](done/multi-cluster-selection.md) /
[multi-cluster-execution.md](done/multi-cluster-execution.md). No behavior change for the current
single-cluster deployment: today's default cluster has `registry_url=NULL`, so
`job_orchestrator.py:45-48` already injects no `REGISTRY_URL`/`REGISTRY_AUTH` env vars; after this
change it injects them from `settings.*`, whose default (`registry:5000` / `None`) matches what the
runner already assumes.

## Background — current state

(Confirmed by reading the code.)

- **The pod's own image is NOT pulled via `cluster.registry_url`.** The Job container image is
  `environment.docker_image` — a fully-qualified reference (e.g. `gcr.io/<proj>/nagelfluh-runner:latest`,
  `models/environment.py:14`, `environments.py:15`) set straight into the manifest at
  `job_orchestrator.py:156`. The registry for the pod's own image is baked into the environment, not
  the cluster. The docstring at `job_orchestrator.py:11-15` claiming the cluster "supplies the
  registry the pod's image is pulled from" is misleading and will be corrected.
- `cluster.registry_url` / `cluster.registry_auth` are consumed in exactly one place —
  `job_orchestrator.py:45-48` — injected only as `REGISTRY_URL` / `REGISTRY_AUTH` **env vars**,
  which the *runner* uses to pull/build **further** images (e.g. `build_frontend_plugin`;
  `docker/base-runner/ymerflow_processes/fake_processes.py:64-68` reads `REGISTRY_URL`/`REGISTRY_AUTH`
  from the environment).
- A **global** registry config already exists and is the prod-configured path:
  `backend/config.py:57-58` — `settings.registry_url` (default `registry:5000`, "overridden by k8s
  ConfigMap in prod") and `settings.registry_auth` (default `None`). The per-cluster columns shadow
  this.
- Admin surface for the columns: `backend/routers/admin.py` — `_cluster_admin_dict` masks
  `registry_auth` (line 22), `_apply_generic_fields` writes `registry_url` (58-59) and
  `registry_auth` (75-79). Frontend: `frontend/src/ClustersAdminPanel.jsx` — `EMPTY_FORM`
  (`registryUrl`/`registryAuth`, lines 14-15), edit prefill (47-48), submit body (102, 106), form
  fields (145-153), table column (243, 256).
- `Cluster.to_dict()` (`models/cluster.py:29-39`) includes `registry_url` (line 33); it never
  included `registry_auth`.
- Current Alembic head: `182d880e84c7`.

## Design decisions (settled in discussion)

- **Global registry is config/ConfigMap-only, no admin UI.** `job_orchestrator` reads
  `settings.registry_url` / `settings.registry_auth` directly. No global-settings table, route, or
  tab is added (a heavier "editable global settings in the UI" option was considered and declined).
- **Drop the columns via migration**, rather than leaving dead columns in place. Clean schema
  matching the new model; removes the need to keep masking an unused secret.
- **No `registry_auth` data preserved.** In the current deployment the only cluster row has
  `registry_url=NULL` / `registry_auth=NULL`, so there is nothing to migrate into the global config.
  Any non-null value in another deployment is intentionally dropped — the correct global value must
  be set via `settings.registry_url`/ConfigMap, not carried over from an incorrect per-cluster value.

---

## Phase 1 — `job_orchestrator` reads global settings

**`backend/services/job_orchestrator.py`**:

- Replace lines 45-48:

  ```python
  if cluster.registry_url:
      env_vars.append(client.V1EnvVar(name="REGISTRY_URL", value=cluster.registry_url))
  if cluster.registry_auth:
      env_vars.append(client.V1EnvVar(name="REGISTRY_AUTH", value=cluster.registry_auth))
  ```

  with (using the already-imported `settings`, `job_orchestrator.py:24`):

  ```python
  if settings.registry_url:
      env_vars.append(client.V1EnvVar(name="REGISTRY_URL", value=settings.registry_url))
  if settings.registry_auth:
      env_vars.append(client.V1EnvVar(name="REGISTRY_AUTH", value=settings.registry_auth))
  ```

- Correct the misleading docstring at `job_orchestrator.py:11-15` — the `cluster` supplies the k8s
  connection and namespace, **not** the image registry (that is `environment.docker_image` for the
  pod itself and `settings.registry_url` for the env vars).

This is the only production consumer of the columns, so after this change nothing reads them.

## Phase 2 — Model + migration: drop the columns

### 2.1 `backend/models/cluster.py`

- Delete the `registry_url` (line 21) and `registry_auth` (line 22) columns.
- Delete `"registry_url": self.registry_url` from `to_dict()` (line 33).

### 2.2 Migration (off head `182d880e84c7`)

Generate the revision id with real entropy per CLAUDE.md rule 9
(`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`), verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` across all migration dirs before committing.

`batch_alter_table('clusters')`: `drop_column('registry_url')`, `drop_column('registry_auth')`.
`downgrade()` re-adds both as `sa.Column(sa.String(255), nullable=True)`.

No data pass — nothing is migrated into global config (see Design decisions).

## Phase 3 — Admin routes: strip registry

**`backend/routers/admin.py`**:

- `_cluster_admin_dict` (18-23): remove line 22 (`d["registry_auth"] = mask_secret(...)`).
- `_apply_generic_fields` (48-79): remove the `registry_url` block (58-59) and the `registry_auth`
  block (75-79). `mask_secret`/`resolve_secret` imports (line 13) stay — still used elsewhere?
  Check: after removal they are unused **in this module** (storage paths use `mask_config`/
  `resolve_config`, not the scalar `mask_secret`/`resolve_secret`). Drop `mask_secret, resolve_secret`
  from the import if and only if nothing else references them.

## Phase 4 — Frontend: remove registry from the Clusters form

**`frontend/src/ClustersAdminPanel.jsx`**:

- `EMPTY_FORM`: drop `registryUrl` / `registryAuth` (14-15).
- Edit prefill: drop lines 47-48.
- Submit body: drop `registry_url` (102) and the `registry_auth` conditional (106).
- Form fields: remove the Registry URL group (145-146) and Registry Auth group (149-153).
- Table: remove the `<th>Registry URL</th>` header (243) and the `registry_url` `<td>` (256).

No change to `datamodel/api.js` or `useAuthQueries.js` — the routes' paths and shapes are unchanged,
only two body keys disappear.

---

## Implementation Order

1. **Phase 1** — `job_orchestrator` → `settings.*`. Verify a job still launches on the default
   cluster and (for a `build_frontend_plugin` run) `REGISTRY_URL` is present in the pod env,
   sourced from `settings.registry_url`.
2. **Phase 2** — model edit + drop-column migration; run `backend/bin/yf-migrate`; confirm
   the default cluster still resolves and jobs run.
3. **Phase 3** — admin route edits; verify `GET/POST/PATCH /admin/clusters` via `/docs` no longer
   accept or emit registry fields and don't 500.
4. **Phase 4** — frontend form/table edits; verify the Clusters admin tab renders, add/edit still
   works, and no registry fields remain.

## Resolved questions

- **Migrating existing per-cluster `registry_auth` values → irrelevant** (decided in discussion).
  No data pass; any per-cluster value is dropped with the column. The correct global value is set
  via config, not carried over.
- **`settings.registry_auth` config wiring → confirmed reachable, just unset by default.**
  `Settings` is pydantic `BaseSettings`, so it reads the `REGISTRY_AUTH` env var directly
  (`config.py:58`). The backend deployment loads env via `envFrom` from **both** the ConfigMap
  `ymerflow-backend-config` **and** the Secret `nagelfluh-backend-secret`
  (`k8s/backend/deployment.yaml:27-31, 46-50`), so any key in either flows into `settings.*`. The
  prod ConfigMap sets `REGISTRY_URL` (`prod/runall-minikube.sh:196`) but not `REGISTRY_AUTH`
  (correct — the dev registry `registry:5000` is unauthenticated). Since `registry_auth` is a secret
  (base64 `username:password`), when a deployment needs authenticated runner sub-pulls the admin
  adds `REGISTRY_AUTH` to **`nagelfluh-backend-secret`** (not the ConfigMap). The `envFrom` Secret
  ref already exists, so **no manifest or code change is required** — this is an ops/doc note only.

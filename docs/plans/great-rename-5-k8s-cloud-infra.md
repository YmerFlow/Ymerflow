# Great Rename — K8s/Cloud-Infra Resource Names

## Goal

Rename **every** `nagelfluh` occurrence that names (or defaults to naming) an **actual
cloud/cluster resource** to `ymerflow`: Kubernetes namespaces, Secrets, Jobs, ServiceAccount
namespace, Kueue queue names, the Postgres database/user, container registry
repository/credentials, the GKE cluster name, and the per-project storage bucket prefix. Nothing
named `nagelfluh` survives anywhere (issue #15's "no references *anywhere*").

## Strategy — settled 2026-08-12: rename everything, redeploy prod from scratch, no data migration

The migration question that made an earlier draft of this plan a "dossier of options" is
**resolved**. The decision:

- **No in-place data migration, ever.** Prod (GKE, live with real data but no external users) is
  **redeployed from scratch** under all-new `ymerflow` names. Existing projects are moved with the
  **GUI project export → reimport** flow, not by migrating any database, bucket, or PV in place.
- Because nothing is migrated in place, there are **no expensive/immutable-resource problems**:
  the GKE cluster, Artifact Registry repo, GCS buckets, namespace, and Postgres DB are all
  **provisioned fresh** under `ymerflow` names; the old `nagelfluh-*` resources are torn down.
  GKE-cluster-name immutability and GCS-bucket-rename cost — the things that made in-place renames
  painful — simply don't apply to a from-scratch redeploy.
- **The one and only code-level compatibility requirement is the export ZIP format**, so a
  project exported under the old naming reimports cleanly. That is owned by
  `great-rename-4-process-type-identifiers.md` (import-time translation table, `format_version`
  bump). Confirmed by reading the export/import services: **cloud-resource names never travel in
  the ZIP** — storage URLs are stripped to zip-relative paths on export and regenerated for the
  target bucket on import — so *none* of the renames in this plan affect import compatibility.
  Only embedded *identifiers* (process-type keys, `docker_image`) do, and those are handled there.

So this plan reduces to: **a straightforward find-and-replace of `nagelfluh` → `ymerflow` across
the code + k8s manifests + prod scripts + config.env**, plus a from-scratch prod redeploy. The
"hard 90%" an earlier draft worried about evaporated once "no data migration, export/reimport"
was chosen.

## Prod state topology (why "redeploy from scratch" is safe)

Confirmed by reading `k8s/` + `prod/runall-production.sh`. All prod state lives in exactly two
places, and neither needs an in-place rename:

- **In-cluster Postgres** — StatefulSet on a PVC, namespace `nagelfluh`, database `nagelfluh`,
  user `nagelfluh` (`k8s/postgres/statefulset.yaml`, `k8s/backend/deployment.yaml:44` DATABASE_URL
  `postgresql+asyncpg://nagelfluh:...@postgres.nagelfluh.svc.cluster.local:5432/nagelfluh`,
  `prod/runall-production.sh:274`). Recreated empty under `ymerflow`; projects reimported into it.
- **External GCS buckets** — `nagelfluh-<project_id>` (`config.env.gcp` `STORAGE_CONFIG_JSON`
  `bucket_prefix: "nagelfluh-"`). New projects created by reimport get fresh `ymerflow-<new_id>`
  buckets; old buckets are deleted with the old deployment.

Everything else in prod (Secrets, Jobs, Deployments, Services, ServiceAccount, Kueue queues) is
stateless and recreated from manifests/scripts on deploy.

## Background — full inventory of code-level occurrences

**Kubernetes namespace default (`"nagelfluh"` / `"nagelfluh-jobs"`)**:
- `frontend/src/ClustersAdminPanel.jsx:13` — form default `namespace: 'nagelfluh-jobs'`
- `backend/models/cluster.py:21` — `Cluster.namespace` column default `"nagelfluh-jobs"`
- `backend/routers/admin.py:71,140` — same default in create/update cluster routes
- `backend/services/k8s_client.py:45` — `K8sClient.__init__` namespace default
  `os.getenv('K8S_NAMESPACE', 'nagelfluh-jobs')`
- `backend/services/cluster_job_provisioning.py:85` — `BACKEND_SERVICE_ACCOUNT_NAMESPACE =
  "nagelfluh"` (the backend's *own* ServiceAccount namespace — distinct from the jobs namespace
  above), env var `NAGELFLUH_BACKEND_NAMESPACE` (`:80-81`)
- `backend/bin/yf-bootstrap-provision:79` — `_APP_NAMESPACE = "nagelfluh"`
- `backend/bin/yf-deploy-app:54` — `APP_NAMESPACE = os.getenv("APP_NAMESPACE", "nagelfluh")`
- `backend/alembic/versions/f6a7b8c9d0e1_seed_default_cluster.py:40` — **seeds a DB row**:
  `os.getenv("K8S_NAMESPACE", "nagelfluh-jobs")` as the bootstrap "Default Cluster"'s namespace

**K8s Secret/Job/ServiceAccount/label names**:
- `backend/services/app_deployment.py:51-53,66` — `SECRET_NAME = "nagelfluh-backend-secret"`,
  `IMAGE_PULL_SECRET_NAME = "nagelfluh-app-pull"`, `MIGRATION_JOB_NAME = "nagelfluh-app-migrate"`,
  `ADMIN_HTPASSWD_SECRET_NAME = "nagelfluh-admin-secret"`; label `{"app":
  "nagelfluh-app-migrate"}` (`:247`); env var `NAGELFLUH_DATA_DIR` (`:195`) as a legacy
  jwt-secret-persistence path, noted in the code as superseded but still read
- `backend/services/job_orchestrator.py:194,221` — label `{"app": "nagelfluh-process"}`, Kueue
  local-queue name `"nagelfluh-queue"`
- `backend/services/cluster_job_provisioning.py:54-55` — `CLUSTER_QUEUE_NAME =
  "nagelfluh-cluster-queue"`, `LOCAL_QUEUE_NAME = "nagelfluh-queue"`
- `backend/services/k8s_client.py:315` — `get_cluster_queue_limits(..., queue_name:
  "nagelfluh-cluster-queue")`
- `backend/bin/yf-bootstrap-provision:78-85,132` — reuses/checks for a pre-existing
  `nagelfluh-backend-secret` on repeat runs
- `backend/bin/nagelfluh-render-backend-secret-env` — **the script's own filename**, plus its
  docstring describing it as rendering "the merged nagelfluh-backend-secret contents"
  (`:2,5,24`)
- `backend/bin/yf-materialize-kubeconfig:57` — tempfile prefix `"nagelfluh-kubeconfig-"` (a local
  temp file, not a cluster resource — low risk, can move with the rest mechanically)

**Container registry / Docker image**:
- `backend/run.sh:21` — `REGISTRY_USER`/`REGISTRY_PASSWORD` default to `"nagelfluh"`/`"nagelfluh"`
- `backend/bin/yf-deploy-app:52,94` — `FRONTEND_REPOSITORY` default `"nagelfluh-frontend"`;
  `user, password = "nagelfluh", "nagelfluh"`
- `backend/alembic/versions/50dd9ce3311b_add_registry_backends_table.py:39` — **seeds a DB row**
  with `user, password = "nagelfluh", "nagelfluh"` as the default registry backend's credentials
- `backend/alembic/versions/08adf96a1437_add_k8s_execution_fields.py:76-79` — `GCP_PROJECT`
  default `'nagelfluh'`, Docker image name `f'gcr.io/{gcp_project}/nagelfluh-runner:latest'` /
  `'nagelfluh-runner:latest'`
- `config.env.gcp`/`.local`/`.mixed` (untracked) and `config.env.example` (tracked) —
  `REGISTRY_CONFIG_JSON`'s `repository` value, `REGISTRY_USER`/`REGISTRY_PASSWORD` example values

**Storage bucket prefix**:
- `backend/config.py:22` — `storage_bucket_prefix: str = "nagelfluh-project-"`
- `config.env.gcp`/`.local`/`.mixed`/`.example` — `STORAGE_CONFIG_JSON`'s `bucket_prefix`
  (live value in `config.env.gcp` is `"nagelfluh-"`, **not** `"nagelfluh-project-"` — the two
  differ already, confirm which is actually authoritative for GCS during implementation)

**GKE cluster name**:
- `config.env.gcp`/`.local`/`.mixed`/`.example` — `CLUSTER_CONFIG_JSON`'s `cluster_name`
  (live value `"nagelfluh-gke"`)

**The `k8s/` manifest tree + `prod/` scripts (NOT in the original file list — a major surface
found during investigation)**:
- `k8s/00-namespaces.yaml`, and `namespace: nagelfluh` / `nagelfluh-jobs` across
  `k8s/backend/*.yaml`, `k8s/frontend/*.yaml`, `k8s/postgres/*.yaml`, `k8s/pgadmin/*.yaml`.
- **Postgres**: `k8s/postgres/statefulset.yaml` — `POSTGRES_DB: nagelfluh`, `POSTGRES_USER:
  nagelfluh`, secret `nagelfluh-postgres-secret`. `k8s/backend/deployment.yaml:29,44` — the
  `pg_isready -U nagelfluh` init check and the DATABASE_URL. `k8s/pgadmin/servers-configmap.yaml`
  — `Host: postgres.nagelfluh.svc.cluster.local`, `MaintenanceDB: nagelfluh`, `Username:
  nagelfluh`. `prod/runall-production.sh:246-252,274` — `nagelfluh-postgres-secret`, the pgpass
  string, and the fully-resolved DATABASE_URL.
- **Secrets/service DNS in the prod script**: `prod/runall-production.sh` — `nagelfluh-backend-
  secret` (Step 6), `-n nagelfluh`, `nagelfluh-frontend` image name, `NAGELFLUH_DATA_DIR`
  (`:95-97` — note this is the host-file JWT dir the script still sets, distinct from the dead
  docstring reference in `app_deployment.py`; confirm during implementation whether prod still
  relies on it or it's vestigial), registry defaults `nagelfluh/nagelfluh`.
- `frontend/nginx.conf:58` — `proxy_pass http://pgadmin.nagelfluh.svc.cluster.local:80/;` — a
  Service DNS name that resolves to `k8s/pgadmin/service.yaml`'s `namespace: nagelfluh`; renames
  together with the namespace above, not in isolation.

**Prose-only** (move with the resources they describe):
- `config.env.example:213-214` — comment mentioning `nagelfluh-admin-secret` and `kubectl delete
  secret ... -n nagelfluh` rotation instructions.
- The many docstrings/comments in `backend/bin/yf-*`, `backend/services/*`, and
  `deps/Ymerflow-plugin-sdk/docs/backend-hooks.md` referencing `nagelfluh-backend-secret`,
  `nagelfluh-bootstrap-provision`, the `nagelfluh` app namespace, etc.

## Implementation Steps

Because the strategy is "rename everything + redeploy from scratch," this is now a mechanical
rename plus a deliberate redeploy — no options to weigh.

1. **Rename every `nagelfluh` string** inventoried above to `ymerflow` across: the backend code
   defaults, the `k8s/` manifest tree, `prod/runall-production.sh`, `frontend/nginx.conf`, and the
   `config.env.*` files (`config.env.example` tracked; `.gcp`/`.local`/`.mixed` are this
   developer's untracked working configs — update them too so the real redeploy uses new names,
   including `REGISTRY_CONFIG_JSON.repository`, `STORAGE_CONFIG_JSON.bucket_prefix`,
   `CLUSTER_CONFIG_JSON.cluster_name`). Rename the script `backend/bin/nagelfluh-render-backend-
   secret-env` → `ymerflow-render-backend-secret-env` (and its caller in `runall-production.sh`).
2. **Edit the three Alembic seed migrations directly** —
   `f6a7b8c9d0e1_seed_default_cluster.py` (namespace `nagelfluh-jobs`),
   `50dd9ce3311b_add_registry_backends_table.py` (registry creds `nagelfluh/nagelfluh`),
   `08adf96a1437_add_k8s_execution_fields.py` (GCP project + `nagelfluh-runner` image). Under the
   from-scratch model this is **correct, not a footgun**: prod's fresh DB re-runs these against an
   empty database, so editing the literal seed defaults is exactly what makes the new deployment
   come up with `ymerflow` names. (An earlier draft warned against editing these — that warning
   only applied to the abandoned in-place-migration approach.)
3. **Provision fresh GCP resources under `ymerflow` names**: new GKE cluster `ymerflow-gke`, new
   Artifact Registry repo `ymerflow`, and let the deploy create `ymerflow-` buckets on demand.
   Decided 2026-08-12: rename these external resources too (not keep them) — the from-scratch
   redeploy makes recreating the cluster + re-pushing images acceptable, and it's what "no
   references anywhere" requires.
4. **Redeploy prod from scratch** via the renamed `prod/runall-production.sh` against the new
   cluster. Then, per project, **GUI-export from the old deployment and reimport into the new one**
   (relying on `great-rename-4-process-type-identifiers.md`'s ZIP backwards-compat). Tear down the
   old `nagelfluh-*` cluster/registry/buckets once every project is verified imported.
5. **Verify** `backend/bin/yf-bootstrap-provision`'s "reuse a previously-deployed backend secret"
   logic (`:132`) references the new secret name, so a re-run finds/reuses the right secret.
6. **Sequencing note**: this plan's k8s/namespace/DB renames and
   `great-rename-3-entrypoint-namespace.md`'s image/package rebuilds land in the **same** from-
   scratch redeploy — coordinate them as one prod cutover, not two.

## Resolved decisions (all settled 2026-08-12)

- **Migration strategy**: rename everything (incl. GKE cluster + registry + buckets), redeploy
  prod from scratch, no in-place data migration; move projects via GUI export/reimport.
- **Prod status**: live with real data, no external users — hence a from-scratch cutover is
  acceptable (no uptime SLA to protect).
- **`storage_bucket_prefix` discrepancy** (config default `nagelfluh-project-` vs `config.env.gcp`
  override `nagelfluh-`): resolved as harmless default-vs-override drift — both get renamed to
  `ymerflow-…`; the explicit `config.env.gcp` override remains authoritative for prod.
- **`NAGELFLUH_DATA_DIR`**: the `app_deployment.py:195` reference is a **dead docstring** (nothing
  reads it) — just rename/drop the mention. The *separate* live use in `runall-production.sh:95-97`
  (host-file JWT dir) is real config; rename it there and confirm prod still wants that mechanism.
- **nginx pgadmin target**: renames together with `k8s/pgadmin/`'s namespace (Step 1), not in
  isolation.

## Open Questions

- [ ] None blocking. One thing to confirm during implementation: whether
      `prod/runall-production.sh`'s `NAGELFLUH_DATA_DIR` host-file JWT persistence is still wanted
      or is vestigial (doesn't block the rename either way — just rename it consistently).

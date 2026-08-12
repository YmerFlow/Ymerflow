# Pluggable registry backend + generalized bootstrap hooks — Plan

## Goal

Make the container registry a pluggable backend, exactly like storage (`StorageBackend`/
`StorageProtocolHandler`) and clusters (`Cluster`/`ClusterProvider`) already are. This plan is
**host-repo work only**: the generic `RegistryBackend`/`RegistryProtocolHandler` extension axis, core's
own `docker-v2` implementation of it (wrapping the existing self-hosted registry), the generalized
`bootstrap()` hook shared by all three pluggable axes, and the cleanup that follows from that
(protocol-agnostic `docker/build.sh`, per-Job pull credentials, generic seed migrations).

It also generalizes a related, previously provider-specific concern: making a newly-connectable
`Cluster` actually ready to run YmerFlow Jobs (namespace, Kueue install, quotas/queues, RBAC). That
logic exists today as two independent, duplicated shell implementations (one for minikube, one
inside the GCP plugin's GKE setup script); this plan replaces both with one provider-agnostic Python
routine, since none of it is actually specific to any given `cluster_type` once you have a working
`K8sClient` — which `ClusterProvider.connect()` already supplies uniformly.

**No Google/GAR-specific code is written here.** Google Artifact Registry support is a separate,
dependent plan — `docs/plans/gar-registry-protocol.md` in the `plugins/ymerflow-gcp` plugin's own
repo — which implements a `gar` protocol against the hooks this plan defines. This plan must be
implemented (and the hooks it adds must be stable) before that one can start.

## Background — current state

(Confirmed by reading the implemented code, not just the docs.)

YmerFlow's only registry today is the self-hosted Docker Registry v2 that `dev/setup-registry.sh`
deploys inside Minikube (namespace `registry`, NodePort 30500, self-signed TLS, htpasswd basic
auth). Every consumer of "the registry" bakes in assumptions specific to that setup:

- **`config.env` / `backend/config.py`** — `REGISTRY_PUBLIC_HOST` (bare host/IP, no scheme or
  port), `REGISTRY_USER`/`REGISTRY_PASSWORD` (dev-only, fed into `dev/setup-registry.sh`'s
  htpasswd), and `settings.registry_url`/`settings.registry_auth` (the values actually consumed at
  runtime — `registry_auth` is a single base64(`username:password`) string, i.e. one long-lived
  static credential, not a token).
- **`docker/build.sh`** — constructs `REGISTRY_URL="${REGISTRY_PUBLIC_HOST}:30500"` (hardcoded
  NodePort), then does `docker tag ... ${REGISTRY_URL}/nagelfluh-base-runner:${ENV_TAG}` and
  `docker login "${REGISTRY_URL}" -u "${REGISTRY_USER}" --password-stdin` with the static
  credentials from `config.env`.
- **`dev/setup-registry.sh`** — provisions the registry deployment itself (TLS cert generation,
  htpasswd secret, NodePort service, in-cluster `ExternalName` service in `nagelfluh-jobs`).
- **`dev/lib/provision-nagelfluh-jobs.sh`** — creates a single K8s `docker-registry` Secret
  (`nagelfluh-registry-pull`, fixed name, one per jobs-namespace) from
  `REGISTRY_PUBLIC_HOST:30500` + `REGISTRY_USER`/`REGISTRY_PASSWORD`, created once at provisioning
  time and never refreshed afterward.
- **`backend/services/job_orchestrator.py`** — every Job pod gets `imagePullSecrets: [{name:
  "nagelfluh-registry-pull"}]` (the secret above) and, separately, `REGISTRY_URL`/`REGISTRY_AUTH` env
  vars sourced from the same global `settings.registry_url`/`settings.registry_auth` (used by
  `build_frontend_plugin` inside the runner to pull/build further images, not for pulling the
  pod's own image — see that file's docstring on why registry config is global rather than
  per-`Cluster`, per `docs/plans/done/cluster-registry-global-not-per-cluster.md`).
- **`backend/routers/admin.py`'s `GET /static/assets/setup-minikube-remote.sh`** — for a remote
  Minikube cluster to be able to pull the image, this route live-fetches the registry's TLS
  certificate via a raw TLS handshake against `registry_host:30500` (`_fetch_registry_ca_pem`) and
  bakes the PEM into the generated setup script, plus the static `REGISTRY_USER`/`REGISTRY_PASSWORD`,
  so the remote node's provisioning script can create its own `nagelfluh-registry-pull` secret
  pointing at the same registry.
- **The pluggable-backend pattern already exists twice, via the identical mechanism.**
  `StorageBackend.protocol` dispatches to a `StorageProtocolHandler`
  (`backend/services/storage_protocols/__init__.py`); `Cluster.cluster_type` dispatches to a
  `ClusterProvider` (`backend/services/cluster_providers/__init__.py`). Both are discovered via
  `nagelfluh.hooks` fan-out hooks (`storage_protocol_handlers`/`cluster_provider_handlers`), and core
  registers its own built-ins (`minio`/`s3`, `same-as-backend`/`kubeconfig`/`minikube`) through the
  exact same channel a plugin would use — no "core is special" path. Both models have one
  active/default row used app-wide (`DEFAULT_STORAGE_BACKEND_ID`/`DEFAULT_CLUSTER_ID`,
  `get_default_storage_backend_id()`), seeded from `config.env` values by one-time Alembic data
  migrations (`182d880e84c7_backfill_default_storage_backend_config.py` for MinIO,
  `f6a7b8c9d0e1_seed_default_cluster.py` for the default cluster — the latter is stale against the
  current `Cluster` schema and needs revisiting regardless of this plan).
- **`backend/bin/nagelfluh-migrate`** establishes the precedent for a shell-invoked script bridging
  into plugin-provided Python via `importlib.metadata.entry_points(group=...)` directly (not even the
  full `hooks.py` fan-out machinery) — it discovers every `nagelfluh.migration_dirs` entry point to
  build Alembic's `version_locations`. This is the model for `docker/build.sh` calling into
  protocol-specific push logic without itself knowing about any given protocol.
- **`prod/runall-minikube.sh`'s `alembic-migrate` Job is isolated from cluster config today.** It
  runs in-cluster (`kubectl apply` a `batch/v1 Job`, lines ~274–294) with only a literal
  `DATABASE_URL` env var — no `envFrom` referencing `nagelfluh-backend-secret`/
  `nagelfluh-backend-config` (created earlier in the same script, lines ~122–201, and consumed by the
  backend Deployment). This is a real, pre-existing gap: today's `182d880e84c7` seed migration would
  silently see the Python-level defaults (`minioadmin`/`minioadmin`) inside that Job rather than an
  operator-customized `MINIO_ROOT_USER`/`PASSWORD`, and it blocks any design that needs the seed
  migration to see config that's only assembled host-side (see Design decision 6 below).
- **Existing GCP plugin precedent** (`plugins/ymerflow-gcp`, its own repo): `GkeClusterProvider`/
  `GkeK8sClient` (GCP service-account key stored in `Cluster.provider_config`, refreshed hourly via a
  `refresh_api_key_hook`) and `GcsProtocolHandler` (admin SA key stored in `StorageBackend.config`,
  produced once via a copy-paste `gcloud` setup script + `/admin/gcp/gcs/register-callback`). This
  plan's hooks are what let that plugin add an equivalent `gar` registry protocol — see its own plan.
- **Cluster job-readiness provisioning (Kueue/RBAC/queues) is duplicated across two shell scripts
  today, and no backend Python hook does any of it.** `dev/lib/provision-nagelfluh-jobs.sh` — sourced
  by `dev/setup-minikube.sh` and spliced verbatim into the generated remote setup script
  (`admin.py:280`, served at `GET /static/assets/setup-minikube-remote.sh`) — creates the jobs
  namespace, installs Kueue (CRDs/controller/webhook, with a `minikube ssh -- nc`-based webhook
  reachability probe that only works because it has host shell access), sizes a `ClusterQueue` quota
  from `MINIKUBE_CPUS`/`MINIKUBE_MEMORY` env vars, applies `ResourceFlavor`/`ClusterQueue`/
  `LocalQueue`, applies the `nagelfluh-backend-jobs` Role/RoleBinding + `nagelfluh-backend-kueue-
  reader` ClusterRole/ClusterRoleBinding (applied unconditionally, "so every provisioned cluster
  carries the same least-privilege intent" per its own comment, even though it's only load-bearing
  for the `same-as-backend` cluster type), and creates the static `nagelfluh-registry-pull` Secret
  (superseded by Design decision 4 above). `plugins/ymerflow-gcp/gcp_plugin/scripts/setup-gke.sh.in`
  (that plugin's own repo) independently reimplements the same Kueue-install-and-queue logic for a
  freshly-created GKE cluster, diverging in two incidental ways: it waits for webhook readiness via
  endpoint-population-plus-a-fixed-sleep instead of an active reachability probe, and it sizes the
  quota from real node allocatable capacity (`kubectl get nodes -o json`) rather than trusting env
  vars — the more general of the two approaches, since it works regardless of what any given node
  actually has available. **`POST /admin/clusters/register-callback` (`admin.py:186-246`), the one
  place a `Cluster` transitions from "just got a working config" to claimable, does none of this
  today** — it only calls `provider.test_connection()` (a generic list-namespaces check) and stores
  `provider_config`; every bit of Kueue/RBAC/queue provisioning happens shell-side, before the
  callback ever fires.

## Design decisions (settled in discussion)

1. **Add a third pluggable-backend axis: `RegistryBackend` + `RegistryProtocolHandler`, mirroring
   `StorageBackend`/`StorageProtocolHandler` exactly.** New model `backend/models/registry_backend.py`
   (`id, name, protocol, config JSON, active, sort_order`) and new
   `backend/services/registry_protocols/` package (`RegistryProtocolHandler` ABC +
   `registry_protocol_handlers` hook + `get_registry_protocol_handler(protocol)`), following the exact
   shape of `backend/services/storage_protocols/__init__.py`. One active/default backend is used
   app-wide (`get_default_registry_backend_id()`, mirroring
   `get_default_storage_backend_id()`) — this preserves the "one global registry" decision from
   `docs/plans/done/cluster-registry-global-not-per-cluster.md` as a consequence of the model shape,
   not a hardcoded assumption.
2. **Core registers its own self-hosted registry as protocol `"docker-v2"`**, through
   `registry_protocol_handlers()` in the root `setup.py`, alongside `("minio", MinioProtocolHandler)`
   — same list, same precedence (none). This is what keeps local/offline dev working with zero GCP
   dependency: a `gar` (or any other plugin-provided) protocol is additive, never a required
   replacement.
3. **`RegistryProtocolHandler` ABC methods** (implemented here only for `docker-v2`; any other
   protocol is a plugin's job):
   - `image_url(repository, tag) -> str` — the single place address *shape* is decided (mirrors
     `storage_base_url`). `docker-v2` returns `host:port/image:tag`.
   - `pull_credentials(config) -> {"username", "password", "expires_at"}` — resolves a pod
     image-pull credential. `docker-v2` returns the static `user`/`password` from its config,
     `expires_at=None`.
   - `configure_push_auth(config) -> None` — performs whatever local `docker login`/credential-helper
     setup push-side tooling needs before a `docker push`. `docker-v2` does today's
     `docker login host:port -u ... -p ...`.
   - `test_connection(config) -> None`.
   - `bootstrap(config) -> config` — see decision 6. `docker-v2`'s implementation is a passthrough
     (`return config`) — there is nothing to provision, the registry server itself is stood up by
     `dev/setup-registry.sh`, not by this hook.
   - No CA-pinning concept anywhere in the ABC: `docker-v2`'s handler keeps doing
     `_fetch_registry_ca_pem`-style CA scraping internally (self-signed TLS is a `docker-v2`-specific
     concern, moved in from `admin.py`); core callers never branch on protocol to decide whether CA
     trust is needed. A protocol that doesn't need it (like a real managed registry) simply never
     implements anything resembling it.
4. **Pull-side: mint per-Job, not a long-lived synced Secret.** Rather than refreshing a single
   `nagelfluh-registry-pull` Secret on some schedule, resolve `pull_credentials()` at Job-creation
   time and create/attach an ephemeral pull secret alongside the Job — reusing the shape already
   established for storage's `credential_strategy="short-lived"` (`expires_at`/`refresh_token` already
   threaded through `create_job_manifest` in `backend/services/job_orchestrator.py`). This sidesteps
   "who refreshes what, on what trigger" entirely: a Job's pull credential is only ever as old as the
   Job itself. Applies uniformly to every cluster (local or remote), and to every protocol — this
   plan only has to prove it works for `docker-v2`'s static credential (`expires_at=None` just means
   "never refresh, reuse the pod-launch-time value"), but the mechanism itself must not assume a
   static credential.
5. **Push-side: `docker/build.sh` becomes registry-protocol-agnostic.** It no longer hardcodes
   `REGISTRY_USER`/`PASSWORD` defaults, `:30500`, or a `docker login` call. Instead it shells out to a
   new entry point, `backend/bin/nagelfluh-registry-push <repository> <tag>`, which:
   1. loads the active `RegistryBackend` row (same DB connection `docker/update_bootstrap_environment.py`
      already opens),
   2. resolves the handler via `get_registry_protocol_handler(backend.protocol)`,
   3. calls `handler.configure_push_auth(backend.config)`,
   4. calls `handler.image_url(repository, tag)`,
   5. prints the resolved full image reference to stdout.
   `build.sh` captures that output, `docker tag`s to it, `docker push`es. This is the same
   shell-into-plugin-Python bridge shape `nagelfluh-migrate` already establishes (entry-point
   discovery), just applied to a new hook name — core only ever exercises this with `docker-v2`;
   any other protocol's `configure_push_auth`/`image_url` behavior is that plugin's concern.
6. **Generalize "config.env can seed a default backend that needs live provisioning" to all three
   axes (registry, storage, cluster) via one shared `bootstrap()` hook and one new host-side entry
   point** — even though core has no protocol that actually *needs* live provisioning today
   (`docker-v2`/`minio`/`kubeconfig` are all passthroughs), the hook and its plumbing are added here
   so that plugin-provided protocols (e.g. `gar`, `gcs`, `gke`) have somewhere to plug into without
   any host-repo changes:
   - `config.env` gains a uniform shape for all three axes:
     ```bash
     REGISTRY_PROTOCOL=docker-v2
     REGISTRY_CONFIG_JSON={"user":"nagelfluh","password":"nagelfluh","public_host":"192.168.1.142"}

     STORAGE_PROTOCOL=s3
     STORAGE_CONFIG_JSON={...}

     CLUSTER_TYPE=kubeconfig
     CLUSTER_CONFIG_JSON={...}
     ```
     Existing `REGISTRY_USER`/`STORAGE_ENDPOINT`/etc. keep working unchanged as a fallback when
     `*_PROTOCOL`/`*_CONFIG_JSON` aren't set explicitly (backward compatible for anyone not opting
     into a plugin-provided protocol).
   - One new common ABC method, `bootstrap(config: dict) -> dict`, added to all three handler bases —
     `RegistryProtocolHandler` (new), `StorageProtocolHandler`, `ClusterProvider` (new capability
     there — no such hook exists on it today). Every core-provided handler/provider implements it as
     a passthrough (`return config`); this plan does not implement any live-provisioning `bootstrap()`
     — that is entirely plugin territory (see the GCP plugin's own plan for `gar`, and any future
     plan for `gcs`/`gke` bootstrap).
   - One new host-side entry point, `backend/bin/nagelfluh-bootstrap-provision` (same
     shell-into-Python-entry-point shape as `nagelfluh-migrate`). For each axis present in the
     environment, it resolves the handler via the existing hook-backed registries
     (`get_protocol_handler`, `get_cluster_provider`, the new `get_registry_protocol_handler`), calls
     `.bootstrap(config)`, and emits the enriched `{protocol, config}` results (e.g. as JSON).
   - **Consuming the output differs by deployment mode:**
     - **dev** (`dev/runall.sh`): runs on the host with direct SQLite access — the enriched config is
       written straight into the three default DB rows.
     - **prod-minikube** (`prod/runall-minikube.sh`): the enriched JSON is folded into
       `nagelfluh-backend-secret`/`nagelfluh-backend-config` alongside `MINIO_ROOT_PASSWORD`/
       `REGISTRY_AUTH` (today's `--from-literal` block, lines ~122–201), which then needs `envFrom`
       added to the `alembic-migrate` Job — closing the pre-existing gap noted in Background. The
       seed migrations read `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON` from their env and upsert the
       corresponding default row — no live-provisioning calls happen in-cluster; any such call would
       already have happened host-side, in the operator's own environment, one step earlier (a
       concern for whichever plugin's `bootstrap()` actually does one).
7. **Seed migrations become generic, replacing today's hardcoded ones.** `182d880e84c7`'s
   MinIO-specific field names and `f6a7b8c9d0e1`'s stale schema assumptions are replaced by a uniform
   "read `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON`, upsert the default row's `protocol`/`config`" shape
   for all three axes — a new migration per axis (registry needs one regardless, since the model is
   new; storage/cluster get a follow-up migration replacing the old hardcoded ones).
8. **Generalize cluster job-readiness provisioning (Kueue/RBAC/queues) into one provider-agnostic
   Python routine, replacing both existing shell implementations.** Since installing Kueue, waiting
   for it, sizing/applying quotas and queues, and applying RBAC are pure Kubernetes API operations —
   nothing about them actually depends on `cluster_type` once a `K8sClient` exists — this becomes a
   single `ensure_cluster_job_ready(k8s_client, namespace, quota_config)` routine
   (`backend/services/cluster_job_provisioning.py`), written against `kubernetes_asyncio` (the same
   library `K8sClient`/`GkeK8sClient` already use), not shell/`kubectl`:
   - **Quota sizing uses real node allocatable capacity** (`list_node()`), uniformly — the more
     general of the two approaches the current shell scripts use (GKE's), and it works identically
     for minikube. `MINIKUBE_CPUS`/`MINIKUBE_MEMORY` remain relevant only for `minikube start
     --cpus/--memory` itself, a separate, earlier, shell-side step — not for quota sizing anymore.
   - **Webhook readiness uses `kubectl wait`-equivalent (poll the Deployment's `available` condition)
     plus polling the webhook Service's Endpoints for a populated address** — both doable purely via
     the K8s API, replacing the `minikube ssh`-only reachability probe (which no other provider can
     perform) with something every provider supports identically.
   - **RBAC (the `nagelfluh-backend-jobs` Role/RoleBinding + `nagelfluh-backend-kueue-reader`
     ClusterRole/ClusterRoleBinding) is applied unconditionally, every time**, preserving today's
     "same least-privilege intent regardless of whether this cluster's identity model strictly needs
     it" policy.
   - **The registry-pull-secret step is dropped entirely** from this routine — superseded by Design
     decision 4's per-Job ephemeral pull credentials, not ported forward.
   - **Invoked from one generic call site**, not three divergent ones: `register-callback`'s claim
     path (`admin.py`), right after `test_connection()` succeeds and before/as the row becomes
     usable. Any plugin-provided `cluster_type` (e.g. a future `gke`, whether registered via the
     existing self-service-registration flow or via a `bootstrap()`-created default `Cluster`, see
     `plugins/ymerflow-gcp/docs/plans/gcs-gke-bootstrap-provisioning.md`) gets job-readiness for free
     from this one path — it never needs to reimplement any of this itself.
   - `dev/lib/provision-nagelfluh-jobs.sh` shrinks down to whatever remains genuinely shell-only for
     local dev (namespace creation can even move into the generic routine too — see Phase 7); the
     Kueue/RBAC/queue logic it currently contains is deleted from it, not kept as a second
     implementation alongside the new Python one.

## Open items to confirm at implementation time

- Whether `nagelfluh-bootstrap-provision`'s dev-mode DB write should go through Alembic (so it's
  versioned/re-runnable via the same migration chain) or write directly — leaning towards *emitting*
  the enriched config for the seed migrations to consume identically in both dev and prod-minikube
  mode, so there's exactly one code path that writes to `registry_backends`/`storage_backends`/
  `clusters`, not two.
- Whether the static per-namespace `nagelfluh-registry-pull` Secret is dropped entirely once per-Job
  pull secrets exist, or kept as a fallback for some case — decide once Phase 3 is implemented and it's
  clear whether anything else still depends on it.
- Confirm no other code path reads `settings.registry_url`/`settings.registry_auth` directly besides
  the ones enumerated in Background before removing them from `Settings`.
- Exact insertion point for `ensure_cluster_job_ready()` within `register-callback` — right after
  `test_connection()` succeeds (decision 8) versus only once the admin actually claims the row via
  `admin_update_cluster`/Save. Leaning towards right after `test_connection()`, since a pending row
  that never gets claimed is harmless either way and it means the admin sees a fully job-ready
  cluster the moment they claim it, not a further wait.
- Whether `admin_create_cluster` (the direct, non-self-service path used by `same-as-backend`/
  `kubeconfig` today) should also call `ensure_cluster_job_ready()`, or whether that path already
  gets it some other way (e.g. `dev/setup-minikube.sh` calling it directly for the local default
  cluster) — confirm there's exactly one place a given `Cluster` gets provisioned, not zero or two.
- **A config.env-driven default `Cluster` seeded via `bootstrap()` (Design decision 6) never goes
  through `register-callback` at all** — it's written directly by the generic seed migration (Phase
  6). `ensure_cluster_job_ready()` needs a second call site for this path too: once
  `nagelfluh-bootstrap-provision`'s seed migration has upserted the default `Cluster` row, call it
  there (dev: right after the direct DB write; prod-minikube: from the in-cluster seed migration,
  since that's where a working `K8sClient` for the newly-configured cluster can actually be
  constructed). A plugin's `bootstrap()` (e.g. `gke` in `plugins/ymerflow-gcp`) must **not** call
  `ensure_cluster_job_ready()` itself — it only ever produces the credential; this host-repo call
  site is what makes job-readiness happen for a bootstrap-seeded cluster, exactly as it does for a
  self-service-registered one.
- Whether `dev/lib/provision-nagelfluh-jobs.sh`'s namespace-creation step also moves into the new
  Python routine (decision 8 leans yes) or stays shell-side for the local dev bootstrap specifically.

## Phases

### Phase 1 — Core registry abstraction
- `backend/models/registry_backend.py`: `RegistryBackend` model, `get_default_registry_backend_id()`.
- `backend/services/registry_protocols/__init__.py`: `RegistryProtocolHandler` ABC,
  `registry_protocol_handlers` hook, `get_registry_protocol_handler()`.
- `backend/services/registry_protocols/docker_v2.py`: wraps today's `dev/setup-registry.sh` registry —
  `image_url`, `pull_credentials` (static user/password), `configure_push_auth` (`docker login`),
  `test_connection`, CA-fetch logic moved in from `admin.py`'s `_fetch_registry_ca_pem`,
  `bootstrap` = passthrough.
- Register `("docker-v2", DockerV2ProtocolHandler)` in root `setup.py`'s `registry_protocol_handlers`.
- New Alembic migration creating `registry_backends` + seeding the default row from
  `REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON` (falling back to today's `REGISTRY_USER`/`PASSWORD`/
  `PUBLIC_HOST` if unset).

### Phase 2 — Push-side generalization
- `backend/bin/nagelfluh-registry-push`: new entry point per decision 5.
- `docker/build.sh`: replace hardcoded registry logic with a call into the new entry point.

### Phase 3 — Pull-side per-Job ephemeral credentials
- `backend/services/job_orchestrator.py`: resolve the active `RegistryBackend`, call
  `pull_credentials()`, create/attach a per-Job `kubernetes.io/dockerconfigjson` Secret instead of the
  fixed `nagelfluh-registry-pull` Secret. Update `dev/lib/provision-nagelfluh-jobs.sh` /
  `setup-minikube-remote.sh` accordingly.

### Phase 4 — Generic `bootstrap()` mechanism (hooks only, no live provisioning)
- Add `bootstrap()` to `RegistryProtocolHandler`, `StorageProtocolHandler`, `ClusterProvider`,
  implemented as a passthrough on every core handler/provider (`docker-v2`, `minio`/`s3`,
  `same-as-backend`/`kubeconfig`/`minikube`).
- `backend/bin/nagelfluh-bootstrap-provision`: new entry point per decision 6.
- `config.env.example`: document `REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON`,
  `STORAGE_PROTOCOL`/`STORAGE_CONFIG_JSON`, `CLUSTER_TYPE`/`CLUSTER_CONFIG_JSON`.

### Phase 5 — Wire bootstrap into dev and prod-minikube flows
- `dev/runall.sh`: call `nagelfluh-bootstrap-provision` before migrations; write enriched config to
  the dev DB.
- `prod/runall-minikube.sh`: call it host-side, fold the enriched JSON into
  `nagelfluh-backend-secret`/`nagelfluh-backend-config`, add the missing `envFrom` to the
  `alembic-migrate` Job.

### Phase 6 — Generic seed migrations
- Replace `182d880e84c7`/`f6a7b8c9d0e1`'s hardcoded shapes with the generic
  `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON` upsert pattern for all three of `registry_backends`,
  `storage_backends`, `clusters`.

### Phase 7 — Generic cluster job-readiness provisioning
- `backend/services/cluster_job_provisioning.py`: `ensure_cluster_job_ready(k8s_client, namespace,
  quota_config)` per Design decision 8 — namespace, Kueue install + readiness waits, node-capacity-
  based quota sizing, `ResourceFlavor`/`ClusterQueue`/`LocalQueue`, backend RBAC. Pure
  `kubernetes_asyncio`, no shell/`kubectl` subprocess calls.
- Wire it into `POST /admin/clusters/register-callback` (`admin.py`) per the Open items' resolved
  insertion point, **and** into the seed-migration path for a `bootstrap()`-seeded default `Cluster`
  (Phase 6/Design decision 6) — the two call sites a `Cluster` can become active through.
- Strip the now-superseded Kueue/RBAC/queue/registry-pull-secret logic out of
  `dev/lib/provision-nagelfluh-jobs.sh`, leaving only whatever remains genuinely shell-only for local
  dev (if anything).
- Update `dev/setup-minikube.sh` accordingly (it currently sources and calls
  `provision_nagelfluh_jobs()` directly for the local default cluster — decide whether it now instead
  triggers the same Python path, e.g. by calling `register-callback`-equivalent logic locally, or
  keeps a thin shell call into the new Python routine).

## Manual verification

- Local (default) cluster/backends: fresh `dev/runall.sh`, confirm `docker-v2`/`s3`(minio)/
  `kubeconfig` defaults still work end to end with no `config.env` changes from today (backward
  compatibility) — build, push, and run a process.
- `prod-minikube` deployment: confirm the `alembic-migrate` Job now receives the enriched
  `REGISTRY_CONFIG_JSON`/etc. via `envFrom` and seeds the default rows correctly.
- Confirm a Job pod's pull secret is created per-Job and reflects `pull_credentials()`'s output
  rather than the old static `nagelfluh-registry-pull` Secret.
- Confirm `bootstrap()` being a no-op passthrough for every core protocol/provider doesn't change
  observable behavior for any existing deployment.
- Protocol-specific behavior (GAR, and any future `gcs`/`gke` bootstrap) is verified by each plugin's
  own plan, not here — this plan's verification is scoped to the hooks and the `docker-v2` reference
  implementation.
- Register a remote minikube cluster end to end via the existing self-service flow: confirm
  `ensure_cluster_job_ready()` (Phase 7) produces the same end state the old shell logic did
  (namespace, Kueue, quotas, queues, RBAC — no registry pull secret anymore, per decision 8/Phase 3),
  and that a process actually runs on it afterward.
- Confirm the local default cluster (`dev/runall.sh`) still ends up job-ready after Phase 7's change
  to `dev/setup-minikube.sh`/`dev/lib/provision-nagelfluh-jobs.sh` — same end state as before the
  shell logic was stripped out.

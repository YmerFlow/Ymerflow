# Generic deployment/build orchestration — remove remaining minikube special-casing

## Goal

`docs/plans/done/minikube-provisioning-plugin.md` (commit `407c30f`, "Moved minikube support to
separate plugin") moved the *backend Python* pieces of minikube support out of the main repo —
`backend/services/cluster_providers/minikube.py`, `backend/services/registry_protocols/docker_v2.py`,
`backend/services/minio_service.py`, `backend/services/storage_protocols/minio.py`,
`dev/setup-minikube.sh`/`setup-minio.sh`/`setup-registry.sh` — into `plugins/ymerflow-minikube`.
It did **not** finish the job: orchestration *shell scripts* (`docker/build.sh`,
`prod/runall-minikube.sh`, `dev/runall.sh`, `dev/prepull-images.sh`, `dev/cleanup-*.sh`,
`scripts/install-deps-on-debian.sh`) and even one *backend router*
(`backend/routers/admin.py`'s self-service cluster-registration callback) still hardcode
minikube/docker-v2/MinIO assumptions directly.

This plan finishes that migration, fully: **no minikube-specific behavior anywhere in the main
repo that isn't reached through the `ClusterProvider`/`RegistryProtocolHandler`/
`StorageProtocolHandler` hook system** (`backend/services/{cluster_providers,registry_protocols,
storage_protocols}/__init__.py`). Every script in `dev/`, `prod/`, `docker/` should call only
generic Python entry points that dispatch through those hooks; every backend code path that
branches on cluster type should do so via a provider flag/method, never a literal `"minikube"`
string. Anything that only makes sense for a self-hosted Minikube-on-Docker setup moves into
`plugins/ymerflow-minikube`. A hypothetical GKE-only deployment should need nothing from `dev/`,
`prod/`, `docker/`, or `scripts/` that assumes Minikube exists.

**Explicitly not a goal**: build/deploy performance. That's a separate, deprioritized concern —
don't let it creep into this plan's scope or reviews.

## Background — current state

(Confirmed by reading the actual code, not assumed. A full repo-wide grep for `minikube` outside
`plugins/`, `node_modules/`, `env/`, `.git/`, `docs/` was run to find everything below — see
Verification for the exact command.)

### Already fully generic — do not touch

- `ClusterProvider`/`RegistryProtocolHandler`/`StorageProtocolHandler` ABCs, each with `bootstrap()`,
  discovered via the `nagelfluh.hooks` fan-out.
- `backend/bin/yf-bootstrap-provision` — resolves whichever `<AXIS>_PROTOCOL`/
  `<AXIS>_CONFIG_JSON` pairs are set and calls `.bootstrap()` on each; zero minikube-specific logic.
- `backend/bin/yf-deploy-app` — resolves the registry + cluster axes generically and calls
  `provider.deploy_app()`/`provider.expose_app()`; zero minikube-specific logic.
- `backend/services/app_deployment.py` (`apply_app_workloads`), `NodePortAppDeploymentMixin` —
  provider-agnostic (NodePort exposure is shared by `same-as-backend` *and* `minikube`, not itself
  a minikube concept).
- `backend/services/job_orchestrator.py` — process Jobs reference the runner image by resolved
  registry ref + a per-Job pull secret minted via `RegistryProtocolHandler.pull_credentials()`. No
  dependency on any image being present in a local Docker daemon.
- `backend/services/cluster_job_provisioning.py`'s `ensure_cluster_job_ready()` — provider-agnostic
  Kueue/RBAC/namespace provisioning, called generically wherever a `Cluster` row is registered/seeded.
- `k8s/backend/deployment.yaml` / `k8s/frontend/{deployment,service}.yaml` — explicitly commented
  "MANUAL / OPT-OUT PATH ONLY", a generic fallback for operators who bypass `deploy_app()`/
  `expose_app()` entirely. Not automatically applied by anything minikube-specific; no change needed.
- Frontend admin UI (`ClustersAdminPanel.jsx`, `App.jsx`, etc.) — lists `cluster_type` values
  data-driven from whatever's registered; "minikube" appearing there is display of plugin-provided
  data, not hardcoded branching.

### Hardcoded to minikube/docker-v2/MinIO — in scope for this plan

**Build/push:**
- **`docker/build.sh`**: gates on `minikube status`, does `eval $(minikube docker-env)` to build
  *and* `docker push` against minikube's internal Docker daemon. The plain `docker push` only
  works because minikube's internal dockerd was started with `--insecure-registry` for the
  self-signed registry cert — `DockerV2ProtocolHandler.configure_push_auth()`
  (`plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py:232`) only does `docker login`
  (credentials), not TLS trust, and its own docstring admits it "preserves today's
  `docker/build.sh` behavior" — this was always a workaround, never a designed contract.
- **`prod/runall-minikube.sh` Step 5**: a hand-rolled `push_image()` bash function
  (`docker save` → `crane push --insecure`) solving the same TLS-trust problem for the host daemon,
  duplicated instead of living on `RegistryProtocolHandler`.

**Config/secrets:**
- **`prod/runall-minikube.sh` Step 6**: the `ymerflow-backend-config` ConfigMap hardcodes
  `STORAGE_PROTOCOL: "s3"`, `STORAGE_ENDPOINT: "https://minio.minio.svc.cluster.local:9000"`,
  `MINIO_ROOT_USER`. Grepped `backend/config.py` and `backend/services/storage_protocols/*.py` —
  zero hits. Likely dead weight from before `STORAGE_CONFIG_JSON` existed (verify and drop).
- **`prod/runall-minikube.sh` Step 6c**: builds the deploy-Job's own image-pull secret via
  `kubectl create secret docker-registry --docker-username=... --docker-password=...` — assumes
  docker-v2's basic-auth shape directly instead of `RegistryProtocolHandler.pull_credentials()`
  (already resolved generically in Step 3's bootstrap-provision output).

**Readiness/connectivity checks:**
- **`dev/runall.sh` Step 6**: hand-rolled "wait for `registry` Deployment, then curl its `/v2/`
  endpoint in a retry loop" — duplicates `DockerV2ProtocolHandler.test_connection()`, and assumes
  a registry that's a k8s Deployment at all (meaningless for a managed registry like GAR).

**Image pre-pull:**
- **`dev/prepull-images.sh`** + **`dev/images.env`**: `minikube ssh -- docker pull` for
  `MINIO_IMAGE`/`REGISTRY_IMAGE`. Both images are already independently declared as constants
  inside the plugin (`storage_protocol.py:39`, `registry_protocol.py:54`) — `dev/images.env` is a
  second, out-of-sync source of truth for the same values.

**Teardown/cleanup:**
- **`dev/cleanup-minikube.sh`**: despite the name, its actual content (delete Kueue
  clusterqueue/resourceflavor, delete the `nagelfluh-jobs` namespace) is **not** minikube-specific
  at all — it's the teardown mirror of `ensure_cluster_job_ready()`. No generic teardown
  counterpart to that function exists yet.
- **`dev/cleanup-all.sh`**: genuinely minikube-specific — gates on `minikube status`, hardcodes
  deleting the `registry`/`minio` namespaces by name, prints `minikube stop`/`minikube delete`
  hints. No generic teardown entry point exists to mirror `yf-bootstrap-provision`.

**Host prep:**
- **`scripts/install-deps-on-debian.sh`**: unconditionally installs the `minikube` binary and
  `docker.io`, regardless of which cluster plugin (if any) is actually going to be used.

**Self-service cluster registration (backend router):**
- **`backend/routers/admin.py`, `cluster_register_callback`**: hardcodes `cluster_type="minikube"`
  when lazily creating the pending `Cluster` row for an unrecognized registration token. Its own
  comment: *"Only 'minikube' self-service-registers today; hardcoded here... `cluster_type` would
  need to travel with the callback (e.g. as a query param) to generalize this to a second
  self-service provider."* The `/static/assets/setup-minikube-remote.sh` endpoint and
  `dev/setup-minikube-remote.sh.in` template are similarly named/scoped to a single provider.
  (`admin_create_cluster`/`admin_test_cluster_connection` elsewhere in the same file already
  dispatch via `provider.self_service_registration`/`get_cluster_provider(cluster_type)` — this is
  the one hardcoded exception, not a systemic problem in this file.)

### Not touched by this plan (noted so reviewers don't expect it)

- `dev/lib/provision-nagelfluh-jobs.sh` — per its own docstring, most of its old job already moved
  into `ensure_cluster_job_ready()`; only namespace creation remains, used solely by the
  remote-cluster self-service registration script path. Not minikube-specific (it's a generic, if
  now nearly-empty, helper for that flow). No change needed.
- Database backend pluggability — Postgres is not a pluggable axis; `k8s/postgres/` stays a static
  manifest regardless of cluster type.
- pgAdmin/Headlamp conditionality — deployed unconditionally today; whether these should become
  optional/hook-driven per cluster type is a separate question, not addressed here.

## Design decisions (settled in discussion)

1. **`push_image()` becomes a method on `RegistryProtocolHandler`**, with the crane-based
   save-then-push mechanism shared rather than reimplemented per protocol — either a concrete
   base-class method parameterized by an overridable "insecure/skip-verify" signal, or a shared
   helper function both protocol implementations call (pick whichever reads cleaner once written).
   `DockerV2ProtocolHandler.push_image()` supplies `insecure=True`; a future GAR handler would
   supply `insecure=False` or override entirely if crane's auth model doesn't fit Workload Identity.
2. **One generic build-and-push entry point**, used identically for backend, frontend, and runner
   images. Replaces `docker/build.sh`'s bespoke build+push and `prod/runall-minikube.sh` Step
   2/5's bespoke build+push. Builds always run against the host's own Docker daemon — never
   `minikube docker-env`.
3. **`dev/prepull-images.sh` and `dev/images.env` are deleted.** `MinioProtocolHandler.bootstrap()`
   and `DockerV2ProtocolHandler.bootstrap()` each pre-pull their own image as part of their own
   `bootstrap()` — no new hook needed.
4. **`prod/runall-minikube.sh` is renamed to `prod/runall-production.sh`.** Update every reference.
5. **Self-service registration callback takes `cluster_type` as a query param**
   (`POST /admin/clusters/register-callback?cluster_type=X`) instead of hardcoding `"minikube"`.
   The per-provider setup-script template is rendered with that type already known, so it can post
   it back; the callback creates the pending row with whatever type is given.
6. **`ClusterProvider.teardown()` (new, optional hook) never runs `minikube stop`/`minikube
   delete`.** It only removes the k8s-level resources this provider's `bootstrap()` created
   (namespaces, Kueue config, etc.). Stopping/deleting the VM itself stays a manual, explicit
   operation — printed as guidance, same as today, never automated. Lower blast radius than
   automating destruction of a local VM.
7. **`dev/cleanup-minikube.sh` is deleted outright.** Its Kueue/jobs-namespace teardown logic
   becomes a shared, provider-agnostic helper (mirroring `ensure_cluster_job_ready()`), called by
   the new generic teardown entry point `dev/cleanup-all.sh` uses. No separate minikube-named
   script remains.
8. **`scripts/install-deps-on-debian.sh` drops `minikube`/`docker.io` entirely**, keeping only
   genuinely generic host deps (python, node, kubectl, etc.). `plugins/ymerflow-minikube` ships
   its own install-deps script/doc for whoever chooses that plugin, invoked separately.

## Phases

### Phase 1 — `push_image()` on `RegistryProtocolHandler`

- Add `push_image(local_image_ref: str, config: dict, repository: str, tag: str) -> str` to the
  ABC (returns the full pushed ref, mirroring `image_url()`'s return shape).
- Implement it on `DockerV2ProtocolHandler`: move the `docker save` / crane-auth-config /
  `crane push --insecure` logic verbatim out of `prod/runall-minikube.sh`'s `push_image()` bash
  function into this method (shells out via `subprocess`, matching this file's existing style —
  see `configure_push_auth()`).

### Phase 2 — one generic build-and-push entry point

- New entry point (shell wrapper around Python, or pure Python — TBD at implementation time;
  interface: `<dockerfile> <build-context> <repository> <tag> [docker build args...]`) that:
  1. `docker build` on the host daemon,
  2. resolves the active `RegistryBackend` (reuse `nagelfluh-registry-push`'s DB-lookup /
     `--resolve-only` pattern for the production-minikube in-pod-then-host split),
  3. calls `push_image()`,
  4. prints only the final pushed ref to stdout (clean-stdout discipline).
- `docker/build.sh` calls this instead of `minikube status`/`eval $(minikube docker-env)`/
  `docker build`/`docker tag`/`docker push`. Schema extraction
  (`docker run --rm --entrypoint cat ... /app/process_schemas.json`) runs against the host daemon.
- `prod/runall-production.sh` Step 2 (backend/frontend `docker build`) and Step 5 (the crane
  `push_image()` bash function) collapse into two calls to this same entry point.

### Phase 3 — fold image pre-pull into protocol `bootstrap()`

- Delete `dev/prepull-images.sh`, `dev/images.env`.
- `MinioProtocolHandler.bootstrap()` pre-pulls `MINIO_IMAGE`; `DockerV2ProtocolHandler.bootstrap()`
  pre-pulls `REGISTRY_IMAGE` (both already define these constants — add the
  `minikube ssh -- docker pull` call before each applies its Deployment).
- `dev/runall.sh`/`prod/runall-production.sh` drop their explicit "namespaces + pre-pull images"
  step; `kubectl apply -f k8s/00-namespaces.yaml` stays (genuinely generic).

### Phase 4 — replace hand-rolled registry-wait/test logic

- `dev/runall.sh` Step 6: delete the `kubectl wait --for=condition=available deployment/registry`
  + curl retry loop. `DockerV2ProtocolHandler.bootstrap()` already calls
  `wait_deployment_available()` internally — its return is already the readiness contract. Replace
  with (at most) a thin generic connectivity check calling
  `get_registry_protocol_handler(protocol).test_connection(config)` against the already-resolved
  config from Step 2's bootstrap-provision output, or drop the check entirely and trust
  `bootstrap()`. Decide during implementation.

### Phase 5 — drop hardcoded ConfigMap/Secret literals in `prod/runall-production.sh`

- Step 6: confirm `STORAGE_PROTOCOL`/`STORAGE_ENDPOINT`/`MINIO_ROOT_USER` are genuinely unread and
  drop them from the ConfigMap if so.
- Step 6c: resolve the deploy-Job's own image-pull secret via
  `RegistryProtocolHandler.pull_credentials()` instead of assuming docker-v2's
  `--docker-username`/`--docker-password` shape.

### Phase 6 — rename

- `prod/runall-minikube.sh` → `prod/runall-production.sh`. Update `runall.sh`,
  `docs/deployment.md`, `CLAUDE.md`, and every comment elsewhere in the repo naming the old path.

### Phase 7 — generic teardown hooks

- Add optional `teardown(config) -> None` to `RegistryProtocolHandler` and
  `StorageProtocolHandler` (default: no-op passthrough, mirroring `bootstrap()`'s default
  passthrough for core-provided handlers). `DockerV2ProtocolHandler.teardown()` deletes the
  `registry` namespace; `MinioProtocolHandler.teardown()` deletes the `minio` namespace.
- Add optional `teardown(provider_config) -> None` to `ClusterProvider` (default: no-op).
  `MinikubeClusterProvider.teardown()` deletes the `nagelfluh-jobs` namespace + Kueue
  clusterqueue/resourceflavor (moved from `dev/cleanup-minikube.sh` — factor this out as a shared
  helper in `backend/services/cluster_job_provisioning.py`, e.g. `teardown_cluster_job_ready()`,
  mirroring `ensure_cluster_job_ready()`, so any provider can call it, not just minikube's). Per
  Design decision 6, does **not** touch the Minikube VM itself.
- New `backend/bin/yf-bootstrap-teardown`, structurally mirroring
  `yf-bootstrap-provision`: resolves whichever `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON` pairs
  are set and calls `.teardown()` on each.

### Phase 8 — generic cleanup scripts

- Delete `dev/cleanup-minikube.sh` (Design decision 7).
- `dev/cleanup-all.sh` becomes protocol-agnostic: screen-session/port-forward cleanup stays as
  plain shell (not cluster-specific), but the registry/MinIO/Kueue/namespace teardown steps are
  replaced by one call to `yf-bootstrap-teardown`. Drop the `minikube status` gate (the
  teardown entry point should itself be a no-op/harmless if nothing is bootstrapped). Keep the
  final `minikube stop`/`minikube delete` hint text as manual guidance only (Design decision 6) —
  but phrase it generically ("stop/delete your cluster, e.g. `minikube delete` for a local
  Minikube setup") rather than assuming Minikube.

### Phase 9 — plugin-owned host prep

- `scripts/install-deps-on-debian.sh`: remove the `minikube` binary install and the `docker.io`
  install (Design decision 8) — keep only deps every deployment needs regardless of cluster
  plugin (python, node, kubectl, etc.). Verify nothing else in the script secretly depends on
  Docker being present for a non-minikube path before removing it.
- `plugins/ymerflow-minikube` gains its own install-deps script/doc (exact location/form —
  `plugins/ymerflow-minikube/scripts/install-deps.sh` or a docs section — TBD at implementation
  time) covering `docker.io` + `minikube`, referenced from this repo's deployment docs as "if
  you're using the minikube plugin, also run ...".

### Phase 10 — generalize self-service cluster registration

- `backend/routers/admin.py`'s `cluster_register_callback`: accept `cluster_type` as a query
  param; use it (not the literal `"minikube"`) when lazily creating the pending `Cluster` row.
  Validate it against `get_cluster_provider(cluster_type).self_service_registration` before
  accepting, so an unregistered/non-self-service type can't be used to forge a pending row.
- The setup-script rendering path (`GET /static/assets/setup-minikube-remote.sh`,
  `dev/setup-minikube-remote.sh.in`) needs the same generalization so its generated command posts
  the right `cluster_type` back to the callback. Exact mechanism (a generic endpoint keyed by
  `cluster_type` reading a per-provider template path/convention, vs. today's single hardcoded
  endpoint kept as-is until a second self-service provider actually exists) — decide during
  implementation; flag here if it turns out more involved than expected, since
  `plugins/ymerflow-minikube` is still the only self-service provider today and there's a real
  YAGNI case for keeping the endpoint itself minikube-named while just fixing the callback's
  `cluster_type` hardcoding (Design decision 5 already covers the load-bearing part of this).

## Verification

- `grep -rIl minikube --include="*.sh" --include="*.py" --include="*.yaml" --include="*.yml"
  --include="*.js" --include="*.jsx" . | grep -v -E "^\./(plugins|node_modules|env|\.git|docs)/"`
  returns only: doc/comment prose that's *about* the plugin (not driving behavior), and
  `dev/setup-minikube-remote.sh.in` / its rendering endpoint name if Phase 10 keeps that
  particular naming (see Phase 10's open note). No script contains a hardcoded `minikube`/
  `docker-v2`/`minio` conditional or literal outside `plugins/`.
- Dev flow: `minikube delete` → `./dev/runall.sh` end-to-end with `plugins/ymerflow-minikube` as
  the configured backend plugin; confirm images build on the host daemon (check `docker images`
  without `minikube docker-env` active) and push successfully.
- Prod flow: `./prod/runall-production.sh` end-to-end; confirm the app is reachable and process
  Jobs still run.
- Teardown flow: `./dev/cleanup-all.sh` end-to-end; confirm registry/minio/jobs namespaces and
  Kueue config are gone, Minikube VM itself is untouched (still running), and the script exits
  cleanly with no error when run a second time in a row (idempotent, matching `bootstrap()`'s own
  idempotency).
- If `plugins/ymerflow-gcp` is installed instead of `plugins/ymerflow-minikube`: confirm
  `prod/runall-production.sh` gets as far as issuing GKE-appropriate calls without hitting any
  `minikube`-specific code path. (Full GCP end-to-end likely isn't reachable in this dev
  environment without real GCP credentials — note as a known limitation of this verification pass,
  not a blocker for the plan.)

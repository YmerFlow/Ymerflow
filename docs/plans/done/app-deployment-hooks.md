# Pluggable app deployment (backend + frontend hosting) — Plan

## Goal

Generalize *deploying the Nagelfluh application itself* (backend + frontend pods, their exposure,
and their config/secrets) onto whatever cluster a deployment's default `Cluster` row points at —
today this only works for Minikube, via `prod/runall-minikube.sh`'s raw shell/`kubectl`
orchestration, entirely outside the pluggable-backend system. This plan adds the hook a
`ClusterProvider` needs to support "also host the app," mirroring exactly how `Cluster`/
`ClusterProvider` already make *process/analysis Job execution* pluggable
(`docs/plans/done/registry-backend-hooks.md` Design decision 8, `ensure_cluster_job_ready()`).

**This plan is host-repo work only.** It defines the hook, a shared K8s-API helper for the
provider-agnostic parts, and reference implementations for the two cluster types core already
ships (`same-as-backend`, `minikube`). It does **not** implement support for any cloud-managed
cluster type — that is a separate, dependent plan for whichever plugin adds one, implementing this
same hook for its own `ClusterProvider`, the same relationship a plugin's own `bootstrap()`
implementation already has to `registry-backend-hooks.md`.

## Background — current state

(Confirmed by reading the implemented code, not just the docs.)

- **`Cluster`/`ClusterProvider` (`backend/services/cluster_providers/__init__.py`) already gives a
  pluggable, credentialed `K8sClient` per `cluster_type`**, but it's used today only for
  process/analysis Jobs (`backend/services/job_orchestrator.py`,
  `backend/services/cluster_job_provisioning.py`'s `ensure_cluster_job_ready()`). Nothing routes
  *app hosting* through it.
- **The default `Cluster` seeded from config.env is always the same cluster the backend itself
  runs on** (confirmed assumption, settled in discussion) — "which cluster runs Jobs" and "which
  cluster hosts the app" are the same row. This plan does **not** add a new pluggable axis/model;
  it extends the existing `ClusterProvider` ABC with app-hosting capability methods.
- **`prod/runall-minikube.sh` is pure shell, bypasses `Cluster`/`ClusterProvider` entirely, and is
  the only place any of this is implemented today:**
  - Builds backend and frontend images directly into Minikube's Docker daemon
    (`eval $(minikube docker-env)` then `docker build`) — never pushed anywhere.
    `k8s/backend/deployment.yaml`/`k8s/frontend/deployment.yaml` hardcode
    `imagePullPolicy: Never`, which only works because the image already exists in-daemon.
  - Config/secrets (JWT key, MinIO creds, registry auth, bootstrap-provisioned
    `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON`, admin creds) are created imperatively via
    `kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -`, against whichever
    kubeconfig context is currently active on the host running the script — not resolved through
    any `Cluster` row.
  - The JWT signing key is persisted **on the host filesystem**
    (`${NAGELFLUH_DATA_DIR}/jwt_secret_key`, default `~/.nagelfluh/data`) so it survives
    `minikube delete && minikube start`. This mechanism assumes the deploying host and the cluster
    share a filesystem — true for Minikube, not true for a cluster only reachable over the network.
  - Exposure is a hardcoded `NodePort` (`k8s/frontend/service.yaml`, port 30080), published on the
    host by Minikube's docker driver; `SERVER_URL` defaults to `http://$(hostname -I):30080`.
  - The DB migration step is a raw `kubectl apply` of a `batch/v1 Job` with a **hardcoded**
    `image: ymerflow-backend:prod` and a literal `DATABASE_URL` (lines ~374–398 of the script) —
    duplicated again as an initContainer on the backend Deployment itself.
  - `kubectl apply -R -f "${PROJECT_ROOT}/k8s/"` applies namespaces, Postgres, backend/frontend,
    RBAC, Headlamp/pgAdmin — assumes one single reachable cluster/kubeconfig context for
    everything.
- **No TLS termination exists in-cluster today** (grepped the repo for
  `letsencrypt|cert-manager|acme|certbot|ManagedCertificate`: zero hits). Whatever HTTPS the
  current production deployment has is handled entirely outside this repo, in front of the
  cluster. This plan doesn't touch that; it only adds a hook so a cloud-managed cluster with no
  such external edge can terminate TLS itself, via whichever provider-specific plugin implements
  `expose_app()` for that cluster type.
- **The registry axis already exists and is reusable here.**
  `docs/plans/done/registry-backend-hooks.md` added `RegistryBackend`/`RegistryProtocolHandler`,
  `image_url()`/`pull_credentials()`/`configure_push_auth()`, and per-Job ephemeral pull secrets —
  today wired up only for the process-runner image (`docker/build.sh` →
  `backend/bin/yf-registry-push`). Backend/frontend images are not pushed through it at
  all. Any cluster that isn't sharing a Docker daemon with the build host (i.e. anything but
  Minikube's local-daemon trick) needs its app images to go through this same axis.
- **`self_service_registration` on `ClusterProvider`** is the existing precedent for a per-type
  capability flag that changes control flow without touching the router (see
  `backend/services/cluster_providers/__init__.py:29`) — the natural shape for gating whether a
  given `cluster_type` supports automated app deployment at all (a generic `kubeconfig`
  bring-your-own cluster realistically can't auto-know its own Ingress class, for example).

## Design decisions (settled in discussion)

1. **No new pluggable axis.** App hosting always targets the same `Cluster` row that job
   execution's provider (`same-as-backend`/`kubeconfig`/`minikube`/any future plugin-provided type)
   already resolves. This generalizes the existing `ClusterProvider` ABC; it does not introduce a
   second `Cluster`-like model.
2. **Two new `ClusterProvider` capability methods**, both optional (default `NotImplementedError`,
   gated behind a new `supports_app_deployment` class flag mirroring `self_service_registration`):
   - `deploy_app(k8s_client, provider_config, images, app_config, secrets) -> None` — applies the
     workload-level resources (Deployments, Services, ConfigMap, Secret, migration Job) via the
     K8s API.
   - `expose_app(k8s_client, provider_config, app_config) -> {"url": str, ...}` — the genuinely
     provider-specific part: how external traffic reaches the app and whether/how TLS is
     terminated. `same-as-backend`/`minikube` implement this as today's NodePort (parameterized,
     not hardcoded); a future plugin-provided cloud cluster type would implement it with whatever
     managed load balancer/certificate mechanism that cloud offers (separate, dependent plan).
3. **A shared, provider-agnostic helper does the identical K8s-API work every provider's
   `deploy_app()` calls into**: new `backend/services/app_deployment.py`,
   `apply_app_workloads(k8s_client, namespace, images, app_config, secrets)` — written against
   `kubernetes_asyncio` (same library `K8sClient`/`ensure_cluster_job_ready()` already use, not
   shell/`kubectl`), applying:
   - backend + frontend `Deployment`/`Service` (parameterized by `images["backend"]`/
     `images["frontend"]`, replacing the hardcoded `ymerflow-backend:prod`/
     `nagelfluh-frontend:prod` + `imagePullPolicy: Never`),
   - the `ymerflow-backend-config`/`nagelfluh-backend-secret` `ConfigMap`/`Secret` (replacing the
     imperative `kubectl create secret` block),
   - the DB migration `Job` (replacing the hardcoded-image heredoc in `runall-minikube.sh`).
   This mirrors the shape of `cluster_job_provisioning.py`'s `ensure_cluster_job_ready()`: a shared
   utility, not itself part of the ABC, called by every provider's own hook method.
4. **Backend/frontend images are pushed through the existing registry axis**, not built into a
   local Docker daemon. `deploy_app()` receives already-resolved `image_url()` strings (per the
   registry axis's existing `RegistryProtocolHandler.image_url()`); pods use the registry's
   per-Job/per-Deployment pull credential mechanism from `registry-backend-hooks.md` Phase 3
   instead of `imagePullPolicy: Never`. This is a real behavior change for local dev/Minikube
   (today's fast "build straight into the daemon" path) — see Open items.
5. **JWT-key (and any other generate-once) secret persistence moves from a host file to
   check-before-generate against the K8s API**: `apply_app_workloads()` reads the existing
   `nagelfluh-backend-secret` first and reuses its `JWT_SECRET_KEY` if present, only generating a
   new one if the Secret doesn't exist yet. This works identically for Minikube (replaces the
   `NAGELFLUH_DATA_DIR` host-file mechanism) and any remote cluster (no shared filesystem needed).
6. **`APP_DOMAIN` becomes a new, optional `config.env` value**, threaded through unchanged as part
   of `app_config` into `expose_app()`. This plan does not interpret it — it's meaningless for
   `same-as-backend`/`minikube` (NodePort has no concept of a domain) and entirely up to whichever
   provider's `expose_app()` wants to use it.
7. **Providers that don't set `supports_app_deployment = True` are unaffected** — an operator using
   the generic `kubeconfig` cluster type continues to expose/manage the app manually via
   `k8s/*.yaml`, exactly as today; this plan adds a capability, it doesn't require every provider
   to implement it.

## Open items to confirm at implementation time

- Whether `same-as-backend`/`minikube` keep a fast local-Docker-daemon build path as a special
  case, or uniformly push backend/frontend images through the registry axis now too (simpler, one
  code path, but changes today's local dev/Minikube build speed and requires the registry to be
  reachable during `deploy_app()`) — confirm before implementing Phase 3.
- Exact shape of `app_config` (what's in it beyond `APP_DOMAIN` — replica counts? resource
  requests?) — start minimal, matching what's needed for parity with today's `runall-minikube.sh`;
  extend later as plugin-provided providers need more, rather than over-designing now.
- Whether `prod/runall-minikube.sh` itself gets rewritten to call through the new
  `deploy_app()`/`expose_app()` mechanism (dogfooding it, same rationale as `docker-v2` being the
  registry axis's reference implementation) or keeps its own parallel shell logic short-term with
  the new hook exercised only by a plugin-provided provider initially. Leaning towards dogfooding
  for the same reason
  `ensure_cluster_job_ready()` replaced *both* existing shell implementations rather than just the
  new one — but flag as open since it's a larger refactor of a script that works today.
- New orchestration entry point name/shape — `backend/bin/yf-deploy-app` (new, shell-into-
  Python bridge like `yf-bootstrap-provision`) vs. folding into
  `yf-bootstrap-provision` itself — decide once Phase 5 is scoped.
- Whether `Secret`/`ConfigMap` field names change at all from today's `nagelfluh-backend-secret`/
  `ymerflow-backend-config` (Design decision 3 assumes they stay the same) — confirm no other code
  depends on the exact `kubectl create secret --dry-run=client` invocation shape rather than just
  the resulting object.

## Phases

### Phase 1 — Shared workload-apply helper
- `backend/services/app_deployment.py`: `apply_app_workloads(k8s_client, namespace, images,
  app_config, secrets)` per Design decision 3 — Deployments/Services/ConfigMap/Secret/migration
  Job, all via `kubernetes_asyncio`.

### Phase 2 — `ClusterProvider` ABC extension + reference implementations
- Add `supports_app_deployment` flag, `deploy_app()`, `expose_app()` to
  `backend/services/cluster_providers/__init__.py`.
- Implement both for `same-as-backend`/`minikube` (NodePort, parameterized from today's hardcoded
  `30080`/`hostname -I`), calling Phase 1's helper for the workload part.

### Phase 3 — Backend/frontend images through the registry axis
- Generalize image build+push (currently Minikube-daemon-only) to route through the existing
  `RegistryProtocolHandler`/`nagelfluh-registry-push` mechanism, resolving per Open items whether
  Minikube keeps a fast-path exception.

### Phase 4 — JWT/secret persistence via the K8s API
- Replace `NAGELFLUH_DATA_DIR`/host-file JWT persistence with the check-before-generate approach
  in Phase 1's helper (Design decision 5).

### Phase 5 — Orchestration entry point + wiring
- New entry point resolving the default `Cluster`'s provider and calling
  `deploy_app()`/`expose_app()` (name/shape per Open items).
- Decide and implement `prod/runall-minikube.sh`'s relationship to it (dogfood vs. parallel path,
  per Open items).

### Phase 6 — Config
- `config.env.example`: document `APP_DOMAIN` (optional, meaningless for core-provided providers).

## Manual verification

- Fresh `prod-minikube` deploy (via whichever path Phase 5 settles on) reaches the same observable
  end state as today: app reachable at `SERVER_URL`, migrations applied, admin login works,
  Headlamp/pgAdmin reachable.
- JWT key persists across a `minikube delete && minikube start` recreate using the new K8s-API
  mechanism (parity with today's host-file behavior) — existing tokens stay valid.
- Confirm a `Cluster` using the generic `kubeconfig` provider (no `supports_app_deployment`) is
  completely unaffected — no attempt to call `deploy_app()`/`expose_app()` for it.
- Provider-specific `expose_app()` behavior for any plugin-provided cloud cluster type is verified
  entirely by that plugin's own dependent plan, not here — this plan's verification is scoped to
  the hook and the `same-as-backend`/`minikube` reference implementation.

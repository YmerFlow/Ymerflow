# Point every `kubectl` invocation in the host repo at the resolved cluster's kubeconfig — never the operator's ambient context

## Goal

`docs/plans/done/generic-deployment-orchestration.md` ("Moved minikube support to a separate
plugin", commit range ending `39b94f9`) already made build/push, registry-wait, image pre-pull,
and secret-resolution generic — but its own "Not touched by this plan" section explicitly punted
on two things:

> - Database backend pluggability — Postgres is not a pluggable axis; `k8s/postgres/` stays a
>   static manifest regardless of cluster type.
> - pgAdmin/Headlamp conditionality — deployed unconditionally today; whether these should become
>   optional/hook-driven per cluster type is a separate question, not addressed here.

That deferral is now a real bug, not just a tidiness gap: since `docs/plans/done/gke-app-deployment.md`
landed, `CLUSTER_TYPE=gke` makes `deploy_app()`/`expose_app()` place the backend + frontend
Deployments **on GKE** (`plugins/ymerflow-gcp`'s `GkeClusterProvider`), while `prod/runall-production.sh`
still applies namespaces, Postgres, pgAdmin, Headlamp, RBAC, and every base Secret/ConfigMap via
plain `kubectl` against whatever the **operator's local kubeconfig context** happens to point at —
completely independent of `CLUSTER_TYPE`. For a local Minikube deploy these two things are
(usually) the same cluster by coincidence. For a GKE deploy they are provably not: the backend pod
on GKE tries to reach `postgres.nagelfluh.svc.cluster.local`, a DNS name that only resolves inside
whatever cluster Postgres actually landed on (local Minikube, if that's still the active kubeconfig
context) — cross-cluster in-cluster DNS doesn't work. The deploy is broken, not just inelegant.

**This plan fixes the bug by fixing the `kubectl` context, not by rewriting the orchestration.**
Every `kubectl` call in `prod/runall-production.sh`, `docker/build.sh`, `backup.sh`, `restore.sh`,
and `debug-harness/run_debug.sh` stays exactly what it is today — same manifests, same heredocs,
same poll loops, same `kubectl exec`/`logs`/`delete` sequencing. The only change is that each
script, before its first `kubectl` call, resolves the active `Cluster` row's kubeconfig through the
`ClusterProvider` abstraction and points `kubectl` at it explicitly via `KUBECONFIG`. No new
`kubernetes_asyncio`-based Python module reimplementing what these scripts already do correctly in
shell.

**Hard rule, non-negotiable:** no shell script anywhere in the host repo may invoke `kubectl`
against whatever context happens to be ambient (the operator's `~/.kube/config` current-context),
and no shell script anywhere in the host repo may invoke a vendor CLI (`gcloud`, `minikube`, or any
other cluster-vendor tool) at all. The plugin is the only thing that ever knows how to reach or
authenticate to a given cluster type; it exposes that knowledge as a kubeconfig (Design decision
1), and every `kubectl`-based script consumes that kubeconfig explicitly. The host repo never
contains vendor-specific reach/auth logic, CLI or otherwise — but it also never needs to reimplement
`kubectl apply -f k8s/postgres/` as a pile of `kubernetes_asyncio` object constructors just to avoid
calling `kubectl`. `kubectl` pointed at the right cluster **is** the fix.

## Background — current state

(Confirmed by reading the implemented code — `prod/runall-production.sh`, `docker/build.sh`,
`backend/services/app_deployment.py`, `backend/services/cluster_job_provisioning.py`,
`backend/services/cluster_providers/*`, `k8s/**` — not assumed.)

### Already fully generic — do not touch

- `backend/bin/yf-bootstrap-provision` — resolves `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON`
  for registry/storage/cluster and calls `.bootstrap()` on each. Runs **host-side** (not as an
  in-cluster Job) — this is the precedent this plan follows: do whatever is natively easiest in the
  shell/process that already has the right credentials, rather than inventing a new abstraction
  layer.
- `backend/bin/yf-registry-push` / `yf-build-and-push` — registry-protocol-agnostic
  build+push, already used for the process-runner image and the backend/frontend images.
- `backend/services/cluster_job_provisioning.py`'s `ensure_cluster_job_ready()` — installs Kueue +
  the `ymerflow-backend-jobs`/`ymerflow-backend-kueue-reader` RBAC via `kubernetes_asyncio`
  against whatever `k8s_client` the resolved `ClusterProvider.connect()` hands back. It runs
  *inside* the migration Job that `apply_app_workloads()`'s `_run_migration_job()` creates on the
  **resolved** cluster (GKE, in our case) — so this is not part of this plan's bug; it already
  lands correctly on GKE today. Not touched.
- `backend/services/app_deployment.py`'s `apply_app_workloads()` + `ClusterProvider.deploy_app()`/
  `expose_app()` — the backend/frontend Deployments/Services/ConfigMap/Secret/migration Job,
  already fully provider-driven (`docs/plans/done/app-deployment-hooks.md`). Not touched by this
  plan, except that it gains one new optional hook call (Design decision 2, below) — the *code
  path* that invokes `deploy_app()`/`expose_app()` (today: from inside the `yf-deploy-app`
  Job) is unchanged.

### Redundant dead weight — found while researching this plan

- **`k8s/rbac/backend-jobs-rbac.yaml`**, applied by `prod/runall-production.sh` Step 7, duplicates
  *exactly* what `ensure_cluster_job_ready()` already applies generically (see above) — same
  Role/RoleBinding/ClusterRole/ClusterRoleBinding names (`ymerflow-backend-jobs`,
  `ymerflow-backend-kueue-reader`). It's a leftover static copy from before that function existed,
  now harmless only because it's applied against the *wrong* cluster half the time and happens to
  be a no-op reapplication the other half. Safe to delete outright — independent of everything else
  in this plan.
- **`backend/services/app_deployment.py`'s own module docstring is stale**: it claims Postgres/
  MinIO/the registry/pgAdmin/Headlamp are "applied identically for every cluster type via the
  existing `k8s/*.yaml` manifests" — true for Postgres/pgAdmin/Headlamp, **false** for MinIO/the
  registry, which haven't been static manifests since the minikube-plugin migration (`bootstrap()`
  deploys them now, per-protocol, only when that axis is configured). Needs a doc fix.

### Genuinely in scope — raw `kubectl` against the ambient local context

All of the below stay `kubectl`-based. The fix in every case is the same: export `KUBECONFIG` to a
file materialized from the resolved cluster's provider, at the top of the script, before any of
these calls run.

**`prod/runall-production.sh`:**
- Step 4 / Step 7: `kubectl apply -f k8s/00-namespaces.yaml`, `k8s/postgres/`, `k8s/storage/`
  (Postgres PV/PVC only), `k8s/backend/service.yaml`, `k8s/rbac/backend-jobs-rbac.yaml` (delete per
  above), `k8s/pgadmin/`, `k8s/headlamp/`.
- Step 6: `kubectl create secret ... nagelfluh-postgres-secret`, `pgadmin-pgpass`,
  `nagelfluh-backend-secret`, plus a `kubectl apply -f -` heredoc for `ymerflow-backend-config`.
- Step 6b: `kubectl create secret ... nagelfluh-admin-secret` (skip-if-exists).
- Step 6c: `kubectl create secret docker-registry nagelfluh-app-pull` + `kubectl apply -f
  k8s/rbac/app-deploy-rbac.yaml`.
- Step 8: a 30-iteration polling loop (`kubectl get secret headlamp-static-token -n headlamp`)
  copying the Headlamp SA token into the `nagelfluh` namespace.
- Step 9: `kubectl apply -f -` of the `yf-deploy-app` batch `Job` manifest, then a
  hand-rolled poll loop (`kubectl get job ... -o jsonpath=...`) for Complete/Failed, `kubectl logs`,
  `kubectl delete job`. Today this Job gets *created* against whatever `kubectl` is pointed at (not
  necessarily the resolved `CLUSTER_TYPE` cluster) — once `KUBECONFIG` is fixed (Design decision
  1), `kubectl apply` creates it on the correct cluster, and its own `deploy_app()`/`expose_app()`
  call inside already correctly targets GKE via the stored SA key (confirmed working today). No
  further change needed here — the bug was purely "which cluster does `kubectl apply` create the
  Job on", not anything about the Job's own contents.

**`docker/build.sh`** (`DEPLOYMENT=production` branch, Step 10 of `runall-production.sh`):
- `kubectl exec -n nagelfluh deploy/backend -- python backend/bin/yf-build-and-push
  --resolve-only` — reaches into the backend pod purely to read `REGISTRY_PROTOCOL`/
  `REGISTRY_CONFIG_JSON`, which are already sitting in this same shell's own environment (exported
  by Step 3's bootstrap-provision). This one call should just be dropped in favor of reading the
  shell's own env directly — not because `kubectl exec` is forbidden, but because it's genuinely
  redundant work once you notice the value is already local. (Small, independent fix — not a
  Python rewrite of anything.)
- The `db-update-${ENV_TAG}` Job: `kubectl create configmap`/`kubectl delete job`/`kubectl apply
  -f -`/`kubectl wait`/`kubectl logs`/`kubectl delete job`, all against the ambient context — fixed
  by the same `KUBECONFIG` export as everything else. Separately, the Job manifest itself
  hardcodes `image: ymerflow-backend:prod` with `imagePullPolicy: Never` (only works if that exact
  tag already sits in whatever local daemon the target node uses — false for GKE) and a **third**,
  independently hardcoded `DATABASE_URL` literal duplicating what's already resolved elsewhere.
  These are real correctness bugs, fixed **in place** in the existing heredoc/manifest (real
  resolved image ref + real `imagePullSecrets`, `envFrom` against the existing
  `ymerflow-backend-config`/`-secret` instead of a literal `DATABASE_URL`) — still applied via
  `kubectl apply -f -`, no Python job-creation helper needed.

**`backup.sh` / `restore.sh` / `debug-harness/run_debug.sh`** — found while researching this plan:
all three are pure `kubectl` shell scripts with **zero** cluster resolution at all (no
`CLUSTER_TYPE`/`CLUSTER_CONFIG_JSON` reference of any kind), so every `kubectl` call in them
silently targets whatever the operator's `~/.kube/config` current-context happens to be — the same
bug class as above:
- `backup.sh` / `restore.sh`: `kubectl scale statefulset/postgres`/`deployment/minio`/
  `deployment/backend`, `kubectl apply -f -` (a `busybox` helper Pod), `kubectl wait`,
  `kubectl exec ... tar czf/xzf` (streaming a PVC's contents over stdout/stdin), `kubectl delete
  pod`, `kubectl get secrets -o json` for the secrets dump/restore.
- `debug-harness/run_debug.sh`: `kubectl create configmap --dry-run=client -o yaml | kubectl
  apply`, `kubectl apply -f -` (a debug Pod), `kubectl wait`, an **interactive**
  `kubectl exec -it ... -- python /app/debug_runner.py` (TTY passthrough), `kubectl delete
  pod`/`configmap` on exit.

None of these operations have (or need) a `kubernetes_asyncio` equivalent — streaming `tar` over a
pod's stdin/stdout, and especially an interactive TTY session, are exactly what `kubectl exec` is
for. The fix here (and everywhere else in this plan) is identical: `kubectl` must never guess the
context; the resolved `ClusterProvider` must hand it one explicitly.

### Not addressed by this plan (flagged so reviewers don't expect it)

- Whether Postgres/pgAdmin/Headlamp become a genuinely pluggable axis (see Goal). Stays a static,
  unconditionally-applied set of manifests, applied via `kubectl` exactly as today — this plan only
  fixes *which cluster* they land on.
- `dev/runall.sh`'s own `kubectl apply -f k8s/00-namespaces.yaml` — dev mode never calls
  `deploy_app()`/`expose_app()` at all (backend/frontend run on the host), so it always targets
  whatever cluster is configured for job execution, which is the one thing dev mode's `kubectl`
  context is already guaranteed to be pointed at. Not a bug; out of scope.
- Teardown for Postgres/pgAdmin/Headlamp — nothing tears these down today; stays that way.
- Eliminating the in-cluster `yf-deploy-app` Job, or reimplementing `k8s/postgres/`,
  `k8s/pgadmin/`, `k8s/headlamp/`, `k8s/00-namespaces.yaml` as `kubernetes_asyncio` Python calls.
  Considered and explicitly rejected — see "Rejected approach" below.

## Rejected approach: rewriting the `kubectl` orchestration in Python

An earlier version of this plan proposed eliminating the `yf-deploy-app` Job and
reimplementing every static manifest under `k8s/postgres/`, `k8s/storage/`, `k8s/pgadmin/`,
`k8s/headlamp/`, `k8s/00-namespaces.yaml` as a new `backend/services/base_infrastructure.py`
module built from `kubernetes_asyncio` object constructors, plus a Python rewrite of
`docker/build.sh`'s schema-update Job. **Rejected.** Once `kubectl` is pointed at the correct
cluster (Design decision 1), the actual bug — orchestration landing on the wrong cluster — is fully
fixed. Reimplementing manifests the cluster already applies correctly, in a parallel Python form
that has to be kept in sync with the YAML by hand, adds a large new surface for zero additional
correctness: it doesn't fix anything `KUBECONFIG`-pointing doesn't already fix, and it makes the
`k8s/*.yaml` files a second source of truth that can drift from the Python that "mirrors" them.
Keep the manifests and the shell orchestration; fix the context.

## Design decisions — proposed, need your sign-off before implementation

### 1. New `ClusterProvider` hook: `materialize_kubeconfig()` — the one channel every `kubectl`-invoking script in the host repo uses to reach a cluster

```python
def materialize_kubeconfig(self, provider_config: dict) -> dict:
    """Return a kubeconfig-shaped dict — the exact shape connect()'s own `kubeconfig` argument
    already accepts (K8sClient loads it via `config.load_kube_config_from_dict`) — for use by
    kubectl-based scripts (prod/runall-production.sh, docker/build.sh, backup.sh, restore.sh,
    debug-harness/run_debug.sh). MUST NOT shell out to a vendor CLI (gcloud, minikube) to build
    this — construct the credential directly via the provider's own Python SDK/HTTP calls (e.g.
    minting a short-lived bearer token from a stored GCP service-account key via `google-auth`,
    embedded straight into the returned dict's `users[].user.token`). No default implementation —
    every provider that wants to support kubectl-based scripts must implement this explicitly; a
    provider that doesn't (raises NotImplementedError) means those scripts can't target that
    cluster type yet, a loud and correct failure rather than a silent wrong-cluster one."""
    raise NotImplementedError
```

- `KubeconfigClusterProvider.materialize_kubeconfig()`: trivial, `return provider_config["kubeconfig"]` — it already *is* one.
- `SameAsBackendClusterProvider.materialize_kubeconfig()`: reads the same local kubeconfig
  `load_kube_config()` would auto-detect, or, if running in-cluster, constructs a kubeconfig dict
  from the mounted ServiceAccount token + CA cert at
  `/var/run/secrets/kubernetes.io/serviceaccount/`. This is *not* "falling back to ambient" in the
  sense this plan forbids — for this provider type, "whatever this process's own cluster is" is
  the correct, resolved answer by definition; the point is that a script gets there by *asking the
  provider*, not by assuming it.
- `GkeClusterProvider.materialize_kubeconfig()` (plugin-side, companion plan): builds a kubeconfig
  dict embedding a short-lived OAuth bearer token minted from the stored SA key via `google-auth`
  — no `gcloud` CLI involved.

New host-side entry point `backend/bin/yf-materialize-kubeconfig`: resolves the active
`Cluster` row exactly the way `yf-bootstrap-provision`/`yf-deploy-app` already do,
calls `provider.materialize_kubeconfig(cluster.provider_config)`, dumps the result as kubeconfig
YAML to stdout (or, with `--export`, prints `export KUBECONFIG=<tmpfile>` for eval'ing directly
into the operator's shell). Every kubectl-based script — `prod/runall-production.sh`,
`docker/build.sh`, `backup.sh`, `restore.sh`, `debug-harness/run_debug.sh` — starts with:

```bash
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
env/bin/yf-materialize-kubeconfig > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"
```

— every subsequent `kubectl` call in the script now targets the resolved cluster explicitly, and
the operator's own `~/.kube/config` is never read or depended on (except indirectly, for
`same-as-backend`, where the provider itself chooses to read it — a resolved decision, not a
fallback). Nothing else in any of these scripts changes: same manifests, same heredocs, same poll
loops, same `kubectl exec`/`logs`/`delete` sequencing.

### 2. New optional `ClusterProvider` hook: `resolve_app_hostname()`

Needed so `BACKEND_BASE_URL` can be computed correctly on the very first deploy for a provider like
`gke` whose externally-reachable hostname isn't known until a resource (a static IP) is reserved —
today that reservation only happens inside `expose_app()`, which runs *after* the ConfigMap
containing `BACKEND_BASE_URL` was already built and applied. This is a GKE-specific problem
(`same-as-backend`/`minikube`'s NodePort hostname is knowable upfront, no reservation needed) —
unrelated to the `kubectl`-vs-context question above; it's already Python code
(`app_deployment.py`, invoked from wherever it's invoked today — unchanged by this plan) that just
needs one more hook called earlier in its existing sequence:

```python
async def resolve_app_hostname(self, provider_config: dict, app_config: dict) -> str | None:
    """Optional, cheap, idempotent. Called BEFORE the ConfigMap is built, so its result can be
    baked into app_config["SERVER_URL"] first. Default: return app_config.get("SERVER_URL")
    unchanged (every provider whose hostname doesn't need a reservation step — same-as-backend/
    minikube — never needs to override this)."""
    return app_config.get("SERVER_URL")
```

The concrete GKE implementation belongs in `plugins/ymerflow-gcp/docs/plans/` (companion plan);
only the hook itself is a host-repo change.

## Open items to confirm at implementation time

- Whether the base Secrets (`nagelfluh-postgres-secret`, `pgadmin-pgpass`,
  `nagelfluh-admin-secret`) keep their exact current skip-if-exists semantics and default values —
  unchanged by this plan either way, since the `kubectl create secret` calls themselves aren't
  being touched, only prefixed with the `KUBECONFIG` export.
- Whether `docker/build.sh`'s db-update Job fix (real image ref, `envFrom` instead of hardcoded
  `DATABASE_URL`) lands in the same phase as the `KUBECONFIG` export or as a follow-up — recommend
  same phase, since both touch the same file and are easy to review together.

## Phases

### Phase 1 — `materialize_kubeconfig()` hook + entry point
- Add `materialize_kubeconfig()` to the `ClusterProvider` ABC (Design decision 1); implement on
  `SameAsBackendClusterProvider`/`KubeconfigClusterProvider` (host repo). `minikube`/`gke`
  implementations are each provider's own plugin's concern (companion plans).
- New `backend/bin/yf-materialize-kubeconfig` entry point (plain YAML to stdout, or
  `export KUBECONFIG=...` with `--export`).

### Phase 2 — `prod/runall-production.sh`
- Add the `KUBECONFIG_FILE`/`trap`/export snippet at the top of the script, before Step 4's first
  `kubectl apply`.
- Delete `k8s/rbac/backend-jobs-rbac.yaml` and its application step (redundant, see Background).
- No other change to Steps 4, 6, 6b, 6c, 7, 8, 9 — same manifests, same secrets, same Job
  create/poll/logs/delete sequence, now targeting the resolved cluster.

### Phase 3 — `docker/build.sh`
- Add the same `KUBECONFIG` export snippet.
- Drop the `kubectl exec ... --resolve-only` call; resolve `REGISTRY_PROTOCOL`/
  `REGISTRY_CONFIG_JSON` straight from the shell's own environment instead (already exported by
  Step 3's bootstrap-provision).
- Fix the `db-update-${ENV_TAG}` Job manifest in place: real resolved backend image ref + real
  `imagePullSecrets` (instead of hardcoded `ymerflow-backend:prod` / `imagePullPolicy: Never`),
  `envFrom` against `ymerflow-backend-config`/`-secret` (instead of a hardcoded `DATABASE_URL`
  literal). Still applied via the existing `kubectl apply -f -` heredoc.

### Phase 4 — `resolve_app_hostname()` hook
- Add to `ClusterProvider` ABC with the no-op default shown above. `same-as-backend`/`minikube`
  need no change (inherit the default). GKE-side implementation is the companion plugin plan.

### Phase 5 — `backup.sh` / `restore.sh` / `debug-harness/run_debug.sh`
- Add the same `KUBECONFIG` export snippet to each, before their first `kubectl` call. No other
  logic in these scripts changes — same Pod manifests, same `tar`/`exec`/`scale` sequencing.

### Phase 6 — doc fix
- Fix `app_deployment.py`'s stale module docstring (MinIO/registry claim, see Background).

## Manual verification

- Local Minikube (`CLUSTER_TYPE=minikube`, unchanged from today): `./runall.sh` end-to-end reaches
  the same observable state as before this plan — app reachable at `SERVER_URL`, admin login works,
  pgAdmin/Headlamp reachable, process Jobs still run. Confirms the `KUBECONFIG`-pointing change is
  behaviorally identical for the existing supported path.
- GKE (`CLUSTER_TYPE=gke`, this repo's actual motivating case): `./runall.sh` end-to-end with **no
  local kubectl context pointed at the GKE cluster beforehand** — confirms the whole flow no longer
  depends on the operator's ambient kubectl state at all. Backend pod successfully reaches Postgres
  (same cluster now). pgAdmin/Headlamp reachable at whatever `expose_app()` returns.
- `backup.sh`/`restore.sh`/`debug-harness/run_debug.sh` against `CLUSTER_TYPE=gke` with **no local
  kubectl context pointed at the GKE cluster beforehand** — confirms `materialize_kubeconfig()` is
  doing the actual work, not the operator's pre-existing setup papering over a gap.
- `grep -n kubectl prod/runall-production.sh docker/build.sh backup.sh restore.sh
  debug-harness/run_debug.sh` — every match occurs after that script's own
  `yf-materialize-kubeconfig`/`export KUBECONFIG=` line; none precede it. Confirm by
  inspection, not just count.
- `grep -rln 'gcloud\|minikube' -- $(git ls-files | grep -v '^plugins/')` returns nothing — no
  vendor-specific CLI name appears anywhere outside a plugin directory.
- Re-running the whole flow twice in a row against an already-deployed GKE cluster is a clean no-op
  modulo intentional redeploys (idempotency parity with today's behavior).

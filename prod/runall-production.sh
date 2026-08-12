#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Configuration ──────────────────────────────────────────────────────────────
# Site-specific overrides live in config.env at the project root (not committed to git).
# Copy config.env.example to config.env and edit it once per server.
if [ -f "${PROJECT_ROOT}/config.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "${PROJECT_ROOT}/config.env"
    set +a
fi

# SERVER_URL: public URL clients use to reach the app (set SERVER_URL in config.env).
# Defaults to http://<primary-host-IP>:30080 — the frontend NodePort, published directly
# on the host by minikube's docker driver (see plugins/ymerflow-minikube's minikube_vm.py).
# This is only a PROVISIONAL guess for CLUSTER_TYPEs whose real address isn't known yet (e.g. a
# cloud provider reserving a load-balancer IP) — Step 9 below overrides it with whatever the
# resolved ClusterProvider's expose_app() actually returns, once that's known.
SERVER_URL="${SERVER_URL:-http://$(hostname -I | awk '{print $1}'):30080}"
BACKEND_BASE_URL="${SERVER_URL}/api"

echo "========================================"
echo "YmerFlow - Production Setup"
echo "========================================"
echo ""
echo "  Server URL:     ${SERVER_URL}  (set SERVER_URL in config.env to override)"
echo "  Backend URL:    ${BACKEND_BASE_URL}"
echo ""
echo "  Clients will reach the app at: ${SERVER_URL}"

# ── Step 1: Base configuration ────────────────────────────────────────────────

# LAN IP added to the apiserver cert SAN so a remote kubeconfig connecting via this IP
# passes TLS verification (see plugins/ymerflow-minikube's minikube_vm.py MINIKUBE_APISERVER_IPS).
export MINIKUBE_APISERVER_IPS="${MINIKUBE_APISERVER_IPS:-$(hostname -I | awk '{print $1}')}"

# Public host:port used to address the Docker registry everywhere (push and every cluster's
# pull, including this one) — never minikube's internal IP. See
# docs/plans/done/remote-cluster-provisioning-and-registry.md.
export REGISTRY_PUBLIC_HOST="${REGISTRY_PUBLIC_HOST:-$(hostname -I | awk '{print $1}')}"

# Content-addressed tag for the backend/frontend images, replacing the floating "prod" tag —
# computed ONCE here so every build/push/deploy step below (and docker/build.sh, invoked from
# Step 10) agrees on the same tag for this run. See docs/plans/versioned-app-image-tags.md.
export APP_IMAGE_VERSION="$(env/bin/python "${PROJECT_ROOT}/backend/bin/yf-resolve-app-image-tag")"
echo "  App image tag: ${APP_IMAGE_VERSION}"

# ── Step 2: Build backend Docker image (host's own Docker daemon) ─────────────────────────────
# Built against the HOST's own Docker daemon, not minikube's — this doesn't need Minikube to
# exist yet (a real dependency-order requirement now that Minikube itself is provisioned by Step
# 3's bootstrap-provision, not a shell script run up front). Only the backend image is needed this
# early: Step 3's bootstrap-provision runs as a `docker run` against it, before Minikube/the
# registry exist, so nothing can be pushed yet — a plain `docker build`, not
# backend/bin/yf-build-and-push, since that entry point always pushes too. The frontend
# image has no such early dependency; it's built (and pushed, along with a cache-fast rebuild of
# this same backend image) together at Step 5, once the registry actually exists. App images are
# never shared with a cluster via a local daemon (Design decision 4 in
# docs/plans/app-deployment-hooks.md: they go through the registry axis, push then pull, like
# every other cluster) — building here instead of inside minikube's daemon changes nothing about
# how they reach the cluster.

echo ""
echo "Step 2: Building backend Docker image..."

docker build -t "ymerflow-backend:${APP_IMAGE_VERSION}" \
    --build-arg BACKEND_PLUGINS="${BACKEND_PLUGINS:-}" \
    -f "${PROJECT_ROOT}/backend/Dockerfile" \
    "${PROJECT_ROOT}"

# ── Step 3: Bootstrap-provision configured backends ───────────────────────────
# For each axis (registry/storage/cluster) where <AXIS>_PROTOCOL/<AXIS>_CONFIG_JSON is set in
# config.env (already exported above — see that file's defaults), resolve its handler and call
# bootstrap(). By default this is plugins/ymerflow-minikube's docker-v2/minio/minikube stack:
# MinikubeClusterProvider.bootstrap() starts/resizes the local Minikube VM itself, and
# MinioProtocolHandler/DockerV2ProtocolHandler.bootstrap() deploy MinIO/the registry into it —
# each is idempotent, so re-running this on every prod/runall-production.sh invocation is a fast
# no-op once already provisioned. The enriched {protocol, config} result is folded into
# nagelfluh-backend-secret below (Step 6). See docs/plans/registry-backend-hooks.md (Design
# decision 6).
#
# Run host-side via the same host venv the rest of this script already uses (env/bin/python — see
# Steps 5 and 6c, and docker/build.sh) — BYTE-IDENTICAL to how dev/runall.sh invokes it. This is
# deliberately NOT a `docker run` wrapper anymore: the old wrapper had to bind-mount docker.sock,
# ~/.minikube, ~/.kube, --network host and forward a pile of MINIKUBE_* env vars into the
# container, which was pure minikube-plugin coupling baked into this generic orchestration script
# (see docs/plans/done/generic-deployment-orchestration.md). Running on the host instead, every
# one of those becomes a no-op: whatever a plugin's bootstrap() needs (the minikube plugin: the
# host's own Docker socket / kubeconfig / MINIKUBE_* config vars from config.env; a cloud plugin:
# its own gcloud/SA credentials) is already natively present in this shell's environment. The
# script no longer knows or cares which cluster plugin it's driving.
NAGELFLUH_DATA_DIR="${NAGELFLUH_DATA_DIR:-$HOME/.nagelfluh/data}"
mkdir -p "${NAGELFLUH_DATA_DIR}"
export NAGELFLUH_DATA_DIR

echo ""
echo "Step 3: Bootstrap-provisioning configured backends..."
BOOTSTRAP_JSON=$(PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision)

# eval runs directly in this shell (not inside a subshell) so the `export` statements it emits
# persist here, ready for Step 7's BACKEND_SECRET_ARGS assembly below. Do NOT wrap this eval in a
# command substitution — that would run it in a subshell and silently discard the exports.
eval "$(python3 -c '
import json, sys, shlex

data = json.loads(sys.argv[1])
axis_map = {
    "registry": ("REGISTRY_PROTOCOL", "REGISTRY_CONFIG_JSON"),
    "storage": ("STORAGE_PROTOCOL", "STORAGE_CONFIG_JSON"),
    "cluster": ("CLUSTER_TYPE", "CLUSTER_CONFIG_JSON"),
}
lines = []
for axis, (protocol_var, config_var) in axis_map.items():
    if axis not in data:
        continue
    entry = data[axis]
    protocol = entry["protocol"]
    config_json = json.dumps(entry["config"])
    lines.append(f"export {protocol_var}={shlex.quote(protocol)}")
    lines.append(f"export {config_var}={shlex.quote(config_json)}")
print("\n".join(lines))
' "${BOOTSTRAP_JSON}")"

BOOTSTRAPPED_AXES=$(python3 -c '
import json, sys

data = json.loads(sys.argv[1])
print(",".join(axis for axis in ("registry", "storage", "cluster") if axis in data))
' "${BOOTSTRAP_JSON}")

if [ -n "${BOOTSTRAPPED_AXES}" ]; then
    echo "  Bootstrap-provisioned axes: ${BOOTSTRAPPED_AXES} (enriched config will be folded into nagelfluh-backend-secret)"
else
    echo "  No axes bootstrap-provisioned (no <AXIS>_PROTOCOL/<AXIS>_CONFIG_JSON set in config.env)"
fi

# ── Materialize kubeconfig: point kubectl at the resolved cluster, never the ambient context ──
# Every kubectl call from here on (in this script and in docker/build.sh, invoked from Step 10)
# must target the CLUSTER_TYPE/CLUSTER_CONFIG_JSON resolved above — never whatever context
# happens to be the operator's current one. See
# docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 1.
echo ""
echo "Resolving kubeconfig for the target cluster..."
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
env/bin/python "${PROJECT_ROOT}/backend/bin/yf-materialize-kubeconfig" > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"

# ── Step 4: Namespaces ──────────────────────────────────────────────────────────────────────
# Minikube now exists (Step 3 brought it up, if it wasn't already) — safe to talk to it. Image
# pre-pulling is no longer a separate step here: each protocol's own bootstrap() (Step 3, above)
# pre-pulls its own image before applying its Deployment (see
# docs/plans/generic-deployment-orchestration.md, Phase 3).

echo ""
echo "Step 4: Creating namespaces..."
kubectl apply -f "${PROJECT_ROOT}/k8s/00-namespaces.yaml"

# ── Step 5: Build (backend, frontend) and push both images to the registry ────────────────────
# Design decision 4 in docs/plans/app-deployment-hooks.md: app images go through the registry
# axis, NOT imagePullPolicy:Never against a shared local daemon. The in-cluster yf-deploy-app
# Job (Step 9) and the Deployments it applies pull these from the registry with a pull secret,
# exactly like process-runner pods already do — so the app can be hosted on a cluster that does not
# share a Docker daemon with this build host. The registry now exists (Step 3's bootstrap-provision
# deployed it), so this can push.
#
# Registry-protocol-agnostic build+push via backend/bin/yf-build-and-push — the SAME entry
# point docker/build.sh uses for the process-runner image (see
# docs/plans/generic-deployment-orchestration.md, Design decision 2). It re-runs `docker build`
# for the backend image (layer-cached from Step 2, so effectively free) and runs the frontend
# build for the first time, then pushes each through whatever RegistryProtocolHandler
# REGISTRY_PROTOCOL resolves to (docker-v2's push_image() does the crane save/push dance formerly
# hand-rolled here — see plugins/ymerflow-minikube's registry_protocol.py).
#
# Resolved directly from REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON (already exported by Step 3's
# bootstrap-provision above) via NAGELFLUH_RESOLVED_REGISTRY_JSON, rather than letting
# yf-build-and-push query the database itself, because Postgres isn't reachable host-side
# here (it runs in-cluster and hasn't even been migrated/seeded yet at this point).

echo ""
echo "Step 5: Building and pushing backend + frontend images..."

RESOLVED_REGISTRY_JSON=$(python3 -c '
import json, os
print(json.dumps({"protocol": os.environ["REGISTRY_PROTOCOL"], "config": json.loads(os.environ["REGISTRY_CONFIG_JSON"])}))
')

BACKEND_IMAGE=$(NAGELFLUH_RESOLVED_REGISTRY_JSON="${RESOLVED_REGISTRY_JSON}" env/bin/python \
    "${PROJECT_ROOT}/backend/bin/yf-build-and-push" \
    "${PROJECT_ROOT}/backend/Dockerfile" "${PROJECT_ROOT}" ymerflow-backend "${APP_IMAGE_VERSION}" \
    --build-arg "BACKEND_PLUGINS=${BACKEND_PLUGINS:-}")
FRONTEND_IMAGE=$(NAGELFLUH_RESOLVED_REGISTRY_JSON="${RESOLVED_REGISTRY_JSON}" env/bin/python \
    "${PROJECT_ROOT}/backend/bin/yf-build-and-push" \
    "${PROJECT_ROOT}/frontend/Dockerfile" "${PROJECT_ROOT}/frontend" nagelfluh-frontend "${APP_IMAGE_VERSION}")

# The registry server address (everything before the first '/' of the resolved ref) — still
# needed by Step 6c's image-pull secret below, which wants a bare host (that's what
# `--docker-server`/the kubelet's pull-secret host match expects).
REGISTRY_ADDR="${BACKEND_IMAGE%%/*}"

# The registry's full image-reference PREFIX (everything before `/{repository}:{tag}`) — used
# below as REGISTRY_URL, consumed by fake_processes.py's create_environment to build its own
# per-environment image references as f"{registry_url}/proj-{project_id}/env-{env_slug}". This is
# NOT the same as REGISTRY_ADDR above for every protocol: docker-v2's prefix IS just its bare host
# (self-hosted registries accept any repository path under the host), but GAR's prefix also
# includes fixed project_id/repository path segments after the host — GAR doesn't auto-create
# repositories, and the bootstrapped service account only has write access to the one repository
# bootstrap() provisioned, so truncating to host-only (as REGISTRY_ADDR does) silently produces an
# unwritable/nonexistent path for GAR. Resolved via RegistryProtocolHandler.image_prefix() (the
# same mechanism image_url() itself is built on) rather than assumed from BACKEND_IMAGE's shape.
# Exported: Step 6 folds this into nagelfluh-backend-secret as a script-computed override (see
# nagelfluh-render-backend-secret-env).
export REGISTRY_URL=$(env/bin/python "${PROJECT_ROOT}/backend/bin/yf-registry-image-prefix" \
    "${REGISTRY_PROTOCOL}" "${REGISTRY_CONFIG_JSON}")

echo "  Pushed ${BACKEND_IMAGE}"
echo "  Pushed ${FRONTEND_IMAGE}"

# ── Step 6: nagelfluh-backend-secret ────────────────────────────────────────
# Carries every app runtime config/secret value the in-cluster yf-deploy-app Job (Step 9)
# reads via envFrom. yf-deploy-app hands its contents to
# backend.services.app_deployment.apply_app_workloads(), which then re-applies (create-or-patch)
# the canonical Secret — so this Step is a bootstrap seed, and apply_app_workloads is the authority
# for its final state (adding the resolved JWT_SECRET_KEY, per Design decision 5).
#
# Generic passthrough (docs/plans/generic-backend-config-passthrough.md): every KEY=VALUE actually
# assigned in config.env reaches this Secret, and from there the backend pod, with ZERO changes to
# this script or yf-deploy-app — a plugin author adding e.g. TICKETS_GITHUB_TOKEN only ever
# touches config.env (and their own plugin's config.py). A short, fixed set of script-computed
# overrides (nagelfluh-render-backend-secret-env's OVERRIDE_KEYS) still wins over the generic
# layer — these are the only keys core deployment code is still allowed to know by name.
#
# JWT persistence: NO host-file (NAGELFLUH_DATA_DIR/jwt_secret_key) mechanism. If the operator set
# JWT_SECRET_KEY in config.env it passes through generically and wins; otherwise it is absent here,
# and apply_app_workloads generates-or-reuses it against the K8s API (check-before-generate: reuse
# the existing nagelfluh-backend-secret's value across a redeploy / minikube recreate so existing
# tokens stay valid, generate a fresh one only on a first-ever deploy). This works identically for
# a cluster that shares no filesystem with this host.

echo ""
echo "Step 6: Creating nagelfluh-backend-secret..."

kubectl create secret generic nagelfluh-postgres-secret \
    --from-literal=postgres-password=nagelfluhpass \
    -n nagelfluh \
    --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic pgadmin-pgpass \
    --from-literal=pgpass="postgres.nagelfluh.svc.cluster.local:5432:nagelfluh:nagelfluh:nagelfluhpass" \
    -n nagelfluh \
    --dry-run=client -o yaml | kubectl apply -f -

MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
export MC_HOST_minio="https://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio.minio.svc.cluster.local:9000"

# REGISTRY_USER/REGISTRY_PASSWORD (config.env, defaults nagelfluh/nagelfluh) only feed
# REGISTRY_AUTH below — yf-deploy-app's fallback registry credential when REGISTRY_PROTOCOL/
# REGISTRY_CONFIG_JSON aren't in the Secret at all. With the default config.env (bootstrap-provision
# always sets both), REGISTRY_AUTH is never actually consumed; it's kept only for an operator who
# has explicitly disabled the registry bootstrap axis.
REGISTRY_USER="${REGISTRY_USER:-nagelfluh}"
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-nagelfluh}"
export REGISTRY_AUTH=$(printf '%s:%s' "${REGISTRY_USER}" "${REGISTRY_PASSWORD}" | base64 -w0)

# DATABASE_URL is fully resolved here (Postgres password inlined) so apply_app_workloads' migration
# Job + the backend Deployment receive it purely via envFrom — no per-manifest secretKeyRef/$(VAR)
# substitution needed (that substitution lived in the old static k8s/backend/deployment.yaml). It
# uses the asyncpg driver for the backend app; the migration Job's alembic step strips "+asyncpg"
# itself (see backend/alembic/env.py).
export DATABASE_URL="postgresql+asyncpg://nagelfluh:nagelfluhpass@postgres.nagelfluh.svc.cluster.local:5432/nagelfluh"

# BACKEND_BASE_URL must use the public host:port because that is the address clients' browsers
# follow when fetching dataset URLs. REGISTRY_PUBLIC_HOST/REGISTRY_URL/STORAGE_ENDPOINT/
# STORAGE_BUCKET_PREFIX below are also script-computed rather than raw config.env text — see
# nagelfluh-render-backend-secret-env's module docstring for why each one must win over a stray
# config.env value (STORAGE_ENDPOINT in particular: an operator's dev-host STORAGE_ENDPOINT must
# NEVER leak into production, which always talks to MinIO via its in-cluster Service DNS name).
#
# STORAGE_PROTOCOL/MINIO_ROOT_USER are deliberately NOT set here (verified genuinely dead, per
# docs/plans/generic-deployment-orchestration.md Phase 5): the seed migration chain's later,
# generic `9623bab8493d_generic_seed_default_storage_backend.py` unconditionally overrides
# `storage_backends.protocol`/`.config` from STORAGE_PROTOCOL/STORAGE_CONFIG_JSON (both already
# folded in below, from Step 3's bootstrap-provision) whenever that axis was bootstrapped — which
# it always is with the default config.env — so any value seeded here from
# `settings.storage_protocol`/`settings.minio_root_user` gets clobbered before a migration run ever
# finishes. STORAGE_ENDPOINT is NOT dead weight, unlike the other two: no migration ever overrides
# the `storage_backends.endpoint` column past the initial seed
# (`a6b7c8d9e0f1_seed_default_storage_backend.py`, which reads `settings.storage_endpoint`), and
# `MinioProtocolHandler.fsspec_kwargs()`/`test_connection()` read `backend.endpoint` directly at
# runtime — it stays here as the one genuinely load-bearing key.
export STORAGE_ENDPOINT="https://minio.minio.svc.cluster.local:9000"
export STORAGE_BUCKET_PREFIX="nagelfluh-project-"
export BACKEND_BASE_URL="${BACKEND_BASE_URL}"
export SERVER_URL="${SERVER_URL}"

kubectl create secret generic nagelfluh-backend-secret \
    --from-env-file=<(env/bin/python "${PROJECT_ROOT}/backend/bin/nagelfluh-render-backend-secret-env" "${PROJECT_ROOT}/config.env") \
    -n nagelfluh \
    --dry-run=client -o yaml | kubectl apply -f -
echo "  nagelfluh-backend-secret applied"

# ── Step 6b: Admin credentials secret ────────────────────────────────────────
# ADMIN_USER and ADMIN_PASSWORD are read from config.env (defaults: admin/password).
# nagelfluh-admin-secret is idempotent: skip if it already exists so a running deployment's
# credentials are never silently rotated.

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"

echo ""
echo "Step 6b: Creating admin credentials secret..."
if ! kubectl get secret nagelfluh-admin-secret -n nagelfluh &>/dev/null; then
    HTPASSWD="${ADMIN_USER}:$(openssl passwd -apr1 "${ADMIN_PASSWORD}")"
    kubectl create secret generic nagelfluh-admin-secret \
        --from-literal=htpasswd="${HTPASSWD}" \
        --from-literal=pgadmin-email="${ADMIN_USER}@example.com" \
        --from-literal=admin-password="${ADMIN_PASSWORD}" \
        -n nagelfluh
    echo "  Created nagelfluh-admin-secret"
    echo "  Admin username: ${ADMIN_USER}"
    echo "  Admin password: ${ADMIN_PASSWORD}"
    echo "  pgAdmin login:  ${ADMIN_USER}@example.com / ${ADMIN_PASSWORD}"
else
    echo "  nagelfluh-admin-secret already exists, skipping"
    echo "  (delete it with: kubectl delete secret nagelfluh-admin-secret -n nagelfluh)"
fi

# ── Step 6c: App image-pull Secret ────────────────────────────────────────────
# The in-cluster yf-deploy-app Job pulls ymerflow-backend from the registry (Step 5), so
# its pod needs a pull credential BEFORE it starts (a Secret it creates itself would be too late
# for its own image). Same-named as app_deployment.IMAGE_PULL_SECRET_NAME so apply_app_workloads
# just re-applies (patches) it for the backend/frontend Deployments — one pull Secret, created here
# for the deploy Job and re-owned by apply_app_workloads for the workloads it applies.
#
# Resolved via RegistryProtocolHandler.pull_credentials() (backend/bin/yf-registry-pull-
# credentials) — the SAME mechanism job_orchestrator.py uses for process-runner pods and
# yf-deploy-app uses for the app's own Deployments later — rather than assuming docker-v2's
# basic-auth (--docker-username/--docker-password) shape directly.

echo ""
echo "Step 6c: Creating app image-pull secret + applying app-deploy RBAC..."
PULL_CREDS_JSON=$(env/bin/python "${PROJECT_ROOT}/backend/bin/yf-registry-pull-credentials" \
    "${REGISTRY_PROTOCOL}" "${REGISTRY_CONFIG_JSON}")
PULL_USER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("username") or "")' "${PULL_CREDS_JSON}")
PULL_PASSWORD=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("password") or "")' "${PULL_CREDS_JSON}")

kubectl create secret docker-registry nagelfluh-app-pull \
    --docker-server="${REGISTRY_ADDR}" \
    --docker-username="${PULL_USER}" \
    --docker-password="${PULL_PASSWORD}" \
    -n nagelfluh \
    --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f "${PROJECT_ROOT}/k8s/rbac/app-deploy-rbac.yaml"

# ── Step 7: Apply base Kubernetes manifests ───────────────────────────────────
# Everything EXCEPT the app's own backend/frontend Deployments + the frontend NodePort Service,
# which yf-deploy-app (Step 12) now owns. Postgres, the backend ExternalName Service in the
# nagelfluh-jobs namespace, pgAdmin and Headlamp are all still plain manifests. The Postgres
# PersistentVolume is no longer a host manifest here — it's applied by the active CLUSTER_TYPE's
# ClusterProvider.bootstrap() (Step 3, before this step runs), mirroring how MinIO's PV moved into
# plugins/ymerflow-minikube's own MinioProtocolHandler.bootstrap() — see
# docs/plans/done/postgres-pv-per-cluster-provider.md and docs/plans/minikube-provisioning-plugin.md.
# k8s/postgres/statefulset.yaml's volumeClaimTemplate sets storageClassName: "" so its generated
# data-postgres-0 PVC binds to that provider-supplied, pre-claimRef'd PV instead of dynamically
# provisioning against a default StorageClass.
#
# backend-jobs RBAC (ymerflow-backend-jobs/ymerflow-backend-kueue-reader) is NOT applied here —
# it's already applied generically by ensure_cluster_job_ready()
# (backend/services/cluster_job_provisioning.py), which runs inside the migration Job on the
# resolved cluster. k8s/rbac/backend-jobs-rbac.yaml was a redundant static copy of the exact same
# Role/RoleBinding/ClusterRole/ClusterRoleBinding names, deleted — see
# docs/plans/base-infrastructure-via-cluster-provider.md.

echo ""
echo "Step 7: Applying base Kubernetes manifests..."
kubectl apply -R \
    -f "${PROJECT_ROOT}/k8s/00-namespaces.yaml" \
    -f "${PROJECT_ROOT}/k8s/postgres" \
    -f "${PROJECT_ROOT}/k8s/backend/service.yaml" \
    -f "${PROJECT_ROOT}/k8s/pgadmin" \
    -f "${PROJECT_ROOT}/k8s/headlamp"

echo ""
echo "  Waiting for PostgreSQL to be ready..."
kubectl rollout status statefulset/postgres -n nagelfluh --timeout=120s
kubectl wait --for=condition=ready pod -l app=postgres -n nagelfluh --timeout=120s

# ── Step 8: Copy Headlamp SA token to nagelfluh namespace for nginx ───────────
# The headlamp SA token lives in the headlamp namespace; nginx (in the frontend pod) runs in
# nagelfluh. We copy the decoded token into a separate secret so nginx can mount and inject it as
# a request header, enabling automatic Headlamp authentication. Done BEFORE yf-deploy-app so
# the frontend pod it creates finds the (optional) headlamp-nginx-token secret already present.

echo ""
echo "Step 8: Copying Headlamp token to nagelfluh namespace..."
for i in $(seq 1 30); do
    HEADLAMP_TOKEN=$(kubectl get secret headlamp-static-token -n headlamp \
        -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [ -n "${HEADLAMP_TOKEN}" ]; then
        echo "  Headlamp token obtained."
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  WARNING: Could not obtain headlamp token after 30 attempts; skipping auto-auth."
        HEADLAMP_TOKEN=""
        break
    fi
    echo "  Waiting for headlamp SA token to be populated... ($i/30)"
    sleep 2
done

if [ -n "${HEADLAMP_TOKEN}" ]; then
    kubectl create secret generic headlamp-nginx-token \
        --from-literal=token="${HEADLAMP_TOKEN}" \
        -n nagelfluh \
        --dry-run=client -o yaml | kubectl apply -f -
    echo "  headlamp-nginx-token secret created/updated in nagelfluh namespace."
fi

# ── Step 9: Deploy the app via yf-deploy-app (dogfoods deploy_app/expose_app) ──────────
# This replaces three things the old script did imperatively: (1) the hardcoded-image alembic
# migration Job, (2) the static k8s/backend + k8s/frontend Deployments (imagePullPolicy:Never),
# and (3) the hardcoded frontend NodePort Service. It runs as an in-cluster Job so
# same-as-backend's K8sClient(kubeconfig=None) auto-detects in-cluster config; it reads config from
# the nagelfluh-backend-secret created above via envFrom, resolves the default Cluster's
# provider, and calls deploy_app() (→ apply_app_workloads: Secret/migration Job/backend+frontend
# Deployments + backend Service) then expose_app() (→ frontend NodePort). See
# docs/plans/app-deployment-hooks.md Phase 5.

echo ""
echo "Step 9: Deploying the application (yf-deploy-app Job)..."
kubectl delete job yf-deploy-app -n nagelfluh --ignore-not-found=true 2>/dev/null
kubectl apply -f - <<MANIFEST
apiVersion: batch/v1
kind: Job
metadata:
  name: yf-deploy-app
  namespace: nagelfluh
spec:
  template:
    spec:
      serviceAccountName: nagelfluh-app-deployer
      # yf-deploy-app reads its whole pod environment generically minus a short, fixed
      # denylist (docs/plans/generic-backend-config-passthrough.md, Design decision 3) — without
      # this, Kubernetes also injects a <SERVICE>_SERVICE_*/<SERVICE>_PORT_* env-var block per
      # Service in this namespace, which is NOT a fixed list (it grows as Services are added), and
      # would defeat that denylist. See backend/bin/yf-deploy-app's own module docstring.
      enableServiceLinks: false
      imagePullSecrets:
      - name: nagelfluh-app-pull
      containers:
      - name: deploy
        image: ${BACKEND_IMAGE}
        # BACKEND_IMAGE is now a content-addressed tag (APP_IMAGE_VERSION, computed once above) —
        # never reused for different content — so IfNotPresent is correct and faster than an
        # unconditional re-pull. See docs/plans/versioned-app-image-tags.md and
        # job_orchestrator.py's existing IfNotPresent precedent.
        imagePullPolicy: IfNotPresent
        command: ["python", "backend/bin/yf-deploy-app"]
        env:
        # yf-deploy-app resolves the app images' tag itself (it runs before the
        # Cluster/RegistryBackend rows exist to read from — see its own module docstring) and
        # defaults APP_IMAGE_TAG to "prod" if this isn't set. Must match the tag BACKEND_IMAGE/
        # FRONTEND_IMAGE were actually pushed under above, or it resolves a ref that was never
        # pushed. See docs/plans/versioned-app-image-tags.md.
        - name: APP_IMAGE_TAG
          value: "${APP_IMAGE_VERSION}"
        envFrom:
        - secretRef:
            name: nagelfluh-backend-secret
      restartPolicy: Never
  backoffLimit: 0
MANIFEST

# apply_app_workloads runs the DB migration Job to completion inside this Job, so allow generous
# time (migrations + Kueue-independent workload apply). Poll for Complete/Failed directly instead
# of `kubectl wait --for=condition=complete`, which does not wake up early on a Failed condition
# and would otherwise report a fast crash only after the full timeout. On failure, dump the deploy
# Job's logs before exiting so the migration/apply error is visible.
deploy_app_deadline=$((SECONDS + 900))
while true; do
    complete=$(kubectl get job/yf-deploy-app -n nagelfluh \
        -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null)
    failed=$(kubectl get job/yf-deploy-app -n nagelfluh \
        -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null)
    [ "$complete" = "True" ] && break
    if [ "$failed" = "True" ]; then
        echo "  yf-deploy-app Job failed — logs follow:"
        kubectl logs job/yf-deploy-app -n nagelfluh || true
        exit 1
    fi
    if [ "$SECONDS" -ge "$deploy_app_deadline" ]; then
        echo "  yf-deploy-app Job did not complete — logs follow:"
        kubectl logs job/yf-deploy-app -n nagelfluh || true
        exit 1
    fi
    sleep 2
done
DEPLOY_APP_LOGS=$(kubectl logs job/yf-deploy-app -n nagelfluh)
echo "${DEPLOY_APP_LOGS}"
kubectl delete job yf-deploy-app -n nagelfluh

# yf-deploy-app's last stdout line is a JSON object — {"url": ..., ...} — from whichever
# ClusterProvider.expose_app() ran (backend/bin/yf-deploy-app's final `print(json.dumps(result))`).
# Every provider returns a "url" key (see nodeport_app_deployment.py's NodePortAppDeploymentMixin
# for the core NodePort case), so this picks it up generically rather than trusting this script's
# own pre-Step-9 SERVER_URL guess above — a provider whose real address isn't knowable until a
# resource is reserved (e.g. a cloud load balancer/static IP) overrides it here, one Step later
# than the guess was made.
DEPLOY_RESULT_JSON=$(echo "${DEPLOY_APP_LOGS}" | grep -E '^\{.*\}$' | tail -1)
if [ -n "${DEPLOY_RESULT_JSON}" ]; then
    RESOLVED_SERVER_URL=$(python3 -c '
import json, sys
try:
    print(json.loads(sys.argv[1]).get("url") or "")
except ValueError:
    print("")
' "${DEPLOY_RESULT_JSON}")
    if [ -n "${RESOLVED_SERVER_URL}" ]; then
        SERVER_URL="${RESOLVED_SERVER_URL}"
        BACKEND_BASE_URL="${SERVER_URL}/api"
    fi
fi

echo ""
echo "  Waiting for app Deployments to be ready..."
kubectl rollout status deployment/backend -n nagelfluh --timeout=180s
kubectl rollout status deployment/frontend -n nagelfluh --timeout=60s

# ── Step 10: Build runner image and update bootstrap environment ──────────────
# build.sh builds the process-runner image on the host's own Docker daemon and pushes it through
# the registry axis (backend/bin/yf-build-and-push), then — because DEPLOYMENT=production
# means Postgres is in-cluster only — runs update_bootstrap_environment as a kubectl Job reaching
# PostgreSQL via in-cluster DNS.

echo ""
echo "Step 10: Building process runner image and updating bootstrap environment..."
DEPLOYMENT=production "${PROJECT_ROOT}/docker/build.sh"

# The frontend NodePort (30080) is published directly on the host by the cluster's own driver
# (for the default minikube plugin, minikube's docker driver — see its minikube_vm.py) — no socat
# forwarder needed.

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "Setup complete!"
echo "========================================"
echo ""
echo "  App:           ${SERVER_URL}"
echo "  API Docs:      ${SERVER_URL}/api/docs"
echo "  pgAdmin:       ${SERVER_URL}/pgadmin/   (${ADMIN_USER:-admin}@example.com / <admin-password>)"
echo "  K8s Dashboard: ${SERVER_URL}/headlamp/  (${ADMIN_USER:-admin} / <admin-password>)"
# Whatever the resolved STORAGE_PROTOCOL's bootstrap() returned (Step 3), printed as-is — this
# script has no per-protocol knowledge of what's useful to show (a console URL, credentials,
# nothing at all). STORAGE_CONFIG_JSON is already exported by Step 3's bootstrap-provision.
if [ -n "${STORAGE_CONFIG_JSON:-}" ]; then
    echo "  Storage backend (${STORAGE_PROTOCOL}):"
    echo "${STORAGE_CONFIG_JSON}" | python3 -m json.tool | sed 's/^/    /'
fi
echo ""
echo "  Admin credentials are in secret nagelfluh-admin-secret (nagelfluh namespace)."
echo "  To rotate: kubectl delete secret nagelfluh-admin-secret -n nagelfluh, then re-run."
echo ""
echo "Useful commands:"
echo "  kubectl logs -f deployment/backend  -n nagelfluh"
echo "  kubectl logs -f deployment/frontend -n nagelfluh"
echo "  kubectl get pods -n nagelfluh"
echo ""
echo "All traffic goes through nginx on the frontend NodePort (30080)."
echo "The backend is only reachable inside the cluster."

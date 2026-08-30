#!/bin/bash
set -e

# Accept optional environment name parameter (defaults to "Bootstrap")
ENV_NAME="${1:-Bootstrap}"
ENV_TAG=$(echo "$ENV_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

# Change to project root (parent directory of docker/)
cd "$(dirname "$0")/.."

# Load DEPLOYMENT (and other settings) from config.env; command-line env vars take precedence.
# CLUSTER_TYPE/CLUSTER_CONFIG_JSON (and REGISTRY_*/STORAGE_*) must be preserved the same way: a
# caller like prod/runall-production.sh exports bootstrap()-enriched versions of these (e.g. with
# the GKE sa_key minted) before invoking this script, and sourcing config.env's raw pre-bootstrap
# values here would silently clobber them.
_ENV_DEPLOYMENT="${DEPLOYMENT:-}"
_ENV_CLUSTER_TYPE="${CLUSTER_TYPE:-}"
_ENV_CLUSTER_CONFIG_JSON="${CLUSTER_CONFIG_JSON:-}"
_ENV_REGISTRY_PROTOCOL="${REGISTRY_PROTOCOL:-}"
_ENV_REGISTRY_CONFIG_JSON="${REGISTRY_CONFIG_JSON:-}"
_ENV_STORAGE_PROTOCOL="${STORAGE_PROTOCOL:-}"
_ENV_STORAGE_CONFIG_JSON="${STORAGE_CONFIG_JSON:-}"
# `set -a` (allexport) so every assignment in config.env is EXPORTED into the environment, not
# left as a plain shell variable. The production branch below shells out to inline `python3`
# subprocesses that read REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON (and the RegistryProtocolHandler
# reads REGISTRY_*_HOST/PORT) via os.environ — those only see EXPORTED vars. Without this a
# standalone `./docker/build.sh` in production mode fails with KeyError: 'REGISTRY_PROTOCOL',
# because it never runs as a child of prod/runall-production.sh (which does its own `set -a`
# before sourcing config.env). Mirrors that script exactly.
if [ -f "config.env" ]; then
    set -a
    source "config.env"
    set +a
fi
[ -n "$_ENV_DEPLOYMENT" ] && DEPLOYMENT="$_ENV_DEPLOYMENT"
[ -n "$_ENV_CLUSTER_TYPE" ] && CLUSTER_TYPE="$_ENV_CLUSTER_TYPE"
[ -n "$_ENV_CLUSTER_CONFIG_JSON" ] && CLUSTER_CONFIG_JSON="$_ENV_CLUSTER_CONFIG_JSON"
[ -n "$_ENV_REGISTRY_PROTOCOL" ] && REGISTRY_PROTOCOL="$_ENV_REGISTRY_PROTOCOL"
[ -n "$_ENV_REGISTRY_CONFIG_JSON" ] && REGISTRY_CONFIG_JSON="$_ENV_REGISTRY_CONFIG_JSON"
[ -n "$_ENV_STORAGE_PROTOCOL" ] && STORAGE_PROTOCOL="$_ENV_STORAGE_PROTOCOL"
[ -n "$_ENV_STORAGE_CONFIG_JSON" ] && STORAGE_CONFIG_JSON="$_ENV_STORAGE_CONFIG_JSON"

# ── Standalone: load the enriched config the last deploy cached ───────────────────────────────
# As a child of prod/runall-production.sh (its Step 10), that script has already
# bootstrap-provisioned every axis (its Step 3) and exported the ENRICHED
# REGISTRY_*/CLUSTER_*/STORAGE_* config into our environment — CLUSTER_CONFIG_JSON then already
# carries e.g. minikube's real kubeconfig, REGISTRY_CONFIG_JSON its resolved addresses/creds.
# Run STANDALONE (`./docker/build.sh <env>` by hand to rebuild just the runner image), we only have
# config.env's RAW pre-bootstrap values — CLUSTER_TYPE=<type> with CLUSTER_CONFIG_JSON={} and no
# kubeconfig — so yf-materialize-kubeconfig below dies with KeyError: 'kubeconfig' (and the
# production registry step fails likewise).
#
# Re-read the enriched config that Step 3 of the LAST deploy cached to .deploy-config.json (see
# prod/runall-production.sh) and export the same env vars its own eval does. This runs NO
# bootstrap() — it never starts/resizes/restarts the cluster, re-mints a credential, or redeploys
# anything; it just reuses this deploy's already-resolved config, uniformly for every cluster type.
# Guarded on an empty INHERITED _ENV_CLUSTER_CONFIG_JSON (runall always passes a non-empty, enriched
# one), so it never runs — and never overrides live values — in the runall-child path.
if [ "${DEPLOYMENT:-}" = "production" ] && [ -z "$_ENV_CLUSTER_CONFIG_JSON" ]; then
    DEPLOY_CONFIG_FILE="$(pwd)/.deploy-config.json"   # pwd == project root (cd'd at top of script)
    if [ ! -f "${DEPLOY_CONFIG_FILE}" ]; then
        echo "ERROR: ${DEPLOY_CONFIG_FILE} not found." >&2
        echo "  It is written by prod/runall-production.sh on each deploy and holds the enriched" >&2
        echo "  registry/cluster config a standalone docker/build.sh needs. Run a full deploy" >&2
        echo "  (prod/runall-production.sh) once before building a runner image standalone." >&2
        exit 1
    fi
    echo "Loading enriched backend config cached by the last deploy (${DEPLOY_CONFIG_FILE})..." >&2
    # Same axis->env-var mapping prod/runall-production.sh's Step 3 eval uses, reading the cached
    # file instead of a fresh bootstrap result.
    eval "$(python3 -c '
import json, sys, shlex

with open(sys.argv[1]) as f:
    data = json.load(f)
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
' "${DEPLOY_CONFIG_FILE}")"
fi

# ── Materialize kubeconfig: point kubectl at the resolved cluster, never the ambient context ──
# See docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 1. Cheap/harmless
# even when this script's kubectl-using (production) branch doesn't run.
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
env/bin/python backend/bin/yf-materialize-kubeconfig > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"

# Content-addressed tag for the backend/frontend images (see docs/plans/versioned-app-image-tags.md).
# Threaded through from prod/runall-production.sh's Step 10 invocation when this script runs as
# its subprocess; resolved directly when this script runs standalone.
APP_IMAGE_VERSION="${APP_IMAGE_VERSION:-$(env/bin/python backend/bin/yf-resolve-app-image-tag)}"

echo "=== Building YmerFlow Runner Image for ${ENV_NAME} Environment ==="
echo "    Repository: ymerflow-base-runner:${ENV_TAG}"
echo ""

# Registry-protocol-agnostic build+push: `docker build` runs against the HOST's own Docker
# daemon — never `minikube docker-env` or any other cluster-provider daemon (see
# docs/plans/generic-deployment-orchestration.md, Design decision 2) — then the result is pushed
# through whatever RegistryProtocolHandler the active RegistryBackend resolves to via
# backend/bin/yf-build-and-push. It prints only the resolved full image reference to
# stdout; the build log and all diagnostics go to stderr.
echo "Building and pushing ymerflow-base-runner:${ENV_TAG}..."

if [ "${DEPLOYMENT:-}" = "production" ]; then
    # yf-build-and-push needs a DB connection to look up the active RegistryBackend, but
    # in production mode (all services in-cluster) Postgres is ClusterIP-only (no host-reachable
    # port) — the host can't query it directly. REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON are already
    # sitting in this shell's own environment though — exported by
    # prod/runall-production.sh's Step 3 bootstrap-provision, inherited here since this script
    # runs as a direct child of that shell (Step 10) — so read them straight from here instead of
    # reaching into the backend pod (`kubectl exec ... --resolve-only`) purely to read a value
    # that's already local. See docs/plans/base-infrastructure-via-cluster-provider.md.
    RESOLVED_JSON=$(python3 -c '
import json, os
print(json.dumps({"protocol": os.environ["REGISTRY_PROTOCOL"], "config": json.loads(os.environ["REGISTRY_CONFIG_JSON"])}))
')
    FULL_IMAGE=$(YMERFLOW_RESOLVED_REGISTRY_JSON="${RESOLVED_JSON}" env/bin/python backend/bin/yf-build-and-push \
        docker/base-runner/Dockerfile . ymerflow-base-runner "${ENV_TAG}")
else
    FULL_IMAGE=$(env/bin/python backend/bin/yf-build-and-push \
        docker/base-runner/Dockerfile . ymerflow-base-runner "${ENV_TAG}")
fi

echo "✓ Image ymerflow-base-runner:${ENV_TAG} built and pushed to: ${FULL_IMAGE}"
echo ""

# Extract process schemas from the built image and update environment
echo "=== Updating ${ENV_NAME} Environment ==="
echo ""
echo "Extracting process schemas from image..."

# Create temporary file for the schemas
SCHEMA_FILE=$(mktemp)

# Extract process_schemas.json from the image using docker (local build tag, still present in
# the host's own Docker daemon from the build above)
if docker run --rm --entrypoint cat "ymerflow-base-runner:${ENV_TAG}" /app/process_schemas.json > "$SCHEMA_FILE" 2>&1; then
    echo "✓ Extracted process schemas from image"

    # Show what we extracted
    PROCESS_COUNT=$(python3 -c "import json; print(len(json.load(open('$SCHEMA_FILE'))))" 2>/dev/null || echo "0")
    echo "  Found $PROCESS_COUNT process type(s)"

    # Update the database
    echo ""
    echo "Updating ${ENV_NAME} environment in database..."

    # FULL_IMAGE was already resolved above (backend/bin/yf-build-and-push) — reused here
    # for the database/schema-extraction step instead of being reconstructed.

    if [ "${DEPLOYMENT:-}" = "production" ]; then
        # Production mode → run update as a Kubernetes Job against in-cluster PostgreSQL
        echo "  Running database update as kubernetes job..."

        # The Job needs a resolved, pullable backend image ref (registry-agnostic — the same one
        # yf-deploy-app resolves for its own Deployments) instead of the old hardcoded
        # `ymerflow-backend:prod` + `imagePullPolicy: Never` (only worked when that exact tag
        # already sat in whatever local daemon the target node used — never true for a
        # non-same-as-backend cluster). REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON are the same
        # already-local env vars used above for the runner image push.
        BACKEND_IMAGE=$(APP_IMAGE_VERSION="${APP_IMAGE_VERSION}" env/bin/python -c '
import json, os
from backend.services.registry_protocols import get_registry_protocol_handler
protocol = os.environ["REGISTRY_PROTOCOL"]
config = json.loads(os.environ["REGISTRY_CONFIG_JSON"])
print(get_registry_protocol_handler(protocol).direct_image_url(config, "ymerflow-backend", os.environ["APP_IMAGE_VERSION"]))
')

        kubectl delete configmap "runner-schemas-${ENV_TAG}" -n ymerflow --ignore-not-found=true 2>/dev/null
        kubectl create configmap "runner-schemas-${ENV_TAG}" \
            --from-file=process_schemas.json="$SCHEMA_FILE" \
            -n ymerflow
        kubectl delete job "db-update-${ENV_TAG}" -n ymerflow --ignore-not-found=true 2>/dev/null
        kubectl apply -f - <<MANIFEST
apiVersion: batch/v1
kind: Job
metadata:
  name: db-update-${ENV_TAG}
  namespace: ymerflow
spec:
  template:
    spec:
      imagePullSecrets:
      - name: ymerflow-app-pull
      containers:
      - name: update
        image: ${BACKEND_IMAGE}
        # BACKEND_IMAGE is now a content-addressed tag (APP_IMAGE_VERSION) — never reused for
        # different content — so IfNotPresent is correct and faster than an unconditional re-pull.
        # See docs/plans/versioned-app-image-tags.md and job_orchestrator.py's existing
        # IfNotPresent precedent.
        imagePullPolicy: IfNotPresent
        command: ["python3", "/app/update_bootstrap_environment.py",
                  "/schemas/process_schemas.json", "${ENV_NAME}", "${FULL_IMAGE}"]
        envFrom:
        - secretRef:
            name: ymerflow-backend-secret
        volumeMounts:
        - name: schemas
          mountPath: /schemas
      volumes:
      - name: schemas
        configMap:
          name: runner-schemas-${ENV_TAG}
      restartPolicy: Never
  backoffLimit: 0
MANIFEST
        kubectl wait --for=condition=complete "job/db-update-${ENV_TAG}" -n ymerflow --timeout=60s
        kubectl logs "job/db-update-${ENV_TAG}" -n ymerflow
        kubectl delete job "db-update-${ENV_TAG}" -n ymerflow
        kubectl delete configmap "runner-schemas-${ENV_TAG}" -n ymerflow
        echo ""
        echo "✓ ${ENV_NAME} environment updated successfully"
    elif python3 docker/update_bootstrap_environment.py "$SCHEMA_FILE" "$ENV_NAME" "$FULL_IMAGE"; then
        # No ymerflow namespace → dev mode with local SQLite database
        echo ""
        echo "✓ ${ENV_NAME} environment updated successfully"
    else
        echo ""
        echo "✗ Failed to update ${ENV_NAME} environment"
        rm "$SCHEMA_FILE"
        exit 1
    fi
else
    echo "⚠ Could not extract process_schemas.json from image"
    echo "  (This is expected if the image doesn't have process schemas yet)"
fi

# Clean up
rm -f "$SCHEMA_FILE"

echo ""
echo "=== ✅ Setup complete! ==="
echo ""
echo "To build for a different environment, run:"
echo "  ./docker/build.sh \"Environment Name\""
echo ""

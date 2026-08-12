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
if [ -f "config.env" ]; then
    source "config.env"
fi
[ -n "$_ENV_DEPLOYMENT" ] && DEPLOYMENT="$_ENV_DEPLOYMENT"
[ -n "$_ENV_CLUSTER_TYPE" ] && CLUSTER_TYPE="$_ENV_CLUSTER_TYPE"
[ -n "$_ENV_CLUSTER_CONFIG_JSON" ] && CLUSTER_CONFIG_JSON="$_ENV_CLUSTER_CONFIG_JSON"
[ -n "$_ENV_REGISTRY_PROTOCOL" ] && REGISTRY_PROTOCOL="$_ENV_REGISTRY_PROTOCOL"
[ -n "$_ENV_REGISTRY_CONFIG_JSON" ] && REGISTRY_CONFIG_JSON="$_ENV_REGISTRY_CONFIG_JSON"
[ -n "$_ENV_STORAGE_PROTOCOL" ] && STORAGE_PROTOCOL="$_ENV_STORAGE_PROTOCOL"
[ -n "$_ENV_STORAGE_CONFIG_JSON" ] && STORAGE_CONFIG_JSON="$_ENV_STORAGE_CONFIG_JSON"

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
echo "    Repository: nagelfluh-base-runner:${ENV_TAG}"
echo ""

# Registry-protocol-agnostic build+push: `docker build` runs against the HOST's own Docker
# daemon — never `minikube docker-env` or any other cluster-provider daemon (see
# docs/plans/generic-deployment-orchestration.md, Design decision 2) — then the result is pushed
# through whatever RegistryProtocolHandler the active RegistryBackend resolves to via
# backend/bin/yf-build-and-push. It prints only the resolved full image reference to
# stdout; the build log and all diagnostics go to stderr.
echo "Building and pushing nagelfluh-base-runner:${ENV_TAG}..."

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
    FULL_IMAGE=$(NAGELFLUH_RESOLVED_REGISTRY_JSON="${RESOLVED_JSON}" env/bin/python backend/bin/yf-build-and-push \
        docker/base-runner/Dockerfile . nagelfluh-base-runner "${ENV_TAG}")
else
    FULL_IMAGE=$(env/bin/python backend/bin/yf-build-and-push \
        docker/base-runner/Dockerfile . nagelfluh-base-runner "${ENV_TAG}")
fi

echo "✓ Image nagelfluh-base-runner:${ENV_TAG} built and pushed to: ${FULL_IMAGE}"
echo ""

# Extract process schemas from the built image and update environment
echo "=== Updating ${ENV_NAME} Environment ==="
echo ""
echo "Extracting process schemas from image..."

# Create temporary file for the schemas
SCHEMA_FILE=$(mktemp)

# Extract process_schemas.json from the image using docker (local build tag, still present in
# the host's own Docker daemon from the build above)
if docker run --rm --entrypoint cat "nagelfluh-base-runner:${ENV_TAG}" /app/process_schemas.json > "$SCHEMA_FILE" 2>&1; then
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
print(get_registry_protocol_handler(protocol).image_url(config, "ymerflow-backend", os.environ["APP_IMAGE_VERSION"]))
')

        kubectl delete configmap "runner-schemas-${ENV_TAG}" -n nagelfluh --ignore-not-found=true 2>/dev/null
        kubectl create configmap "runner-schemas-${ENV_TAG}" \
            --from-file=process_schemas.json="$SCHEMA_FILE" \
            -n nagelfluh
        kubectl delete job "db-update-${ENV_TAG}" -n nagelfluh --ignore-not-found=true 2>/dev/null
        kubectl apply -f - <<MANIFEST
apiVersion: batch/v1
kind: Job
metadata:
  name: db-update-${ENV_TAG}
  namespace: nagelfluh
spec:
  template:
    spec:
      imagePullSecrets:
      - name: nagelfluh-app-pull
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
            name: nagelfluh-backend-secret
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
        kubectl wait --for=condition=complete "job/db-update-${ENV_TAG}" -n nagelfluh --timeout=60s
        kubectl logs "job/db-update-${ENV_TAG}" -n nagelfluh
        kubectl delete job "db-update-${ENV_TAG}" -n nagelfluh
        kubectl delete configmap "runner-schemas-${ENV_TAG}" -n nagelfluh
        echo ""
        echo "✓ ${ENV_NAME} environment updated successfully"
    elif python3 docker/update_bootstrap_environment.py "$SCHEMA_FILE" "$ENV_NAME" "$FULL_IMAGE"; then
        # No nagelfluh namespace → dev mode with local SQLite database
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

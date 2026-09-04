#!/bin/bash
# Debug harness that runs as a K8s pod (like the real job does)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/config.json}"

# Load environment variables from config.env if it exists
if [ -f "$PROJECT_ROOT/config.env" ]; then
    echo "Loading environment from $PROJECT_ROOT/config.env"
    set -a
    source "$PROJECT_ROOT/config.env"
    set +a
    echo ""
fi

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Configuration file not found: $CONFIG_FILE"
    exit 1
fi

# ── Materialize kubeconfig: point kubectl at the resolved cluster, never the ambient context ──
# See docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 1.
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
"$PROJECT_ROOT/env/bin/python" "$PROJECT_ROOT/backend/bin/yf-materialize-kubeconfig" > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"

# Parse config file
read -r PROCESS_TYPE PROCESS_ID VERSION PROJECT_ID DOCKER_IMAGE STORAGE_BASE CONFIG_STORAGE_ENDPOINT CONFIG_AWS_ACCESS_KEY CONFIG_AWS_SECRET_KEY PARAMETERS_JSON < <(python3 <<EOF
import json
with open('$CONFIG_FILE') as f:
    config = json.load(f)
print(
    config['process_type'],
    config['process_id'],
    config['version'],
    config['project_id'],
    config['docker_image'],
    config['storage_base'],
    config['storage_endpoint'],
    config['aws_access_key_id'],
    config['aws_secret_access_key'],
    json.dumps(config['parameters'])
)
EOF
)

# Use credentials from .env
if [ -n "$AWS_ACCESS_KEY_ID" ]; then
    FINAL_AWS_ACCESS_KEY="$AWS_ACCESS_KEY_ID"
    FINAL_AWS_SECRET_KEY="${AWS_SECRET_ACCESS_KEY}"
    CRED_SOURCE="AWS_ACCESS_KEY_ID from config.env"
elif [ -n "$MINIO_ROOT_USER" ]; then
    FINAL_AWS_ACCESS_KEY="$MINIO_ROOT_USER"
    FINAL_AWS_SECRET_KEY="$MINIO_ROOT_PASSWORD"
    CRED_SOURCE="MINIO_ROOT_USER from config.env"
else
    FINAL_AWS_ACCESS_KEY="$CONFIG_AWS_ACCESS_KEY"
    FINAL_AWS_SECRET_KEY="$CONFIG_AWS_SECRET_KEY"
    CRED_SOURCE="config.json"
fi

# Convert localhost endpoint to internal service name (like job_orchestrator.py does)
POD_STORAGE_ENDPOINT="${CONFIG_STORAGE_ENDPOINT/http:\/\/localhost:9000/http:\/\/minio-ymerflow.ymerflow-jobs.svc.cluster.local:9000}"

echo "=========================================="
echo "Starting Debug Pod in K8s"
echo "=========================================="
echo "Process Type: $PROCESS_TYPE"
echo "Process ID: $PROCESS_ID"
echo "Docker Image: $DOCKER_IMAGE"
echo "Storage Endpoint: $POD_STORAGE_ENDPOINT"
echo "Credentials Source: $CRED_SOURCE"
echo "=========================================="
echo ""

# Create debug pod YAML with debug_runner.py as a ConfigMap
POD_NAME="debug-${PROCESS_ID}-$(date +%s)"

# Setup cleanup on exit — also removes KUBECONFIG_FILE, since this trap replaces the one set
# above (bash's `trap ... EXIT` overwrites rather than stacks).
cleanup() {
    echo ""
    echo "Cleaning up..."
    kubectl delete pod $POD_NAME -n ymerflow-jobs --wait=false 2>/dev/null || true
    kubectl delete configmap $POD_NAME-scripts -n ymerflow-jobs 2>/dev/null || true
    rm -f "$KUBECONFIG_FILE"
    echo "Cleanup complete"
}
trap cleanup EXIT

# Create ConfigMap with debug scripts
kubectl create configmap "$POD_NAME-scripts" \
    --from-file=debug_runner.py="$SCRIPT_DIR/debug_runner.py" \
    --from-file=runner.py="$SCRIPT_DIR/runner_debug.py" \
    -n ymerflow-jobs \
    --dry-run=client -o yaml | kubectl apply -f -

# Create pod YAML
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: $POD_NAME
  namespace: ymerflow-jobs
spec:
  restartPolicy: Never
  containers:
  - name: debug
    image: $DOCKER_IMAGE
    imagePullPolicy: IfNotPresent
    command: ["sleep", "3600"]
    stdin: true
    tty: true
    env:
    - name: PROCESS_TYPE
      value: "$PROCESS_TYPE"
    - name: PROCESS_ID
      value: "$PROCESS_ID"
    - name: VERSION
      value: "$VERSION"
    - name: PROJECT_ID
      value: "$PROJECT_ID"
    - name: PARAMETERS_JSON
      value: '$PARAMETERS_JSON'
    - name: BACKEND_URL
      value: "http://backend-service:8000"
    - name: STORAGE_BASE
      value: "$STORAGE_BASE"
    - name: STORAGE_ENDPOINT
      value: "$POD_STORAGE_ENDPOINT"
    - name: AWS_ACCESS_KEY_ID
      value: "$FINAL_AWS_ACCESS_KEY"
    - name: AWS_SECRET_ACCESS_KEY
      value: "$FINAL_AWS_SECRET_KEY"
    volumeMounts:
    - name: scripts
      mountPath: /app/debug_runner.py
      subPath: debug_runner.py
    - name: scripts
      mountPath: /app/runner.py
      subPath: runner.py
  volumes:
  - name: scripts
    configMap:
      name: $POD_NAME-scripts
EOF

echo ""
echo "Waiting for pod to start..."
kubectl wait --for=condition=Ready pod/$POD_NAME -n ymerflow-jobs --timeout=60s

echo ""
echo "=========================================="
echo "Starting debug session in pod"
echo "=========================================="
echo ""

# Execute the debug runner interactively in the pod
kubectl exec -it $POD_NAME -n ymerflow-jobs -- python /app/debug_runner.py

echo ""
echo "=========================================="
echo "Debug session ended"
echo "=========================================="

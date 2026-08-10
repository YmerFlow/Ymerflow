#!/bin/bash
set -e

cd "$(dirname "$0")"

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ]; then
    echo "Usage: $0 <backup_dir>"
    echo ""
    echo "Available backups:"
    ls -d backup_* 2>/dev/null | sort -r || echo "  (none)"
    exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
    echo "Error: backup directory not found: $BACKUP_DIR"
    exit 1
fi

# ── Materialize kubeconfig: point kubectl at the resolved cluster, never the ambient context ──
# See docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 1.
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
env/bin/python backend/bin/nagelfluh-materialize-kubeconfig > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"

echo "=== YmerFlow Restore from $BACKUP_DIR ==="
echo ""

restore_secrets() {
    local INPUT="$1"
    if [ ! -f "$INPUT" ]; then
        echo "  (skipping secrets - file not found: $INPUT)"
        return
    fi
    echo "Restoring secrets..."
    kubectl apply -f "$INPUT"
    echo "  ✓ Secrets"
}

restore_pvc() {
    local NAME="$1" NAMESPACE="$2" PVC="$3" INPUT="$4"
    echo "Restoring $NAME..."

    kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: restore-helper
  namespace: $NAMESPACE
spec:
  restartPolicy: Never
  containers:
  - name: helper
    image: busybox
    command: ["sleep", "3600"]
    volumeMounts:
    - name: pvc
      mountPath: /pvc
  volumes:
  - name: pvc
    persistentVolumeClaim:
      claimName: $PVC
EOF
    kubectl wait pod/restore-helper -n "$NAMESPACE" --for=condition=Ready --timeout=60s
    kubectl exec -n "$NAMESPACE" restore-helper -- sh -c "rm -rf /pvc/* /pvc/.[!.]*"
    kubectl exec -i -n "$NAMESPACE" restore-helper -- tar xzf - -C /pvc < "$INPUT"
    kubectl delete pod restore-helper -n "$NAMESPACE" --wait=false
    echo "  ✓ $NAME"
}

# Scale down
kubectl scale deployment/backend   -n nagelfluh --replicas=0
kubectl scale statefulset/postgres -n nagelfluh --replicas=0
kubectl scale deployment/minio     -n minio      --replicas=0
kubectl wait pod -n nagelfluh -l app=backend  --for=delete --timeout=60s 2>/dev/null || true
kubectl wait pod -n nagelfluh -l app=postgres --for=delete --timeout=60s 2>/dev/null || true
kubectl wait pod -n minio     -l app=minio    --for=delete --timeout=60s 2>/dev/null || true

restore_secrets "$BACKUP_DIR/secrets-nagelfluh.yaml"
restore_pvc "PostgreSQL" nagelfluh data-postgres-0 "$BACKUP_DIR/postgres.tar.gz"
restore_pvc "MinIO"      minio     minio-pvc        "$BACKUP_DIR/minio.tar.gz"

# Scale back up
kubectl scale statefulset/postgres -n nagelfluh --replicas=1
kubectl scale deployment/minio     -n minio      --replicas=1
kubectl scale deployment/backend   -n nagelfluh --replicas=1

echo ""
echo "Done"

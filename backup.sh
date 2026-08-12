#!/bin/bash
set -e

cd "$(dirname "$0")"

# ── Materialize kubeconfig: point kubectl at the resolved cluster, never the ambient context ──
# See docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 1.
KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "$KUBECONFIG_FILE"' EXIT
env/bin/python backend/bin/yf-materialize-kubeconfig > "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"

BACKUP_DIR="backup_$(date +%Y%m%d_%H%M%S)"
mkdir "$BACKUP_DIR"

echo "=== YmerFlow Backup → $BACKUP_DIR ==="
echo ""

backup_secrets() {
    local NAMESPACE="$1" OUTPUT="$2"
    echo "Backing up secrets ($NAMESPACE)..."
    kubectl get secrets -n "$NAMESPACE" -o json | python3 -c "
import json, sys
d = json.load(sys.stdin)
strip = ('resourceVersion','uid','creationTimestamp','managedFields','generation','selfLink')
items = []
for s in d.get('items', []):
    if s.get('type') == 'kubernetes.io/service-account-token':
        continue
    for f in strip:
        s.get('metadata', {}).pop(f, None)
    items.append(s)
d['items'] = items
json.dump(d, sys.stdout, indent=2)
" > "$OUTPUT"
    local COUNT
    COUNT=$(python3 -c "import json; print(len(json.load(open('$OUTPUT'))['items']))")
    echo "  ✓ $COUNT secrets"
}

backup_pvc() {
    local NAME="$1" NAMESPACE="$2" PVC="$3" OUTPUT="$4"
    echo "Backing up $NAME..."

    kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: backup-helper
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
    kubectl wait pod/backup-helper -n "$NAMESPACE" --for=condition=Ready --timeout=60s
    kubectl exec -n "$NAMESPACE" backup-helper -- tar czf - -C /pvc . > "$OUTPUT"
    kubectl delete pod backup-helper -n "$NAMESPACE" --wait=false
    echo "  ✓ $(du -sh "$OUTPUT" | cut -f1)"
}

# Scale down for consistent snapshots
kubectl scale statefulset/postgres -n ymerflow --replicas=0
kubectl scale deployment/minio    -n minio      --replicas=0
kubectl wait pod -n ymerflow -l app=postgres --for=delete --timeout=60s 2>/dev/null || true
kubectl wait pod -n minio     -l app=minio    --for=delete --timeout=60s 2>/dev/null || true

backup_secrets ymerflow "$BACKUP_DIR/secrets-ymerflow.yaml"
backup_pvc "PostgreSQL" ymerflow data-postgres-0 "$BACKUP_DIR/postgres.tar.gz"
backup_pvc "MinIO"      minio     minio-pvc        "$BACKUP_DIR/minio.tar.gz"

# Scale back up
kubectl scale statefulset/postgres -n ymerflow --replicas=1
kubectl scale deployment/minio    -n minio      --replicas=1

echo ""
echo "Done: $BACKUP_DIR"

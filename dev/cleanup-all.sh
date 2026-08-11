#!/bin/bash
# Comprehensive cleanup script for the Nagelfluh development environment.
# This script cleans up:
# - Screen sessions (dev services)
# - Stray kubectl port-forwards (informational — MinIO/registry use NodePort, not port-forward)
# - All bootstrap-provisioned backends (registry/storage/cluster), via the generic
#   yf-bootstrap-teardown entry point — whatever REGISTRY_PROTOCOL/STORAGE_PROTOCOL/
#   CLUSTER_TYPE resolve to, NOT a hardcoded registry/MinIO/Kueue teardown (see
#   docs/plans/generic-deployment-orchestration.md, Phase 8).
#
# Does NOT stop or delete the cluster itself (e.g. the Minikube VM) — that stays a manual,
# explicit operation, printed as guidance below (Design decision 6).

set -e

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

# Load user config, exporting all variables so the teardown entry point inherits the
# <AXIS>_PROTOCOL/<AXIS>_CONFIG_JSON pairs it dispatches on.
if [ -f "config.env" ]; then
    set -a
    source config.env
    set +a
fi

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo "=========================================="
echo "Nagelfluh Complete Cleanup"
echo "=========================================="
echo ""

# ==========================================
# Step 1: Stop Screen Sessions
# ==========================================
echo "Step 1: Stopping screen sessions..."
if screen -list | grep -q "nagelfluh-dev"; then
    screen -X -S nagelfluh-dev quit 2>/dev/null || true
    print_status "Screen session stopped"
else
    print_status "No screen session running"
fi

# ==========================================
# Step 2: Report Port-Forwards
# ==========================================
echo ""
echo "Step 2: Checking for stray port-forwards..."
if pgrep -f "kubectl port-forward" > /dev/null; then
    print_warning "kubectl port-forwards still running:"
    pgrep -f "kubectl port-forward" -a || true
else
    print_status "No kubectl port-forwards running"
fi

# ==========================================
# Step 3: Tear down bootstrap-provisioned backends
# ==========================================
# Generic teardown — the mirror of dev/runall.sh Step 2's yf-bootstrap-provision. Resolves
# each configured axis's handler and calls its teardown() hook (registry/storage delete their
# namespaces; the cluster provider deletes the jobs namespace + Kueue config). Each teardown() is
# idempotent, so this is a clean no-op if nothing was ever provisioned OR if it's run twice in a
# row. No `minikube status` gate: the teardown handlers themselves connect to whatever cluster the
# axis config points at and simply find nothing to delete if it's already gone.
echo ""
echo "Step 3: Tearing down bootstrap-provisioned backends..."
if [ -d env ]; then
    PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-teardown || \
        print_warning "Teardown reported an error (cluster may already be gone) — continuing"
else
    print_warning "No Python venv (env/) found — skipping backend teardown"
fi
print_status "Backend teardown complete"

# ==========================================
# Done
# ==========================================
echo ""
echo "=========================================="
echo "Cleanup Complete!"
echo "=========================================="
echo ""
echo "The cluster itself was left running (only Nagelfluh's k8s resources were removed)."
echo ""
echo "To also stop/delete your cluster, do so manually — e.g. for a local Minikube setup:"
echo "  minikube stop      # stop the VM (keeps data)"
echo "  minikube delete    # destroy the VM completely (WARNING: destroys all data)"
echo ""
echo "To start fresh, run:"
echo "  ./dev/runall.sh"
echo ""

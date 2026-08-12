#!/bin/bash
# Master setup and run script for YmerFlow development environment
# This script:
# - Installs dependencies (including backend plugins)
# - Bootstrap-provisions the registry/storage/cluster axes (by default: the local Minikube +
#   MinIO + docker-v2 registry stack, via plugins/ymerflow-minikube — see
#   docs/plans/minikube-provisioning-plugin.md)
# - Runs database migrations
# - Builds docker images
# - Starts all services in a single screen session with multiple windows

set -e

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

# Load user config, exporting all variables so child processes (setup scripts, screen windows) inherit them
if [ -f "config.env" ]; then
    set -a
    source config.env
    set +a
fi

# Default REGISTRY_PUBLIC_HOST to the host's primary LAN IP when not set in config.env (same
# pattern as prod/runall-production.sh's Step 1, and MINIKUBE_APISERVER_IPS below it). Must be
# exported here, before Step 2's bootstrap-provision — that's what actually calls
# DockerV2ProtocolHandler.bootstrap(), which requires this to be set (see
# docs/plans/done/remote-cluster-provisioning-and-registry.md, Design decision 1: one public
# address, used everywhere, so the handler itself never falls back to a minikube-internal IP that
# a remote cluster's nodes couldn't reach). A plain LAN IP is fine for pure local dev — this does
# not need to be a real public IP/DNS name.
export REGISTRY_PUBLIC_HOST="${REGISTRY_PUBLIC_HOST:-$(hostname -I | awk '{print $1}')}"

echo "=========================================="
echo "YmerFlow Development Environment Setup"
echo "=========================================="
echo ""

# Color codes for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_section() {
    echo ""
    echo "=========================================="
    echo "$1"
    echo "=========================================="
    echo ""
}

# Function to check if a screen session exists
screen_exists() {
    screen -list | grep -q "\.$1\s"
}

# Function to kill a screen session if it exists
kill_screen() {
    if screen_exists "$1"; then
        print_warning "Killing existing screen session: $1"
        screen -S "$1" -X quit || true
        sleep 1
    fi
}

# ==========================================
# Step 1: Python Environment Setup
# ==========================================
print_section "Step 1: Python Environment Setup"

if [ ! -d "env" ]; then
    print_warning "Virtual environment not found. Creating..."
    python3 -m venv env
    print_status "Virtual environment created"
fi

# Activate virtual environment
source env/bin/activate
print_status "Virtual environment activated"

# Install/upgrade backend dependencies
echo "Installing Python dependencies..."
pip install -q --upgrade pip
pip install -q -e "${PROJECT_ROOT}"
print_status "Python dependencies installed"

# Install server-side backend plugins listed in BACKEND_PLUGINS (paths / PyPI names / git URLs).
# Same script the prod backend image uses, so dev and prod install plugins identically. This MUST
# happen before Step 2's bootstrap-provision: by default BACKEND_PLUGINS includes
# plugins/ymerflow-minikube, which is what registers the docker-v2/minio/minikube handlers that
# bootstrap-provision resolves — without it installed first, that step has nothing to resolve
# REGISTRY_PROTOCOL/STORAGE_PROTOCOL/CLUSTER_TYPE to.
echo "Installing backend plugins..."
BACKEND_PLUGINS="${BACKEND_PLUGINS:-}" bash "${PROJECT_ROOT}/scripts/install-backend-plugins.sh"
print_status "Backend plugins installed"

# ==========================================
# Step 2: Bootstrap-provision configured backends
# ==========================================
print_section "Step 2: Bootstrap Provisioning"

# For each axis (registry/storage/cluster) where <AXIS>_PROTOCOL/<AXIS>_CONFIG_JSON is set in
# config.env (already exported above — see that file's defaults), resolve its handler and call
# bootstrap(). By default this is plugins/ymerflow-minikube's docker-v2/minio/minikube stack:
# MinikubeClusterProvider.bootstrap() starts/resizes the local Minikube VM itself (replacing the
# deleted dev/setup-minikube.sh), and MinioProtocolHandler/DockerV2ProtocolHandler.bootstrap()
# deploy MinIO/the registry into it (replacing dev/setup-minio.sh/dev/setup-registry.sh) — each is
# idempotent, so re-running this on every dev/runall.sh invocation is a fast no-op once already
# provisioned. The enriched {protocol, config} result overrides whatever config.env set, since
# bootstrap() is authoritative (it may have live-provisioned something — e.g. the MinIO root
# credentials actually deployed). See docs/plans/minikube-provisioning-plugin.md and
# docs/plans/registry-backend-hooks.md (Design decision 6).
echo "Running bootstrap-provision..."
BOOTSTRAP_JSON=$(PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision)

# eval runs directly in this shell (not inside a subshell) so the `export` statements it emits
# actually persist into this script's environment, and therefore into Step 5's yf-migrate
# subprocess. Do NOT wrap this eval in a command substitution — that would run it in a subshell
# and silently discard the exports.
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

# Separately (no exports involved here, just a plain string) determine which axes were
# bootstrap-provisioned, for the status line below.
BOOTSTRAPPED_AXES=$(python3 -c '
import json, sys

data = json.loads(sys.argv[1])
print(",".join(axis for axis in ("registry", "storage", "cluster") if axis in data))
' "${BOOTSTRAP_JSON}")

if [ -n "${BOOTSTRAPPED_AXES}" ]; then
    print_status "Bootstrap-provisioned axes: ${BOOTSTRAPPED_AXES} (enriched config exported for migrations)"
else
    print_status "No axes bootstrap-provisioned (no <AXIS>_PROTOCOL/<AXIS>_CONFIG_JSON set in config.env)"
fi

# ==========================================
# Step 3: Namespaces
# ==========================================
print_section "Step 3: Namespaces"

# Minikube now exists (Step 2 brought it up, if it wasn't already) — safe to talk to it. Image
# pre-pulling is no longer a separate step here: each protocol's own bootstrap() (Step 2, above)
# pre-pulls its own image before applying its Deployment (see
# docs/plans/generic-deployment-orchestration.md, Phase 3).
kubectl apply -f "${PROJECT_ROOT}/k8s/00-namespaces.yaml"
print_status "Namespaces ready"

# ==========================================
# Step 4: Frontend Dependencies
# ==========================================
print_section "Step 4: Frontend Dependencies"

cd frontend
if [ ! -d "node_modules" ]; then
    print_warning "node_modules not found. Installing..."
    npm install
    print_status "Frontend dependencies installed"
else
    print_status "Frontend dependencies already installed"
fi
cd "$PROJECT_ROOT"

# ==========================================
# Step 5: Database Migrations
# ==========================================
print_section "Step 5: Database Migrations"

echo "Running database migrations..."
PYTHONPATH=. env/bin/python backend/bin/yf-migrate
print_status "Database migrations complete"

# ==========================================
# Step 5b: Sync bootstrap-provisioned config into the database
# ==========================================
print_section "Step 5b: Syncing Bootstrap Config to Database"

# The one-shot seeding migrations (50dd9ce3311b for registry, 9623bab8493d for storage) only ever
# write REGISTRY_CONFIG_JSON/STORAGE_CONFIG_JSON into the DB the FIRST time migrations are ever
# applied to a fresh DB. But key-minting bootstrap() handlers (e.g. GarProtocolHandler,
# GcsProtocolHandler) mint a brand-new SA key — and delete the previous one — on every Step 2
# bootstrap-provision run, not just the first. Without this step, every run after the DB's first
# migration leaves the DB holding a now-deleted key while a fresh, working one sits unused in this
# shell's env, so anything reading the active backend row straight from the DB (e.g.
# nagelfluh-build-and-push, Step 7) fails with a permanent "Invalid JWT Signature" — not a
# transient propagation delay. Unconditionally overwrite protocol+config on the active row for
# each bootstrapped axis, every run, so the DB can never go stale relative to what Step 2 actually
# provisioned.
echo "Syncing bootstrap-provisioned registry/storage config into the database..."
PYTHONPATH=. env/bin/python -c '
import json, os

from sqlalchemy import create_engine, update

from backend.models.registry_backend import RegistryBackend
from backend.models.storage_backend import StorageBackend


def sync(model, protocol_env, config_env):
    protocol = os.environ.get(protocol_env)
    config_json = os.environ.get(config_env)
    if not protocol or not config_json:
        return
    config = json.loads(config_json)
    database_url = os.getenv("DATABASE_URL", "sqlite:///./nagelfluh.db").replace(
        "postgresql+asyncpg://", "postgresql://")
    engine = create_engine(database_url)
    with engine.begin() as conn:
        result = conn.execute(
            update(model).where(model.active == True).values(protocol=protocol, config=config)
        )
        print(f"  {model.__tablename__}: updated {result.rowcount} active row(s)")


sync(RegistryBackend, "REGISTRY_PROTOCOL", "REGISTRY_CONFIG_JSON")
sync(StorageBackend, "STORAGE_PROTOCOL", "STORAGE_CONFIG_JSON")
'
print_status "Bootstrap config synced to database"

# ==========================================
# Step 6: Registry Verification
# ==========================================
print_section "Step 6: Registry Verification"

# Generic, protocol-agnostic connectivity check via RegistryProtocolHandler.test_connection()
# (see docs/plans/generic-deployment-orchestration.md, Phase 4) — replaces the old hand-rolled
# "wait for a Deployment named `registry` in a namespace named `registry`, then curl its /v2/
# endpoint" loop, which assumed a registry that's a k8s Deployment at all (meaningless for a
# managed registry like GAR). DockerV2ProtocolHandler.bootstrap() (Step 2, above) already waited
# for its own Deployment to become available internally; this is an end-to-end confirmation that
# whatever REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON resolved to is actually reachable and
# authenticates.
echo "Testing registry connectivity (protocol=${REGISTRY_PROTOCOL})..."
PYTHONPATH=. env/bin/python -c '
import asyncio, json, os

from backend.services.registry_protocols import get_registry_protocol_handler

protocol = os.environ["REGISTRY_PROTOCOL"]
config = json.loads(os.environ["REGISTRY_CONFIG_JSON"])
handler = get_registry_protocol_handler(protocol)
asyncio.run(handler.test_connection(config))
'
print_status "Registry accessible (protocol=${REGISTRY_PROTOCOL})"

# ==========================================
# Step 7: Build Docker Image
# ==========================================
print_section "Step 7: Docker Image Build"

echo "Building YmerFlow runner image..."
# The docker/build.sh script will use the registry NodePort
./docker/build.sh
print_status "Docker image built and pushed to registry"

# ==========================================
# Step 8: Start Services in Screen
# ==========================================
print_section "Step 8: Starting Services"

# Kill existing screen session
SCREEN_SESSION="nagelfluh-dev"
kill_screen "$SCREEN_SESSION"

# Create a new detached screen session with the first window (backend)
echo "Starting services in screen session '$SCREEN_SESSION'..."
screen -dmS "$SCREEN_SESSION" -t backend bash -c "cd '$PROJECT_ROOT' && echo 'Starting backend...' && sleep 2 && ./backend/run.sh"

# Add frontend window
screen -S "$SCREEN_SESSION" -X screen -t frontend bash -c "cd '$PROJECT_ROOT/frontend' && echo 'Starting frontend...' && sleep 2 && npm start"

# Add service monitor window
screen -S "$SCREEN_SESSION" -X screen -t monitor bash -c "cd '$PROJECT_ROOT' && echo 'Starting service monitor...' && sleep 2 && ./dev/monitor-services.sh"

sleep 3

if screen_exists "$SCREEN_SESSION"; then
    print_status "All services started in screen session '$SCREEN_SESSION'"
else
    print_error "Failed to start screen session"
    exit 1
fi

# ==========================================
# Complete!
# ==========================================
print_section "Setup Complete!"

echo "Services running:"
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:3000"
echo "  MinIO:    https://localhost:9000 (self-signed cert)"
echo "  Registry: protocol=${REGISTRY_PROTOCOL} (connection details in REGISTRY_CONFIG_JSON)"
echo ""
echo "Screen session: $SCREEN_SESSION"
echo "  Window 0: backend          - FastAPI backend"
echo "  Window 1: frontend         - React frontend"
echo "  Window 2: monitor          - Service monitor (auto-restarts)"
echo ""
echo "Useful commands:"
echo "  screen -r $SCREEN_SESSION              # Attach to session"
echo "  Ctrl+A, then N                         # Next window"
echo "  Ctrl+A, then P                         # Previous window"
echo "  Ctrl+A, then 0/1/2                     # Switch to window 0/1/2"
echo "  Ctrl+A, then \"                          # List all windows"
echo "  Ctrl+A, then D                         # Detach from session"
echo "  screen -X -S $SCREEN_SESSION quit      # Stop all services"
echo ""
echo "To view logs, attach to screen and navigate between windows."
echo ""

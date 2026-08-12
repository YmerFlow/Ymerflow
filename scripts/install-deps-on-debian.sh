#!/bin/bash
# Install the generic system dependencies required to develop and run YmerFlow on Debian/Ubuntu,
# regardless of which cluster/registry/storage plugin is used.
# Run once on a fresh machine before running ./dev/runall.sh
#
# Installs:
#   - kubectl              (Kubernetes CLI — every deployment talks to some cluster)
#   - Node.js + npm        (frontend build)
#   - Python 3 + venv      (backend virtualenv)
#   - screen               (used by dev/runall.sh to multiplex services)
#   - curl, git            (general tooling)
#
# It does NOT install docker.io, minikube, or minio-client: those are specific to the
# ymerflow-minikube plugin's local Minikube-on-Docker + MinIO + docker-v2 stack, not generic
# YmerFlow deps (a cloud deployment on GKE/GAR/GCS needs none of them). If you're using that
# plugin, ALSO run its own dependency installer afterward:
#   plugins/ymerflow-minikube/scripts/install-deps.sh
# (see docs/plans/generic-deployment-orchestration.md, Phase 9 / Design decision 8).

set -e

# Detect OS
. /etc/os-release
echo "Detected OS: $NAME $VERSION_ID"

ARCH=$(dpkg --print-architecture)
echo "Architecture: $ARCH"

# ==========================================
# 1. Core apt packages
# ==========================================
echo ""
echo "=== Installing apt packages ==="

sudo apt-get update
sudo apt-get install -y \
    curl \
    git \
    screen \
    python3 \
    python3-venv \
    python3-pip \
    nodejs \
    npm \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release

# ==========================================
# 2. kubectl
# ==========================================
echo ""
echo "=== Installing kubectl ==="

KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt)
curl -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl
echo "kubectl $(kubectl version --client --short 2>/dev/null || kubectl version --client) installed"

# ==========================================
# 3. Node.js (LTS via NodeSource, if apt version is too old)
# ==========================================
echo ""
echo "=== Checking Node.js version ==="

NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "Node.js version too old ($NODE_MAJOR), installing LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "Node.js $(node --version), npm $(npm --version)"

# ==========================================
# Done
# ==========================================
echo ""
echo "============================================="
echo "Generic dependencies installed successfully!"
echo "============================================="
echo ""
echo "Next steps:"
echo "  1. If you're using the ymerflow-minikube plugin (the default local dev stack), also run:"
echo "       plugins/ymerflow-minikube/scripts/install-deps.sh"
echo "     then, if it added you to the 'docker' group, log out and back in (or: newgrp docker)."
echo "  2. Run the full dev setup:"
echo "       ./dev/runall.sh"
echo ""

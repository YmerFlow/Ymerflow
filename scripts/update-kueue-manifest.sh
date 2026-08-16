#!/bin/bash
# Refresh the vendored Kueue release manifest bundle that
# backend/services/cluster_job_provisioning.py applies when provisioning a cluster's Kueue
# operator.
#
# The bundle is vendored (checked in) rather than downloaded at provisioning time because that
# provisioning runs inside an alembic migration, where a transient GitHub release-CDN disconnect
# used to abort the whole `alembic upgrade`. Reading a pinned, in-image file removes that network
# dependency. The pin lives in KUEUE_VERSION_TAG in cluster_job_provisioning.py.
#
# To bump the Kueue version:
#   1. run this script with the new tag:  ./scripts/update-kueue-manifest.sh v0.17.0
#   2. update KUEUE_VERSION_TAG in backend/services/cluster_job_provisioning.py to match
#   3. remove the old kueue-manifests/<old>.yaml
#   4. verify the manifest still uses the same CRD/API version constants the module expects
#      (KUEUE_API_VERSION_STR, KUEUE_CRD_NAME, KUEUE_DEPLOYMENT_NAME, KUEUE_WEBHOOK_SERVICE_NAME)
set -euo pipefail

KUEUE_VERSION_TAG="${1:-v0.16.4}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${SCRIPT_DIR}/../backend/services/kueue-manifests"
DEST="${DEST_DIR}/${KUEUE_VERSION_TAG}.yaml"

mkdir -p "${DEST_DIR}"

# -f: fail on HTTP errors (don't save a GitHub error page); -L: follow the redirect to the CDN.
curl -fL \
  "https://github.com/kubernetes-sigs/kueue/releases/download/${KUEUE_VERSION_TAG}/manifests.yaml" \
  -o "${DEST}"

echo "Wrote ${DEST} ($(wc -l < "${DEST}") lines)"

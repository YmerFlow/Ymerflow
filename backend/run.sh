#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to parent directory so Python can find the 'backend' module
cd "$SCRIPT_DIR/.."

# Load user config, exporting all variables so child processes inherit them
if [ -f "config.env" ]; then
    set -a
    source config.env
    set +a
fi

# Derive REGISTRY_AUTH (base64 user:password) from REGISTRY_USER/REGISTRY_PASSWORD for
# settings.registry_auth. Defaults match plugins/ymerflow-minikube's registry_protocol.py, which
# always turns on registry auth even if config.env doesn't set these. See
# docs/plans/done/self-signed-tls-minio-registry.md.
if [ -z "${REGISTRY_AUTH:-}" ]; then
    export REGISTRY_AUTH=$(printf '%s:%s' "${REGISTRY_USER:-nagelfluh}" "${REGISTRY_PASSWORD:-nagelfluh}" | base64 -w0)
fi

# Activate virtual environment if it exists
if [ -d "env" ]; then
    source env/bin/activate
fi

# Run database migrations
echo "Running database migrations..."
python backend/bin/nagelfluh-migrate

# Start the server
echo "Starting YmerFlow server..."
uvicorn backend.main:app --reload \
  --reload-dir backend \
  --reload-dir plugins \
  --reload-delay 1.0

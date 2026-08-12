#!/bin/bash
# Install the server-side backend plugins listed in $BACKEND_PLUGINS.
#
# Each entry is a pip specifier and may be one of:
#   - a local path (e.g. plugins/billing)  -> installed EDITABLE so dev edits are picked up live
#   - a PyPI name   (e.g. some-plugin==1.2) -> installed from the registry
#   - a git URL     (e.g. git+ssh://git@github.com/org/repo.git) -> installed from git
#
# Backend plugins register `ymerflow.hooks` setuptools entry points that the host discovers at
# runtime (see backend/hooks.py). This script is the single source of truth for installing them and
# is invoked from BOTH dev/runall.sh (into the venv) and backend/Dockerfile (into the image), so the
# two modes stay in lock-step.
set -e

PLUGINS="${BACKEND_PLUGINS:-}"

if [ -z "${PLUGINS// /}" ]; then
    echo "No BACKEND_PLUGINS configured; no backend plugins to install."
    exit 0
fi

for spec in $PLUGINS; do
    if [ -d "$spec" ]; then
        echo "Installing backend plugin (editable local path): $spec"
        pip install -e "$spec"
    else
        echo "Installing backend plugin: $spec"
        pip install "$spec"
    fi
done

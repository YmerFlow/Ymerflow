FROM gcr.io/kaniko-project/executor:v1.24.0 AS kaniko

FROM python:3.11-slim-trixie

WORKDIR /app

# Install crane for extracting files from container images.
# Also install C++ build tools and libboost-dev (1.83 in Trixie) needed to
# compile pyinterp from source (requires Boost >= 1.79).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl tar ca-certificates gnupg \
        build-essential cmake clang libboost-dev libeigen3-dev && \
    curl -sL "https://github.com/google/go-containerregistry/releases/download/v0.19.0/go-containerregistry_Linux_x86_64.tar.gz" | tar -xz -C /usr/local/bin crane && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Node.js + npm — required by the build_frontend_plugin process type to run the real npm/vite
# Module-Federation build.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy Kaniko executor from the official kaniko image
COPY --from=kaniko /kaniko/executor /kaniko-executor

RUN echo "Version 11"

# Copy nagelfluh_runner package for utilities
RUN mkdir -p /app/nagelfluh_runner
COPY backend/utils/xyz_utils.py /app/nagelfluh_runner/xyz_utils.py
RUN touch /app/nagelfluh_runner/__init__.py

# Install the shared frontend-plugin build harness (used by build_frontend_plugin) from its own
# repo (ymerflow-plugin-sdk) via git URL. Nothing is copied from the host tree — the image depends
# only on the published repo. The repo is public, so https needs no build credentials; for a PRIVATE
# repo you would instead use a BuildKit ssh mount (`RUN --mount=type=ssh ... git+ssh://...`) or a
# token. Pin a tag/commit here once the SDK starts cutting releases.
RUN pip install --no-cache-dir "git+https://github.com/YmerFlow/Ymerflow-plugin-sdk.git@nagelfluh"

# Bake test plugins' npm SOURCE into the image so build_frontend_plugin can resolve them from the
# server-local source dir with no PVC/volume. `npm pack` each source into PLUGIN_NPM_SOURCE_DIR;
# the build routine resolves them by name@version (e.g. cluster-test-widget@1.0.0).
ENV PLUGIN_NPM_SOURCE_DIR=/var/lib/nagelfluh/plugin-npm-source
COPY docker/base-runner/plugin-npm-source /app/plugin-npm-source-src
RUN mkdir -p "$PLUGIN_NPM_SOURCE_DIR" && \
    for d in /app/plugin-npm-source-src/*/; do \
        npm pack "$d" --pack-destination "$PLUGIN_NPM_SOURCE_DIR"; \
    done && \
    ls -la "$PLUGIN_NPM_SOURCE_DIR"

# Warm the npm cache AND smoke-test the build routine at image-build time: a build breakage fails
# the image build (not a runtime Process), and the warmed cache lets the in-pod build run with
# --prefer-offline regardless of pod egress.
RUN python -m ymerflow_plugin_build cluster-test-widget 1.0.0 /tmp/_warmup \
        --source "$PLUGIN_NPM_SOURCE_DIR" && \
    test -f /tmp/_warmup/remoteEntry.js && \
    rm -rf /tmp/_warmup

# Copy and install ymerflow_processes package
COPY docker/base-runner/ymerflow_processes /app/ymerflow_processes
RUN pip install --no-cache-dir -e /app/ymerflow_processes

# Copy and install aem_processes package
COPY docker/base-runner/aem_processes /app/aem_processes
# Use clang to avoid GCC 14 ICE in boost/multiprecision/cpp_int/literals.hpp (pyinterp dep)
RUN CC=clang CXX=clang++ pip install --no-cache-dir -e '/app/aem_processes[all]'

# Copy and install mag_processes package
COPY docker/base-runner/mag_processes /app/mag_processes
RUN pip install --no-cache-dir -e /app/mag_processes

# Copy runner and schema generator scripts
COPY docker/base-runner/runner.py /app/runner.py
COPY docker/base-runner/storage_credentials_client.py /app/storage_credentials_client.py
COPY docker/base-runner/storage_credential_refresher.py /app/storage_credential_refresher.py
COPY docker/base-runner/get_schema.py /app/get_schema.py

# Generate process schemas JSON file
RUN python /app/get_schema.py

ENTRYPOINT ["python", "-u", "/app/runner.py"]

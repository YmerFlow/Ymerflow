# Environment and Docker Image Architecture

Environments in YmerFlow are Docker images that contain process types and their dependencies. Each environment defines what process types are available and how they execute.

## Overview

```
Docker Image (Environment)
  ├─> Python packages with process types
  ├─> setuptools entrypoints (nagelfluh.process_types)
  ├─> runner.py (execution entrypoint)
  ├─> get_schema.py (schema extraction at build time)
  └─> process_schemas.json (generated schemas file)
```

An environment is a complete execution environment that:
1. Defines available process types via setuptools entrypoints
2. Includes all dependencies needed by those process types
3. Provides a runner that loads and executes processes dynamically
4. Pre-generates JSON schemas at build time for the backend

## Docker Image Structure

### Base Image

The real `docker/base-runner/Dockerfile` is multi-stage and considerably heavier than a plain
Python base:

```dockerfile
FROM gcr.io/kaniko-project/executor:v1.24.0 AS kaniko

FROM python:3.11-slim-trixie

WORKDIR /app
```

The final image is based on `python:3.11-slim-trixie` (not plain `python:3.11-slim`). A separate
build stage pulls in the Kaniko executor binary, which is copied into the final image (see
[`create_environment` process](#create_environment-process) below for why the runner image needs
Kaniko at all).

Beyond Python, the image also installs:
- A full C++ toolchain (`build-essential`, `cmake`, `clang`, `libboost-dev`, `libeigen3-dev`) —
  needed to compile `pyinterp` (an `aem_processes` dependency) from source, which requires
  Boost >= 1.79
- The `crane` binary (`go-containerregistry`) — used to export files from a just-built image
  without a running Docker daemon
- Node.js 22 + npm — required by the `build_frontend_plugin` process type to run real
  npm/vite Module-Federation builds
- `ymerflow-plugin-sdk`, installed via git URL, providing the shared frontend-plugin build
  harness used by `build_frontend_plugin`

Compiling `aem_processes` (specifically `pyinterp`) uses `CC=clang CXX=clang++` as a workaround
for a GCC 14 internal compiler error in `boost/multiprecision/cpp_int/literals.hpp`.

### Process Type Packages

Process types are organized into three separately-installed Python packages, each with its own
setuptools entrypoints (see [Process Types - Example Process Types](processes.md#example-process-types)
for what each package provides):

```dockerfile
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
```

Each package contains:
- Process type classes
- `setup.py` with entrypoint registrations
- Dependencies in extras_require

**Example package structure:**
```
ymerflow_processes/
├── __init__.py
├── fake_processes.py          # create_environment
├── compound_filter.py
├── build_frontend_plugin.py
└── setup.py                   # Entrypoint registration
```

### Runner and Schema Scripts

```dockerfile
# Copy runner and schema generator scripts
COPY docker/base-runner/runner.py /app/runner.py
COPY docker/base-runner/storage_credentials_client.py /app/storage_credentials_client.py
COPY docker/base-runner/storage_credential_refresher.py /app/storage_credential_refresher.py
COPY docker/base-runner/get_schema.py /app/get_schema.py

# Generate process schemas JSON file
RUN python /app/get_schema.py

ENTRYPOINT ["python", "-u", "/app/runner.py"]
```

Note the `-u` flag: it forces unbuffered stdout/stderr, which matters because process logs are
streamed to the UI via captured `print()` output (see [Logging](processes.md#logging)) — buffered
output would delay or batch log lines instead of streaming them in real time.

## Setuptools Entrypoints

Process types are registered using setuptools entrypoints in the `nagelfluh.process_types` group.

### Entrypoint Registration

Process types are registered in `setup.py` using the `nagelfluh.process_types` entrypoint group. The entry name becomes the process type identifier.

**See:** [Process Types - Registering a New Process Type](processes.md#registering-a-new-process-type) for complete setup.py examples and registration details.

### Process Class Requirements

Each process class must implement `schema()` and `run()` class methods.

**See:** [Process Types](processes.md) for complete documentation on creating process classes, including method signatures, parameters, and examples.

## Schema Extraction at Build Time

During Docker image build, schemas are extracted from all registered process types and stored in a JSON file.

### get_schema.py

**Location:** `/app/get_schema.py` (copied from `docker/base-runner/get_schema.py`)

**Purpose:** Discovers all process types via entrypoints, loads their classes, calls `schema()`, and writes to JSON.

**Execution:**
```dockerfile
RUN python /app/get_schema.py
```

**Process:**

1. **Discover entrypoints:**
   ```python
   for entry_point in get_entry_points('nagelfluh.process_types'):
       # ...
   ```

2. **Load process class:**
   ```python
   process_class = entry_point.load()
   ```

3. **Extract schema:**
   ```python
   schema = process_class.schema()
   schemas[entry_point.name] = {"schema": schema}
   ```

4. **Write to file:**
   ```python
   with open('/app/process_schemas.json', 'w') as f:
       json.dump(schemas, f, indent=2)
   ```

### process_schemas.json

**Location:** `/app/process_schemas.json` (generated at build time)

**Format:**
```json
{
  "fft": {
    "schema": {
      "type": "object",
      "properties": {
        "input_data": {
          "type": "string",
          "format": "uri",
          "x-format": "dataset",
          "title": "Input Dataset"
        }
      },
      "required": ["input_data"]
    }
  },
  "inversion": {
    "schema": {
      "type": "object",
      "properties": {
        "input_data": {
          "type": "string",
          "format": "uri",
          "x-format": "dataset",
          "title": "AEM Data"
        },
        "alpha": {
          "type": "number",
          "default": 0.01,
          "title": "Regularization Parameter"
        }
      },
      "required": ["input_data"]
    }
  }
}
```

**Usage:** The backend reads this file from the Docker image to:
- List available process types in the environment
- Provide schemas to the frontend for form generation
- Validate parameters before process execution

## Process Execution

When a Kubernetes pod runs a process, it executes `runner.py` with environment variables.

### runner.py

**Location:** `/app/runner.py` (copied from `docker/base-runner/runner.py`)

**Purpose:** Dynamically loads and executes the specified process type with parameters.

**Entrypoint:**
```dockerfile
ENTRYPOINT ["python", "-u", "/app/runner.py"]
```

### Environment Variables

The runner receives configuration via environment variables, set by the backend's job
orchestrator (`backend/services/job_orchestrator.py`):

| Variable | Description | Example |
|----------|-------------|---------|
| `PROCESS_TYPE` | Process type to execute | `"import_skytem"` |
| `PROCESS_ID` | Unique process identifier | `"process-abc-123"` |
| `VERSION` | Process version number | `"0"` |
| `PROJECT_ID` | Project identifier | `"project-xyz-789"` |
| `PARAMETERS_JSON` | JSON-encoded parameters | `'{"input_data":"http://..."}}'` |
| `BACKEND_URL` | Backend API endpoint | `"http://backend-service:8000"` |
| `STORAGE_BASE` | Storage bucket URL | `"s3://nagelfluh-project-xyz"` |
| `STORAGE_KWARGS_JSON` | Protocol-general fsspec kwargs, JSON-encoded (e.g. `endpoint_url`, `key`/`secret` for S3; `token` for GCS) — built by the project's `StorageProtocolHandler` | `'{"key":"...","secret":"...","client_kwargs":{"endpoint_url":"http://minio:9000"}}'` |
| `CREDENTIAL_STRATEGY` | `"static-key"` (default) or `"short-lived"` — selects whether `storage_kwargs` is a plain dict or a live, self-refreshing view (see below) | `"short-lived"` |
| `STORAGE_CREDENTIALS_EXPIRES_AT` | (short-lived only) ISO timestamp when the initial minted credential expires | `"2026-08-12T00:00:00"` |
| `STORAGE_REFRESH_TOKEN` | (short-lived only) token used by the refresher subprocess to mint fresh credentials | From backend |
| `REGISTRY_URL` / `REGISTRY_AUTH` | (only for `build_frontend_plugin`/`create_environment`-style jobs) registry to push/pull images, and its auth | From backend settings |
| `PLUGIN_SHARED_VERSIONS` / `PLUGIN_NPM_SOURCE_MODE` / `PLUGIN_NPM_SOURCE_DIR` / `PLUGIN_NPM_REGISTRY` | (only for `build_frontend_plugin` jobs) how to resolve the plugin's npm dependencies during the in-pod build | From backend settings |

There is no `STORAGE_ENDPOINT`, `AWS_ACCESS_KEY_ID`, or `AWS_SECRET_ACCESS_KEY` — all storage
credentials and endpoint configuration are folded into the single `STORAGE_KWARGS_JSON` dict and
passed straight to `fsspec.open(url, **storage_kwargs)`; fsspec dispatches on the URL scheme in
`STORAGE_BASE` (`s3://`, `gs://`, …), so there's no protocol-specific env var construction.

#### Credential Refresh Subsystem

When `CREDENTIAL_STRATEGY=short-lived`, the initial `STORAGE_KWARGS_JSON` credential is only a
starting point — it can expire mid-job (jobs can run for many hours), and environment variables
of an already-running process can't be updated. To handle this, `runner.py` spawns a separate
**refresher subprocess** (`storage_credential_refresher.py`, using
`storage_credentials_client.py`) at startup. The refresher periodically re-mints credentials and
writes them, atomically, to a local file (`/tmp/storage-credentials.json`); the main process reads
that file on *every* storage access (via a `RefreshableStorageKwargs` mapping passed as
`storage_context['storage_kwargs']`) instead of trusting the credential it started with. The
refresher runs as a separate OS process rather than a thread specifically because inversion/
processing code is often CPU-bound and can hold the GIL for long stretches — a thread-based
refresher could end up starved right when a refresh is needed. On exit, `runner.py` terminates
the refresher so the pod doesn't hang waiting on a lingering child. For
`CREDENTIAL_STRATEGY=static-key` (the default), none of this runs — `storage_kwargs` is just a
plain dict computed once at startup.

### Execution Flow

1. **Parse environment variables:**
   ```python
   process_type = os.environ['PROCESS_TYPE']
   process_id = os.environ['PROCESS_ID']
   parameters_json = os.environ['PARAMETERS_JSON']
   storage_base = os.environ['STORAGE_BASE']

   parameters = json.loads(parameters_json)
   ```

2. **Discover and load process class:**
   ```python
   for entry_point in get_entry_points('nagelfluh.process_types'):
       if entry_point.name == process_type:
           process_class = entry_point.load()
           break
   ```

3. **Build storage context:**
   ```python
   storage_context = {
       'process_id': process_id,
       'project_id': project_id,
       'storage_base': storage_base,
       'storage_kwargs': get_storage_kwargs()
   }
   ```

4. **Execute process:**
   ```python
   result = process_class.run(
       storage_context=storage_context,
       **parameters
   )
   ```

5. **Handle result:**
   ```python
   if result and 'outputs' in result:
       # Report outputs to backend (TODO)
       pass

   sys.exit(0)  # Success
   ```

6. **Error handling:**
   ```python
   except Exception as e:
       print(f"ERROR: {str(e)}", file=sys.stderr)
       traceback.print_exc()
       sys.exit(1)  # Failure
   ```

### Storage Context

The `storage_context` parameter provides process ID, project ID, storage base URL, and fsspec configuration.

**See:** [Storage Architecture](storage.md#dataset-io-with-fsspec) for complete details on storage context structure and fsspec usage patterns.

## Building Custom Environments

### Creating a New Environment Image

1. **Create base Dockerfile:**
   ```dockerfile
   FROM python:3.11-slim

   WORKDIR /app

   # Install your process packages
   COPY my_processes /app/my_processes
   RUN pip install -e /app/my_processes

   # Install additional dependencies
   RUN pip install numpy scipy matplotlib

   # Copy runner scripts
   COPY runner.py /app/runner.py
   COPY get_schema.py /app/get_schema.py

   # Generate schemas
   RUN python /app/get_schema.py

   # -u forces unbuffered stdout/stderr, required for real-time print()-based log streaming
   ENTRYPOINT ["python", "-u", "/app/runner.py"]
   ```

   This is a minimal from-scratch example. The actual `docker/base-runner/Dockerfile` is
   considerably more involved (multi-stage with a Kaniko executor stage, C++ toolchain, Node.js,
   `crane`, and three process packages) — see [Base Image](#base-image) above for the real
   structure.

2. **Create process package with entrypoints:**
   ```python
   # my_processes/setup.py
   setup(
       name="my_processes",
       entry_points={
           "nagelfluh.process_types": [
               "my_process=my_processes.processors:MyProcess",
           ],
       },
   )
   ```

3. **Build image:**
   ```bash
   docker build -t my-environment:latest .
   ```

4. **Push to registry:**
   ```bash
   docker tag my-environment:latest gcr.io/project/my-environment:latest
   docker push gcr.io/project/my-environment:latest
   ```

5. **Create environment in YmerFlow:**
   - Use the `create_environment` process type (fully implemented, see
     [`create_environment` process](#create_environment-process) below)
   - Or manually register in the database

### Environment Versioning

Environments should be versioned to ensure reproducibility:

```bash
# Tag with version
docker tag my-environment:latest my-environment:v1.2.3

# Use specific versions in production
# In Kubernetes Job spec:
spec:
  template:
    spec:
      containers:
      - image: gcr.io/project/my-environment:v1.2.3
```

### `create_environment` Process

`create_environment` (`docker/base-runner/nagelfluh_processes/fake_processes.py`) is a fully
implemented process type — not a stub — that builds and registers a brand-new environment image
entirely from within a running process job, without any privileged Docker daemon access:

1. Takes `environment_name`, `base_image`, optional `python_packages` and
   `dockerfile_instructions` as parameters, and constructs a `Dockerfile` from them
2. Builds and pushes the image using the **Kaniko executor** (`/kaniko-executor`, baked into the
   runner image — see [Base Image](#base-image) above), which needs no Docker daemon and works
   inside an unprivileged container. Registry auth, if any, comes from the `REGISTRY_AUTH`
   env var and is written out as a Docker `config.json` that both Kaniko and `crane` read
3. After the push succeeds, runs `crane export` on the freshly-built image to pull
   `app/process_schemas.json` out of it directly (again with no Docker daemon involved) and
   parses the schemas
4. Writes an `environment.json` file (containing the image reference, source process id, and the
   extracted `process_types`) to `{storage_base}/processes/{process_id}/environment.json`

That `environment.json` file is the handoff point to the backend — see
[Backend Integration](#backend-integration) below for how it gets picked up automatically, no
API call from the process required.

## Backend Integration

### Reading Schemas from a Built Environment

There is no `docker create`/`docker cp` step in the backend — the backend never touches Docker or
any container runtime directly. Instead (`backend/models/process.py`, in and around
`_create_outputs`): after **any** process version's job finishes, the backend checks whether
`{storage_base}/processes/{process.id}/environment.json` exists in storage. If it does (this file
is written by the `create_environment` process — see above), the backend reads it directly with
fsspec and constructs an `Environment` database row from its `name`, `docker_image`, and
`process_types` fields. No image pull, no container creation, no subprocess calls of any kind —
the schemas were already extracted at build time (by `create_environment` itself, via `crane`) and
simply travel to the backend as a JSON file in the project's own storage bucket. If
`environment.json` is absent — the normal case for every process type other than
`create_environment` — this check is a no-op.

Once registered, environments and their process types are served to the frontend via
`backend/routers/environments.py` — there is no bare `/process-types` endpoint. The real
endpoints are:
- `GET /environments` - list all environments (id, name, process type names; pass
  `include_schemas=true` to embed full schemas)
- `GET /environments/{env_id}/process-types` - all process type schemas for one environment,
  keyed by type name
- `GET /environments/{env_id}/process-types/{type_name}` - the schema for a single named
  process type

### Bootstrap Environment via `docker/build.sh`

A second, separate path exists purely for bootstrapping the initial "Bootstrap" environment at
image-build time, bypassing HTTP and the `create_environment` process entirely:
`docker/build.sh` builds and pushes the base-runner image, then invokes
`docker/update_bootstrap_environment.py`, which connects **directly to the database** and
UPSERTs an `environments` row (by name) with the image reference and the `process_schemas.json`
generated during the image build. This is how the environment used to run `create_environment`
itself (and everything else, before any custom environment exists) gets into the database in the
first place.

### Creating Kubernetes Jobs

When a process is created, the backend:

1. **Selects environment image** based on environment ID
2. **Creates Kubernetes Job** with image
3. **Sets environment variables** for runner.py, including the resolved `STORAGE_KWARGS_JSON`
   (credentials and endpoint config folded together, not injected as separate `AWS_*` vars)

**Job manifest:**
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: process-abc-123-v0
spec:
  template:
    spec:
      containers:
      - name: process
        image: gcr.io/project/my-environment:v1.2.3
        env:
        - name: PROCESS_TYPE
          value: "import_skytem"
        - name: PROCESS_ID
          value: "process-abc-123"
        - name: VERSION
          value: "0"
        - name: PROJECT_ID
          value: "project-xyz-789"
        - name: PARAMETERS_JSON
          value: '{"input_data":"http://..."}'
        - name: BACKEND_URL
          value: "http://backend-service:8000"
        - name: STORAGE_BASE
          value: "s3://nagelfluh-project-xyz"
        - name: STORAGE_KWARGS_JSON
          value: '{"key":"...","secret":"...","client_kwargs":{"endpoint_url":"http://minio:9000"}}'
        - name: CREDENTIAL_STRATEGY
          value: "static-key"
        # ... more env vars
```

## Best Practices

### Process Type Development

1. **Use entrypoints**: Always register via setuptools entrypoints
2. **Implement both methods**: Every process class needs `schema()` and `run()`
3. **Test locally**: Test process classes before building Docker image
4. **Version packages**: Use semantic versioning for process packages
5. **Document schemas**: Add descriptions to all schema properties

### Docker Image Building

1. **Layer caching**: Install dependencies before copying code
2. **Small images**: Use slim base images, clean up after installs
3. **Build-time schema generation**: Always run `get_schema.py` during build
4. **Version everything**: Tag images with version numbers
5. **Test images**: Run `docker run --rm my-env:latest --help` to verify

### Schema Design

1. **Clear titles**: Use descriptive titles for all properties
2. **Good defaults**: Provide sensible default values
3. **Validation**: Use min/max, patterns, enums for validation
4. **Dataset refs**: Use `"format": "uri"` + `"x-format": "dataset"` for inputs
5. **Documentation**: Add descriptions to explain parameters

## Troubleshooting

### Schema Extraction Fails

**Problem:** `get_schema.py` exits with error during build

**Solutions:**
- Check that all process packages are installed
- Verify entrypoint names don't have typos
- Ensure `schema()` method doesn't have import errors
- Test `python -c "from my_module import MyClass; MyClass.schema()"`

### Process Not Found

**Problem:** Runner reports "Unknown process type"

**Solutions:**
- Verify entrypoint is registered in `setup.py`
- Check package is installed (`pip list | grep my-package`)
- Run `python -c "from importlib.metadata import entry_points; print(list(entry_points(group='nagelfluh.process_types')))"` in image

### Schema Not in JSON

**Problem:** Process type exists but schema file is missing it

**Solutions:**
- Check `get_schema.py` ran successfully during build
- Look for errors in build logs
- Verify `/app/process_schemas.json` exists in image
- Rebuild image: `docker build --no-cache`

### Import Errors at Runtime

**Problem:** Process fails to import dependencies

**Solutions:**
- Add missing dependencies to `setup.py` or `requirements.txt`
- Install with extras: `pip install -e '.[all]'`
- Check that base image has required system libraries
- Test imports: `docker run --rm my-env python -c "import mylibrary"`

## Related Documentation

- **[Process Types](processes.md)** - Creating and registering process types
- **[Storage](storage.md)** - Storage context and fsspec usage
- **[System Overview](overview.md)** - Overall architecture and data model

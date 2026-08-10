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

```dockerfile
FROM python:3.11-slim

WORKDIR /app
```

All environments start from a Python 3.11 base image.

### Process Type Packages

Process types are organized into Python packages with setuptools entrypoints:

```dockerfile
# Copy and install process packages
COPY docker/base-runner/nagelfluh_processes /app/nagelfluh_processes
RUN pip install --no-cache-dir -e /app/nagelfluh_processes

COPY docker/base-runner/aem_processes /app/aem_processes
RUN pip install --no-cache-dir -e '/app/aem_processes[all]'
```

Each package contains:
- Process type classes
- `setup.py` with entrypoint registrations
- Dependencies in extras_require

**Example package structure:**
```
nagelfluh_processes/
├── __init__.py
├── fake_processes.py          # Process type classes
└── setup.py                   # Entrypoint registration
```

### Runner and Schema Scripts

```dockerfile
# Copy runner and schema generator scripts
COPY docker/base-runner/runner.py /app/runner.py
COPY docker/base-runner/get_schema.py /app/get_schema.py

# Generate process schemas JSON file at build time
RUN python /app/get_schema.py

# Set entrypoint
ENTRYPOINT ["python", "/app/runner.py"]
```

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
ENTRYPOINT ["python", "/app/runner.py"]
```

### Environment Variables

The runner receives configuration via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `PROCESS_TYPE` | Process type to execute | `"fft"` |
| `PROCESS_ID` | Unique process identifier | `"process-abc-123"` |
| `VERSION` | Process version number | `"0"` |
| `PROJECT_ID` | Project identifier | `"project-xyz-789"` |
| `PARAMETERS_JSON` | JSON-encoded parameters | `'{"input_data":"http://..."}}'` |
| `BACKEND_URL` | Backend API endpoint | `"http://backend:8000"` |
| `STORAGE_BASE` | Storage bucket URL | `"s3://nagelfluh-project-xyz"` |
| `STORAGE_ENDPOINT` | Storage endpoint (MinIO) | `"http://minio:9000"` (optional) |
| `AWS_ACCESS_KEY_ID` | Storage credentials | From Kubernetes secret |
| `AWS_SECRET_ACCESS_KEY` | Storage credentials | From Kubernetes secret |

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

   ENTRYPOINT ["python", "/app/runner.py"]
   ```

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
   - Use `create_environment` process (coming soon)
   - Or manually register in database

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

## Backend Integration

### Reading Schemas from Image

The backend extracts schemas from the Docker image:

1. **Pull image** (or use existing in registry)
2. **Extract `/app/process_schemas.json`** from image filesystem
3. **Parse JSON** to get available process types
4. **Store in database** or cache in memory
5. **Serve to frontend** via `/process-types` API endpoint

**Example extraction (using Docker):**
```python
import subprocess
import json

# Create temporary container
subprocess.run(["docker", "create", "--name", "temp", "my-environment:latest"])

# Copy schemas file from container
subprocess.run(["docker", "cp", "temp:/app/process_schemas.json", "./schemas.json"])

# Remove temporary container
subprocess.run(["docker", "rm", "temp"])

# Parse schemas
with open("./schemas.json") as f:
    schemas = json.load(f)
```

### Creating Kubernetes Jobs

When a process is created, the backend:

1. **Selects environment image** based on environment ID
2. **Creates Kubernetes Job** with image
3. **Sets environment variables** for runner.py
4. **Injects storage credentials** via Kubernetes secrets

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
          value: "fft"
        - name: PROCESS_ID
          value: "process-abc-123"
        - name: VERSION
          value: "0"
        - name: PARAMETERS_JSON
          value: '{"input_data":"http://..."}'
        - name: STORAGE_BASE
          value: "s3://nagelfluh-project-xyz"
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: project-xyz-storage
              key: access_key
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

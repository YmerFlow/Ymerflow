# Process Type Development

Process types are the core computational units in YmerFlow. They are implemented as Python classes and registered via setuptools entrypoints, allowing for a plugin-based architecture.

**Related documentation:**
- [Environment](environment.md) - How process types are packaged in Docker images and executed
- [Storage](storage.md) - How processes read and write datasets

## Entrypoint Group

All process types must be registered in the **`nagelfluh.process_types`** entrypoint group.

## Process Type Class Structure

Each process type class must implement two class methods:

### `schema()` Method

Returns JSON Schema for process parameter validation and UI form generation.

```python
@classmethod
def schema(cls):
    """Return JSON Schema for process parameters.

    Returns:
        dict: JSON Schema object defining parameter validation
    """
    return {
        "type": "object",
        "properties": {
            "input_data": {
                "type": "string",
                "format": "uri",
                "x-format": "dataset",  # Shows dataset selector in UI
                "title": "Input Dataset"
            },
            "parameter1": {
                "type": "number",
                "default": 1.0,
                "title": "Parameter 1",
                "description": "Description shown in form"
            },
            "option": {
                "type": "string",
                "enum": ["choice1", "choice2"],
                "default": "choice1",
                "title": "Select Option"
            }
        },
        "required": ["input_data"]
    }
```

#### Dataset References

To allow a process to reference another process's output dataset, use:

```python
"my_param": {
    "type": "string",
    "format": "uri",
    "x-format": "dataset",  # Triggers custom dataset selector widget
    "title": "Input Data"
}
```

The frontend will automatically render a searchable dataset selector for this field. The value will be a dataset URL like `http://localhost:8000/projects/{project_id}/dataset/{id}`.

#### Supported Schema Features

- Basic types: `string`, `number`, `integer`, `boolean`, `array`, `object`
- Validation: `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `enum`
- UI hints: `title`, `description`, `default`
- Custom formats: `x-format: "dataset"` for dataset selection

### `run()` Method

Executes the process with the provided parameters.

```python
@classmethod
def run(cls, storage_context=None, **kwargs):
    """Execute the process.

    Args:
        storage_context (dict): Storage configuration with keys:
            - process_id (str): Current process ID
            - project_id (str): Project ID
            - storage_base (str): Storage base URL (e.g., s3://nagelfluh-project-abc)
            - storage_kwargs (dict): fsspec kwargs (e.g., endpoint_url for MinIO)
        **kwargs: Process parameters from JSON Schema

    Returns:
        dict: Result with 'status' and optional 'outputs':
            {
                "status": "success",
                "outputs": {
                    "output_name": "s3://path/to/dataset"
                }
            }
    """
    # Your process implementation here
    print(f"Running my_process with params: {kwargs}")

    # Example: Write output dataset
    outputs = {}
    if storage_context:
        dataset_url = write_dataset(
            storage_context['storage_base'],
            storage_context['process_id'],
            storage_context['storage_kwargs']
        )
        outputs['result'] = dataset_url

    return {"status": "success", "outputs": outputs}
```

> **Note:** the `"outputs"` key in the return value shown above does **not** actually register
> anything with the backend today — `runner.py` only prints it. Output datasets are registered by
> the backend scanning storage for dataset directories after the job completes, independent of
> what `run()` returns. See [How Outputs Are Actually Registered](#how-outputs-are-actually-registered)
> below before relying on the return value for anything.

#### Storage Context

The `storage_context` parameter provides process ID, project ID, storage base URL, and fsspec kwargs.

**See:** [Storage - Dataset I/O with fsspec](storage.md#dataset-io-with-fsspec) for complete details on the storage context structure and usage patterns.

#### Reading and Writing Datasets

Processes read input datasets and write output datasets using fsspec.

**See:** [Storage - Dataset I/O with fsspec](storage.md#dataset-io-with-fsspec) for:
- Reading datasets from storage
- Writing output datasets
- Multi-part dataset handling
- Path construction patterns
- Complete code examples

## Registering a New Process Type

### 1. Create Your Process Class

```python
# mypackage/processes.py

class my_custom_process:
    """Description of what this process does."""

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset"
                },
                "threshold": {
                    "type": "number",
                    "default": 0.5,
                    "minimum": 0,
                    "maximum": 1,
                    "title": "Threshold"
                }
            },
            "required": ["input"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        print(f"Running with parameters: {kwargs}")
        # ... process implementation ...
        return {"status": "success"}
```

### 2. Register in setup.py

```python
from setuptools import setup

setup(
    name="mypackage",
    version="0.1.0",
    packages=["mypackage"],
    entry_points={
        "nagelfluh.process_types": [
            "my_custom_process=mypackage.processes:my_custom_process",
        ],
    },
)
```

The entrypoint name (`my_custom_process`) becomes the process type identifier in the UI.

### 3. Install in Docker Image

Process packages must be installed in the environment Docker image.

**See:** [Environment - Building Custom Environments](environment.md#building-custom-environments) for complete Dockerfile examples and image building instructions.

## Schema Generation

When the Docker image is built, all process type schemas are automatically collected:

- **Script**: `/app/get_schema.py` runs during Docker build
- **Output**: `/app/process_schemas.json`
- **Format**: `{"process_type_name": {...schema...}, ...}`
- **Usage**: Backend reads this file to list available process types without executing process code

The `get_schema.py` script:
1. Uses `importlib.metadata.entry_points` to discover all entrypoints in `nagelfluh.process_types` (falling back to `pkg_resources` only on Python < 3.10, which doesn't apply to the runner image's `python:3.11-slim-trixie` base — the fallback exists purely for portability)
2. Loads each class
3. Calls `cls.schema()`
4. Writes JSON file with all schemas

## Example Process Types

The real process type implementations live in three separately-installed packages under
`docker/base-runner/`, each registering its entrypoints in its own `setup.py`:

- **`nagelfluh_processes`** (`docker/base-runner/nagelfluh_processes/`) - general-purpose process
  types: `create_environment` (builds and pushes a custom environment image; see
  [Environment](environment.md#create_environment-process)), `compound_filter`,
  `build_frontend_plugin`
- **`aem_processes`** (`docker/base-runner/aem_processes/`) - the AEM (airborne electromagnetic)
  process family: `import_skytem`, `import_nagelfluh_aem`, `process_tem`, `invert_tem`,
  `forward_tem`, `grid_tem`
- **`mag_processes`** (`docker/base-runner/mag_processes/`) - the magnetics process family:
  `import_mag`, `process_mag`, `equiv_source_mag`, `inversion_3d_mag`

Each package's `setup.py` `entry_points["nagelfluh.process_types"]` list is the definitive
source of truth for which process types it provides. See the actual class implementations in
those packages for real-world examples of `schema()` and `run()`.

## Best Practices

### Error Handling

Always catch exceptions and return appropriate status:

```python
@classmethod
def run(cls, storage_context=None, **kwargs):
    try:
        # ... process logic ...
        return {"status": "success", "outputs": {...}}
    except ValueError as e:
        print(f"ERROR: Invalid input - {e}")
        return {"status": "failed", "error": str(e)}
    except Exception as e:
        print(f"ERROR: Unexpected error - {e}")
        return {"status": "failed", "error": str(e)}
```

### Logging

Use `print()` for logging - stdout is captured and streamed to the UI:

```python
print("Starting process...")
print(f"Processing {n} items...")
print(f"Progress: {i}/{n} ({100*i/n:.1f}%)")
print("Complete!")
```

### Progress Updates

For long-running processes, print progress regularly:

```python
for i, item in enumerate(data):
    process_item(item)
    if i % 100 == 0:
        print(f"Processed {i}/{len(data)} items")
```

### Resource Efficiency

- Clean up temporary files
- Release memory when possible
- Use streaming for large datasets
- Respect the deadline parameter

### Schema Design

- Provide sensible defaults
- Use descriptive titles and descriptions
- Group related parameters in nested objects
- Use enums for fixed choices
- Mark required fields appropriately
- Use appropriate number ranges (minimum/maximum)

## Testing Process Types

### Local Testing

Test your process class locally before deploying:

```python
# test_process.py
from mypackage.processes import my_custom_process

# Test schema
schema = my_custom_process.schema()
print("Schema:", schema)

# Test run
result = my_custom_process.run(
    storage_context={
        'process_id': 'test',
        'project_id': 'test-project',
        'storage_base': 'file:///tmp/test-storage',
        'storage_kwargs': {}
    },
    input="test-data",
    threshold=0.7
)
print("Result:", result)
```

### Docker Testing

Test in Docker container locally:

```bash
# Build image
./docker/build.sh

# Run test
docker run --rm \
  -e PROCESS_TYPE=my_custom_process \
  -e PROCESS_ID=test \
  -e VERSION=1 \
  -e PROJECT_ID=test-project \
  -e PARAMETERS_JSON='{"threshold": 0.7}' \
  -e STORAGE_BASE=file:///tmp/storage \
  -e BACKEND_URL=http://localhost:8000 \
  nagelfluh-base-runner:latest
```

## Advanced Topics

### How Outputs Are Actually Registered

**Important:** the `outputs` dict in `run()`'s return value is *not* what registers a process's
output datasets. `runner.py` currently only prints it (`# TODO: POST to backend to register
outputs` — the POST is not implemented, see [Environment](environment.md)). Whatever you put in
the returned `"outputs"` key is inert as far as the backend and frontend are concerned.

The real mechanism is storage-based: after a process version's job finishes, the backend
(`backend/models/process.py`, `_create_outputs`) scans
`{storage_base}/processes/{process_id}/{version}/datasets/` for subdirectories and reads an
`info.json` file from each one it finds. Every subdirectory with a valid `info.json` becomes a
registered output dataset — regardless of what (if anything) `run()` returned.

This means a process type registers outputs by **writing dataset directories with an
`info.json` to storage during `run()`**, not by returning a dict describing them. See
[Storage - Dataset I/O with fsspec](storage.md#dataset-io-with-fsspec) for how to write a dataset
directory (including its `info.json`) correctly.

### Multiple Outputs

Write each dataset to its own subdirectory under `processes/{process_id}/{version}/datasets/`,
each with its own `info.json`:

```python
write_dataset(storage_context, name="primary_result", data=result_data)
write_dataset(storage_context, name="diagnostics", data=diagnostics_data)
write_dataset(storage_context, name="metadata", data=metadata_data)
```

The backend will discover all three as separate output datasets once the job completes — there is
no need to (and no effect from) also listing them in the return value.

### Conditional Outputs

Outputs can vary based on parameters — simply choose which dataset directories to write:

```python
write_dataset(storage_context, name="result", data=result_data)
if kwargs.get("save_intermediate"):
    write_dataset(storage_context, name="intermediate", data=intermediate_data)
```

### Nested Schema Parameters

Use nested objects for complex configurations:

```python
"properties": {
    "solver": {
        "type": "object",
        "properties": {
            "method": {"type": "string", "enum": ["conjugate_gradient", "lbfgs"]},
            "tolerance": {"type": "number", "default": 1e-6},
            "max_iterations": {"type": "integer", "default": 1000}
        }
    }
}
```

Access in run():

```python
def run(cls, storage_context=None, solver=None, **kwargs):
    method = solver["method"]
    tolerance = solver["tolerance"]
    ...
```

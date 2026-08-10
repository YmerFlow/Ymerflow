# MCP Tools Reference

YmerFlow exposes a subset of its REST API as MCP (Model Context Protocol) tools via [fastapi-mcp](https://github.com/tadata-ru/fastapi-mcp), mounted at `/mcp` using the Streamable HTTP transport.

## Authentication

All tools require a project-scoped API key:

```
Authorization: Bearer apk_<key>
```

API keys are scoped to a single project, so no `project_id` selection is needed at the session level — the key carries it.

## Typical Workflow

```
1. list_environments          — discover available environments and process type names
2. get_process_type_schema    — fetch the JSON Schema for the specific type you want to run
3. upload_file                — upload local input data (or use request_upload_token + curl for large files)
4. create_process             — submit the job; save the returned id and version
5. get_process                — poll until versions[-1].state is 'done' or 'failed'
6. get_dataset                — resolve output URLs from versions[-1].outputs
7. curl '{url}'               — download results; /files/ URLs need no authentication
```

Use `describe_dataset` before downloading to check columns, record counts, and bounding box.

## Which endpoints are NOT exposed

Binary data download endpoints are excluded from MCP because they overflow LLM context windows:
- `GET /dataset/{id}/data` and `/geography` — use the `url` field from `get_dataset` + curl instead
- `GET /files/{path}` — auth-free, download directly with curl
- `GET /uploads/{id}` — use the `url` returned by `upload_file`

---

## Processes

### `create_process`
`POST /process`

Submit any type of job — data import, processing, inversion, forward modelling, etc. The job is queued and runs asynchronously in Kubernetes. Returns immediately with the process id and version number.

**Retry vs. new process:** If retrying a failed job or correcting parameters, pass the original `id` in the body to append a new version. Do NOT create a new process — that loses history. Omit `id` only when starting a genuinely new workflow.

**Resource sizing for inversions:** Never use defaults for inversions — the defaults (1 CPU, 2 Gi RAM, 1 h deadline) will cause OOM-kills or deadline failures with no output produced. Set `resource_requests` and `deadline_seconds` explicitly based on dataset size.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project ID the job belongs to. |

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | Process type key, e.g. `aem_inversion`. Obtain from `list_environments` / `get_process_type_schema`. |
| `environment_id` | string | Yes | ID of the compute environment. Obtain from `list_environments`. |
| `params` | object | No | Process-type-specific parameters defined by the process type's JSON Schema. Fields with `x-format: dataset` expect a file URL from `search_datasets` or `get_dataset`. |
| `id` | string | No | Existing process ID. Provide to add a new version (retry/correction). Omit to create a new process. |
| `name` | string | No | Human-readable display name. Defaults to `<type>-process`. |
| `resource_requests` | object | No | Kubernetes resource requests. See below. |
| `deadline_seconds` | integer | No | Max wall-clock time before the job is killed. Default: `3600`. Always set explicitly for inversions. |
| `cluster_id` | string | No | Cluster to run on. Obtain valid ids from `available_clusters`. Omit to auto-select the first allowed cluster. |

**`resource_requests` fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `cpu` | string | `"1000m"` | CPU request in Kubernetes notation, e.g. `"500m"` or `"4"`. |
| `memory` | string | `"2Gi"` | Memory request, e.g. `"512Mi"` or `"16Gi"`. |
| `ephemeral-storage` | string | `"10Gi"` | Temporary disk space for the job. |

**Returns:** `{"id": "<process_id>", "versions": [{"version": <n>}]}`

---

### `list_processes`
`GET /processes`

List all processes the current user can access, with their status and outputs.

Each process has a `versions` array sorted ascending by version number; `versions[-1]` is the most recent run. Each version includes `state`, `outputs`, and `parameters`. Logs are not included — use `get_process_logs` for those.

**Important:** The URLs in `outputs` are `/dataset/{id}` metadata URLs, not directly usable as `input_data`. Call `get_dataset` to resolve the actual file URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No | Filter to a specific project. Without this, returns all processes across all projects the user can access (or just the API key's scoped project). |

**Returns:** Array of process objects.

---

### `get_process`
`GET /process/{process_id}`

Get a single process by ID, including all versions with state, parameters, and outputs. Prefer this over `list_processes` when you already have the ID — it fetches only the one record.

After `create_process` returns an id, poll this endpoint until `versions[-1].state` is `done` or `failed`, then read `versions[-1].outputs` for dataset URLs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `process_id` | string | Yes | Process ID from `create_process`. |

**Returns:** Single process object. Returns 404 if not found or not a project member.

---

### `get_process_logs`
`GET /process/{process_id}/logs`

Retrieve execution logs for a process job. Use this to diagnose why a job failed (`state == 'failed'`).

Always pass `version` when diagnosing a specific run — omitting it returns logs from all versions interleaved.

**Pagination examples:**
- `offset=0, limit=100` → first 100 lines
- `offset=100, limit=100` → next 100 lines
- `offset=-50` → last 50 lines (tail)
- `offset=-100, limit=50` → 50 lines starting 100 from the end

| Parameter | Type | Required | Description |
|---|---|---|---|
| `process_id` | string | Yes | Process ID. |
| `version` | integer | No | Version number. Omitting returns logs from all versions interleaved. |
| `offset` | integer | No | Positive = from start; negative = from end. Default: `0`. |
| `limit` | integer | No | Maximum number of log entries to return. Omit for all entries from offset. |

**Returns:** Array of log entry objects with timestamps and messages.

---

### `clone_process_version`
`POST /process/{process_id}/versions/{version}/clone`

Create a new version of a process by copying parameters from an existing version with optional overrides. Enables iterative tuning: run → inspect results → adjust one parameter → re-run, without re-specifying everything.

Resource limits and deadline are inherited from the source version unless explicitly overridden. **For inversions, always override resources** — the source may have been created with small defaults.

Returns the same `{"id", "versions": [{"version"}]}` format as `create_process`. Poll `get_process` to track state.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `process_id` | string | Yes | Process ID. |
| `version` | integer | Yes | Source version number to clone. |

**Request body (optional):**

| Field | Type | Description |
|---|---|---|
| `parameter_overrides` | object | Keys to change relative to the source version. All other parameters are copied unchanged. |
| `resource_requests` | object | Override resource limits (same fields as in `create_process`). |
| `deadline_seconds` | integer | Override the deadline (seconds). If omitted, inherits from source version. |
| `cluster_id` | string | Override the cluster. Obtain valid ids from `available_clusters`. If omitted, inherits the source version's cluster (falls back to the first allowed cluster if no longer allowed). |

**Returns:** `{"id": "<process_id>", "versions": [{"version": <n>}]}`

---

### `available_clusters`
`GET /utilities/available-clusters`

Return the clusters the current user may run a process on, each with live CPU/memory limits (read from the cluster's Kueue `ClusterQueue`) and its `max_runtime_seconds` ceiling (`null` = unbounded). Call this before `create_process` to discover valid `cluster_id` values and size `resource_requests`/`deadline_seconds` within the selected cluster's limits. Sorted in the same order the value should be presented in.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No | Restrict to clusters allowed for this project. |
| `cpu` | string | No | CPU request to check allowance for, e.g. `"4"`. |
| `memory` | string | No | Memory request to check allowance for, e.g. `"16Gi"`. |
| `deadline_seconds` | integer | No | Requested wall-clock deadline to check against each cluster's `max_runtime_seconds`. |

**Returns:** Array of cluster objects: `id`, `name`, `sort_order`, `max_cpu_cores`, `max_memory_gb`, `max_runtime_seconds`.

---

### `cancel_process_version`
`POST /process/{process_id}/versions/{version}/cancel`

Cancel a process version that is currently queued or running. Deletes the Kubernetes job (if submitted) and marks the version as failed. Returns 409 if the version is already in a terminal state (`done` or `failed`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `process_id` | string | Yes | Process ID. |
| `version` | integer | Yes | Version number to cancel. |

**Returns:** `{"status": "cancelled"}`

---

## Datasets

### `search_datasets`
`GET /datasets`

Search for datasets produced by completed processing jobs. Each result includes `id`, `url` (for use as `input_data`), `dataset_name`, `process_name`, and `mime_type`. The `url` can be downloaded directly with curl — no authentication required.

The search string is matched case-insensitively against `<process_name> / v<version> / <dataset_name>`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | Name fragment to filter by. Default: `""` (all datasets). |
| `project_id` | string | No | Restrict to one project. |
| `completed_only` | boolean | No | Default: `true`. Set `false` to include datasets from still-running or failed jobs. |

**Returns:** Array of dataset metadata objects.

---

### `get_dataset`
`GET /dataset/{dataset_id}`

Return metadata for a specific dataset including its `mime_type`, `parts` structure, and the process version that produced it.

The `url` field in the response is the actual file URL — downloadable directly with curl (`curl "{url}" -o /tmp/result.msgpack`). **Use this `url` as `input_data` when passing this dataset to `create_process`**, not the `/dataset/{id}` URL from `list_processes` outputs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dataset_id` | string | Yes | Dataset ID. |

**Returns:** Dataset metadata object including `url`, `mime_type`, and `parts`.

---

### `describe_dataset`
`GET /dataset/{dataset_id}/describe`

Return compact statistics for a dataset without downloading the full content. Much cheaper than downloading, especially for large AEM files.

Returns (depending on `mime_type`):
- **XYZ/AEM** (`application/x-aarhusxyz-msgpack`): `flightline_count`, `columns`, `value_ranges` for numeric columns, `bbox`, `crs`
- **GeoJSON** (`application/geo+json`): `feature_count`, `bbox`
- **JSON** (`application/json`): `record_count` (if array), `keys`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dataset_id` | string | Yes | Dataset ID. |

**Returns:** Statistics object appropriate for the dataset's mime type.

---

## Environments

### `list_environments`
`GET /environments`

List available compute environments. Returns each environment's `id`, `name`, and `process_types`. By default `process_types` is a list of type name strings only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `include_schemas` | boolean | No | Include full JSON Schemas for each process type. Default: `false`. Use `get_process_type_schema` to fetch a single type's schema instead of embedding all schemas here. |

**Returns:** Array of environment objects.

---

### `get_process_types`
`GET /environments/{env_id}/process-types`

Return all process types available in an environment, keyed by type name. Each entry is a JSON Schema describing the required and optional `params` for that process type. Fields with `x-format: dataset` expect a file URL from `search_datasets`.

Returns an empty dict if the environment has not finished registering its process types yet (environment setup is itself a process — check `list_processes` to see if it has completed).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `env_id` | string | Yes | Environment ID from `list_environments`. |

**Returns:** Object mapping type name → JSON Schema.

---

### `get_process_type_schema`
`GET /environments/{env_id}/process-types/{type_name}`

Return the JSON Schema for exactly one named process type. Even the largest schemas (~44 KB) fit in a single response.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `env_id` | string | Yes | Environment ID from `list_environments`. |
| `type_name` | string | Yes | Process type key, e.g. `import_skytem`. |

**Returns:** JSON Schema object. Returns 404 if the environment or type name is not found.

---

### `create_environment`
`POST /environments`

Register a Docker image as a named compute environment. Typically called automatically by a build pipeline after pushing a new image. The environment is immediately available for `create_process`; its `process_types` are populated once the environment's setup job completes.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Human-readable display name. |
| `docker_image` | string | Yes | Fully-qualified Docker image reference, e.g. `registry.example.com/myenv:latest`. |
| `process_id` | string | No | ID of the process that built this environment, if any. Links the environment back to its build job. |

**Returns:** Environment object including the generated `id`.

---

## Uploads

### `upload_file`
`POST /upload`

Upload a raw input file (e.g. AEM survey data, CSV) that is not the output of any process. The response `url` is a direct HTTP file URL ready to pass as `input_data` to `create_process`.

Supports two body formats, auto-detected from `Content-Type`:

**Multipart/form-data** (any file size):
```bash
curl -F "file=@data.xyz" "https://host/upload?project_id=..."
```

**JSON + base64** (MCP-friendly, up to ~20 MB):
```json
{
  "filename": "data.xyz",
  "content": "<base64-encoded bytes>",
  "content_type": "application/x-aarhusxyz-msgpack"
}
```

For files larger than ~20 MB, use `request_upload_token` to get a short-lived token, then upload via curl:
```bash
curl -X POST "https://host/upload?project_id=..." \
  -H "Authorization: Bearer upt_..." \
  -F "file=@survey.xyz"
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No* | Project ID. Required unless using an upload token (`upt_...`) that already encodes the project. |

**Returns:** `{"id": "<upload_id>", "filename": "<name>", "url": "<http_url>"}`

---

### `request_upload_token`
`POST /upload/request-token`

Issue a short-lived Bearer token (prefix `upt_`) for uploading large files via curl, without passing full session credentials. The token is a signed JWT that expires after 1 hour and is scoped to the same project as the current session.

Requires a project-scoped API key session.

No parameters.

**Returns:** `{"token": "upt_<jwt>", "expires_in": 3600}`

---

## Workspaces

### `list_workspaces`
`GET /workspaces`

List all saved workspaces. Returns `id`, `title`, and timestamps for each workspace (layout tree is not included).

No parameters.

**Returns:** Array of workspace summary objects.

---

### `get_workspace`
`GET /workspace/{workspace_id}`

Get the full layout tree for a workspace. Returns a recursive JSON tree of nodes with `id`, `widget`, optional `children`, and widget-specific `layoutConfig`.

Call `get_workspace_schema` first to understand valid node structures and widget types.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Workspace ID from `list_workspaces`. |

**Returns:** Workspace object including the full `layout` tree.

---

### `create_workspace`
`POST /workspace`

Create a new workspace with a title and layout tree. If an `id` is provided and already exists, the workspace is updated (upsert behaviour).

The `layout` must conform to the schema from `get_workspace_schema`. Always call `get_workspace_schema` before constructing a layout to discover valid widget types and their `layoutConfig` schemas.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | No | Display name. Default: `"Untitled Workspace"`. |
| `layout` | object | No | Recursive node tree. Must conform to the schema from `get_workspace_schema`. |
| `id` | string | No | If provided and exists, updates the workspace (upsert). Omit to always create a new one. |

**Returns:** Created or updated workspace object including the generated `id` and full `layout`.

---

### `get_workspace_schema`
`GET /workspace-schema`

Return the JSON Schema for the workspace layout format. The schema describes a recursive tree of layout nodes; container widgets (`VerticalSplit`, `HorizontalSplit`, `TabSet`) hold `children` arrays, and leaf widgets hold `layoutConfig`.

Returns 503 if widget schemas have not been generated yet. To generate them:
```bash
cd frontend && npm run export-schemas
```

No parameters.

**Returns:** JSON Schema object with `$defs` for all registered widget types.

---

### `get_app_url`
`GET /workspace/app-url`

Build a deep-link URL that opens the app with specific state pre-selected. All parameters after `workspace_id` are optional — omit trailing ones to link at a coarser level.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Workspace to open. |
| `project_id` | string | No | Pre-select a project. |
| `process_id` | string | No | Pre-select a process. |
| `version` | integer | No | Pre-select a specific process version. |
| `part` | string | No | Pre-select a dataset part path. |
| `sounding` | integer | No | Pre-select a specific sounding index. |

**Returns:** `{"url": "https://..."}`

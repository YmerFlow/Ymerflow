# MCP Tools Reference

YmerFlow exposes a subset of its REST API as MCP (Model Context Protocol) tools via [fastapi-mcp](https://github.com/tadata-ru/fastapi-mcp), mounted at `/mcp` using the Streamable HTTP transport.

Only routes tagged `Processes`, `Datasets`, `Environments`, `Uploads`, or `Workspaces` are exposed as MCP tools (`backend/main.py`, `FastApiMCP(..., include_tags=[...])`). Auth, Projects, Publications, Admin, Systems, Tags, Plugins, and Internal routes are REST-only and not visible to MCP clients. No `operation_id` is set on any route, so tool names follow FastAPI's default `{function_name}_{path}_{method}` pattern (e.g. `create_process_projects__project_id__process_post`) — MCP tool names are auto-derived from the route path, so they follow automatically whenever a route moves; nothing to hand-update here.

## Authentication

All tools require a project-scoped API key:

```
Authorization: Bearer apk_<key>
```

API keys are scoped to a single project, but every project-resource endpoint still takes that
same `project_id` as an explicit path parameter (`/projects/{project_id}/...`) — pass it on every
call. Under the hood, a single bearer credential is dispatched by prefix: `apk_...` (API key,
hashed and looked up, scopes the request to its project — the `project_id` you pass must match the
key's scope or you get 403), `upt_...` (short-lived 1h upload-only JWT from
`request_upload_token`), or a full-session JWT (no project scope). Write endpoints require real
project membership; read endpoints additionally accept a read-only publication id in place of
`project_id` (see `docs/plans/done/publication-readonly-projects.md`) — not relevant to MCP
clients, which always authenticate with a real project-scoped API key.

## Typical Workflow

```
1. list_environments          — discover available environments and process type names
2. get_process_type_schema    — fetch the JSON Schema for the specific type you want to run
3. upload_file                — upload local input data (or use request_upload_token + curl for large files)
4. create_process              — submit the job; save the returned id and version
5. get_process                — poll until versions[-1].state is 'done' or 'failed'
6. get_dataset                — resolve output URLs from versions[-1].outputs
7. curl '{url}'                — download results; /files/ URLs need no authentication
```

Use `get_dataset` to inspect a dataset before downloading it in full: its `files` dict (root-level and per-part) may include a `"application/vnd.nagelfluh.stats+json"` entry whose URL resolves to pre-computed statistics (count, min, max, mean, rms, percentiles, skewness, kurtosis), so you can check value ranges without downloading the binary content.

## Which endpoints are NOT exposed

Binary data download endpoints are excluded from MCP (`include_in_schema=False`) because they overflow LLM context windows:
- `GET /projects/{project_id}/dataset/{id}/data` and `/geography` — use the `url` field from `get_dataset` + curl instead
- `GET /files/{path}` — auth-free, download directly with curl
- `GET /uploads/{id}` — use the `url` returned by `upload_file`

There is no longer a `describe_dataset` endpoint — it was removed and replaced by the pre-computed stats files described above (see `get_dataset`).

---

## Processes

### `create_process`
`POST /projects/{project_id}/process`

Submit any type of job — data import, processing, inversion, forward modelling, etc. The job is queued and runs asynchronously in Kubernetes. Returns immediately with the process id and version number.

**Retry vs. new process:** If retrying a failed job or correcting parameters, pass the original `id` in the body to append a new version. Do NOT create a new process — that loses history. Omit `id` only when starting a genuinely new workflow.

**Resource sizing for inversions:** Never use defaults for inversions — the defaults (1 CPU, 2 Gi RAM, 1 h deadline) will cause OOM-kills or deadline failures with no output produced. Set `resource_requests` and `deadline_seconds` explicitly based on dataset size.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project ID the job belongs to. |

**Request body** (`ProcessCreate`; accepts extra unknown fields, which are silently ignored):

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | Process type key, e.g. `aem_inversion`. Obtain from `list_environments` / `get_process_type_schema`. |
| `environment` | object | Yes | Compute environment to run in — `{id, [name]}`. Obtain from `list_environments` (pass the object straight through, or just `{"id": ...}`). |
| `params` | object | No | Process-type-specific parameters defined by the process type's JSON Schema. Default `{}`. Fields with `x-format: dataset` expect a file URL from `search_datasets` or `get_dataset`. |
| `id` | string | No | Existing process ID. Provide to add a new version (retry/correction). Omit to create a new process. |
| `name` | string | No | Human-readable display name. Defaults to `<type>-process`. |
| `resource_requests` | object | No | Kubernetes resource requests. See below. |
| `deadline_seconds` | integer | No | Max wall-clock time before the job is killed. Default: `3600`. Always set explicitly for inversions. |
| `cluster` | object | No | Cluster to run on — `{id, [name]}`. Obtain from `available_clusters`. Omit to auto-select the first allowed cluster (by `sort_order`). |

A value obtained from `list_environments`, `available_clusters`, or a prior `get_process` can be passed straight through as the `environment`/`cluster` field — no extraction step needed. `name`, if present on `environment`/`cluster`, is ignored server-side (only `.id` is read).

**`resource_requests` fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `cpu` | string | `"1000m"` | CPU request in Kubernetes notation, e.g. `"500m"` or `"4"`. |
| `memory` | string | `"2Gi"` | Memory request, e.g. `"512Mi"` or `"16Gi"`. |
| `ephemeral-storage` | string | `"10Gi"` | Temporary disk space for the job. |

**Returns:** `{"id": "<process_id>", "versions": [{"version": <n>}]}`

---

### `list_processes`
`GET /projects/{project_id}/processes`

List processes in a project, with their status and outputs.

Each process has a `versions` array sorted ascending by version number; `versions[-1]` is the most recent run. Each version includes `state`, `outputs`, and `parameters`. Logs are not included — use `get_process_logs` for those.

**Important:** The URLs in `outputs` are `/projects/{project_id}/dataset/{id}` metadata URLs, not directly usable as `input_data`. Call `get_dataset` to resolve the actual file URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project to list processes in. |

**Returns:** Array of process objects — `{id, name, type, environment: {id, name, created_at}|null, project_id, flow_x, flow_y, versions: [...]}`. Each version is `{version, parameters, outputs: {name: "<url>/projects/{project_id}/dataset/{id}"}, state: "queued"|"running"|"done"|"failed", dependencies, resource_requests, deadline_seconds, cluster, tags}`.

---

### `get_process`
`GET /projects/{project_id}/process/{process_id}`

Get a single process by ID, including all versions with state, parameters, and outputs. Prefer this over `list_processes` when you already have the ID — it fetches only the one record.

After `create_process` returns an id, poll this endpoint until `versions[-1].state` is `done` or `failed`, then read `versions[-1].outputs` for dataset URLs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the process belongs to. |
| `process_id` | string | Yes | Process ID from `create_process`. |

**Returns:** Single process object (same shape as `list_processes` entries). Returns 404 if not found in the given project.

---

### `get_process_logs`
`GET /projects/{project_id}/process/{process_id}/logs`

Retrieve execution logs for a process job. Use this to diagnose why a job failed (`state == 'failed'`).

Always pass `version` when diagnosing a specific run — omitting it returns logs from all versions interleaved.

**Pagination examples:**
- `offset=0, limit=100` → first 100 lines
- `offset=100, limit=100` → next 100 lines
- `offset=-50` → last 50 lines (tail)
- `offset=-100, limit=50` → 50 lines starting 100 from the end

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the process belongs to. |
| `process_id` | string | Yes | Process ID. |
| `version` | integer | No | Version number. Omitting returns logs from all versions interleaved. |
| `offset` | integer | No | Positive = from start; negative = from end. Default: `0`. |
| `limit` | integer | No | Maximum number of log entries to return. Omit for all entries from offset. |

**Returns:** Array of log entry objects — `{timestamp, message}`.

---

### `clone_process_version`
`POST /projects/{project_id}/process/{process_id}/versions/{version}/clone`

Create a new version of a process by copying parameters from an existing version with optional overrides. Enables iterative tuning: run → inspect results → adjust one parameter → re-run, without re-specifying everything.

Resource limits and deadline are inherited from the source version unless explicitly overridden. **For inversions, always override resources** — the source may have been created with small defaults.

Returns the same `{"id", "versions": [{"version"}]}` format as `create_process`. Poll `get_process` to track state.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the process belongs to. |
| `process_id` | string | Yes | Process ID. |
| `version` | integer | Yes | Source version number to clone. |

**Request body (optional):**

| Field | Type | Description |
|---|---|---|
| `parameter_overrides` | object | Keys to change relative to the source version. All other parameters are copied unchanged. |
| `resource_requests` | object | Override resource limits (same fields as in `create_process`). |
| `deadline_seconds` | integer | Override the deadline (seconds). If omitted, inherits from source version. |
| `cluster` | object | Override the cluster for the cloned run — `{id, [name]}`. Obtain from `available_clusters`. If omitted, inherits the source version's cluster (falls back to the first allowed cluster if no longer allowed). |

**Returns:** `{"id": "<process_id>", "versions": [{"version": <n>}]}`

---

### `cancel_process_version`
`POST /projects/{project_id}/process/{process_id}/versions/{version}/cancel`

Cancel a process version that is currently queued or running. Deletes the Kubernetes job (if submitted) and marks the version as failed. Returns 409 if the version is already in a terminal state (`done` or `failed`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the process belongs to. |
| `process_id` | string | Yes | Process ID. |
| `version` | integer | Yes | Version number to cancel. |

**Returns:** `{"status": "cancelled"}`

---

### `update_process_position`
`PATCH /projects/{project_id}/process/{process_id}/position`

Persist the FlowView canvas position for a process node, so the layout is remembered between sessions.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the process belongs to. |
| `process_id` | string | Yes | Process ID. |

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `x` | number | Yes | X coordinate on the FlowView canvas. |
| `y` | number | Yes | Y coordinate on the FlowView canvas. |

**Returns:** No content (`204`).

---

### `available_clusters`
`GET /projects/{project_id}/utilities/available-clusters`

Return the clusters the current user may run a process on, each with live CPU/memory limits (read from the cluster's Kueue `ClusterQueue`) and its `max_runtime_seconds` ceiling (`null` = unbounded). Call this before `create_process` to discover valid cluster IDs and size `resource_requests`/`deadline_seconds` within the selected cluster's limits. Sorted by `sort_order`, the same order the value should be presented in.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Restrict to clusters allowed for this project. |
| `cpu` | string | No | CPU request to check allowance for, e.g. `"4"`. |
| `memory` | string | No | Memory request to check allowance for, e.g. `"16Gi"`. |
| `deadline_seconds` | integer | No | Accepted but currently unused server-side — only `cpu`/`memory` affect which clusters are returned. |

**Returns:** Array of cluster objects — `{id, name, namespace, created_at, sort_order, active, max_runtime_seconds, provisioning_status, max_cpu_cores, max_memory_gb}`.

---

## Datasets

### `search_datasets`
`GET /projects/{project_id}/datasets`

Search for datasets produced by completed processing jobs. Each result includes `id`, `url` (for use as `input_data`), `dataset_name`, `process_name`, and `mime_type`. The `url` can be downloaded directly with curl — no authentication required.

The search string is matched case-insensitively against `<process_name> / v<version> / <dataset_name>`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project to search datasets in. |
| `search` | string | No | Name fragment to filter by. Default: `""` (all datasets). |
| `completed_only` | boolean | No | Default: `true`. Set `false` to include datasets from still-running or failed jobs. |

**Returns:** Array of dataset metadata objects (same shape as `get_dataset`).

---

### `get_dataset`
`GET /projects/{project_id}/dataset/{dataset_id}`

Return metadata for a specific dataset including its `mime_type`, `parts` structure, and the process version that produced it.

The `url` field in the response is the actual file URL — downloadable directly with curl (`curl "{url}" -o /tmp/result.msgpack`). **Use this `url` as `input_data` when passing this dataset to `create_process`**, not the `/projects/{project_id}/dataset/{id}` URL from `list_processes` outputs.

The `files` dict (both at the root and under `parts.<name>.files`) may contain a key `"application/vnd.nagelfluh.stats+json"`. Fetching that URL returns pre-computed statistics — `count`, `min`, `max`, `mean`, `rms`, `geometric_mean`, `std`, percentiles `p5`/`p25`/`p50`/`p75`/`p95`, `skewness`, `kurtosis` (constant columns/flightlines appear as `{"constant": true, "value": X}` instead). Structure varies by dataset type:
- **XYZ/AEM** (`application/x-aarhusxyz-msgpack`): `flightlines` (per-column stats) and `layer_data` (per-channel, with `.layers` arrays indexed by layer number for varying channels).
- **MAG** (`application/x-magdata-msgpack`): `columns` (per-column stats).
- **Grid/webxtile** (`application/x-webxtile`): `variables`, each with `all` and (for 3-D variables) `slices` arrays indexed by z-slice.

Use this stats URL to inspect a dataset without downloading the full binary file.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the dataset belongs to. |
| `dataset_id` | string | Yes | Dataset ID. |

**Returns:** Dataset metadata object — `{id, mime_type, process_id, process_name, process_version, dataset_name, project_id, parts, url}`.

---

## Environments

### `list_environments`
`GET /environments`

List available compute environments. Returns each environment's `id`, `name`, and `process_types`. By default `process_types` is a list of type name strings only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `include_schemas` | boolean | No | Include full JSON Schemas for each process type. Default: `false`. Use `get_process_type_schema` to fetch a single type's schema instead of embedding all schemas here. |

**Returns:** Array of environment objects — `{id, name, docker_image, process_id, process_types, created_at}`.

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
`POST /projects/{project_id}/upload`

Upload a raw input file (e.g. AEM survey data, CSV) that is not the output of any process. The response `url` is a direct HTTP file URL ready to pass as `input_data` to `create_process`.

Supports two body formats, auto-detected from `Content-Type`:

**Multipart/form-data** (any file size):
```bash
curl -F "file=@data.xyz" "https://host/projects/{project_id}/upload"
```

**JSON + base64** (MCP-friendly, up to ~20 MB):
```json
{
  "filename": "data.xyz",
  "content": "<base64-encoded bytes>",
  "content_type": "application/x-aarhusxyz-msgpack"
}
```

For files larger than ~20 MB, use `request_upload_token` to get a short-lived token, then upload via curl (the token already encodes the project it was requested for, but `project_id` in the path must still match it):
```bash
curl -X POST "https://host/projects/{project_id}/upload" \
  -H "Authorization: Bearer upt_..." \
  -F "file=@survey.xyz"
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project ID. Must match the API key's/upload token's scope. |

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

Workspaces belong to a project and are versioned: each workspace is a parent record with a
`versions` array (mirroring how `Process`/`ProcessVersion` work). Saving over a workspace never
overwrites — it appends the next version, and "current" is always the highest version number. A
workspace can be marked public (`is_public`), which lists it in the cross-project public gallery
where any authenticated user can fork a specific version of it into their own project.

A workspace object has the shape:
`{id, title, project_id, is_public, forked_from_workspace_id, forked_from_version, created_at, versions: [{version, layout, created_at}], project_name?}`
(`project_name` is included only on public-gallery and single-workspace reads).

### `list_workspaces`
`GET /workspaces?project_id=<id>`

List the workspaces belonging to a project, each with its full version history. Requires the
caller to be a member of the project (the API key's scoped project).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project whose workspaces to list. |

**Returns:** Array of workspace objects (see shape above).

---

### `list_public_workspaces`
`GET /workspaces/public`

List every public workspace across all projects — the "public gallery" used to discover
workspaces worth forking. Any authenticated user can call this (no project-membership check).
Each entry includes its home project's `project_name` and full version list.

No parameters.

**Returns:** Array of workspace objects, each including `project_name`.

---

### `get_workspace`
`GET /workspace/{workspace_id}`

Get a workspace and its full version history. Returns 404 unless the workspace is public or the
caller is a member of its home project. Each entry in `versions` holds a recursive JSON `layout`
tree of nodes with `id`, `widget`, optional `children`, and widget-specific `layoutConfig`.

Call `get_workspace_schema` first to understand valid node structures and widget types.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Workspace ID from `list_workspaces` or `list_public_workspaces`. |

**Returns:** Workspace object (see shape above). Returns 404 if missing or not accessible.

---

### `create_workspace`
`POST /workspace?project_id=<id>`

Create a new workspace in a project, with an initial version-1 layout. Requires membership of
`project_id`.

The `layout` should conform to the schema from `get_workspace_schema`, though this is documented
convention only — the request body is an untyped dict and is **not validated server-side**. Always
call `get_workspace_schema` before constructing a layout.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | Yes | Project the workspace belongs to. |

**Request body** (untyped dict):

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | No | Display name. Default: `"Untitled Workspace"`. |
| `layout` | object | No | Recursive node tree for version 1. Default: `{}`. |

**Returns:** Created workspace object with its generated `id` and a single `version` 1.

---

### `create_workspace_version`
`POST /workspace/{workspace_id}/versions`

Append a new version to an existing workspace's layout — never overwrites, so prior layouts stay
browsable. Requires membership of the workspace's home project (whether or not it's public).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Workspace to add a version to. |

**Request body:** `{layout}` — the new version's node tree.

**Returns:** The workspace object with the new version appended.

---

### `update_workspace`
`PATCH /workspace/{workspace_id}`

Rename a workspace and/or toggle whether it's public. Any member of the workspace's home project
may do either (no creator-only or admin-only restriction).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Workspace to update. |

**Request body:** `{title?, is_public?}` — supply either or both.

**Returns:** The updated workspace object.

---

### `fork_workspace`
`POST /workspace/{workspace_id}/fork?project_id=<id>`

Copy a version of a public workspace into your own project as a new, independent workspace. The
fork is a snapshot copy (not a live reference): it starts its own version-1 history and never
changes when the source is edited afterward. Requires membership of the *destination* `project_id`;
the source must be public (404 otherwise).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | Yes | Public source workspace to fork. |
| `project_id` | string | Yes | Destination project (the fork's new home). |

**Request body:** `{version?}` — which source version to copy. Defaults to the source's latest.

**Returns:** The new forked workspace object (with `forked_from_workspace_id`/`forked_from_version` set).

---

### `get_workspace_schema`
`GET /workspace-schema`

Return the JSON Schema for the workspace layout format. The schema describes a recursive tree of layout nodes; container widgets (`VerticalSplit`, `HorizontalSplit`, `TabSet`) hold `children` arrays, and leaf widgets hold `layoutConfig`.

Returns 503 if widget schemas have not been generated yet (reads `backend/widget_schemas.json`). To generate them:
```bash
cd frontend && npm run export-schemas
```

No parameters.

**Returns:** JSON Schema document with `$schema`, `title`, `description`, `$defs` for all registered widget types, and `$ref` to the root `Node` union.

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

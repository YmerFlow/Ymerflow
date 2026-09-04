# System Architecture

## Overview

YmerFlow uses a distributed architecture with React frontend, FastAPI backend, and Kubernetes-based process execution:

```
Frontend (React) → Backend (FastAPI) → Kubernetes Cluster
                                       ├─> Kueue → Job → Pod (process execution)
                                       ├─> Log streaming via WebSocket
                                       └─> MinIO (development) / GCS/S3 (production)
                                           └─> Per-project buckets with IAM
```

## Data Model

The user-facing data model consists of environments, process types, processes, and datasets:

```
┌─────────────────────────────────────────────────────────────┐
│ Environment                                                  │
│  - Collection of available process types                    │
│  - Defines Docker image and dependencies                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Process Type (e.g., "fft", "inversion")              │  │
│  │  - Defines process behavior                          │  │
│  │  - JSON Schema for parameters                        │  │
│  │                                                       │  │
│  │  ┌────────────────────────────────────────────────┐ │  │
│  │  │ Process Instance                                │ │  │
│  │  │  - User-created execution                       │ │  │
│  │  │  - Name, resource requirements                  │ │  │
│  │  │  - Versions (parameter snapshots)               │ │  │
│  │  │                                                  │ │  │
│  │  │  ┌──────────────────────────────────────────┐  │ │  │
│  │  │  │ Parameters                                │  │ │  │
│  │  │  │  - Validated against schema              │  │ │  │
│  │  │  │  - May reference input datasets          │  │ │  │
│  │  │  │    (URLs to other process outputs)       │  │ │  │
│  │  │  └──────────────────────────────────────────┘  │ │  │
│  │  │                                                  │ │  │
│  │  │  ┌──────────────────────────────────────────┐  │ │  │
│  │  │  │ Output Datasets                          │  │ │  │
│  │  │  │  - Created by process execution          │  │ │  │
│  │  │  │  - Stored in project bucket              │  │ │  │
│  │  │  │  - Can be inputs to other processes      │  │ │  │
│  │  │  └──────────────────────────────────────────┘  │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Relationships:
  Environment → has many → Process Types
  Process Type → has schema → defines Parameters
  Process Type → instantiated as → Process Instances
  Process Instance → has → Parameters (validated by schema)
  Process Instance → creates → Output Datasets
  Process Instance → references → Input Datasets (from other processes)
  Dataset → stored in → Project Bucket (per-project isolation)
```

**Key concepts:**

- **Environment**: A container environment with specific process types available (e.g., "Bootstrap" with basic types, custom environments with specialized libraries)
- **Process Type**: A template defining what a process does (FFT, inversion, etc.) and what parameters it accepts (via JSON Schema)
- **Process Instance**: A specific execution of a process type with user-provided parameters and resource requirements
- **Parameters**: User inputs validated against the process type's schema, may include references to datasets from other processes
- **Datasets**: Output files from process execution, stored in per-project buckets (pluggable storage backend — see [Storage Architecture](storage.md)), can be used as inputs to other processes

**Data flow example:**
1. User selects Environment → sees available Process Types
2. User creates Process Instance → fills Parameters (validated by schema)
3. Parameters may reference Input Datasets (outputs from previous processes)
4. Process executes → creates Output Datasets
5. Output Datasets → available as inputs to subsequent processes

**See also:**
- [Process Types](processes.md) - Creating and registering process types
- [Environment](environment.md) - Docker images, entrypoints, and schema extraction

## Backend Components

### FastAPI Server
- **REST API**: 13 routers (`backend/main.py`) covering auth, projects, publications,
  environments, processes, datasets, workspaces, uploads, utilities, systems, tags, plugins,
  plugin assets, internal, and admin endpoints
- **WebSocket endpoints**: Real-time log streaming and state updates
- **MCP server**: Mounted at `/mcp` (`fastapi_mcp.FastApiMCP`, `backend/main.py`), exposing
  Processes, Datasets, Environments, Uploads, and Workspaces as MCP tools for AI agents — see
  [MCP Tools](../mcp-tools.md)
- **Authentication**: JWT user sessions, project-scoped API keys (`backend/models/api_key.py`),
  short-lived upload tokens, and anonymous read-only publication links
- **Database**: SQLite (development) / PostgreSQL (production) with Alembic migrations

### Kubernetes Client
- Kubernetes API integration for job management
- Creates and monitors Jobs in the target `Cluster`'s namespace (`Cluster.namespace`,
  `backend/models/cluster.py`, defaults to `ymerflow-jobs` but is configurable per cluster —
  see "Pluggable Backends" below and "Kubernetes Resources" for the multi-cluster picture)
- Handles job lifecycle and cleanup (TTL 1 hour after completion)

### Job Orchestrator
- Creates Kubernetes Job manifests with:
  - Resource limits (CPU, memory, ephemeral storage)
  - Deadline enforcement
  - A Kueue queue-name **label** (`kueue.x-k8s.io/queue-name`) on the Job for queuing
  - Storage credentials via a `STORAGE_KWARGS_JSON` env var (opaque, protocol-agnostic fsspec
    kwargs) — not a Kubernetes Secret
  - A per-Job, ephemeral image-pull Secret (minted fresh from the active registry backend's
    credential, owned by the Job for automatic garbage collection — see
    [Registry Architecture](registry.md))
  - Environment variables for process configuration

### Pluggable Backends

Three axes of the system are pluggable, each following the same shape (a discriminator column on
a DB row dispatching to a handler/provider class, discovered via a `ymerflow.hooks` fan-out
entry point — no "core is special" path):

| Axis | Model | Handler ABC | Docs |
|---|---|---|---|
| Object storage | `StorageBackend` (one per project) | `StorageProtocolHandler` | [Storage Architecture](storage.md) |
| Job-running cluster | `Cluster` (selectable per process — cluster picker on process creation, `backend/routers/processes.py`) | `ClusterProvider` | this document, "Kubernetes Resources" below |
| Container registry | `RegistryBackend` (one, app-wide) | `RegistryProtocolHandler` | [Registry Architecture](registry.md) |

All three also share a `bootstrap(config) -> config` hook, used by `config.env`-driven, opt-in
live provisioning (`backend/bin/yf-bootstrap-provision`) — see
[Registry Architecture § Configuration](registry.md#configuration) for the full mechanism.

Admins can also manage clusters and storage backends directly — CRUD endpoints plus a
self-service cluster registration flow (an admin-issued token, claimed by a script run on the
target cluster) live in `backend/routers/admin.py`.

### Plugin & Hook System

Beyond the three pluggable backend axes above, the whole application is extensible through a
generic hook system (`backend/hooks.py`): plugins register themselves via the `ymerflow.hooks`
setuptools entry point, and the backend fans calls out to every installed plugin at defined
extension points, e.g. `register_routers`, `register_models` (wired in
`backend/models/__init__.py`), `job_pre_run`/`job_completed` (used by `plugins/billing` for
balance holds/settlement — see "Database Schema" above), `select_clusters`/
`select_storage_backends` (restrict which `Cluster`/`StorageBackend` rows a user may pick),
`storage_protocol_handlers`/`cluster_provider_handlers`/`registry_protocol_handlers`, and
`frontend_bundles`. See [Plugin SDK Overview](../plugin-sdk/overview.md) for the full contract.

Frontend plugins are built as Module Federation bundles: `backend/routers/plugins.py` serves
installed plugin assets, and a plugin is built by submitting a `build_frontend_plugin` process
through the same generic process-creation endpoint used for all other job types — there is no
separate plugin-build API.

**Workspaces** (`backend/models/workspace.py`) are user-authored, versioned dashboards/layouts
with a full CRUD/fork/publish API (`backend/routers/workspaces.py`) and are MCP-exposed — see
[MCP Tools](../mcp-tools.md).

**Process tags** (`backend/routers/tags.py`) let users label process versions with custom,
per-project tags.

**Project export/import** (`backend/models/project_export.py`, `ProjectExport`/`ProjectImport`)
lets a project's processes, datasets, and metadata be packaged up and restored elsewhere.

### Log Collector
- Streams pod logs to ProcessLog database table
- Broadcasts logs to connected WebSocket clients
- Real-time updates for process state changes
- Persistent log storage for historical viewing

### Database Schema
Core models registered in `backend/models/__init__.py`:
- **User**: Authentication
- **StorageBackend**: Pluggable per-project object storage configuration
- **RegistryBackend**: Pluggable, app-wide container registry configuration
- **Cluster**: Registered job-running Kubernetes clusters
- **Project**, **ProjectMember**, **ProjectInvite**, **Publication**: Multi-tenant project
  isolation, membership, invites, and read-only publication links
- **ApiKey**: Project-scoped API keys for programmatic/MCP access
- **Environment**: Docker image + available process types
- **Process**, **ProcessVersion**, **ProcessLog**, **ProcessTag**: Process definitions with
  versioning, parameter snapshots/outputs/state, timestamped log entries, and tags
- **Dataset**: Dataset metadata and references
- **Workspace**, **WorkspaceVersion**: User-authored dashboards/layouts, versioned and
  forkable/publishable (MCP-exposed — see [MCP Tools](../mcp-tools.md))
- **Upload**: User-uploaded files
- **ProjectExport**, **ProjectImport**: Project export/import records
- **System**: Application-wide settings
- **Plugin**, **PluginVersion**, **UserPlugin**: Installed backend/frontend plugins and
  per-user enablement

Billing (HOLD/DEBIT/RELEASE transactions) is not a core model — it lives entirely in
`plugins/billing`, wired in via the `job_pre_run`/`job_completed` hooks (see "Plugin & Hook
System" below). A stock install without that plugin has no balance tracking at all.

## Frontend Components

### Flexout Layout System
A custom drag-and-drop layout engine for flexible UI arrangement:
- **LayoutContext**: Manages recursive layout tree structure
- **Built-in widgets**: Split (vertical/horizontal), TabSet, Empty
- **Pane component**: Individual draggable/droppable pane with header controls
- **Popout support**: Detach panes to separate windows
- **MenuContext**: Global menu registration system

Layout tree structure:
```javascript
{
  id: "unique-id",
  widget: "WidgetName",  // e.g., "FlowView", "VerticalSplit"
  children: [...]         // For Split/TabSet widgets
}
```

### State Management

#### ProcessContext
Global state for:
- All processes and their versions
- Active process selection
- Real-time updates via WebSocket
- Process creation and editing

#### API Client
- Centralized API calls to backend (`http://localhost:8000`)
- Process CRUD operations
- Dataset retrieval
- Process type schema fetching

### Core Widgets

Built-in widgets are registered via `registerHook('widgets', ...)` in `frontend/src/App.jsx` — a
plugin-extensible hook system (see [Widget System](../frontend/widgets.md)), not a static
`const widgets = {...}` object. Plugins register additional widgets through the same hook.

#### FlowView
- Visual graph of processes using ReactFlow
- Shows process dependencies (input/output relationships)
- Click to set active process
- Drag to rearrange graph layout

#### ProcessEditor
Dual-mode editor:
- **Create mode** (no active process): Form to create new process
  - Select process type
  - Fill JSON Schema form with parameters
  - Resource configuration (CPU, memory, deadline)
  - Cost estimation
- **Edit mode** (active process): View/edit existing process
  - Create new versions with modified parameters
  - Cancel a queued or running version
  - View output datasets

#### ProcessLog
- Real-time log streaming with status badges
- WebSocket connection to backend
- Filterable by process
- Persistent across sessions

#### PlotView
Plotly-based visualization with:
- **Plot elements registry**: Extensible element types (Line, Points, etc.)
- **Unit matching**: Automatic axis assignment based on data units
- **Dynamic trace building**: Loads data from datasets, builds Plotly traces
- **Configuration form**: Add/configure plot elements with dataset selection

#### EnvironmentView
Lists available Environments (Docker image, creator, creation date); click a row for details.

#### ProcessProgress
Real-time progress line plot for a running process, driven by log-derived progress events over
the same WebSocket log stream ProcessLog uses.

#### Export
Browses a process version's output datasets and lets the user download them.

#### ProcessInfo
Read-only YAML dump of a process's metadata, with URLs rendered as clickable links.

#### AEMModelSimulator
Interactive forward-modelling canvas for AEM flightlines — create/load/save models, add
flightlines, and brush-edit layers.

#### InUseEditor
In-place dataset editing mode (enable/disable/clear, with E/D/C keyboard shortcuts and undo).

#### PluginManager
Lists installed plugins and lets the user enable, disable, or upgrade them per account.

### WebSocket Clients
- **Log streaming**: Real-time process logs
- **State updates**: Process state changes (`queued`, `running`, `done`, `failed`)
- Automatic reconnection on disconnect
- Multiplexed updates for multiple processes

## Kubernetes Resources

### Namespace
- **Name**: `Cluster.namespace` (`backend/models/cluster.py`), defaults to `ymerflow-jobs` but
  is configurable per registered `Cluster` — multi-cluster execution is real and user-facing (a
  cluster picker on process creation resolves the target `Cluster` and namespace per job; see
  `backend/routers/processes.py` and the "Pluggable Backends" table above)
- **Purpose**: Isolated environment for process execution
- **Resources**: Jobs, Pods, Secrets, ConfigMaps

### Kueue Configuration
- **Local queue**: `ymerflow-queue` (namespace-scoped)
- **Cluster queue**: `ymerflow-cluster-queue` (cluster-wide resource management)
- **Resource limits**: Enforced CPU, memory, ephemeral storage
- **Job queuing**: Automatic queuing when resources unavailable
- **Admission control**: Jobs admitted based on available quota

**Provisioning**: making a `Cluster` job-ready (installing Kueue if not already present, sizing
and applying its `ResourceFlavor`/`ClusterQueue`/`LocalQueue` from the cluster's real node
allocatable capacity, and applying the backend's job-running RBAC) is a single, provider-agnostic
routine — `backend.services.cluster_job_provisioning.ensure_cluster_job_ready(k8s_client,
namespace)`, written against `kubernetes_asyncio` with no shell/`kubectl` subprocess calls. It
runs identically for any `cluster_type`, and is called automatically:
- when a cluster completes self-service registration (`POST
  /admin/clusters/register-callback`, after connectivity is confirmed),
- when an admin creates a cluster directly (`admin_create_cluster`), or
- once, when the default cluster's row is seeded (the generic cluster seed migration,
  `d1266f2f6e68_generic_seed_default_cluster.py`).

This replaced two independent, duplicated shell implementations (a minikube-only script and a
GCP-plugin-specific GKE setup script). `plugins/ymerflow-minikube`'s provision-ymerflow-jobs.sh now only creates the
jobs namespace — everything else moved into the Python routine above.

### Job Structure
Each process creates a Kubernetes Job with (`backend/services/job_orchestrator.py`):
- **Name**: `process-{process_id}-v{version}`
- **Job labels**: `kueue.x-k8s.io/queue-name` (Kueue's queue-name label lives on the Job itself)
- **Pod template labels**: `app=ymerflow-process`, `process_id={id}`, `version={v}`
- **Resource requests/limits**: User-specified CPU/memory
- **Deadline**: `activeDeadlineSeconds` for timeout enforcement
- **Backoff limit**: 0 (no automatic retries)
- **TTL**: 3600 seconds (1 hour cleanup after completion)
- **Image pull secret**: A fresh, per-Job `kubernetes.io/dockerconfigjson` Secret, owned by the
  Job for automatic garbage collection (see [Registry Architecture](registry.md))

### Pod Configuration
- **Image**: `ymerflow-base-runner:latest` (or environment-specific image)
- **Environment variables**:
  - `PROCESS_TYPE`: Type of process to run
  - `PROCESS_ID`: Unique process identifier
  - `VERSION`: Process version number
  - `PROJECT_ID`: Project identifier for multi-tenancy
  - `PARAMETERS_JSON`: Serialized process parameters
  - `BACKEND_URL`: Backend API endpoint
  - `STORAGE_BASE`: Storage bucket path (scheme depends on the project's `StorageBackend`
    protocol — s3/gs/…)
  - `STORAGE_KWARGS_JSON`: Opaque, protocol-agnostic fsspec kwargs (credentials included) —
    project-scoped, never the backend's admin creds; not delivered via a Kubernetes Secret
  - `CREDENTIAL_STRATEGY`: `static-key` (default) or `short-lived`
  - `STORAGE_CREDENTIALS_EXPIRES_AT`, `STORAGE_REFRESH_TOKEN`: Only set for `short-lived`
    credential strategy, so the runner can re-mint mid-job
  - `REGISTRY_URL`, `REGISTRY_AUTH`: Global registry config, used by `build_frontend_plugin`
    jobs to push/pull built plugin images
- **Restart policy**: Never (controlled by Kueue)

## Data Flow

### Process Creation
1. User fills form in ProcessEditor
2. Frontend validates parameters against JSON Schema
3. POST to `/projects/{project_id}/process` (`backend/routers/processes.py`) with:
   - Process type, environment, and (optionally) target cluster
   - Parameters (may include dataset URLs)
   - Resource requirements
4. Backend creates the `ProcessVersion` record in `queued` state and returns immediately
   (`Process.create_queued`, `backend/models/process.py`) with the process ID — state and
   outputs are not included yet; the frontend polls/subscribes for updates.
5. A background task (`ProcessVersion.run_task`) then, asynchronously:
   - Runs the pluggable `job_pre_run` hook (e.g. the billing plugin's balance check — see
     "Plugin & Hook System" below; without that plugin this is a no-op)
   - Resolves dependencies and storage/registry credentials
   - Creates the Kubernetes Job with its Kueue queue-name label
   - Updates `ProcessVersion.state` and broadcasts progress over WebSocket

### Process Cancellation
1. User clicks "Cancel" in ProcessEditor (visible only for queued/running versions)
2. POST to `/projects/{project_id}/process/{id}/versions/{version}/cancel`
3. Backend:
   - Verifies version is in `queued` or `running` state (returns 409 otherwise)
   - Deletes the Kubernetes Job if one was submitted
   - Adds a log entry "Process cancelled by user"
   - Marks version as `failed` and broadcasts state update via WebSocket

### Process Execution
1. Kueue admits Job when resources available
2. Kubernetes creates Pod
3. Pod container runs `runner.py`:
   - Loads process type class via entrypoints
   - Deserializes parameters
   - Calls `process_class.run(storage_context, **params)`
   - Writes outputs to storage
   - Reports results to backend
4. Backend:
   - Collects logs from pod
   - Updates ProcessVersion state (`done` or `failed`)
   - Creates Dataset records for outputs
   - Runs the pluggable `job_completed` hook (e.g. the billing plugin calculates actual cost
     and settles the HOLD; without that plugin this is a no-op)

### Dataset Access
1. Frontend requests dataset: GET `/projects/{project_id}/dataset/{id}`
2. Backend:
   - Looks up dataset metadata (storage URL, mime type)
   - Verifies user has access to the project (real membership, or a read-only publication —
     see `docs/plans/done/publication-readonly-projects.md`)
   - Fetches data from storage (S3/GCS/MinIO)
   - Returns data with appropriate content-type
3. Frontend consumes dataset (plots, downloads, etc.)

### Real-time Updates
1. Backend monitors pod logs via Kubernetes API
2. New log lines:
   - Stored in ProcessLog table
   - Broadcast to WebSocket clients
3. State changes:
   - ProcessVersion.state updated
   - Broadcast to WebSocket clients
4. Frontend:
   - ProcessLog widget displays logs
   - FlowView updates process node status
   - ProcessEditor shows current state

## Security Model

### Authentication
- JWT tokens for user sessions
- Project-scoped API keys (`backend/models/api_key.py`) for programmatic/MCP access
- Short-lived upload tokens for direct file uploads
- Anonymous, capability-scoped publication links for read-only project access
- Secrets stored in environment variables
- Single shared database — isolation is row-level, enforced per-request via `ProjectMember`
  membership checks and `Publication` capability links, not physical per-user database
  separation

### Storage Access Control
- Per-project buckets via a pluggable `StorageBackend`/`StorageProtocolHandler` system
  (protocols include `s3`, `gcs`, `az`, `file` — see [Storage Architecture](storage.md))
- IAM policies with path-based conditions (where the underlying protocol supports them)
- Process pods get scoped credentials:
  - READ: All uploads and datasets in project
  - WRITE: Only to own process directory
- No cross-project access
- See [Storage Architecture](storage.md) for details

### Network Policies
Future enhancement: Pod network isolation

## Monitoring and Observability

### Current Implementation
- Real-time log streaming to UI
- Process state tracking (`queued`, `running`, `done`, `failed`)
- Job events from Kubernetes API

### Future Enhancements
- Prometheus metrics collection
- CPU/memory usage tracking
- Grafana dashboards
- Alert notifications
- Performance profiling

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
- **Datasets**: Output files from process execution, stored in per-project S3/GCS buckets, can be used as inputs to other processes

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
- **REST API**: Process creation, dataset retrieval, process type schemas
- **WebSocket endpoints**: Real-time log streaming and state updates
- **Authentication**: JWT-based user authentication
- **Database**: SQLite (development) / PostgreSQL (production) with Alembic migrations

### Kubernetes Client
- Kubernetes API integration for job management
- Creates and monitors Jobs in the `nagelfluh-jobs` namespace
- Handles job lifecycle and cleanup (TTL 1 hour after completion)

### Job Orchestrator
- Creates Kubernetes Job manifests with:
  - Resource limits (CPU, memory, ephemeral storage)
  - Deadline enforcement
  - Kueue annotations for queuing
  - Storage credentials via Kubernetes secrets
  - A per-Job, ephemeral image-pull Secret (minted fresh from the active registry backend's
    credential, owned by the Job for automatic garbage collection — see
    [Registry Architecture](registry.md))
  - Environment variables for process configuration

### Pluggable Backends

Three axes of the system are pluggable, each following the same shape (a discriminator column on
a DB row dispatching to a handler/provider class, discovered via a `nagelfluh.hooks` fan-out
entry point — no "core is special" path):

| Axis | Model | Handler ABC | Docs |
|---|---|---|---|
| Object storage | `StorageBackend` (one per project) | `StorageProtocolHandler` | [Storage Architecture](storage.md) |
| Job-running cluster | `Cluster` (one per process, selectable) | `ClusterProvider` | this document, "Kubernetes Resources" below |
| Container registry | `RegistryBackend` (one, app-wide) | `RegistryProtocolHandler` | [Registry Architecture](registry.md) |

All three also share a `bootstrap(config) -> config` hook, used by `config.env`-driven, opt-in
live provisioning (`backend/bin/nagelfluh-bootstrap-provision`) — see
[Registry Architecture § Configuration](registry.md#configuration) for the full mechanism.

### Log Collector
- Streams pod logs to ProcessLog database table
- Broadcasts logs to connected WebSocket clients
- Real-time updates for process state changes
- Persistent log storage for historical viewing

### Database Schema
- **Users**: Authentication and billing
- **Projects**: Multi-tenant project isolation
- **Processes**: Process definitions with versioning
- **ProcessVersions**: Parameter snapshots, outputs, state
- **ProcessLogs**: Timestamped log entries
- **Datasets**: Dataset metadata and references
- **Uploads**: User-uploaded files
- **Transactions**: Billing history (HOLD, DEBIT, RELEASE)

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

#### MapView
Geographic visualization of survey data with interactive features.

### WebSocket Clients
- **Log streaming**: Real-time process logs
- **State updates**: Process state changes (running, completed, failed)
- Automatic reconnection on disconnect
- Multiplexed updates for multiple processes

## Kubernetes Resources

### Namespace
- **Name**: `nagelfluh-jobs`
- **Purpose**: Isolated environment for process execution
- **Resources**: Jobs, Pods, Secrets, ConfigMaps

### Kueue Configuration
- **Local queue**: `nagelfluh-queue` (namespace-scoped)
- **Cluster queue**: `nagelfluh-cluster-queue` (cluster-wide resource management)
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
GCP-plugin-specific GKE setup script). `plugins/ymerflow-minikube`'s provision-nagelfluh-jobs.sh now only creates the
jobs namespace — everything else moved into the Python routine above.

### Job Structure
Each process creates a Kubernetes Job with:
- **Name**: `process-{process_id}-v{version}`
- **Labels**: `nagelfluh.app=process`, `process-id={id}`, `version={v}`
- **Annotations**: Kueue queue-name
- **Resource requests/limits**: User-specified CPU/memory
- **Deadline**: `activeDeadlineSeconds` for timeout enforcement
- **Backoff limit**: 0 (no automatic retries)
- **TTL**: 3600 seconds (1 hour cleanup after completion)

### Pod Configuration
- **Image**: `nagelfluh-base-runner:latest` (or environment-specific image)
- **Environment variables**:
  - `PROCESS_TYPE`: Type of process to run
  - `PROCESS_ID`: Unique process identifier
  - `VERSION`: Process version number
  - `PROJECT_ID`: Project identifier for multi-tenancy
  - `PARAMETERS_JSON`: Serialized process parameters
  - `BACKEND_URL`: Backend API endpoint
  - `STORAGE_BASE`: S3/GCS bucket path
  - `STORAGE_ENDPOINT`: MinIO endpoint (development only)
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: From Kubernetes secret
- **Restart policy**: Never (controlled by Kueue)

## Data Flow

### Process Creation
1. User fills form in ProcessEditor
2. Frontend validates parameters against JSON Schema
3. POST to `/process` with:
   - Process type
   - Parameters (may include dataset URLs)
   - Resource requirements
4. Backend:
   - Checks user balance vs. estimated cost
   - Creates HOLD transaction
   - Creates ProcessVersion record
   - Creates Kubernetes Job with Kueue annotations
   - Returns process ID

### Process Cancellation
1. User clicks "Cancel" in ProcessEditor (visible only for queued/running versions)
2. POST to `/process/{id}/versions/{version}/cancel`
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
   - Updates ProcessVersion state
   - Creates Dataset records for outputs
   - Calculates actual cost
   - Creates DEBIT and RELEASE transactions

### Dataset Access
1. Frontend requests dataset: GET `/dataset/{id}`
2. Backend:
   - Looks up dataset metadata (storage URL, mime type)
   - Verifies user has access to parent project
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
- Secrets stored in environment variables
- Per-user database isolation

### Storage Access Control
- Per-project S3/GCS buckets
- IAM policies with path-based conditions
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
- Process state tracking (pending, running, completed, failed)
- Job events from Kubernetes API

### Future Enhancements
- Prometheus metrics collection
- CPU/memory usage tracking
- Grafana dashboards
- Alert notifications
- Performance profiling

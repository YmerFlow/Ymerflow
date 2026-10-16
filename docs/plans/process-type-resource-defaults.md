# Plan: resource defaults per process type

Ticket: https://github.com/YmerFlow/Ymerflow/issues/116

## Goal

A new process opens with CPU, memory, disk and deadline suited to its type, instead of the same 1 CPU, 2 GB, 10 GB disk and 60 minutes for everything. A user who picks `create_environment` gets resources a build actually finishes with; a user who picks an import gets small ones. Disk becomes settable in the web interface.

## Background: current state

- **One set of defaults for every type.** The process editor starts every new process at 1 CPU, 2 GB memory and 60 minutes (`frontend/src/widgets/ProcessEditor.jsx`, the `useState` initial values and the reset on "Process > Create"). The backend applies the same values when an API call omits them (`backend/models/process.py`, `resource_requests` default `{"cpu": "1000m", "memory": "2Gi", "ephemeral-storage": "10Gi"}`, `deadline_seconds` 3600). Re-running an existing version keeps that version's values.
- **Disk is not in the interface.** The resource dialog has cluster, CPU, memory and deadline. Every submission from the editor sends `"ephemeral-storage": "10Gi"`; only the API can ask for more.
- **The defaults fail for heavy types, and the failures are hard to read.** An environment build (`create_environment`) compiles `pyinterp` from source: at 8 GB memory it is killed, and the log says only `Kaniko build failed with exit code -9`. The builds that succeeded used 4 CPU, 24 GB memory and 30 GB disk, and took 13 to 14 minutes. A first-time user has no way to know any of this from the form.
- **Schemas already carry extensions.** Process type schemas are extracted from the image at build time and served per type (`docs/architecture/environment.md`); the frontend already reads custom keys such as `x-format`, and `inversion-smart-defaults-and-simple-ui.md` proposes `x-display-group`.

## Design

### A process type declares its resources in its schema

A top-level `x-resources` key in the schema `schema()` returns, in the units the resource dialog shows:

```json
"x-resources": {"cpu_cores": 4, "memory_gb": 24, "disk_gb": 30, "deadline_minutes": 120}
```

The backend converts to its own form (`"cpu": "4"`, `"memory": "24Gi"`, `"ephemeral-storage": "30Gi"`, `deadline_seconds`) where it applies them.

Every key is optional; a missing key falls back to today's default. Because it lives in the schema, it travels with the image and the environment, with no database change and no new endpoint: an environment built from a newer package gets the newer values.

### The editor prefills from it

When the user picks a process type for a **new** process, the editor sets CPU, memory, disk and deadline from that type's `x-resources`, clamped to the selected cluster's single-node capacity the way a cluster change already clamps them. Picking a different type re-applies that type's values, even if the user had edited them: types differ by an order of magnitude, and a predictable reset beats a stale value. Re-running an existing version keeps that version's resources, as today. The user can still change everything in the resource dialog.

### The backend falls back to it

When a submission omits `resource_requests` or `deadline_seconds` (an API or MCP call), the backend uses the process type's `x-resources` from the environment's stored schemas, then today's defaults. Submit-time validation against the cluster is unchanged.

### Disk in the resource dialog

The resource dialog gains **Disk (GB)**, and the summary card shows it. The editor sends it as `ephemeral-storage` instead of the fixed `10Gi`.

### Initial values

Measured where possible; a type with no measurement declares nothing and keeps today's defaults.

| process type | package | `x-resources` | from |
|---|---|---|---|
| `create_environment` | Ymerflow-process-sdk | 4 cores, 24 GB, 30 GB disk, 120 min | builds of 13 to 14 minutes at 4 cores / 24 GB / 30 GB; killed at 8 GB |
| `invert_tem` | aem-processes | from the measured runs in the demo-data tutorial "Sizing a job so it finishes" | that tutorial's tables |
| `yf_process_tem`, `yf_qc_tem` | aem-processes | set after the first runs on a delivered survey | first runs |
| everything else | | none | today's defaults |

Whether 10 GB disk is enough for a build is not yet known (both successful builds asked for 30 GB); one build at 10 GB settles it before `create_environment`'s value is fixed.

## Implementation steps

1. Backend: read `x-resources` from the environment's stored schema for the submitted type when resources or deadline are omitted, and convert to the backend's units. Test: a submission without resources gets the type's values; one with resources keeps its own.
2. Frontend: prefill from `x-resources` on type selection for new processes, clamp to the cluster, add Disk (GB) to the dialog and the summary card, send it as `ephemeral-storage`.
3. Process SDK: `create_environment` declares its `x-resources`.
4. aem-processes: `invert_tem` and the YF-pro types declare theirs once measured.
5. Docs: `docs/architecture/processes.md` documents `x-resources` with the other schema extensions; the environment-build tutorial says the build form now opens with working resources.

## Out of scope

- Sizing from the input (number of soundings, layers): a later step, which `x-resources` does not prevent. Inversion sizing in particular depends on the dataset.
- Per-project or per-user overrides.
- Cluster-specific values: clamping to the cluster's capacity is enough for now.

## Decisions (2026-10-16)

1. **Units:** the editor's (`cpu_cores`, `memory_gb`, `disk_gb`, `deadline_minutes`), easier to write in a schema; the backend converts.
2. **Fallback:** the backend applies a type's `x-resources` to API and MCP submissions that omit resources, so scripted and agent submissions get working values too.
3. **Type change:** picking a different type re-applies that type's values, even after the user edited them.

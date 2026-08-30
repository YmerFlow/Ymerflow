# MCP terse process tools (caller-aware verbosity)

## Problem

The MCP server (`FastApiMCP`, mounted in `backend/main.py`) re-exposes REST
endpoints 1:1 as MCP tools — an MCP tool's output *is* the endpoint's JSON
response. Those endpoints were shaped for the **frontend**, which legitimately
needs everything at once (FlowView renders positions + all versions + all
parameters). MCP tools inherit that frontend-shaped payload.

Concretely, `list_processes` on a real project returned **453 KB / 13,871 lines**
for 51 processes. `Process.to_dict()` serializes a `versions[]` array (one
process had 29 versions), and `ProcessVersion.to_dict()`
(`backend/models/process.py:380`) emits the full `parameters`, `outputs`,
`dependencies`, `resource_requests`, `environment`, `tags`, and timestamps for
**every** version. This overflows an LLM context window before it can be read.

There is no way for an LLM to list processes, then drill into one process, then
into one version — every list call pays for the entire project's parameter dump.

## Design constraints (decided with the user)

1. **One endpoint per shape, shared by both callers.** Do NOT create an
   MCP-only response surface. Endpoints take a `verbose` query param that
   **defaults to `false` (terse)**; the frontend explicitly passes
   `verbose=true` to get today's full behavior. The `verbose` param is **hidden
   from the OpenAPI schema** (`include_in_schema=False`), so the MCP tool schema
   never shows it to the LLM — the LLM cannot set it and always gets the terse
   default. This needs no MCP-caller detection and no custom httpx client.
2. **Tools map 1:1 to real, published REST endpoints.** We are only *adding
   endpoints* (which become new tools) and *changing defaults* between the two
   ways of calling the same endpoint. No tool may have a response shape that no
   REST endpoint produces.
3. **Clean `operation_id`s.** Every MCP-exposed endpoint gets an explicit
   `operation_id` so tool names are clean (`list_processes`, not
   `list_processes_projects__project_id__processes_get`). This also fixes the
   existing drift where the MCP `description` already refers to tools by clean
   names that don't exist yet (`get_environment_process_type`,
   `describe_dataset`).

### Explicitly OUT of scope (not selected)

- Resolving `outputs` URLs to directly-usable file URLs (the get_dataset
  translation dance stays as documented).
- Trimming the tool surface (workspaces / publications / fork stay).
- Pagination / search on `list_processes`.

These can be follow-up plans.

## Mechanism: hidden `verbose` query param

`fastapi_mcp` 0.4.0 builds each tool's input schema from the endpoint's
**OpenAPI operation parameters**. A FastAPI `Query(..., include_in_schema=False)`
param is fully functional at the HTTP level but is **omitted from the generated
OpenAPI schema** — so fastapi_mcp never sees it and never surfaces it to the LLM.

Every affected endpoint gains:

```python
from fastapi import Query

async def list_processes(
    ...,
    verbose: bool = Query(False, include_in_schema=False),
):
    # verbosity lives in to_dict(), not in the handler — see Serialization below
    return [p.to_dict(verbose=verbose) for p in processes]
```

- **Default is terse** for everyone who doesn't pass `verbose=true` (MCP, curl).
- **Frontend opts in** by appending `?verbose=true` to its calls (see below).
- The MCP tool schema omits `verbose` entirely, so the LLM cannot toggle it and
  always receives the terse default.

No custom `http_client`, no marker header, no MCP-caller detection, no extra
service module. This is the "changing defaults between the two ways of calling"
the user specified, implemented purely via a hidden param default.

### Frontend opt-in

The one consumer that needs full payloads is the frontend. Update its API layer
to pass `verbose=true` on the affected calls:

- `frontend/src/datamodel/api.js` — `getProcesses()` (`/processes`) and
  `getProcess()` (`/process/{id}`, line ~575) append `verbose=true`.

Any other frontend caller of these endpoints must be found and updated too
(grep for the paths) — a missed caller silently gets the terse shape and breaks.

## Endpoint / tool changes

### Existing endpoints — add hidden `verbose` param (default terse)

- `GET /projects/{project_id}/processes` — `operation_id="list_processes"`
  - `verbose=true` (frontend): unchanged — `[Process.to_dict()]` with full versions.
  - default (MCP/terse): `[{id, name, type, latest_version, latest_state,
    n_versions}]`. `type`/`state` read from `versions[-1]` (per-version fields).
    ~1 short row per process instead of the full version dump.

- `GET /projects/{project_id}/process/{process_id}` — `operation_id="get_process"`
  - `verbose=true` (frontend): unchanged — full `Process.to_dict()`.
  - default (MCP/terse): process overview **including its version summary rows** —
    `{id, name, type, latest_version, latest_state, versions: [{version, type,
    state, started_at, completed_at, run_length, has_outputs}]}`. No
    `parameters`. This is the single "list the versions of one process" tool
    (there is no separate `list_process_versions` — decided they are the same
    thing, so `get_process` is the one name).

### New endpoints (become new tools automatically — they inherit the
`Processes` tag on the router)

- `GET /projects/{project_id}/process/{process_id}/version`
  — `operation_id="get_process_version"`
  Full detail for **one** version *except* outputs: `{version, type, state,
  parameters, dependencies, resource_requests, deadline_seconds, environment,
  cluster, started_at, completed_at, run_length}`.
  `version` is an **optional query param** (`version: Optional[int] = None`);
  when omitted it resolves to `max(v.version)` for the process (latest). A query
  param is used rather than a path param specifically so it can default — and it
  shows in the MCP tool schema as optional. (This differs from the existing
  `clone`/`cancel` endpoints, which use a required `/versions/{version}` path
  param because a write must target an explicit version.)

- `GET /projects/{project_id}/process/{process_id}/version/outputs`
  — `operation_id="get_process_version_outputs"`
  Just the outputs for one version: `{version, state, outputs}` where `outputs`
  is the current `{name: /projects/{id}/dataset/{id} URL}` map (URL resolution
  is out of scope). Same optional `version` query param defaulting to latest.
  Naming is deliberately parallel to `get_process_version`.

Note the deliberate path split: writes act on a specific version via the
existing `/process/{id}/versions/{version}/...` path scheme (`clone`, `cancel`
— `backend/routers/processes.py:247,337`), while these two new reads use
`/process/{id}/version` with an optional `?version=` query param so it can
default to latest.

### Serialization

Thread `verbose` **through the existing `to_dict()` methods** rather than adding
parallel `to_summary_dict()` handlers and branching in the router — the handler
just forwards the flag:

- `Process.to_dict(verbose=False)` — when `verbose` (frontend), current full
  behavior: `versions: [v.to_dict(project_id, verbose=True)]`. When terse
  (default): the list-row shape `{id, name, type, latest_version, latest_state,
  n_versions}`; and for the single-process `get_process` case, the process
  overview with `versions: [v.to_dict(project_id, verbose=False)]` (version
  rows). (`Process.to_dict` gains the `verbose` param; the router passes it
  straight through.)
- `ProcessVersion.to_dict(project_id, verbose=False)` — `verbose`: current full
  dict (unchanged). Terse: the version-row shape `{version, type, state,
  started_at, completed_at, run_length, has_outputs}` (no `parameters`,
  `outputs`, `dependencies`, `resource_requests`, `environment`, `cluster`,
  `tags`).
- The two new detail endpoints need shapes that aren't just "the version dict":
  - `get_process_version` → full-version-minus-outputs. Add a dedicated method
    (e.g. `ProcessVersion.to_detail_dict(project_id)`) that reuses the full
    `to_dict` body minus the `outputs` key.
  - `get_process_version_outputs` → `{version, state, outputs}`. Factor the
    `datasets` → URL map (currently inline in `to_dict`,
    `backend/models/process.py:371`) into a small helper reused by both
    `to_dict` and this endpoint.

The `verbose=True` paths reproduce today's exact output, so the REST/frontend
contract is unchanged.

## Operation_id cleanup (whole MCP surface)

Set explicit `operation_id` on every endpoint currently exposed via
`include_tags` so all tool names are clean and stable. Audit the current MCP
`description` in `backend/main.py` against the resulting names and fix drift
(`get_environment_process_type`, `describe_dataset` vs `get_dataset`, etc.).
Renaming tools is intended — the description already references the clean names.

> NOTE: renaming `operation_id`s changes tool names for existing MCP clients.
> This is desired and coordinated with the description update, but call it out
> in the changelog / commit.

## Description update

Rewrite the MCP `description` workflow to reference the new drill-down flow:
`list_processes` → `get_process` (process + its version rows) →
`get_process_version` / `get_process_version_outputs` (default to latest), and
the clean tool names.

## Files touched

- `backend/main.py` — updated MCP `description` only (no tag/client changes).
- `backend/routers/processes.py` — hidden `verbose` param on `list_processes`
  and `get_process`; three new endpoints; explicit `operation_id`s.
- `backend/models/process.py` — add `verbose` param to `Process.to_dict` and
  `ProcessVersion.to_dict`; add `ProcessVersion.to_detail_dict`; factor the
  outputs (datasets→URL) map into a reusable helper.
- `frontend/src/datamodel/api.js` — pass `verbose=true` on `getProcesses` /
  `getProcess` (and any other caller of these paths found by grep).
- Other routers (datasets, environments, uploads, workspaces, utilities,
  publications) — explicit `operation_id` only (mechanical, for clean names).

## Testing / verification

- Live MCP: `list_processes` returns ~51 short rows (was 13,871 lines);
  `get_process` on the 29-version process returns the process + 29 version rows
  without parameters; `get_process_version` (no `version`) returns the latest
  version's params; `get_process_version_outputs` returns just outputs. Confirm
  the MCP tool schema for `list_processes`/`get_process` does **not** list a
  `verbose` parameter, and that `get_process_version` lists `version` as
  optional.
- REST/frontend: `GET /processes?verbose=true` still returns the full dump and
  FlowView still works; `GET /processes` (no param) returns the terse shape.

## Resolved design decisions

- `get_process` and `list_process_versions` are the same thing → one tool,
  `get_process`, returning the process plus its version-summary rows.
- `version` on the detail/outputs tools is an optional query param defaulting to
  the latest (max) version.
- Param name is `verbose` (hidden from the MCP schema, default `false`).

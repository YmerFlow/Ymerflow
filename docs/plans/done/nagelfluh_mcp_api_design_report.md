# YmerFlow MCP API Design Analysis

**Date:** 2026-06-06  
**Based on:** Analysis of 131 Claude Code session transcripts across 7 project directories

---

## Executive Summary

Across sessions involving the YmerFlow platform, a recurring pattern emerged: the MCP tools as implemented cause severe over-fetching, returning responses that overflow the LLM context window. The result is that users routinely fall back to copy-pasting browser content, SSH-ing into production servers, and using `curl` directly against the REST API — despite MCP tools existing for the relevant operations.

The core problem is a mismatch between what the tools return and what an agent can use in a single context window. Process status and log fetching tools exist (`list_processes` exposes `versions[].state`; `get_process_logs` accepts a `version` filter), but an agent cannot get a process's status without downloading all processes with all their logs embedded — making the nominally-available features effectively unusable due to response size.

The MCP was auto-generated from the FastAPI OpenAPI spec via `fastapi-mcp`, inheriting the REST API's data model without adaptation for LLM context constraints or agentic workflows.

---

## Design Problems Found

### 1. `list_processes` Embeds Full Logs in Every Response

**Observed impact:** A call returning 2 processes and 3 process versions produced a 73,517-character response. Of this, 51,905 characters (95%) were 413 Kubernetes/pod event log entries across the three versions. The response overflowed context and had to be saved to disk; subsequent queries used `grep` on the saved file rather than re-calling the MCP tool.

**What triggered it:** The user simply wanted to know which processes existed and what parameters they were run with.

**Root cause:** `GET /processes` embeds `process.versions[].logs[]` in the list response. There is no `?include_logs=false` or `?fields=` projection parameter, and no pagination.

**Cost:** 2 sub-agent spawns (~104k tokens total) to retrieve approximately 2KB of actually useful data.

---

### 2. No Way to Fetch a Single Process Type's Schema

**Observed impact:** A call for environment info returned 260,405 characters (4,690 lines) for a single environment with 11 process types. The user wanted the schema for `import_skytem`, which is 1,023 characters. The response was 254× larger than the requested data; the full list of process type names alone would be 276 characters — making the actual over-fetch ratio 504×.

**Data model note:** Process type schemas being per-environment is correct by design — different environments (Docker images) expose different process types with different schemas. This cannot and should not change. The problem is access granularity: there is no way to retrieve a single process type's schema without fetching all schemas for that environment.

**Current endpoints:**
- `list_environments` — returns all environments with all process type schemas embedded
- `get_environment_process_types(env_id)` — returns all process types for one environment, still with all schemas

**Missing endpoints:**
- List process type *names* for an environment (no schemas) — so an agent can discover what types exist cheaply
- Get schema for *one specific* process type in an environment — so an agent can fetch only what it needs

**Pattern:** Sub-agent must chunk-read the saved response file in 200-line windows to find the relevant section.

---

### 3. Process Status and Logs Are Technically Available But Structurally Inaccessible

**What the MCP provides:**
- `list_processes` returns `versions[].state` (`queued | running | done | failed`) — status is present
- `get_process_logs(process_id, version)` retrieves logs for a specific version — log access is present

**Observed impact:** Despite these tools existing, 12 sessions saw users copy-paste logs from the browser UI, and 9 sessions saw users SSH into the production server to run `kubectl`. The tools were either unknown to users in those sessions or, more significantly, *using them required first successfully calling `list_processes`* — which overflows context and forces a workaround before the user can even get a process ID into the agent's working memory.

**The structural trap:** To check whether a specific process finished, an agent must call `list_processes`, receive a 73KB response it cannot hold in context, save it to disk, grep for the process ID, and extract the state field. The status information is present in the data model but the only retrieval path is through a response too large to use. The `list_processes` tool description itself acknowledges this: *"There is no single-process GET endpoint — use this endpoint and filter by id client-side."*

**Remaining gaps even with the tools:**
- `get_process_logs` returns all log entries at once — no `tail` or pagination parameter. For a long inversion job with thousands of log lines, this is also a context overflow risk.
- No live streaming or incremental log access while a job runs.
- One user explicitly asked: *"Is there any way to get progress during each interpolation?"* — the answer is technically yes but practically no.

---

### 4. No Single-Process Lookup — Confirmed by Design

**Observed impact:** Every subsequent question about a specific process required re-calling `list_processes` (73KB) or grepping the cached file on disk.

**Confirmed by tool description:** The `list_processes` tool explicitly documents: *"There is no single-process GET endpoint — use this endpoint and filter by id client-side."* This is a deliberate design choice in the FastAPI backend, not an MCP exposure gap. An agent that knows a process ID (from a prior `create_process` call) must pay the full cost of fetching all processes every time it wants to check that one process's state.

---

### 5. Process Schema "system" Parameter Is an Inline 30–44KB Discriminated Union

**Observed impact:** Even if `list_environments` were split into a per-process-type call, the `invert_tem.system` parameter schema alone is 43,797 characters. An agent trying to understand "what parameters does inversion take?" would have its context dominated by an exhaustive schema for every supported instrument geometry variant.

**Root cause:** The JSON Schema for the `system` parameter embeds the full configuration for all supported instrument systems in one `anyOf`. From the agent's perspective, this is unusable inline — the structure it needs to understand is lost in noise.

---

### 6. No Dataset Summary / Describe Endpoint

**Observed impact:** To inspect what a dataset contains, a user had to: (a) try to download the raw msgpack file via curl (failed due to auth complexity), (b) manually download it from the browser and place it on disk, then (c) use local Python with `libaarhusxyz` to inspect column names and value ranges. The MCP's `get_dataset_data` and `get_dataset_geography` endpoints return raw data — potentially large — with no lightweight summary or statistics operation.

---

### 8. Tool Names Are Verbose and Require Deferred Loading

**Observed impact:** Names like `mcp__nagelfluh__get_environment_process_types_environments__env_id__process_types_get` (80 characters) are generated verbatim from REST API path patterns. Every new session requires a `ToolSearch` call before the first MCP call, adding a round trip. The verbosity also makes tool selection harder for the model.

**Root cause:** `fastapi-mcp` auto-generates tool names from HTTP method + URL path. The names encode implementation details (HTTP verb, URL parameter position) rather than user intent.

---

### 9. No Process Version Comparison or Cloning

**Observed impact:** The intended agentic workflow — run inversion, inspect result, adjust parameters, re-run — requires creating a new process version with modified parameters. The agent must re-specify all parameters from scratch; there is no "clone this version with these overrides" operation. Comparing parameters between two versions also requires fetching both full process records.

---

### 10. Import → Run → Wait Workflow Has No Atomic Path

**Observed impact:** Three sessions where users asked Claude to "import data and run inversion" resulted in the spawned sub-agent building extensive infrastructure (new environments, storage setup, custom scripts). Users rejected all three attempts with frustration. The sub-agent over-complicated the task because the sequence — upload file, create dataset, start process, wait for completion — spans 4+ separate API calls with no single "run this workflow" convenience endpoint.

---

## Summary of Observed Workarounds

| Workaround | Session Count | Missing API Capability |
|---|---|---|
| Copy-paste K8s logs from browser | 12 | `get_process_logs` exists but requires navigating `list_processes` first; MCP not connected in many sessions |
| SSH into server to run `kubectl` | 9 | No live log streaming; logs may be lost if pod dies before backend captures them |
| `grep` cached MCP response file on disk | 1 (multiple greps) | No single-process GET; `list_processes` embeds logs making it too large to re-call |
| Sub-agent to chunk-read oversized response | 2 sub-agents in 1 session | `list_processes` log embedding (73KB); no per-type schema endpoint |
| `curl` against REST API with manual auth | 7 sessions, 44+ calls | MCP not configured in those sessions; per-type schema endpoint missing |
| Download dataset to disk for local inspection | 1 | No dataset describe/statistics endpoint |
| Local Python (`libaarhusxyz`) for analysis | 3+ | Data not yet imported to platform; import workflow requires multiple steps |
| User rejected sub-agent for import+run | 3 | No single import-run-wait convenience tool |

---

## Recommendations

### High Priority (Context Overflow and Core Workflow)

**R1. Make `logs` opt-in in `list_processes` — add `?include_logs=false` default**

The `list_processes` response embeds full log arrays in every version entry. The tool description itself notes logs are "also available via `get_process_logs`" — yet they are included unconditionally. Adding `?include_logs=false` as the default (or stripping logs from the list response entirely since `get_process_logs` exists) would reduce the observed 73KB response to ~2KB. This is the single highest-impact change.

**R2. Add `GET /processes/{process_id}` to the FastAPI backend and expose it in MCP**

The `list_processes` tool explicitly documents: *"There is no single-process GET endpoint."* This should be added to the backend. An agent that has a process ID from a prior `create_process` call should not pay the cost of fetching all processes to check one. The MCP tool description could then be simplified: instead of "filter by id client-side," agents call `get_process(process_id)`.

**R3. Add two finer-grained process type endpoints**

The per-environment data model is correct — different environments expose different process types. The problem is that there is no way to access them at a finer grain than "all types in an environment." Two additions fix this:

- `GET /environments/{env_id}/process-types` returning only names (no schemas) — an agent can discover what types exist without fetching any schema
- `GET /environments/{env_id}/process-types/{type_name}` returning the schema for exactly one type — an agent can fetch `import_skytem` (1KB) without downloading `invert_tem` (44KB) and the other 10 types

The `list_environments` tool description notes that process type schemas are "already included" to save an extra call — this is fine for a human-facing client but harmful for an agent context window. These two endpoints do not change the data model; they expose the existing per-environment-per-type structure at a useful granularity.

**R4. Add `tail` and `offset` parameters to `get_process_logs`**

`get_process_logs` exists and accepts a `version` filter, but returns all log entries at once. For a long inversion job this can itself overflow context. Adding `?tail=N` (last N lines) and `?offset=M&limit=N` (pagination) makes the tool usable throughout a job's lifetime, not just after it completes cleanly with a short log.

---

### Medium Priority (Usability and Agent Workflow)

**R5. Add `GET /datasets/{dataset_id}/describe`**

Returns compact dataset metadata: number of records, column names, value ranges, spatial bounding box, time range. The current `get_dataset_data` and `get_dataset_geography` endpoints return raw data — an agent needs a summary to decide whether to fetch the full data or which columns to request.

**R6. Add `POST /processes/{process_id}/versions/{version}/clone`**

Creates a new version of an existing process, copying all parameters, with an optional `parameter_overrides` body. This directly enables the iterative "adjust parameters, re-run" workflow that the platform is designed for.

**R7. Rename MCP tools to intent-based names**

Replace auto-generated names with short, intent-based names:

| Current | Suggested |
|---|---|
| `mcp__nagelfluh__list_processes_processes_get` | `list_processes` |
| `mcp__nagelfluh__list_environments_environments_get` | `list_environments` |
| `mcp__nagelfluh__get_environment_process_types_environments__env_id__process_types_get` | `get_process_type_schema` |
| `mcp__nagelfluh__get_process_logs_process__process_id__logs_get` | `get_process_logs` |
| `mcp__nagelfluh__create_process_process_post` | `create_process` |
| `mcp__nagelfluh__get_dataset_dataset__dataset_id__get` | `get_dataset` |
| `mcp__nagelfluh__search_datasets_datasets_get` | `search_datasets` |

This also eliminates the need for deferred tool schema loading in most sessions.

---

### Lower Priority (Convenience and Polish)

**R8. Add `run_workflow` convenience tool**

A single tool that: uploads a file, creates a dataset, starts a named process type with given parameters, and returns a process ID. The agent can then poll with `list_processes(project_id=...)` filtered to that ID. Eliminates the multi-step import+create sequence that caused sub-agent rejection in 3 sessions.

**R9. No need to break process type schemas into smaller pieces**

The largest individual schemas (`invert_tem`, `forward_tem`, `process_tem`) are ~44KB / ~11K tokens — 5.5% of a 200K context window. Once fetched via `get_process_type_schema`, the full schema is usable inline; no recursive exploration tool or `$ref`-based breakdown is needed. The `system` parameter's `anyOf` discriminated union is large but an LLM can navigate it to find the relevant instrument variant. The schema size was only a problem when all 11 types were returned together (260KB); per-type fetching resolves it entirely.

**R10. Add a version-summary field to `list_processes` (or `get_process`)**

The current version entries embed full parameter objects and log arrays. For iteration history — "show me the parameters of each run" — an agent only needs version number, state, created_at, and a parameter hash or diff. A `?summary=true` mode (or stripping logs as in R1) would serve this without a new endpoint.

---

## Ideal Tool Structure for LLM Performance

Given the existing data model (environments own process types; processes own versions with logs, parameters, and outputs; datasets are independent resources), the following tool structure minimises context usage while keeping the number of round trips reasonable.

The governing principle is a **two-level access pattern**: list operations return only enough to identify and select a resource; full data is fetched per-resource via a separate call. Nothing is eagerly embedded unless it is always small and always needed.

### Level 1 — Discovery (always cheap, returns IDs and names only)

| Tool | Returns | Notes |
|---|---|---|
| `list_projects()` | `[{id, name}]` | No members, no storage info |
| `list_environments()` | `[{id, name, process_types: [name, ...]}]` | Type **names** embedded — not schemas. One call reveals all available process types across all environments without fetching any schema. |
| `list_processes(project_id?)` | `[{id, name, type, env_id, version_count, latest_state, latest_version}]` | No logs, no parameters, no outputs |
| `list_datasets(project_id?, process_id?)` | `[{id, name, mime_type, created_at}]` | No URLs, no parts |

Embedding type names (not schemas) in `list_environments` is the right trade-off: the names are always small regardless of how complex the schemas are, and knowing which types exist in which environment is prerequisite to any subsequent schema fetch. This avoids a redundant `list_process_types(env_id)` call while keeping the response bounded.

These responses stay small regardless of how many versions a process has run, how large its logs are, or how many instrument configurations a process type supports.

### Level 2 — Single-resource detail (one round trip per resource of interest)

| Tool | Returns | Notes |
|---|---|---|
| `get_process(process_id)` | `{id, name, type, versions: [{version, state, created_at, parameters, outputs: {name → dataset_id}}]}` | No logs — fetched separately; outputs as dataset IDs not URLs |
| `get_process_type_schema(env_id, type_name)` | Full JSON Schema for that one type | Per-environment-per-type matches the data model exactly; `env_id` + `type_name` together identify a schema uniquely. Even the largest schemas (~44KB, ~11K tokens) are well within a 200K context window at 5.5% — no recursive exploration or further breakdown needed. |
| `get_dataset(dataset_id)` | `{id, url, mime_type, parts, produced_by: {process_id, version}}` | Existing tool; already correct |

### Level 3 — Sub-resource / paginated (for large data within a resource)

| Tool | Parameters | Returns |
|---|---|---|
| `get_process_logs(process_id, version)` | Add `tail=N` and `offset+limit` | Log entries, paginated |
| `get_dataset_data(dataset_id)` | Existing; add `columns`, `offset`, `limit` | Row data, column-filtered |
| `get_dataset_geography(dataset_id)` | Existing; add spatial bbox filter | Geometry data |

### What this changes from current behaviour

| Current behaviour | Ideal behaviour |
|---|---|
| `list_environments` embeds all process type schemas (260KB) | Returns `[{id, name}]` only; schemas fetched via `get_process_type_schema` |
| `list_processes` embeds logs in every version (95% of payload) | Returns summary row per process; logs fetched via `get_process_logs` |
| `list_processes` embeds full parameters in every version | Parameters in `get_process` only |
| No single-process GET | `get_process(process_id)` returns full version history without logs |
| `get_process_logs` returns all log lines at once | Accepts `tail` / `offset+limit` |
| Outputs stored as full URLs | Stored as dataset IDs; URL resolved via `get_dataset` |

### Round-trip cost for common agent tasks

| Task | Current | Ideal |
|---|---|---|
| Check if a process finished | 1 call → 73KB overflow → disk grep | `list_processes(project_id)` → small list, read `latest_state` |
| Get schema for one process type | 1 call → 260KB overflow → sub-agent | `list_process_types(env_id)` + `get_process_type_schema(env_id, name)` → 2 calls, ~1KB total |
| Diagnose a failed run (last 50 log lines) | `get_process_logs` → all lines, may overflow | `get_process_logs(id, version, tail=50)` → bounded response |
| Chain two processes (output → input) | `list_processes` overflow → grep for output URL → pass URL | `get_process(id)` → read `outputs.result` dataset_id → `get_dataset(id)` → pass `url` |
| Check parameters of the last 3 runs | `list_processes` overflow → grep 3× | `get_process(id)` → read `versions[-3:]` parameters inline |

The two-level pattern adds at most one extra round trip compared to eager embedding, while bounding every individual response to a size an LLM context window can hold without assistance.

---

## Architectural Note

The MCP was auto-generated from the FastAPI OpenAPI spec via `fastapi-mcp`. This approach produces correct tools quickly, but REST API design and LLM tool design have different optimization targets:

- REST APIs optimize for resource modeling, HTTP semantics, and client-side composition
- LLM tools optimize for context budget, single-turn completeness, and agentic loop compatibility

The problems above (over-fetching, missing single-resource lookup, no log pagination) are classic REST patterns that work well when the client is stateful and can cache, paginate, and compose efficiently. An LLM context window cannot cache between turns, has a hard token budget per response, and needs atomic operations rather than multi-step compositions.

The highest-value fix is not adding more tools — it is making `logs` opt-in in `list_processes` responses and adding a single-process GET endpoint. These two changes eliminate the context overflow that forces every other workaround and unlock the monitoring capabilities already present in the data model.

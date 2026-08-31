# Expose Dataset-Path Completion via the MCP Server — Plan

## Goal

Let an MCP client (an LLM building a workspace layout) discover **valid values**
for the special path fields used inside workspace `layoutConfig`s — without
reading frontend source. Today the path grammar (`proc.version.dataset.column`,
the `current` placeholder) and the set of valid paths live only in the frontend
combobox (`frontend/src/jsoneditor/DatasetColumnCombobox.jsx`), so an agent
constructing a `PlotView` layer has to guess `dataset: "current.smooth_model"`
by reverse-engineering React components.

## Background & Current State

Three string fields in workspace layouts are flagged with an `x-format` and get
a live-data combobox in the frontend. `buildOptions` in
`DatasetColumnCombobox.jsx` is the single source of the convention:

| `x-format`      | combobox `mode` | Completion values                                             |
| --------------- | --------------- | ------------------------------------------------------------ |
| `processVersion`| `process`       | `current`, `<procName>.<version>`                            |
| `datasetPath`   | `dataset`       | `current.<dsName>`, `<procName>.<version>.<dsName>`          |
| `expression`    | `column`        | `current.<dsName>.<col>`, `<procName>.<version>.<dsName>.<col>` |

Key semantics:
- **`current`** is a runtime placeholder meaning "whichever process/version the
  user has selected while viewing the workspace." A workspace is a *template*;
  `current.smooth_model` re-binds per viewer. The server has no "current"
  selection, so `current.*` completions must be derived from some concrete
  process's outputs (see Decision 3).
- Values come entirely from data the server already holds:
  - process/version/dataset names → `ProcessVersion.build_outputs()`
    (`dataset_name → url`, `backend/models/process.py:387`).
  - column names → the per-dataset stats sidecar
    (`application/vnd.ymerflow.stats+json`), whose keys are `flightlines` +
    `layer_data` (XYZ), `columns` (MAG), or `variables` (grid). Documented at
    `backend/routers/datasets.py:83`.

The MCP schema tools live in `backend/routers/workspaces.py` and are
auto-registered by `operation_id`:
- `get_workspace_schema` — widget index
- `get_widget_schema(widget)` — one widget's node/param schema (PlotView's
  `layoutConfig` includes `transforms`, which use `expression` fields)
- `list_plot_layer_types(widget)` — PlotView layer-type names
- `get_plot_layer_schema(widget, layer_type)` — one layer's params (e.g.
  `ResistivityCurtain.dataset` is `x-format: datasetPath`)

The gap: these tools emit fields carrying `x-format: datasetPath | expression`
(and `processVersion` where present) but nothing tells the client the grammar or
the valid values. `list_processes` is deliberately terse and omits `outputs`, so
the only current workaround is a fan-out of `get_process_version_outputs` across
every process plus guessing the `current.` form and column names.

## Out of Scope

- The `dataset` and `upload` x-formats (process **input** selectors) — already
  served by `search_datasets` / `request_upload_token`.
- Any change to the layout **schema JSON** itself. Explicitly rejected below.
- Frontend changes. `buildOptions` stays as-is; this only adds a server-side
  peer for headless/MCP callers.

## Design Decisions

### Decision 1: Three completion tools, one per `x-format` — **chosen**

Add three MCP tools, each a Python port of one `buildOptions` branch. **No
`mode` parameter** — the tool name selects the mode, so each tool has a tight,
self-describing signature and its own return shape:

| `x-format`       | tool                           | Returns                                          |
| ---------------- | ------------------------------ | ------------------------------------------------ |
| `processVersion` | `complete_process_version_path`| `current`, `<proc>.<ver>`                        |
| `datasetPath`    | `complete_dataset_path`        | `current.<ds>`, `<proc>.<ver>.<ds>`              |
| `expression`     | `complete_column_path`         | `current.<ds>.<col>`, `<proc>.<ver>.<ds>.<col>`  |

This keeps the grammar authoritative on the server, mirrors exactly what the UI
offers, and avoids a discriminated-union return that a single `mode` tool would
force.

Rejected alternative — *one `complete_layout_path(mode=...)` tool*: a `mode`
parameter hides three different behaviors and return shapes behind one name;
splitting makes each tool's purpose obvious in the tool list.

Rejected alternative — *inline `enum`s of valid paths into
`get_plot_layer_schema`*: those tools read a static, project-agnostic
`widget_schemas.json`; injecting live per-project values would couple static
schema to DB state and bloat every schema call.

Rejected alternative — *just add `with_outputs=true` to `list_processes` + prose
docs*: lightest change, but pushes path assembly and the `current` semantics
back onto the client.

### Decision 2: Advertise the tools in the schema tools' **descriptions**, not the schema — **chosen**

Per operator direction: **do not modify the schema JSON** (no `x-completion`
annotation on fields). Instead, extend the **docstrings** (MCP tool
descriptions) of the tools that return schemas *which can contain these
references* so the client learns, at the point of reading the schema, which
`x-format` maps to which completion tool:
> A field marked `x-format: datasetPath` takes a dotted path — call
> `complete_dataset_path(project_id, ...)` to enumerate valid values;
> `x-format: processVersion` → `complete_process_version_path`;
> `x-format: expression` → `complete_column_path`. `current` is a placeholder
> for the viewer's selected process.

Tools whose descriptions get this note:
- `get_plot_layer_schema` — layer params include `datasetPath` (+ `expression`).
- `get_widget_schema` — PlotView `layoutConfig.transforms` use `expression`.
- `get_workspace_schema` and `create_workspace` — **also included** (chosen):
  they orient the whole layout-building flow, so a pointer here surfaces the
  completion tools before the client drills into a specific widget/layer.

### Decision 3: Resolving `current.*` server-side — **`example_process_id` parameter**

Because "current" has no server-side selection, each tool takes an optional
`example_process_id` (and optional `version`). When given, `current.*`
completions are the outputs (and, for `complete_column_path`, columns) of that
process version — i.e. "if the viewer selects a process shaped like this one,
these are the paths." When omitted, `current.*` entries are the union of
distinct `dataset_name`s across the project's process outputs (still useful,
less precise). Fully-qualified `<proc>.<ver>.<dataset>` entries never depend on
it. `complete_process_version_path` always emits the bare `current` token.

**Chosen default (no `example_process_id`):** `current.*` entries are the union
of all distinct `dataset_name`s across the project's process outputs (broad and
useful with zero args), alongside every fully-qualified path. The caller narrows
to a specific process's outputs by passing `example_process_id`.

### Decision 4: Ship all three tools now, including `complete_column_path` — **chosen**

`complete_process_version_path` and `complete_dataset_path` need only the DB
(`build_outputs`). `complete_column_path` additionally reads column names from
each dataset's stats sidecar (`flightlines`+`layer_data` / `columns` /
`variables` keys) — more expensive and the branch most likely to drift from the
JS `buildOptions`, but `expression`/column fields are common in PlotView
transforms, so shipping it together closes the whole gap in one change.

Implementation note for the sidecar cost: fetch stats lazily and only for the
datasets that pass the `prefix` filter, so a narrow prefix doesn't fan out
across every dataset in the project.

## Backend Changes

### `backend/routers/workspaces.py` — three new endpoints

Three sibling `GET` endpoints, each with its own `operation_id`. Shared query
params: `project_id`, `prefix=""`, `example_process_id=None`, `version=None`
(defaults to latest of `example_process_id`).

```
complete_process_version_path(project_id, prefix="", ...) -> list[str]
    # "current", "<name>.<version>"

complete_dataset_path(project_id, prefix="", ...) -> list[str]
    # "current.<dsName>", "<name>.<version>.<dsName>"

complete_column_path(project_id, prefix="", ...) -> list[str]   # phase 2 (Decision 4)
    # "current.<dsName>.<col>", "<name>.<version>.<dsName>.<col>"
```

- A shared private helper loads the project's processes with
  `selectinload(versions → datasets)` (same pattern as existing process
  endpoints) and reuses `ProcessVersion.build_outputs`; each endpoint formats its
  own branch of `buildOptions`.
- `current.*` derived per Decision 3.
- `prefix` applies the same case-insensitive substring filter as the UI.
- Auth: `require_project_member` (reads), consistent with other project tools.
- `complete_column_path` additionally reads column names from each dataset's
  stats sidecar (`flightlines`+`layer_data` / `columns` / `variables` keys).

### Docstring edits (Decision 2)

Extend the descriptions of `get_plot_layer_schema`, `get_widget_schema`,
`get_workspace_schema`, and `create_workspace` to map each `x-format` to its
completion tool (`datasetPath` → `complete_dataset_path`, `processVersion` →
`complete_process_version_path`, `expression` → `complete_column_path`). No
code/schema behavior change.

## Frontend Changes

None. (Optional later: factor the grammar into a shared doc both `buildOptions`
and the new endpoint cite, to bound drift.)

## Implementation Steps

1. Add the shared process-loading helper + `complete_process_version_path` and
   `complete_dataset_path` endpoints in `workspaces.py`; reuse `build_outputs`.
2. Add `complete_column_path`, reading columns from the stats sidecar; fetch
   sidecars lazily, only for datasets passing `prefix`.
3. Edit the four schema-tool docstrings to map each x-format to its completion
   tool.
4. Manual verify against Measured-3:
   - `complete_dataset_path(example_process_id=<an invert_tem>)` includes
     `current.smooth_model` and `<proc>.<ver>.smooth_model`;
   - `complete_dataset_path()` (no example) includes `current.smooth_model` via
     the union default;
   - `complete_column_path(example_process_id=<an invert_tem>)` includes a real
     column under `current.smooth_model.*`.
5. Regenerate/inspect the MCP tool list; confirm the three new tools + updated
   descriptions surface.

## Resolved Questions

- **`complete_column_path` now or later?** → Ship all three tools now, including
  column mode via the stats sidecar (Decision 4).
- **Docstring-edit scope?** → Also edit `get_workspace_schema` /
  `create_workspace`, not just the two field-emitting tools (Decision 2).
- **`current.*` with no `example_process_id`?** → Union of all distinct dataset
  names across the project, alongside fully-qualified paths (Decision 3).

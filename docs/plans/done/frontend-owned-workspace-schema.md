# Frontend-owned workspace layout schema

**State:** implemented (2026-11-01)
**Labels:** refactor, frontend, backend, mcp, tech-debt

## Motivation

The workspace-layout JSON Schema that the MCP tools hand to an agent is built in two places, and only one of them is right.

The **per-widget `layoutConfig` schemas** are already extracted from the frontend: `frontend/scripts/export-widget-schemas.mjs` drives the running app with puppeteer, reads each widget's `get_schema()` / `get_default()` off `window.__ymerflow_widgets`, and dumps `backend/widget_schemas.json`. That is the model we want everywhere.

Everything **around** those widget schemas is hand-built in Python in `backend/routers/workspaces.py`:

- the generic node envelope — `id`, `widget`, `children`, `customTitle`, `compact`, `globalCompact`, and `additionalProperties: false` (`_NODE_ID_PROP`, `_CUSTOM_TITLE_PROP`, `_COMPACT_PROP`, `_GLOBAL_COMPACT_PROP`, `_container_node_def`, `_leaf_node_def_raw`)
- the container-widget list and their descriptions (`_CONTAINER_WIDGETS`)
- the recursive `Node` tree (`_build_full_workspace_schema`)
- the terse widget index assembled in `get_workspace_schema`

This duplicates knowledge that lives in flexout and the widgets, and it drifts. `customTitle` was never advertised at all. Adding `compact` / `globalCompact` for the compact-pane-headers work meant hand-editing Python to re-state fields flexout already defines — which is what surfaced this.

Worth stating plainly: **no workspace layout is ever validated against these schemas on write** — `create_workspace` / `create_workspace_version` / `fork_workspace` only check `isinstance(body.layout, dict)`. The node envelope and `additionalProperties: false` are *descriptive*, consumed only by MCP agents through the schema tools. So this refactor moves where the schema is built; it changes no write-path behaviour.

## Principle

**The frontend owns the workspace-layout schema, and builds it whole.** At build time the frontend constructs one full recursive JSON Schema for the entire workspace layout — every widget's own `get_schema()` output, amended with the generic node properties, with container widgets recursing into their children — and dumps it verbatim to a file. Every schema construction and shaping hack lives in frontend code.

**The backend MCP tools do the splitting.** They load that one file and, per MCP request, serve it whole or slice out the part asked for — one widget type, or one plot-layer type — and collapse oversized unions to fit the tool-output limit. The backend navigates and chunks the frontend's schema; it never constructs schema.

## Scope

**In scope** — the four schema endpoints and every backend helper/constant that *builds* schema:
`get_workspace_schema`, `get_widget_schema`, `list_plot_layer_types`, `get_plot_layer_schema`, and the construction helpers/constants listed under Motivation. The slicing/navigation helpers (`_plot_layer_members`, `_collapse_plot_layers`) stay — they now operate on the loaded full schema instead of a hand-built one.

**Out of scope** — the completion endpoints in the same router (`complete_process_version_path`, `complete_dataset_path`, `complete_column_path`). Those enumerate *live project data* from the database and storage sidecars, not schema; they stay in the backend. The plan does not touch them.

## The exported schema

One file: the full recursive workspace-layout JSON Schema, in the shape today's hidden `verbose` dump already has, so it stays sliceable by key:

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Workspace Layout",
  "$defs": {
    "VerticalSplitNode": { ...envelope + children:[{$ref:#/$defs/Node}]... },
    "TabSetNode":        { ...envelope + children... },
    "PlotViewNode":      { ...envelope + layoutConfig:{...full gladly schema, layers union intact...} },
    "FlowViewNode":      { ...envelope... },
    // ...one <Widget>Node per registered widget...
    "Node": { "oneOf": [ {"$ref": "#/$defs/VerticalSplitNode"}, ... ] }
  },
  "$ref": "#/$defs/Node"
}
```

Every flexout node type appears uniformly — leaf widgets and containers alike, one `<Widget>Node` def each. A node def is the generic envelope (`id`, `widget`, `customTitle`, `compact`; `additionalProperties: false`) merged with that widget's `get_schema()` `layoutConfig` if it has one. For the **container** widgets (`VerticalSplit`, `HorizontalSplit`, `TabSet`, `Grid`), the builder additionally injects `children.items = {$ref: #/$defs/Node}` (recursion) and `globalCompact` — the one place that hardcodes "these widgets are containers". That hardcoding is fine: the builder is flexout's own code, so it is allowed to know special things about itself. The PlotView layer union is left **intact** in the file — collapsing it is a backend delivery concern, not part of the authoritative schema.

Because the builder lives in flexout it sees the whole node-type set, so `Grid` and `Empty` (flexout builtins that the hand-built Python omitted entirely) are now covered too, and container titles/descriptions come from the widgets themselves rather than a Python list.

The backend MCP tools then slice this one document:

| endpoint | does |
|---|---|
| `get_workspace_schema()` | derive and return the terse widget index by walking `$defs`; `verbose=true` returns the whole file |
| `get_widget_schema(widget)` | return `$defs["<widget>Node"]`, collapsing PlotView's `layers` union to a type-name list to fit the output limit |
| `list_plot_layer_types(widget)` | read the layer union members out of `$defs["PlotViewNode"]` |
| `get_plot_layer_schema(widget, layer_type)` | return one member's param schema (with `$defs`) from that union |

All four are navigation/slicing over the frontend's schema. None assembles schema.

## Frontend ownership

A new module `frontend/src/flexout/workspaceSchema.js` is the single source of truth for the node envelope and the assembly. `buildWorkspaceSchema(appWidgets)`:

- defines the generic node envelope (`id`, `widget`, `customTitle`, `compact`, `additionalProperties: false`) — flexout's own fields, declared once here
- merges the flexout builtins it imports (`VerticalSplit`, `HorizontalSplit`, `TabSet`, `Grid`, `Empty`) with the passed `appWidgets`, so every node type is covered from one registry
- hardcodes the container set and, for those, injects `children` (recursing to `#/$defs/Node`) and `globalCompact` — flexout knowing its own special nodes
- for each widget, merges its `get_schema()` `layoutConfig` (if any) into a `<Widget>Node` def under the envelope
- wires the recursive `Node = oneOf[...]` and returns the whole document

The rjsf-compatibility hacks that already live in `PlotView.get_schema` (`makeLayersSchemaRjsfCompatible`, `dropEmptyEnums`, `addConstDefaults`) stay put — the new module consumes their output. `App.jsx` exposes `window.__ymerflow_workspace_schema = buildWorkspaceSchema(widgets)` alongside the existing `__ymerflow_widgets`, and the export script dumps that object to the file.

`compact` / `globalCompact` / `customTitle` are declared once here, so a future generic node field is a one-line frontend change that flows to the MCP schema automatically — no Python edit.

## Backend after

`backend/routers/workspaces.py` keeps: the file loader + 503 guard (still reading `widget_schemas.json`, now the full-schema document), the four endpoints reimplemented as slicing over the loaded document, and the existing layer-navigation helpers (`_plot_layer_members`, `_collapse_plot_layers`) operating on it. Deleted (all construction): `_CONTAINER_WIDGETS`, `_NODE_ID_PROP`, `_CUSTOM_TITLE_PROP`, `_COMPACT_PROP`, `_GLOBAL_COMPACT_PROP`, `_container_node_def`, `_leaf_node_def_raw`, `_widget_layout_config`, `_build_full_workspace_schema`. The completion endpoints and all workspace CRUD stay exactly as they are.

## Decisions

Resolved with the user:

- The frontend emits the **full recursive schema** as one document; the backend MCP tools do all splitting — whole / by widget / by layer — and the size-collapsing.
- **Filename stays `backend/widget_schemas.json`** (no rename, so no Dockerfile/doc path churn), even though it now holds the full workspace schema. The 503 "run `npm run export-schemas`" guard stays.
- **Containers appear as ordinary widgets**; the only special knowledge is the hardcoded container set in `workspaceSchema.js` that injects the recursive `children` property (and `globalCompact`). Hardcoding is acceptable because the builder is flexout's own code.
- **MCP response contracts unchanged** — every endpoint keeps its path and JSON shape, so existing agents and the tool descriptions in `backend/main.py` keep working. Visible differences are additive: `customTitle` / `compact` / `globalCompact` are now advertised, and the flexout builtins `Grid` / `Empty` (previously omitted) now appear.

Confirmed during implementation:

1. **Container structural fields.** Beyond `children`, containers carry structural fields the hand-built envelope never advertised: `size` (Split), `activeTab` (TabSet), `colWidths` / `rowHeights` (Grid). **Decided: declare them** in the respective container node defs in `workspaceSchema.js` (`CONTAINER_STRUCTURAL_PROPS`), since flexout owns them and `additionalProperties: false` would otherwise mark a real `size`/`activeTab` as invalid.

## Implementation

- `frontend/src/flexout/workspaceSchema.js` (new): node envelope + generic props, container list, `buildWorkspaceSchema(widgets)` producing the full recursive `$defs`/`Node` document.
- `frontend/src/App.jsx`: expose `window.__ymerflow_workspace_schema`.
- `frontend/scripts/export-widget-schemas.mjs`: read `window.__ymerflow_workspace_schema`, write `backend/workspace_schema.json` (the `export-schemas` npm script name stays).
- `backend/routers/workspaces.py`: delete the construction helpers/constants; reimplement the four endpoints as slicing over the loaded full schema; keep `_plot_layer_members` / `_collapse_plot_layers`. Loader filename unchanged (`widget_schemas.json`).
- `backend/widget_schemas.json`: regenerate — content changes from the per-widget map to the full recursive schema document.
- Docs: `docs/frontend/widgets.md` (schema-export section), `docs/mcp-tools.md`, `docs/architecture/environment.md` (schema extraction), and any other reference to the backend node-def construction.
- Tests (vitest): `workspaceSchema.test.js` — `Node.oneOf` lists every widget; each node def carries `customTitle` / `compact`; container defs carry `children` recursing to `#/$defs/Node` and `globalCompact`; `PlotViewNode` embeds the full gladly `layoutConfig` with its layer union intact.

About a day.

## Not changing

- No validation is added to the write path (there is none today, and this plan does not introduce it).
- The rjsf form schemas and the pane Configure forms are untouched.
- The completion endpoints (`complete_*_path`) and all workspace CRUD stay as they are.
- The MCP tool set, endpoint paths, and response shapes are unchanged — only the schema's *source* moves to the frontend. The advertised content gains, additively: `customTitle` / `compact` / `globalCompact` on nodes, and the `Grid` / `Empty` builtins.

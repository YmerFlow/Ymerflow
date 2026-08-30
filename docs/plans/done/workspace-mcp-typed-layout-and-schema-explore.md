# Workspace MCP: typed `layout` + piecemeal schema exploration

## Problem

Creating a workspace over MCP is a footgun, demonstrated by a real failure:

1. **`create_workspace` / `create_workspace_version` take `body: Dict`.**
   Because the body is an untyped `Dict`, the generated MCP/OpenAPI tool schema
   advertises **only `project_id`** — neither `title` nor `layout` appears, and
   nothing tells the caller that `layout` must be a JSON *object*. A caller
   naturally passes `layout` as a serialized JSON **string**.

2. **Nothing rejects the wrong type.** `layout = Column(JSON)` (see
   `backend/models/workspace.py:54`) stores a string just as happily as an
   object — a string is valid JSON. `create_workspace` does
   `layout = body.get("layout", {})` and persists it verbatim, returns `200`,
   and `to_dict()` round-trips the string back out. The mistake only becomes
   visible later, in the frontend layout editor, which renders the string as a
   YAML block scalar (`|-` followed by the JSON text) instead of a tree.

3. **The schema that would have helped is unreadable and unenforced.**
   `get_workspace_schema` returns **248 KB / 5,235 lines** — it overflows the
   MCP tool-output token limit, so it cannot be read in one call. The bulk is
   entirely `PlotView.layoutConfig` (the `transforms` grammar plus the
   `layers.items.anyOf` union of ~19 layer types). Every other widget's schema
   is small. And the schema is never applied to the create endpoints, so it
   cannot catch anything even when read.

Net effect: the last hop of an otherwise-fine task (find project → read schema →
copy an existing idiom) silently accepted a type error that surfaced far away.

## Goals

1. Type the request body so `layout` is a declared **object** in the tool
   schema, and a string is rejected with `422` before it reaches the DB.
2. Let the MCP caller explore the layout schema **piecemeal** instead of one
   248 KB dump: a terse widget index, one widget's parameter schema, and —
   because `PlotView` is the one widget that is itself too big — a dedicated
   drill into its layer types.

## Reused mechanism: hidden `verbose` query param

This follows the pattern established in
`docs/plans/done/mcp-terse-process-tools.md`. `fastapi_mcp` builds each tool's
input schema from the endpoint's OpenAPI parameters, and a FastAPI
`Query(..., include_in_schema=False)` param is fully functional over HTTP but
**omitted from the OpenAPI schema** — so the MCP tool never sees it and cannot
set it. An endpoint therefore gains:

```python
verbose: bool = Query(False, include_in_schema=False)
```

- **MCP** always gets the terse default (`verbose=False`) — it literally cannot
  request the full form.
- The **frontend** (or any REST consumer) passes `verbose=true` for the full
  shape.

One endpoint, one `operation_id`, two shapes — no MCP-only response surface.
(Note: today the frontend consumes widget schemas from the build-time
`widget_schemas.json`, not this endpoint, so `verbose=true` is currently an
escape hatch / future-frontend shape; the terse default is what matters for MCP.)

## Design decisions (to confirm with the user)

### 1. Typed request bodies (decided: yes)

Replace `body: Dict` with Pydantic models on the two layout-writing endpoints:

```python
class CreateWorkspaceBody(BaseModel):
    title: str = "Untitled Workspace"
    layout: dict          # object-typed → tool schema shows an object; str → 422

class CreateWorkspaceVersionBody(BaseModel):
    layout: dict
```

- `layout: dict` alone fixes both failure modes: the MCP tool schema now
  declares `layout` as an object (so the model emits an object, not a string),
  and FastAPI returns `422` on a string/array instead of silently storing it.
- Keep `layout` typed as `dict` (not a full recursive `Node` Pydantic model).
  The authoritative layout schema is generated from the frontend widgets
  (`widget_schemas.json`) — duplicating it as Pydantic would drift. Structural
  validation, if wanted, belongs in step 3 below (optional), not in the type.
- `fork_workspace` / `update_workspace` bodies are left as-is for now (they
  carry `version` / `title` / flags, not a `layout`); typing them is a tidy
  follow-up, out of scope here.

**Open sub-decision — reject string defensively too?** Even with `layout: dict`,
add an explicit guard so a future untyped path can't reintroduce the bug:
`if not isinstance(layout, dict): raise HTTPException(400, ...)`. Low cost,
recommended. (Full jsonschema validation of the layout against the widget
schema is a separate, larger option — see "Out of scope".)

### 2. Schema exploration: terse `get_workspace_schema` + per-widget tool

**`get_workspace_schema` gains the hidden `verbose` param.**
- `verbose=true` (frontend / escape hatch) → today's full 248 KB recursive dump.
- `verbose=false` (MCP default) → a terse **widget index**: one short row per
  widget type, no deep schemas. This is the "list widgets" capability, folded
  into the existing endpoint exactly as the terse-process plan folds terse
  `list_processes` into the same endpoint:
  ```json
  {
    "widgets": [
      {"widget": "VerticalSplit", "title": "VerticalSplit",
       "description": "Split the pane vertically...", "container": true, "has_params": false},
      {"widget": "PlotView", "title": "Plot view", "container": false, "has_params": true},
      {"widget": "Export", "title": "Export", "container": false, "has_params": false},
      ...
    ],
    "node_envelope": { "id": "<uuid>", "widget": "<name>", "children?": "[...]", "layoutConfig?": "{...}" }
  }
  ```
  Source: the 3 built-in container widgets + leaf widgets from
  `widget_schemas.json` (title / description / whether a `schema` exists).

**`get_widget_schema` → `GET /workspace-schema/widget/{widget}`** (new tool,
`operation_id="get_widget_schema"`). "Get parameter schema for a widget":
- Container widget → the `{id, widget, children}` node shape.
- Leaf widget → the `{id, widget, layoutConfig}` node shape, `layoutConfig`
  being that widget's schema from `widget_schemas.json` (`$defs` inlined enough
  to stand alone).

For every widget **except `PlotView`** this is small and complete. For
`PlotView`, the response returns the top-level `layoutConfig` shape
(`transforms` / `axes` / `interactions`) but **collapses `layers.items.anyOf`
to just the list of layer-type names**, with a pointer to the two PlotView tools
below. (No `verbose` needed here — the payload is already small; the PlotView
bigness is handled by dedicated tools, per decision 3.)

### 3. PlotView-specific tools: list layer types, get one layer's params

`PlotView` is the only widget whose own schema is too big to return whole (the
`layers.items.anyOf` union of ~19 layer types is the bulk of the 248 KB). It
gets two dedicated tools, mirroring the enumerate-then-drill flow that actually
worked when done by hand with `jq`:

**`list_plot_layer_types` → `GET /workspace-schema/widget/{widget}/layer`**
(`operation_id="list_plot_layer_types"`) — one row per layer type:
```json
[
  {"layer_type": "ResistivityCurtain", "title": "ResistivityCurtain", "description": "..."},
  {"layer_type": "points", "title": "points", "description": "..."},
  ...
]
```

**`get_plot_layer_schema` → `GET /workspace-schema/widget/{widget}/layer/{layer_type}`**
(`operation_id="get_plot_layer_schema"`) — the parameter schema for one layer
type, e.g. `ResistivityCurtain` → `{dataset, topo_column, cmin, cmax, yAxis,
xAxis, selection}`. Source: the matching `anyOf` member under
`PlotView.layoutConfig.layers.items` in `widget_schemas.json`.

### 4. (Optional, out of the default scope) validate layout against the schema

Server-side jsonschema validation of `layout` against the generated workspace
schema, returning `422` with the offending path on mismatch. This would catch
bad widget names, misplaced `children`, etc. — not just the string-vs-object
error. Larger and needs a jsonschema dependency + care around the recursive
`Node` union. Proposed as a **follow-up**, not part of this plan, unless the
user wants it included now.

## Changes (file-by-file)

- `backend/routers/workspaces.py`
  - Add `CreateWorkspaceBody` / `CreateWorkspaceVersionBody` Pydantic models;
    switch `create_workspace` and `create_workspace_version` signatures to them.
    (Optional defensive `isinstance(layout, dict)` guard.)
  - Refactor the widget-schema assembly in `get_workspace_schema` into small
    helpers (container-widget table + `widget_schemas.json` loading + per-widget
    node builder + plot-layer accessor) so all the tools below reuse it — no
    duplication.
  - The four schema-exploration routes nest under `/workspace-schema`, with the
    widget / layer-type ids carried in the **path** (layers are a sub-resource
    of a widget). Router prefix is `/workspace`, so the decorator arg is the
    `-schema…` suffix shown below:

    | `operation_id` | decorator arg | full path | path params |
    |---|---|---|---|
    | `get_workspace_schema` | `"-schema"` | `GET /workspace-schema` | — (`verbose` hidden query) |
    | `get_widget_schema` | `"-schema/widget/{widget}"` | `GET /workspace-schema/widget/{widget}` | `widget` |
    | `list_plot_layer_types` | `"-schema/widget/{widget}/layer"` | `GET /workspace-schema/widget/{widget}/layer` | `widget` |
    | `get_plot_layer_schema` | `"-schema/widget/{widget}/layer/{layer_type}"` | `GET /workspace-schema/widget/{widget}/layer/{layer_type}` | `widget`, `layer_type` |

    Example: `GET /workspace-schema/widget/PlotView/layer/ResistivityCurtain`.

  - `get_workspace_schema`: add `verbose: bool = Query(False,
    include_in_schema=False)`. `verbose=true` → today's full dump; default →
    terse widget index. Update docstring to point at the drill-down routes.
  - Add `get_widget_schema` — path param `widget`; returns the widget node schema
    (PlotView collapses its `layers` union to names + a pointer to the layer
    routes below).
  - Add `list_plot_layer_types` — path param `widget`; lists that widget's layer
    types (only `PlotView` is populated — ~19 types; other widgets → empty/404).
  - Add `get_plot_layer_schema` — path params `widget`, `layer_type`; returns
    that layer type's parameter schema.
  - No route collision: the three new routes differ only by path depth, and the
    whole `/workspace-schema/…` tree starts with `workspace-`, so it never
    matches `/workspace/{workspace_id}` (the char after `workspace` is `-` vs
    `/`), exactly as today's `/workspace-schema` already coexists with it.
- `backend/main.py`
  - Update the `FastApiMCP` workflow description to mention the workspace tools:
    `get_workspace_schema` (terse index) → `get_widget_schema` /
    `list_plot_layer_types` → `get_plot_layer_schema` → `create_workspace`.
  - No `include_tags` change needed (new endpoints are already `Workspaces`).
- Docs: note the new tools in `docs/architecture/overview.md` API section (and
  wherever workspace MCP tools are listed).
- **No frontend change.** Unlike the terse-process plan, the frontend does not
  call `get_workspace_schema` and so nothing needs to pass `verbose=true`. The
  layout-config forms build their schema client-side from each widget's static
  `get_schema(data_context)` (`frontend/src/flexout/components/Pane.jsx`,
  `TabSet.jsx`); `widget_schemas.json` is a build-time export read only by the
  backend. `verbose=true` is therefore an unused-by-default escape hatch that
  keeps today's full-dump shape available to OpenAPI/REST/manual callers — do
  not go looking for a frontend caller to switch over; there isn't one.

## Out of scope

- **Examples per widget / layer type (deferred follow-up).** A schema conveys
  *shape* but not *idiom* — it never says `dataset` should be
  `current.smooth_model` (the "current process's output" convention) or that an
  `axes` key like `resistivity` links a layer to its colorbar, which is what
  actually made the original task hard (copying a working example is what
  worked). Attaching a minimal valid `example` to each widget/layer — ideally
  exported from the widgets into `widget_schemas.json` next to
  `title`/`schema`/`default` — is worthwhile but out of this plan's scope.
- Full jsonschema validation of layouts (decision 4 — possible follow-up).
- Typing `fork_workspace` / `update_workspace` bodies.
- Re-saving the already-broken "View and export" workspace (a one-off data fix,
  handled separately from this plan).

## Testing

- `create_workspace` with `layout` as a **string** → `422` (previously `200`
  with a corrupted record).
- `create_workspace` with `layout` as an **object** → `200`, and
  `get_workspace` returns `layout` as a nested object (not a `|-` string).
- `get_workspace_schema` (MCP default, `verbose=false`) → small widget index,
  every container + leaf widget present, `has_params` correct, within token
  limits; `verbose=true` → the full dump unchanged from today.
- `get_widget_schema(widget="Export")` → tiny node schema.
- `get_widget_schema(widget="PlotView")` → top-level shape with layers collapsed
  to names + pointer, within token limits.
- `list_plot_layer_types()` → ~19 layer-type rows.
- `get_plot_layer_schema(layer_type="ResistivityCurtain")` → just that layer's
  params (matches the `dataset`/`selection`/`cmin`/`cmax`/… shape).
- MCP smoke test: `create_workspace`, `get_widget_schema`,
  `list_plot_layer_types`, and `get_plot_layer_schema` appear as tools with
  correct input schemas (`layout` typed as object).

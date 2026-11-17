# Drag a process output dataset onto a plot to add a layer

**State:** decided 2026-11-17, ready to implement
**Labels:** enhancement, frontend, FlowView, PlotView, dnd
**Repos touched:** main (`frontend/` only)

## Motivation

In FlowView a user drag-moves a process node by grabbing anywhere on its card.
The output dataset boxes on a node's right edge are today just visual labels with
a reactflow connection `Handle`. We want those boxes to become **drag sources**:
a user grabs an output dataset box and drops it onto another widget to add that
dataset there. The first (and for now only) drop consumer is **PlotView** — a
dropped dataset becomes a new plot layer.

On drop onto a plot, the candidate layer types are filtered twice:

1. **Dataset compatibility** — the layer's `dataset` field must accept the
   dropped dataset's media type (the `x-target-mediatypes` constraint already
   declared on every layer, see [[dataset-selector-mediatype-filter]]).
2. **Existing-axis compatibility (conflict-avoidance)** — the layer must not need
   an axis slot the plot already uses with a *different* quantity kind.

The surviving layer types are shown by name in a small context-menu popup at the
drop point; the user picks one and it is appended as a new layer with its
`dataset` field set to the dropped dataset path and every other field at its
schema default. If exactly one type survives, the popup is skipped.

## Decisions (settled with user 2026-11-17)

1. **Output boxes stop moving the node.** Each output box is exempted from
   reactflow node-dragging (reactflow honours the `nodrag` CSS class) and becomes
   an HTML5/react-dnd drag source instead. Input boxes are unchanged. The node
   card still moves when grabbed anywhere else.
2. **Generic helper module, outside `flexout/`.** The reusable pieces (drag item
   type + payload shape, a `useDatasetDrop` hook, the shared picker popup) live in
   a new small module. `flexout/` is **not** touched — the global `react-dnd`
   `DndProvider` (set up at `frontend/src/index.jsx:14`) already lets any component
   register a drag source or drop target. PlotView is the first consumer; a future
   widget opts in with one `useDatasetDrop(...)` call. All layer-specific logic
   stays inside PlotView.
3. **Item type `'dataset'`** — distinct from flexout's `'pane'` item type, so
   none of the existing pane/tab drop targets react to a dataset drag and vice
   versa (verified: every flexout drop target is `accept: 'pane'`).
4. **Axis filter = conflict-avoidance.** A candidate layer type is kept unless, for
   any x/y/z axis slot it would occupy, the plot already has that slot populated
   with a *different* quantity kind. An empty plot has no occupied slots, so every
   media-compatible type passes.
5. **Picker = context menu at the cursor**, reusing the existing portal-dropdown
   pattern (`frontend/src/flexout/components/PaneMenuDropdown.jsx`) anchored to the
   drop point instead of an element.
6. **Zero survivors → no-op** (the drop simply does nothing; no layer added).
   Media-type is the gate; a layer's deeper column requirements remain enforced by
   its `createLayer` returning `[]` (graceful empty render), exactly as today.

## What exists

### Drag source side — FlowView output boxes

- `frontend/src/widgets/FlowView/ProcessNode.jsx:102-138` renders the output
  boxes via `outputNames.map(...)`. In scope: `process` (`:9`), `selectedVersion`
  (`:9`), `versionObj.outputs` (`:31`), each output `name` (the map key), and
  `outputUrl = versionObj.outputs[name]` / `datasetId = outputUrl.split('/').pop()`
  (`:105-106`).
- The box `<div>` uses `labelStyle`, which sets **`pointerEvents: 'none'`**
  (`ProcessNode.jsx:52`). A drag source must receive pointer events, so the
  draggable box needs `pointerEvents: 'auto'`.
- The reactflow source `Handle` (`:121-134`, `id={name}`) sits at the box's right
  edge and must keep working for drawing edges — it has its own reactflow pointer
  handling. The draggable region is the box body (the label), not the handle.
- react-dnd's `useDrag` returns a ref connector and cannot be called inside the
  `.map` loop, so the output box must be extracted into a small child component
  that calls `useDrag` for its own item.

### Dataset path format PlotView expects

From `frontend/src/widgets/PlotView/pinnedDatasets.js:1-10` and `pinnedDatasetId`
(`:40-47`): a layer references another process's output as
`"<encProcName>.<version>.<encDsName>"`, where the first and third segments are
run through `encodeSeg` (`frontend/src/datamodel/datasetPath.js`). Building the
path in the drag source:

```js
import { encodeSeg } from '../../datamodel/datasetPath';
const datasetPath = `${encodeSeg(process.name)}.${selectedVersion}.${encodeSeg(name)}`;
```

PlotView already loads such pinned paths automatically via `loadPinnedData`
(`pinnedDatasets.js:55`), so appending a layer with this path needs no extra
wiring to make the data appear.

### Compatibility machinery (already present)

- `frontend/src/jsoneditor/mediatypeMatch.js`: `rootPartMediatypes(ds)` and
  `datasetMatchesMediatypes(ds, spec)` — the same functions the dataset pickers
  use. `spec` is a layer's `x-target-mediatypes`; absent/empty → always true.
- Every layer's `dataset` field already declares `x-target-mediatypes` (e.g.
  `FlightlinePlot.js:76`, `MagLinePlot.js:40`, `ChannelPlot.js:67`,
  `ResistivityCurtain.js:122`). `GridLayer` has **no** `datasetPath` field (it uses
  column expressions) → it is simply never a drop candidate.
- The dropped dataset's media types come from its dataset dict's `.parts`
  (`rootPartMediatypes`). PlotView can look the dict up from `ProcessContext`
  (`datasets` search results, which carry `.parts`) by `datasetId`.

### Layer-type registry and axis configs (gladly-plot public API)

- `getRegisteredLayerTypes()` → array of registered names.
- `getLayerType(name)` → the `LayerType` instance.
- `layerType.schema(data)` → the per-layer JSON Schema (carries
  `x-format: 'datasetPath'` + `x-target-mediatypes` on its dataset field, and
  `default` on the other fields).
- `layerType.resolveAxisConfig(parameters, data)` → `{ xAxis, xAxisQuantityKind,
  yAxis, yAxisQuantityKind, zAxis, zAxisQuantityKind, ... }` — the **public**
  method (`core/LayerType.js:450`) that handles both static and dynamic
  (`getAxisConfig`) layers. Use this, not the private `_getAxisConfig`.

All are exported from `gladly-plot` (`node_modules/gladly-plot/src/index.js:12`).

### PlotView config write path

- `layoutConfig.layers` is an array of single-key objects `{ LayerName: {params} }`
  (`PlotView/index.jsx` `get_default` → `layers: []`).
- A widget persists config with `parentUpdate('replace', id, { id, widget,
  layoutConfig, ...rest })` — the exact call PlotView already makes
  (`PlotView/index.jsx:78`).

## Design

### A. New shared DnD module — `frontend/src/dnd/`

`datasetDnd.js`:
```js
import { useDrag, useDrop } from 'react-dnd';

export const DATASET_DRAG_TYPE = 'dataset';
// payload shape: { datasetId, datasetPath, datasetName }

// Drag source — returns the connector ref to attach to a draggable element.
export function useDatasetDragSource(item) {
  const [, drag] = useDrag({ type: DATASET_DRAG_TYPE, item }, [JSON.stringify(item)]);
  return drag;
}

// Drop target — onDrop(item, clientOffset) fires on drop.
export function useDatasetDrop(onDrop) {
  const [, drop] = useDrop({
    accept: DATASET_DRAG_TYPE,
    drop: (item, monitor) => onDrop(item, monitor.getClientOffset()),
  }, [onDrop]);
  return drop;
}
```

`DatasetDropMenu.jsx` — a cursor-anchored portal menu (adapt
`PaneMenuDropdown.jsx`: same `ReactDOM.createPortal` + mousedown-to-close, but
positioned at a `{x, y}` point instead of an `anchorRef` rect). Props:
`{ x, y, items: [{name, label}], onPick, onClose }`.

### B. Drag source — FlowView `ProcessNode.jsx`

- Extract the output-box JSX (`:102-138`) into a small `DatasetOutputBox`
  component in the same file (or a sibling file). It receives `name`, `outputUrl`,
  `datasetId`, `bg`, the positioning props, and `process`/`selectedVersion` (or the
  prebuilt `datasetPath`).
- Inside it: build `datasetPath` via `encodeSeg`, call
  `const dragRef = useDatasetDragSource({ datasetId, datasetPath, datasetName: name })`,
  attach `ref={dragRef}` to the box `<div>`, add `className="nodrag"` (so reactflow
  does not move the node), and set `pointerEvents: 'auto'` (overriding
  `labelStyle`). Keep the inner `Handle` unchanged.
- The one integration risk to verify at implementation time: reactflow node-drag
  (pointer-based) vs HTML5 drag (native `draggable`) on the same box. The `nodrag`
  class plus react-dnd's HTML5 backend setting the `draggable` attribute is
  expected to resolve it; confirm dragging the box starts a dataset drag and does
  **not** move the node, while the `Handle` still draws edges.

### C. Drop consumer — PlotView

Add a small helper `frontend/src/widgets/PlotView/datasetDrop.js`:

```js
import { getRegisteredLayerTypes, getLayerType } from 'gladly-plot';
import { datasetMatchesMediatypes } from '../../jsoneditor/mediatypeMatch';

// The datasetPath field name + its media-type spec, or null if the layer has no
// datasetPath field (e.g. GridLayer) → not a drop candidate.
function datasetField(schema) {
  for (const [k, prop] of Object.entries(schema.properties || {}))
    if (prop['x-format'] === 'datasetPath') return { name: k, spec: prop['x-target-mediatypes'] };
  return null;
}

// slot -> quantityKind already occupied by the plot's current layers.
function occupiedAxes(layers, data) {
  const map = {};
  for (const layer of layers || []) {
    const [name, params] = Object.entries(layer)[0] || [];
    if (!name) continue;
    let cfg; try { cfg = getLayerType(name).resolveAxisConfig(params || {}, data); } catch { continue; }
    for (const [slot, qk] of [[cfg.xAxis, cfg.xAxisQuantityKind], [cfg.yAxis, cfg.yAxisQuantityKind], [cfg.zAxis, cfg.zAxisQuantityKind]])
      if (slot && qk != null) map[slot] = qk;
  }
  return map;
}

// Candidate layer types for a dropped dataset dict + current config.
export function compatibleLayerTypes(datasetDict, layers, data) {
  const occupied = occupiedAxes(layers, data);
  const out = [];
  for (const name of getRegisteredLayerTypes()) {
    let lt; try { lt = getLayerType(name); } catch { continue; }
    let schema; try { schema = lt.schema(data); } catch { continue; }
    const field = datasetField(schema);
    if (!field) continue;                                   // no datasetPath field
    if (!datasetMatchesMediatypes(datasetDict, field.spec)) continue;  // media gate
    // Conflict-avoidance: coarse check with minimal params (dropped ds not loaded
    // yet → column-driven QKs fall back to the layer's defaults).
    let cfg; try { cfg = lt.resolveAxisConfig({ [field.name]: '' }, data); } catch { cfg = {}; }
    const conflict = [[cfg.xAxis, cfg.xAxisQuantityKind], [cfg.yAxis, cfg.yAxisQuantityKind], [cfg.zAxis, cfg.zAxisQuantityKind]]
      .some(([slot, qk]) => slot && qk != null && occupied[slot] != null && occupied[slot] !== qk);
    if (conflict) continue;
    out.push({ name, field: field.name });
  }
  return out;
}

// Build a new layer object { Name: {defaults..., <datasetField>: path} }.
export function buildLayer({ name, field }, datasetPath, data) {
  const schema = getLayerType(name).schema(data);
  const params = {};
  for (const [k, prop] of Object.entries(schema.properties || {}))
    if (prop.default !== undefined) params[k] = prop.default;
  params[field] = datasetPath;
  return { [name]: params };
}
```

In `PlotView/index.jsx`:
- Register the drop target: `const dropRef = useDatasetDrop(handleDatasetDrop)`
  and attach `ref={dropRef}` to the PlotView root container. (If the root already
  has a ref, compose them.)
- `handleDatasetDrop(item, offset)`:
  1. Look the dropped dataset dict up from `ProcessContext` `datasets` by
     `item.datasetId` (for `rootPartMediatypes`).
  2. `const cands = compatibleLayerTypes(dict, layoutConfig.layers, currentPlotData)`
     where `currentPlotData` is the DataGroup PlotView already builds for
     `plot.update`.
  3. `cands.length === 0` → no-op. `=== 1` → append `buildLayer(cands[0],
     item.datasetPath, data)` and persist. `> 1` → open `DatasetDropMenu` at
     `offset` with the candidate names; on pick, append + persist.
- Append + persist:
  ```js
  const next = { ...layoutConfig, layers: [...(layoutConfig.layers||[]), newLayer] };
  parentUpdate('replace', id, { id, widget, layoutConfig: next, ...rest });
  ```
  (mirror the existing write at `PlotView/index.jsx:78`).

### Candidate layer types per dropped dataset (expected, from current media types)

| Dropped dataset media type | Candidate layers (before axis filter) |
|---|---|
| `application/x-aarhusxyz-msgpack` (AEM data) | FlightlinePlot, ChannelPlot, GateAnomalyPlot, SoundingPlot, SoundingMarker, SoundingResistivityPlot, ResistivityCurtain(2D/3D/Lines) |
| `application/x-aarhusxyz-model-msgpack` (AEM model) | FlightlinePlot, SoundingResistivityPlot, ResistivityCurtain(2D/3D/Lines) |
| `application/x-magdata-msgpack` (MAG line) | MagLinePlot |
| other | none (no-op) |

(GridLayer is never a candidate — no `datasetPath` field.)

## Testing (manual, against a project with AEM data, an AEM model, and a MAG line)

1. In FlowView, dragging an output box no longer moves the node; dragging the node
   card elsewhere still moves it; the output `Handle` still draws edges.
2. Drop an AEM data output onto an **empty** plot → popup lists all AEM-data
   layer types; picking ChannelPlot adds a working channel layer.
3. Drop the same dataset where exactly one type matches (e.g. a MAG line onto any
   plot) → no popup, MagLinePlot added directly.
4. Drop onto a plot that already has a ResistivityCurtain (xdist/elevation axes):
   a second resistivity/model layer (same axes) stays offered; a SoundingPlot
   (time/dbdt axes — different QK on the same `xaxis_bottom`/`yaxis_left` slots) is
   filtered out by conflict-avoidance.
5. Drop a dataset no layer accepts (e.g. a JSON dataset) → nothing happens.
6. Added layer has its `dataset` field set to `<proc>.<ver>.<ds>` and renders; its
   other fields are at schema defaults.
7. The dataset drag does not disturb flexout pane/tab dragging, and a pane drag
   does not trigger a plot drop.

## Files touched (main repo, `frontend/` only)

- `src/dnd/datasetDnd.js` — **new**: `DATASET_DRAG_TYPE`, `useDatasetDragSource`,
  `useDatasetDrop`.
- `src/dnd/DatasetDropMenu.jsx` — **new**: cursor-anchored portal picker.
- `src/widgets/FlowView/ProcessNode.jsx` — extract `DatasetOutputBox`, make it a
  drag source (`nodrag`, `pointerEvents: auto`, build `datasetPath`).
- `src/widgets/PlotView/datasetDrop.js` — **new**: `compatibleLayerTypes`,
  `buildLayer`.
- `src/widgets/PlotView/index.jsx` — register `useDatasetDrop` on the root, handle
  drop (filter → 0/1/many → append + `parentUpdate`), render `DatasetDropMenu`.

No backend, flexout, migration, or dependency changes.

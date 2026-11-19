# Drag a dataset onto form fields and the process editor

**State:** decided 2026-11-19, ready to implement
**Labels:** enhancement, frontend, jsoneditor, ProcessEditor, dnd
**Repos touched:** main (`frontend/` only)

## Context

The existing "drag a dataset onto a plot" feature (`docs/plans/done/drag-dataset-onto-plot.md`
plus the pin/incompatible-message follow-up) made every FlowView output box a
react-dnd drag source and PlotView the first — and so far only — drop consumer.
The generic wiring already exists in `frontend/src/dnd/` and the media-type
matcher in `frontend/src/jsoneditor/mediatypeMatch.js`.

This change adds **three more drop consumers** so a dataset handle can be dropped
not just onto plots but onto the places a user actually wires datasets into work:

1. **Dataset-reference form fields** (`x-format: "dataset"` → `DatasetSelector`,
   and `x-format: "datasetPath"` → `DatasetPathField`/`DatasetColumnCombobox`):
   drop sets the field value, but only if the field's type filter accepts the
   dataset.
2. **The ProcessEditor**: dropping a dataset onto the editor pops a menu of
   process types whose main dataset input accepts the dataset; picking one shows
   that type and sets its input field to the dropped dataset.

The outcome: a user drags an output box onto a field to fill it, or onto the
editor to start the right process pre-wired to that dataset — no manual
search-and-click.

## What already exists (reuse, do not rebuild)

- **Drag source + payload** — `frontend/src/dnd/datasetDnd.js`:
  `DATASET_DRAG_TYPE = 'dataset'`, `useDatasetDragSource(item)`,
  `useDatasetDrop(onDrop)`. Payload today:
  `{ datasetId, datasetPath, datasetName, processId, processVersion }`.
  Built in `frontend/src/widgets/FlowView/ProcessNode.jsx` (`DatasetOutputBox`,
  ~`:16`, `:147-167`); `datasetPath` is the pinned `<proc>.<ver>.<ds>` form.
- **Media-type matcher** — `frontend/src/jsoneditor/mediatypeMatch.js`:
  `rootPartMediatypes(ds)`, `datasetMatchesMediatypes(ds, spec)` (spec =
  `x-target-mediatypes`, OR-of-ANDs, absent → always true).
- **Pin-toggle menu** — `frontend/src/dnd/DatasetDropMenu.jsx`: cursor-anchored
  portal, `items` list + thumbtack header; `onPick(item, path)` where `path` is
  `pinnedPath` or `currentPath` per the toggle. Current-vs-other logic
  (`isCurrent`, `pinnedPath`, `currentPath`) lives in
  `PlotView/index.jsx` `handleDatasetDrop` (~`:149-153`) — the pattern to copy.
- **The two form widgets** already accept `targetMediatypes` and filter their
  own lists with `datasetMatchesMediatypes`: `DatasetSelector.jsx` (value = a
  dataset **URL**, set via `onChange(ds.url)`), `DatasetColumnCombobox.jsx`
  (value = a dotted **path**, set via `onChange(path)`). Wiring that passes
  `schema['x-target-mediatypes']` into both is in `CustomStringField.jsx`
  (`:23-31`, `:35-60`).
- **ProcessEditor** — `frontend/src/widgets/ProcessEditor.jsx`: `types` =
  `useEnvironmentProcessTypes(localEnvironment)` (name → `{ schema }`);
  `localType`/`setLocalType`, `formData`/`setFormData`, `activeProcess`,
  `currentProject` all in scope. Type schemas' dataset inputs use
  `x-format: "dataset"` (see `docs/plans/done/dataset-selector-mediatype-filter.md`).
- **Dataset dict lookup** — `useSearchDatasets('', true, currentProject)` returns
  all project datasets (each with `.id`, `.url`, `.parts`); already cached/shared
  (used this exact way in `DatasetColumnCombobox.jsx:16`). Drop targets resolve
  the dropped dict by `item.datasetId` from this list.

## Decisions (settled with user 2026-11-19)

- **D1 — Mismatch = no-drop cursor.** A field/editor that cannot accept the
  dragged dataset rejects it via react-dnd `canDrop`, so the HTML5 backend shows
  the browser no-drop cursor and the drop is refused (no-op). Requires extending
  `useDatasetDrop` to take an optional `canDrop(item)` predicate.
- **D2 — `datasetPath` fields use the same pin-toggle system as plots.** Dropping
  onto a `datasetPath` field: if the dropped output is the **active process's
  active version**, show `DatasetDropMenu` with a single confirm item and the pin
  toggle (default unpinned → `current.<ds>`); otherwise auto-apply the pinned
  `<proc>.<ver>.<ds>` path with no menu. Mirrors the plot "menu only when there's
  something to choose" rule.
- **D3 — `dataset` (URL) fields have no pin concept.** `DatasetSelector` stores
  an absolute dataset URL; a compatible drop sets it directly, no menu.
- **D4 — ProcessEditor drop = process-type menu.**
  - Candidates = process types in the current environment whose schema has a
    **main dataset input** (first property with `x-format` in
    `{"dataset","datasetPath"}` whose `x-target-mediatypes` matches the dropped
    dataset). 0 candidates → `canDrop` false (D1).
  - **1 candidate → auto-select, no menu.** **>1 → menu** listing the candidate
    types; the editor's current `localType` is **highlighted** if it is itself a
    candidate.
  - On selecting type **T** with matched field **F**:
    - **T === current `localType`** → keep `formData`, just set `formData[F] =
      value` (update input in place).
    - **T ≠ current** → `setLocalType(T)` and reset `formData` to `{ [F]: value }`
      (empty form + the dropped input).
  - `value` = `item.datasetUrl` when F is `x-format:"dataset"`; the pinned path
    when F is `x-format:"datasetPath"` (process-param datasetPath is rare; pin
    menu is not surfaced in the editor flow).

## Design

### A. Drag payload — carry the dataset URL

`DatasetSelector` stores a URL, which the payload lacks. In `ProcessNode.jsx` the
drag source already has `outputUrl = versionObj.outputs[name]` (`:150`). Add
`datasetUrl: outputUrl` to the `useDatasetDragSource` item (`DatasetOutputBox`
props + call site `:156-166`), and update the payload doc comment in
`datasetDnd.js:11`.

### B. Extend `useDatasetDrop` with `canDrop` and monitor (datasetDnd.js)

```js
export function useDatasetDrop(onDrop, canDrop) {
  const [, drop] = useDrop({
    accept: DATASET_DRAG_TYPE,
    canDrop: canDrop ? (item) => canDrop(item) : undefined,
    drop: (item, monitor) => {
      if (monitor.didDrop()) return;            // inner target already handled
      onDrop(item, monitor.getClientOffset(), monitor);
    },
  }, [onDrop, canDrop]);
  return drop;
}
```
`didDrop()` lets the ProcessEditor's outer target bail when a nested field target
consumed the drop. Existing PlotView caller (one arg) is unaffected.

### C. Shared drop helper (small, new) — `frontend/src/dnd/useDroppedDataset.js`

A tiny hook the field targets reuse to resolve the dropped dict + build the
`canDrop` predicate, avoiding duplication:

```js
// Returns { droppedDict(item), matches(item, spec) } over the cached project datasets.
export function useDatasetLookup() {
  const { currentProject } = useContext(ProcessContext);
  const { data: all = [] } = useSearchDatasets('', true, currentProject);
  const byId = useMemo(() => new Map(all.map(d => [d.id, d])), [all]);
  const droppedDict = useCallback(item => byId.get(item.datasetId) || null, [byId]);
  const matches = useCallback(
    (item, spec) => { const d = droppedDict(item); return d ? datasetMatchesMediatypes(d, spec) : false; },
    [droppedDict]);
  return { droppedDict, matches };
}
```
(`matches` returns **false** on a cache miss for `canDrop`, so an unknown dataset
is rejected rather than silently accepted — stricter than the list filters, which
is correct for a discrete drop action.)

### D. `DatasetSelector` as a drop target (D1, D3)

In `DatasetSelector.jsx`: call `useDatasetLookup()`; register
`const dropRef = useDatasetDrop(onDropHere, item => matches(item, targetMediatypes))`
and attach `ref={dropRef}` to the wrapper `<div>` (`:165`). `onDropHere(item)` →
`onChange(item.datasetUrl); setDisplayValue(...); setSearchText(...)`. The display
label can reuse the existing `getDataset`-based effect by letting the `value`
change drive it, or set it from the dropped dict directly.

### E. `DatasetColumnCombobox` as a drop target (D1, D2)

In `DatasetColumnCombobox.jsx` (the `mode="dataset"` path is what `datasetPath`
fields render): call `useDatasetLookup()` and `useContext(ProcessContext)` for
`activeProcess`. Register `useDatasetDrop(onDropHere, item => matches(item,
targetMediatypes))` on the wrapper `<div>` (`:170`). `onDropHere(item, offset)`:
```js
const isCurrent = item.processId === activeProcess?.processId
               && String(item.processVersion) === String(activeProcess?.version);
const pinnedPath  = item.datasetPath;
const currentPath = 'current.' + item.datasetPath.split('.')[2];
if (!isCurrent) { onChange(pinnedPath); return; }      // D2: no menu
setDropMenu({ x, y, pinnedPath, currentPath });        // D2: pin toggle
```
Render `DatasetDropMenu` with `pinnable` true, a single item (e.g.
`{ name: 'use', label: 'Use dataset' }`), `onPick=(_, path) => { onChange(path);
setDropMenu(null); }`. Only reached for `datasetPath` fields; `column`/`process`
modes get no drop target (unaffected).

### F. ProcessEditor as a drop target (D4)

New helper `frontend/src/widgets/ProcessEditor.datasetDrop.js` (or inline):
```js
// First dataset-input field of a process-type schema whose spec matches the dict.
export function mainDatasetInput(schema, dict) {
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    if (prop['x-format'] !== 'dataset' && prop['x-format'] !== 'datasetPath') continue;
    if (datasetMatchesMediatypes(dict, prop['x-target-mediatypes']))
      return { name, format: prop['x-format'] };
  }
  return null;
}
// Candidate types: [{ type, field }] over the environment's `types` map.
export function compatibleProcessTypes(types, dict) {
  const out = [];
  for (const [type, entry] of Object.entries(types || {})) {
    const field = entry?.schema ? mainDatasetInput(entry.schema, dict) : null;
    if (field) out.push({ type, field });
  }
  return out;
}
```
In `ProcessEditor.jsx`: `useDatasetLookup()`;
`const dropRef = useDatasetDrop(onEditorDrop, item => { const d = droppedDict(item);
return !!d && compatibleProcessTypes(types, d).length > 0; })`; attach `ref` to
the outer `<div className="container-fluid">` (`:303`). `onEditorDrop(item,
offset, monitor)` (the hook already skips when `monitor.didDrop()`):
```js
const dict = droppedDict(item); if (!dict) return;
const cands = compatibleProcessTypes(types, dict);
if (cands.length === 1) { applyCandidate(cands[0], item); return; }
setTypeMenu({ x, y, cands, item });   // >1 → menu, highlight localType
```
`applyCandidate({ type, field }, item)`:
```js
const value = field.format === 'dataset' ? item.datasetUrl : item.datasetPath;
if (type === localType) setFormData(fd => ({ ...fd, [field.name]: value }));
else { setLocalType(type); setFormData({ [field.name]: value }); }
```
**Type menu:** reuse `DatasetDropMenu` with the pin header suppressed (add a
`showPin={false}` prop so the thumbtack strip is omitted) and an optional
`highlightName` prop that bolds/box-outlines the item whose `name === localType`.
`items = cands.map(c => ({ name: c.type, label: typeTitle(c.type, types[c.type]) }))`
(reuse `typeTitle` from `ProcessTypeSelect.jsx`). `onPick(item) =>
applyCandidate(cands.find(c => c.type === item.name), menu.item)`.

## Files touched (main repo, `frontend/` only)

- `src/dnd/datasetDnd.js` — `useDatasetDrop(onDrop, canDrop)` + `didDrop` guard;
  payload doc comment (`datasetUrl`).
- `src/dnd/useDroppedDataset.js` — **new**: `useDatasetLookup()`.
- `src/dnd/DatasetDropMenu.jsx` — add `showPin` and `highlightName` props
  (backward compatible: default `showPin` true, no highlight).
- `src/widgets/FlowView/ProcessNode.jsx` — add `datasetUrl` to the drag item.
- `src/jsoneditor/DatasetSelector.jsx` — drop target (D1/D3).
- `src/jsoneditor/DatasetColumnCombobox.jsx` — drop target + pin menu (D1/D2).
- `src/widgets/ProcessEditor.jsx` — drop target + type menu (D4).
- `src/widgets/ProcessEditor.datasetDrop.js` — **new**: `mainDatasetInput`,
  `compatibleProcessTypes`.

No backend, flexout, migration, or dependency changes. No change to
`mediatypeMatch.js`, `compatibleLayerTypes`, or the drag source's core payload
shape (only an added field).

## Verification (manual, against a project with mixed datasets)

Prereqs: a project with an AEM data import, an AEM model (inversion output), and a
MAG line, plus an environment whose process types declare
`x-target-mediatypes` on their dataset inputs.

1. **Compatible field drop (URL).** Open a process whose schema has an
   `input_data` dataset field. Drag a matching output box onto that field → the
   field fills with the dataset (label shows `proc / vN / ds`); drag an
   incompatible dataset over it → no-drop cursor, drop refused.
2. **`datasetPath` field, pin toggle.** In a PlotView layer editor, drop the
   **active process/active version** output onto a `dataset` (datasetPath) field →
   pin menu appears; default writes `current.<ds>`, toggling the thumbtack writes
   `<proc>.<ver>.<ds>`. Drop an **other-process** output → no menu, pinned path
   written directly.
3. **Editor drop, single candidate.** With only one process type matching the
   dropped dataset's media type, drop onto the editor background → that type is
   selected, form reset, its input field set. No menu.
4. **Editor drop, multiple candidates.** Drop a dataset many types accept → menu
   lists them; if the editor's current type is among them it is highlighted.
   Picking the **current** type keeps the existing form values and just sets the
   input; picking a **different** type empties the form and sets the input.
5. **Editor: field vs background.** Dropping onto a dataset field *inside* the
   editor sets that field (type menu does **not** appear — `didDrop` guard);
   dropping onto editor chrome opens the type menu.
6. **Incompatible everywhere.** Drag a dataset no type/field accepts → no-drop
   cursor over every field and the editor; nothing changes on release.
7. **Regression.** Dropping onto a plot still works exactly as before; flexout
   pane/tab dragging is undisturbed.

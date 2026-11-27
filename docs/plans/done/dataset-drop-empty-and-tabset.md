# Drag a dataset onto an Empty pane or the tab bar

**State:** decided 2026-11-27, ready to implement
**Labels:** enhancement, frontend, flexout, PlotView, dnd
**Repos touched:** main (`frontend/` only)

## Context

Datasets can already be dragged (from FlowView output boxes) onto several drop
consumers — a plot (`docs/plans/done/drag-dataset-onto-plot.md`), form fields and
the process editor (`docs/plans/drag-dataset-onto-fields-and-editor.md`). All of
those consumers are **app-level** components that register their own
`useDatasetDrop` target.

This change adds **two more drop targets**, but both live in **flexout/**, which
must stay app-agnostic (per the flexout rule: "Do NOT implement project-specific
functions hard coded directly inside `flexout/`. If needed, new registration/hook
systems can be added."):

1. **The Empty pane** — dropping a dataset replaces the Empty placeholder with a
   new `PlotView`, and the dataset is dropped onto that new plot (so its layer
   picker / drop menu shows).
2. **The tab bar** — dropping a dataset to the right of the existing tabs (the
   trailing `+` area in a `TabSet` header) creates a new `PlotView` tab, activates
   it, and the dataset is dropped onto that new plot.

The outcome: a user can turn empty layout space — a blank pane or a new tab — into
a plot of a dataset in one drag, with the same layer-choice flow as dropping onto
an existing plot.

The hard part is architectural: a dataset drag carries a **dataset reference**
(`{ datasetId, datasetPath, … }`), **not** a layout node, and the target `PlotView`
**does not exist** at the moment the drag ends. So flexout needs (a) a generic way
to turn a non-pane drag into a layout node without knowing about datasets or
PlotView, and (b) a generic way to replay the original drop onto the newly-created
widget once it mounts.

## What already exists (reuse, do not rebuild)

- **Dataset drag + drop wiring** — `frontend/src/dnd/datasetDnd.js`:
  `DATASET_DRAG_TYPE = 'dataset'`, `useDatasetDragSource(item)`,
  `useDatasetDrop(onDrop, canDrop)`. Payload:
  `{ datasetId, datasetPath, datasetName, processId, processVersion, datasetUrl }`.
  The type is deliberately distinct from flexout's `'pane'`, so pane targets
  ignore datasets and vice-versa.
- **Dataset lookup** — `frontend/src/dnd/useDroppedDataset.js`: `useDatasetLookup()`
  → `{ droppedDict(item), matches(item, spec) }` over the cached project datasets
  (`useSearchDatasets('', true, currentProject)`). `droppedDict` returns the full
  dict (media types, parts) for an `item.datasetId`, or `null` on a cache miss.
- **Layer-type matcher** — `frontend/src/widgets/PlotView/datasetDrop.js`:
  `compatibleLayerTypes(dict, layers, data)` → array of candidate layer types a
  dataset can feed, filtered by media type and axis-conflict avoidance; `buildLayer`.
  Called in PlotView with `data` possibly `null`, so it tolerates a null data arg.
- **PlotView drop handling** — `frontend/src/widgets/PlotView/index.jsx`:
  - `handleDatasetDrop(item, offset)` (`:202-240`) — the full drop behavior: 0
    candidates → red status; exactly 1 candidate and a fixed pin → auto-append; else
    show the cursor-anchored `DatasetDropMenu` at `offset`.
  - `useDatasetDrop(handleDatasetDrop)` (`:242`) on the outer div — the live target.
  - `PlotView.get_default()` (`:732`) → `{ layoutConfig: { transforms: [], layers: [],
    axes: {}, statusBar: false } }`. `id` is a prop (`:97`).
- **Layout tree + mutation** — `frontend/src/flexout/LayoutContext.jsx`
  (`LayoutProvider`, `updateLayout`, the `widgets`/`data_context` injection pattern,
  `builtinWidgets` incl. `Empty` at `:17`), `components/Pane.jsx` (renders every
  widget via `<Widget parentUpdate={…} {...node} />` at `:329`; `node.widget ===
  'Empty'` is the placeholder), `components/TabSet.jsx` (`addTab` `:212`; the
  trailing `+` `<li>` `:262-264`; tab bodies render through `<Pane {...tab}/>` `:273`).
- **App wiring** — `frontend/src/App.jsx`: `AppWithContext` holds
  `processContext = useContext(ProcessContext)` and renders
  `<LayoutProvider widgets={widgets} … data_context={processContext}>` (`:163-212`);
  `PlotView` is already imported here.

## Decisions (settled with user 2026-11-27)

- **D1 — Generic converter seam.** flexout learns nothing about datasets or
  PlotView. The app injects an ordered list of **converters** via a new
  `LayoutProvider` `converters` prop (same channel as `widgets`). A converter is
  `{ accept, convert }` where `convert(item, dragType) => node | null`. On a
  non-`'pane'` drop onto a converter target, flexout tries converters in order and
  places the first non-null node; all-null → not droppable.
- **D2 — Replay via a *simulated drop*, never via persisted config.** The converter
  returns **only a node** (a bare PlotView). flexout holds the **original drop**
  itself — `{ item, dragType, offset }` — in a transient, memory-only ref-store
  keyed by the new node's id (never serialized, never a node field). A flexout hook
  `useSimulatedDrop(nodeId, onDrop)` delivers that stored drop **once on mount** to
  whatever widget registers a receiver by calling the hook. "If the target node
  component has a drop receiver" = it called `useSimulatedDrop`. A reloaded
  workspace is just an ordinary empty PlotView.
- **D3 — Incompatible dataset is refused.** The converter returns `null` when
  `compatibleLayerTypes(dict, [], null)` is empty (or the dict is unknown), so
  `canDrop` is false → the browser shows the no-drop cursor and nothing is created.
  This avoids an orphan empty plot (a fresh PlotView has its status bar off, so the
  existing "not compatible" red message would be invisible). Consistent with D1 of
  the sibling fields/editor plan.
- **D4 — Behavior mirrors a live plot drop.** PlotView replays the simulated drop
  through its **existing** `handleDatasetDrop`, so the "1 candidate + fixed pin →
  auto-append, otherwise show the menu" rule is identical to dropping onto an
  existing plot. This is exactly "drop onto it so its drop menu shows."
- **D5 — Target geometry.** The Empty target is the Empty pane **body** (replace
  self with the PlotView node). The tab-bar target is the trailing `+` **header
  `<li>`** (right of the existing tabs; add a new PlotView tab and activate it).
  The existing `+` click (add an Empty tab) is kept. Both targets show a drag-over
  highlight, gated on `canDrop` so an incompatible drag does not highlight.
- **D6 — flexout owns the node id.** flexout assigns the id at placement time and
  keys the simulated-drop store to that same id; placement preserves it (a tab-add
  path that does not re-generate the id). No "preserve the converter's id" rule and
  no fragility from `addTab` re-id'ing.

## Design

### A. flexout: converter registry + simulated-drop store — `LayoutContext.jsx`

`LayoutProvider` gains a `converters` prop (default `[]`) and a transient store:

```js
export const LayoutProvider = ({ children, widgets, initial_layout, data_context, converters = [] }) => {
  // …existing layout state…
  const simulatedDrops = useRef(new Map());          // nodeId -> { item, dragType, offset }
  const setSimulatedDrop  = useCallback((id, drop) => { simulatedDrops.current.set(id, drop); }, []);
  const takeSimulatedDrop = useCallback((id) => {
    const d = simulatedDrops.current.get(id);
    simulatedDrops.current.delete(id);               // consume-once
    return d;
  }, []);

  const contextValue = useMemo(() => ({
    widgets: allWidgets, layout, updateLayout, data_context: data_context || {},
    findWidgetPaths: (t) => findWidgetPaths(layout, t), activatePath,
    converters, setSimulatedDrop, takeSimulatedDrop,     // ← new
  }), [allWidgets, layout, updateLayout, data_context, activatePath, converters, setSimulatedDrop, takeSimulatedDrop]);
  // …
};
```

The store is a `useRef(Map)` (not state) so writing it never re-renders; entries
are tiny, keyed by unique uuids, consumed on mount, and gone on reload.

### B. flexout: the two generic hooks — `flexout/converterDrop.js` (new)

```js
// Drop target that turns a non-'pane' drag into a layout node via the injected
// converters, stashes the ORIGINAL drop for replay, and places the node.
// `place(node)` is supplied by the caller (Empty → replace self; TabSet → add tab).
export function useConverterDrop(place) {
  const { converters, setSimulatedDrop } = useContext(LayoutContext);
  const accept = useMemo(
    () => [...new Set(converters.flatMap(c => [].concat(c.accept)))],
    [converters]);
  const build = useCallback((item, dragType, offset) => {
    for (const c of converters) {
      if (![].concat(c.accept).includes(dragType)) continue;
      const node = c.convert(item, dragType);
      if (node) return { node, offset };
    }
    return null;
  }, [converters]);

  const [{ isOver }, drop] = useDrop({
    accept: accept.length ? accept : '__none__',
    canDrop: (item, m) => !!build(item, m.getItemType(), null),
    drop: (item, m) => {
      if (m.didDrop()) return;
      const built = build(item, m.getItemType(), m.getClientOffset());
      if (!built) return;
      const id = uuidv4();
      const finalNode = { ...built.node, id };          // D6: flexout owns the id
      setSimulatedDrop(id, { item, dragType: m.getItemType(), offset: built.offset });
      place(finalNode);
      return {};
    },
    collect: (m) => ({ isOver: m.isOver({ shallow: true }) && m.canDrop() }),
  }, [accept, build, place, setSimulatedDrop]);

  return { drop, isOver };
}

// Receiver side: a widget opts in to receive the simulated drop for its node.
export function useSimulatedDrop(nodeId, onDrop) {
  const { takeSimulatedDrop } = useContext(LayoutContext);
  const onDropRef = useRef(onDrop); onDropRef.current = onDrop;
  useEffect(() => {
    const d = takeSimulatedDrop(nodeId);                // consume-once on mount
    if (d) onDropRef.current(d.item, d.dragType, d.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
}
```

`canDrop` passes a `null` offset — it only needs the yes/no, and converters are
cheap/pure (dict lookup + `compatibleLayerTypes`). `getItemType()` lets one target
host several converter types; here it is just `'dataset'`.

### C. flexout: wire the Empty target — `components/Pane.jsx`

When the pane is the Empty placeholder, wrap its body in a converter-drop target
that replaces the Empty node with the produced PlotView node. This is a **separate**
element from the existing `'pane'`-move drop on the outer div, so the two react-dnd
targets never conflict.

```js
const replaceSelf = useCallback(
  (newNode) => { parentUpdate ? parentUpdate('replace', node.id, newNode) : updateLayout(newNode); },
  [parentUpdate, node.id, updateLayout]);
const { drop: convDrop, isOver: convOver } = useConverterDrop(replaceSelf);
const isEmpty = node.widget === 'Empty';
// …render…
<WidgetErrorBoundary widgetName={node.widget} node={node}>
  {isEmpty ? (
    <div ref={convDrop} className={`h-100${convOver ? ' converter-drop-over' : ''}`}>
      <Widget parentUpdate={parentUpdate} {...node} … />
    </div>
  ) : (
    <Widget parentUpdate={parentUpdate} {...node} … />
  )}
</WidgetErrorBoundary>
```

`useConverterDrop` is always called (hooks rules); it only activates its DOM target
when `isEmpty` attaches the ref. (If simpler in review, call the hook
unconditionally and attach the ref only in the Empty branch — same effect.)

### D. flexout: wire the tab-bar target — `components/TabSet.jsx`

Attach a converter-drop to the trailing `+` `<li>`, adding the produced node as a
new active tab **without re-id'ing** it (D6):

```js
const addConvertedTab = useCallback((tabNode) => {
  parentUpdate('replace', node.id, {
    ...node, children: [...node.children, tabNode], activeTab: tabNode.id,
  });
}, [parentUpdate, node]);
const { drop: convDrop, isOver: convOver } = useConverterDrop(addConvertedTab);
// …in the header <ul>, after the mapped TabHeaders:
<li ref={convDrop} className={`nav-item${convOver ? ' converter-drop-over' : ''}`}>
  <button className="nav-link tab-mini" onClick={() => addTab({ id: uuidv4(), widget: 'Empty' })}>+</button>
</li>
```

The existing `+` click (add an Empty tab) is unchanged; the `<li>` merely also
becomes a dataset drop zone. The TabSet body's existing `'pane'` drop is untouched.

### E. app: the dataset → PlotView converter — `App.jsx` (`AppWithContext`)

`AppWithContext` already has `ProcessContext` and imports `PlotView`; build the
converter there (reusing `useDatasetLookup`) and pass it to `LayoutProvider`.

```js
import { DATASET_DRAG_TYPE } from './dnd/datasetDnd';
import { useDatasetLookup } from './dnd/useDroppedDataset';
import { compatibleLayerTypes } from './widgets/PlotView/datasetDrop';
// …
function AppWithContext({ widgets }) {
  const processContext = useContext(ProcessContext);
  const { droppedDict } = useDatasetLookup();
  const converters = useMemo(() => [{
    accept: DATASET_DRAG_TYPE,
    convert: (item) => {
      const dict = droppedDict(item);
      if (!dict || compatibleLayerTypes(dict, [], null).length === 0) return null;  // D3
      return { widget: 'PlotView', ...PlotView.get_default() };                     // D1/D2: bare node
    },
  }], [droppedDict]);

  return (
    <LayoutProvider widgets={widgets} initial_layout={{ id: 'root', widget: 'Empty' }}
                    data_context={processContext} converters={converters}>
      …
    </LayoutProvider>
  );
}
```

The converter is pure and returns only a node — no layer, no payload. The layer
choice happens later, in the mounted PlotView via the simulated drop. (`import`
path for `compatibleLayerTypes` is `./widgets/PlotView/datasetDrop`.)

### F. app: PlotView receives the simulated drop — `PlotView/index.jsx`

Add a receiver alongside the existing live `useDatasetDrop`. Because
`handleDatasetDrop` needs the dataset cache loaded (it resolves the dict from
`allDatasets`), gate the replay behind a ready-check so it fires once the cache is
available rather than being lost on an early mount:

```js
import { useSimulatedDrop } from '../../flexout/converterDrop';
// …inside PlotView…
const simDropRef = useRef(null);
useSimulatedDrop(id, (item, _dragType, offset) => { simDropRef.current = { item, offset }; });
useEffect(() => {
  const d = simDropRef.current;
  if (!d) return;
  if (!(allDatasets || []).some(x => x.id === d.item.datasetId)) return;  // wait for cache
  simDropRef.current = null;
  handleDatasetDrop(d.item, d.offset);
}, [allDatasets, handleDatasetDrop]);
```

`handleDatasetDrop` is already memoized on `[allDatasets, activeProcess]`, so the
effect re-runs when the cache arrives. The menu (if shown) anchors at the stored
`offset` (the cursor position where the dataset was released).

### G. CSS — `converter-drop-over`

A small highlight class (mirror the existing `tab-drop-target` treatment, e.g. a
tinted background / dashed outline) in the relevant flexout stylesheet.

## Files touched (main repo, `frontend/` only)

- `src/flexout/LayoutContext.jsx` — `LayoutProvider` `converters` prop; transient
  `simulatedDrops` ref-store with `setSimulatedDrop`/`takeSimulatedDrop`; expose the
  three in the context value.
- `src/flexout/converterDrop.js` — **new**: `useConverterDrop(place)` and
  `useSimulatedDrop(nodeId, onDrop)`.
- `src/flexout/components/Pane.jsx` — Empty-pane body as a converter-drop target
  (replace self); highlight.
- `src/flexout/components/TabSet.jsx` — trailing `+` `<li>` as a converter-drop
  target (add active tab, no re-id); highlight. Existing `+` click and body
  `'pane'` drop unchanged.
- `src/App.jsx` — build the dataset → PlotView converter (via `useDatasetLookup` +
  `compatibleLayerTypes` + `PlotView.get_default`) and pass `converters` to
  `LayoutProvider`.
- `src/widgets/PlotView/index.jsx` — `useSimulatedDrop` receiver + ready-gated
  replay through the existing `handleDatasetDrop`.
- flexout stylesheet — `.converter-drop-over` highlight.

No backend, migration, or dependency changes. No change to the drag source, the
dataset payload, `datasetDnd.js`, `useDroppedDataset.js`, `DatasetDropMenu.jsx`,
`compatibleLayerTypes`/`buildLayer`, or the workspace schema (the produced nodes are
ordinary `PlotView`/`Empty` nodes; nothing new is persisted).

## Verification (manual, against a project with mixed datasets)

Prereqs: a project with at least one plottable dataset (e.g. an AEM import or a MAG
line) and one dataset no plot layer accepts, plus a workspace with an Empty pane and
a TabSet.

1. **Empty pane, compatible.** Drag a plottable dataset onto an Empty pane → the
   pane becomes a PlotView and the layer drop menu appears (or, for a single
   fixed-pin candidate, the layer is appended directly), exactly as when dropping
   onto an existing plot.
2. **Empty pane, incompatible.** Drag a non-plottable dataset over an Empty pane →
   no-drop cursor, no highlight, nothing created on release.
3. **Tab bar, compatible.** Drag a plottable dataset onto the `+` area to the right
   of a TabSet's tabs → a new PlotView tab is created and activated, and its drop
   menu appears for the dataset.
4. **Tab bar, incompatible.** Drag a non-plottable dataset over the `+` area →
   no-drop cursor, no new tab.
5. **Pin toggle / candidate count.** Drop the active process's active-version output
   → menu with the pin toggle; drop another process/version output with one
   candidate → appended directly, no menu — matching live-plot behavior.
6. **Persistence.** After creating a plot via either target, reload the workspace →
   the plot persists as an ordinary PlotView; the drop menu does **not** re-appear
   (nothing ephemeral was saved).
7. **Regressions.** The `+` button still adds an Empty tab on click; dragging a
   *pane*/tab onto an Empty pane or a TabSet still works (pane-move unaffected);
   dropping a dataset onto an existing plot still works; dataset drops onto form
   fields / the process editor still work.

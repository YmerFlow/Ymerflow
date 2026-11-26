# Process Overview — Tree (Forest) Display Mode

## Goal

Give the **Processes overview** widget (`FlowView`) a second, mostly text-based display mode.

A new config field **`Graph`** (boolean, default `true`) selects the mode:

- **`Graph = true`** (default): the widget looks and behaves exactly as today — the ReactFlow
  process graph.
- **`Graph = false`**: the widget renders a **forest of trees**. Roots are processes with no
  input (no dependencies in their selected version). Children are the processes downstream of a
  node (processes whose selected version consumes one of this node's outputs). Because the
  dependency DAG can contain diamonds, the **same process may appear in several places in the
  forest — that is expected and fine**.

Tree-mode behaviour:

- Branches **open/collapse on click**. The path from a root down to the **currently active
  process** is always kept expanded.
- Each node row shows: **name**, a **version dropdown**, a **status pill** (an empty colored pill
  — same colors as graph mode, the status text shown on mouseover), and an **info icon**.
- Clicking the info icon opens a small **popup** showing: process **type**, **input** datasets
  and **output** datasets (shown separately), and the **tags / tag editor** exactly as on graph
  nodes. **Output** datasets are **draggable** (same drag payload as graph mode); input datasets
  are display-only. Clicking **outside** the popup closes it.

## Design decisions (confirmed with user)

1. **Status pill color for failed state** — *Add a failed color.* Graph mode's `StateBadge`
   currently maps only `queued`/`starting`/`running`/`done` and renders **nothing** for any other
   state (including `failed`). We extend the shared mapping with a `failed → bg-danger` (red)
   entry, labelled "Failed". `StateBadge` is shared with `ClusterQueueView/QueueCard`, so graph
   mode and the cluster-queue view gain the red "Failed" badge too — this is the intended
   single-source-of-truth behaviour.
2. **Version dropdown change** — *Reuse graph propagation.* Changing a node's version in tree
   mode runs the same up/down version-selection propagation as graph mode, and syncs
   `activeProcess`. The visible forest can therefore change as a result (same mental model as the
   graph).
3. **Info popup datasets** — *Show inputs and outputs separately; only outputs draggable.* Outputs
   reuse the existing dataset drag payload. Inputs are listed (param name + source) but are not
   drag sources.
4. **Shared derivation** — *Extract a shared hook.* The version-selection propagation + dependency
   maps + the `datasetColorById` map are extracted into `useProcessGraphModel`; graph mode is
   refactored to consume it (one source of truth). Graph mode's ReactFlow layout/render is
   otherwise untouched.
5. **Expand/collapse persistence** — *Ephemeral.* Expand state lives in React state only; it is
   **not** persisted (not to widget config, IndexedDB, localStorage, or the backend). It resets on
   reload. The always-expanded active-process path is recomputed each render regardless.
6. **Dataset colors in tree** — *Same colors as graph mode.* The tree popup's draggable output
   chips are colored by the same `datasetColorById` map graph mode uses (now provided by the
   shared hook).

## Background & current state

### The widget

`frontend/src/widgets/FlowView/index.jsx` (`FlowView`, default export, registered in `App.jsx` as
`{ name: 'FlowView', component: FlowView }`, `FlowView.title = "Processes overview"`). It is today
a single component that:

- Reads `processes`, `activeProcess`, `setActiveProcess`, `currentProject`, `isLoading` from
  `ProcessContext`.
- Derives, from each process's **selected version's** `dependencies[]`
  (`source_process_id`, `source_process_version`, `source_dataset_name`, `target_param_name`):
  - **version-selection propagation** — `computeVisibleVersions()`, `propagate()`,
    `initialise()`, `handleVersionChange()` (seed latest visible version per sink, override with
    `activeProcess`, DFS up to sources and down to sinks);
  - **depths / roots** — `calculateDepths()` builds an `upstreamMap`; a process with no upstream
    is a root (`depth 0`);
  - **edges** — one edge per dependency whose source's selected version matches.
- Lays nodes out by depth (or persisted `flow_x`/`flow_y`) and renders `<ReactFlow>` with the
  `processNode` node type → `ProcessNode.jsx`.
- Persists its one existing config field, `selectedFilterTagNames` (tag filter bar), as a
  **top-level node field** via `parentUpdate('replace', nodeProps.id, { ...nodeProps, ... })`.

`FlowView` currently has **no `get_schema`** — it is a plain leaf widget.

### The node renderer (`ProcessNode.jsx`)

`ProcessNode` renders, from `data`: the process **name**, the **version `<select>`**
(→ `onVersionChange`), a `<StateBadge state={versionObj.state} />`, the process **type**
(`versionObj.type`), a `<TagSelector variant="node-bottom">`, input-param labels on the left edge
(ReactFlow target `Handle`s), and **output dataset boxes** on the right edge
(`DatasetOutputBox`).

`DatasetOutputBox` (defined inside `ProcessNode.jsx`):
- is a **dataset drag source** via `useDatasetDragSource({ datasetId, datasetPath, datasetName,
  processId, processVersion })` (`frontend/src/dnd/datasetDnd.js`, drag type `'dataset'`);
- **also embeds a ReactFlow `<Handle>`** for drawing graph edges. **This is why it cannot be
  reused as-is in the tree popup** — `<Handle>` requires ReactFlow context, which the popup does
  not have. The tree needs a plain draggable chip that reuses only `useDatasetDragSource`.
- `datasetPath = \`${encodeSeg(process.name)}.${selectedVersion}.${encodeSeg(name)}\``,
  `datasetId = outputUrl.split('/').pop()`.

### Config form mechanism

A widget that defines `get_schema()` (+ optional `get_default()`) gets a "Configure" modal
(`Pane.jsx`) rendering an RJSF form from `Widget.get_schema(data_context)`; on submit it does
`parentUpdate('replace', node.id, formData)`. The form keeps formData fields not in the schema
(no `omitExtraData`), so adding a `get_schema` with just `Graph` will **not** drop the existing
`selectedFilterTagNames` field. Reference: `ProcessInfo.get_schema`/`get_default` for the minimal
pattern, including the read-only `id` and `widget` envelope properties.

### State / active process

`activeProcess` is derived from the URL (`ProcessContext`); `setActiveProcess({ processId,
version })` navigates. Graph mode highlights the node whose `process.id === activeProcess.processId`
and clicking a node calls `setActiveProcess`.

---

## Implementation

Per the user's guidance, the widget becomes a **thin wrapper over two mode components**, with the
graph mode being essentially today's component moved unchanged.

### 1. Shared derivation hook — `FlowView/useProcessGraphModel.js` (new)

Extract the pure, mode-independent derivation currently inlined in `FlowView/index.jsx` into a
hook so both modes share **identical** version-selection semantics (decision 2). It owns:

- `processes` (from context) and tag-filter visibility (`computeVisibleVersions`,
  `visibleVersionsByProcess`, filtered by `selectedFilterTagNames`);
- `selectedVersions` state + `propagate`, `initialise`, `handleVersionChange`, and the
  `activeProcess` sync effect;
- `upstreamMap` / **`downstreamMap`** (new: inverse of `upstreamMap`, i.e. for each process the
  set of processes whose selected version depends on it) and **`roots`** (processes whose selected
  version has no dependencies).

Returns everything both modes need. **Graph mode is refactored only to the extent of consuming
this hook instead of its inline copies** — the ReactFlow layout/render is untouched. This keeps
one source of truth for propagation. It also owns the **`datasetColorById`** map (built as graph
mode builds it today) so the tree popup's output chips get the same colors (decision 6).

### 2. Wrapper — `FlowView/index.jsx`

Shrinks to:

- `FlowView.title = "Processes overview"`, `FlowView.get_default = () => ({ Graph: true })`,
  `FlowView.get_schema = () => ({ type:'object', properties: { id:{…readOnly}, widget:{…readOnly},
  Graph:{ type:'boolean', title:'Graph', default:true } } })`.
- Component body: read `Graph` from props (default `true`), then render
  `Graph ? <ProcessGraphView {...props}/> : <ProcessTreeView {...props}/>`. The tag filter bar
  (`TagFilterBar` + `selectedFilterTagNames` persistence) stays with the wrapper so both modes
  share it (it already drives `visibleVersions`, which both modes use for the version dropdown).

### 3. Graph mode — `FlowView/ProcessGraphView.jsx` (moved)

The current `FlowView` component body (ReactFlow + layout) moves here essentially verbatim,
consuming `useProcessGraphModel` for the derived state. No behavioural change.

### 4. `StateBadge.jsx` — extend + empty-pill support (decision 1)

- Add `failed: { cls: 'bg-danger', label: 'Failed' }` to `STATE_BADGES`.
- Add an **`empty`** prop: when set, render `<span className={\`badge ${cls}\`} title={label}
  style={{ ... }}>` with **no text content** (a small fixed-size colored pill) and the label in
  `title` (native mouseover tooltip). Graph mode keeps calling `<StateBadge state={…}/>`
  (text pill, unchanged); tree mode calls `<StateBadge state={…} empty/>`. Unmapped states still
  render nothing in both forms.

### 5. Tree mode — `FlowView/ProcessTreeView.jsx` (new)

- Consumes `useProcessGraphModel` → `roots`, `downstreamMap`, `selectedVersions`,
  `visibleVersionsByProcess`, `handleVersionChange`; and `activeProcess`/`setActiveProcess` from
  context.
- **Rendering the forest**: recursive `<TreeNode>` starting from each root. A node's children are
  `downstreamMap[processId]` (processes whose selected version consumes one of this node's
  outputs). Guard against revisiting an ancestor on the current path (DAG → no cycles, but belt &
  suspenders) so a diamond re-expands as a fresh subtree rather than looping.
- **Node identity = tree path**, not process id (a process can appear in multiple places). Expand
  state is a `Set` of path keys (`\`${ancestorPath}/${processId}\``), held in **ephemeral React
  state** (decision 5 — not persisted anywhere; resets on reload). Clicking a node's disclosure
  toggles its path key.
- **Always-expanded current path**: compute the path(s) from a root to `activeProcess.processId`
  and force every prefix expanded (union with the user's toggles) on each render.
- **Node row** (mostly text): a disclosure caret (if it has children), the process **name**, the
  **version `<select>`** (same options filtered by `visibleVersionsForProcess`, `onChange →
  handleVersionChange`, `stopPropagation` so it doesn't toggle/close), the **status pill**
  (`<StateBadge state={versionObj.state} empty/>`), and an **info icon** button. Clicking the row
  (not the controls) calls `setActiveProcess({ processId, version })`; the active node is
  visually marked (same accent as graph: `#2269A7`).

### 6. Info popup — `FlowView/ProcessInfoPopover.jsx` (new)

Opened by the info icon, positioned near it (absolute, within the tree container; a simple fixed
popover is sufficient). Closes on **outside click** (a `mousedown` listener on `document` that
closes unless the target is inside the popover or the triggering icon) and on `Escape`. Contents:

- **Type**: `versionObj.type`.
- **Inputs** (display-only): list `versionObj.dependencies` as `target_param_name ← source`
  (source process name + `source_dataset_name`), non-draggable.
- **Outputs** (draggable): one chip per `Object.keys(versionObj.outputs)`, each a new
  `DraggableDataset` chip — a plain component using `useDatasetDragSource({ datasetId, datasetPath,
  datasetName, processId, processVersion })` with the **same** `datasetId`/`datasetPath`
  computation as `DatasetOutputBox`, but **without** the ReactFlow `<Handle>`. Colored by the
  shared `datasetColorById` map, same as graph mode (decision 6).
- **Tags**: `<TagSelector variant="inline" processId version currentTags={versionObj.tags}
  projectId={currentProject}/>` — identical editing behaviour to graph nodes.

Only one popover open at a time (track open node-path in `ProcessTreeView`).

---

## Files

**New**
- `frontend/src/widgets/FlowView/useProcessGraphModel.js` — shared derivation/version-selection hook.
- `frontend/src/widgets/FlowView/ProcessGraphView.jsx` — current graph component, moved.
- `frontend/src/widgets/FlowView/ProcessTreeView.jsx` — forest renderer + `TreeNode`.
- `frontend/src/widgets/FlowView/ProcessInfoPopover.jsx` — info popup.
- `frontend/src/widgets/FlowView/DraggableDataset.jsx` — Handle-free draggable dataset chip (shared
  drag payload).

**Changed**
- `frontend/src/widgets/FlowView/index.jsx` — thin wrapper + `get_schema`/`get_default`/title.
- `frontend/src/widgets/FlowView/StateBadge.jsx` — add `failed`/`bg-danger`; add `empty` prop.

**Unchanged / reused**
- `ProcessNode.jsx`, `TagSelector.jsx`/`TagInput.jsx`/`TagBadge.jsx`, `datasetDnd.js`,
  `mimeColors.js`, `datasetPath.js`.

## Resolved decisions (all confirmed)

All design questions are settled (see **Design decisions** above):

1. Shared-hook extraction — **yes**, graph mode consumes `useProcessGraphModel`.
2. `StateBadge` shared `failed → bg-danger` red "Failed" badge (also appears in graph + cluster
   queue views) — **yes, intended**.
3. Expand/collapse — **ephemeral**, not persisted.
4. Dataset colors in tree — **same colors as graph mode** via the shared `datasetColorById`.

## Risks / notes

- Moving graph mode's inline derivation into `useProcessGraphModel` is the one change that touches
  existing graph behaviour; it must be a faithful move (same `propagate`/`initialise`/depths/
  edges), verified by eyeballing graph mode still renders and version propagation still works.

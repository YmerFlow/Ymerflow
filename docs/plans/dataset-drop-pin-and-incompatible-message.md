# Dataset-drop: pin control + incompatible-dataset message

**State:** decided 2026-11-18, ready to implement
**Labels:** enhancement, frontend, PlotView, drag-and-drop, status-bar
**Repos touched:** main (`frontend/`)

## Motivation

The recently added "drag a dataset onto a plot" feature
(`823923a`/`8f0c718` "Dataset dragging") has three gaps:

1. **Silent failure on incompatible drops.** When no layer type can accept the
   dragged dataset, the drop handler is a no-op
   (`PlotView/index.jsx:111` — `if (cands.length === 0) return;`). The user gets
   no feedback that the drop was rejected.
2. **No control over pin vs. current.** A layer's dataset reference is stored
   either as `current.<ds>` (follows the active process/version) or as the
   pinned `<procName>.<version>.<ds>` (a fixed other-process output). The drag
   source always produces the **pinned** form
   (`FlowView/ProcessNode.jsx:154`), so dropping an output of the *active*
   process pins it instead of letting the layer track "current". There is no UI
   to choose.
3. **No pin affordance in the drop menu.** The `DatasetDropMenu`
   (`dnd/DatasetDropMenu.jsx`) is a plain list of layer-type buttons.

## Decisions (agreed with user)

### D1 — Incompatible drop → red status-bar message
When `compatibleLayerTypes(...)` returns `[]`, show the message
**"Dataset not compatible with existing layers"** in the existing readout bar,
using the **pick** slot, and turn the **whole bar's background** red.

- The **pick** slot (not coords) because coords is overwritten by the next
  mouse-move within milliseconds, whereas pick persists until the next click.
- The red clears when **a new pick is selected** (user clicks a point) **or a
  new layer is successfully added** — both publish a `pick` value with no color.

### D2 — Bar background color model (generalised, both bars)
Add a color channel to each readout slot. Applies to **both** the shared
`PlotStatusBar` and each plot's own `config.statusBar` mirror.

- Two channels: `coordsColor` (travels with `coords`) and `pickColor` (with
  `pick`).
- **Precedence for the whole-bar `background`:** `pickColor ?? coordsColor ??
  default` (`#f8f9fa`).
- **Color is set as background, not text color**, for the entire bar — dark text
  (`#495057`) stays unchanged.
- **Each channel clears itself:** whenever a slot's *value* is published, that
  slot's color becomes whatever color came with it (so a value with no color
  clears that slot's color). A normal mouse-move (`{coords}`, no color) clears
  the coords color; a normal click (`{pick}`, no color) clears the pick color
  (and thus the red error).
- Error red = **`#f8d7da`** (light danger; keeps the dark text readable). Easy
  to adjust.
- The coords-color channel has **no producer today**; it is implemented for
  symmetry/future use ("while we're at it").

### D3 — Pin icon in the drop menu
`DatasetDropMenu` gets a **pin icon (Font Awesome `fa-thumbtack`) in the top
right**. Its behaviour depends on whether the dragged dataset belongs to the
**current process** (see D4):

- **Current process** → pin is **interactive**, **unpinned by default**.
  - *Unpinned* ⇒ the layer's dataset path is `current.<ds>` (process name
    replaced by `current`; version dropped).
  - *Pinned* ⇒ the full `<procName>.<version>.<ds>` path.
- **Other process** → pin is **always pinned and greyed out** (disabled). Path
  is always the full pinned `<procName>.<version>.<ds>`.

### D4 — "Current process" = same process AND same version
The pin is toggleable / unpinned-by-default **only** when the dragged dataset is
the **active process's active version** — exactly what `current.<ds>` resolves
to (active process, active version, part selected in the top bar). Any other
process, **or a non-active version of the active process**, is treated as
"other" → pin forced on + greyed. This guarantees an unpinned layer always shows
the data that was actually dragged.

### D5 — When is the menu shown? (single-candidate rule)
The menu exists to let the user pick a layer type **and** to expose the pin
toggle. So:

| candidates | current process (pin toggleable) | other process (pin fixed) |
|-----------:|----------------------------------|---------------------------|
| **0**      | red error message (D1)           | red error message (D1)    |
| **1**      | **show menu** (for the toggle)   | **auto-append** (no menu) |
| **>1**     | show menu                        | show menu (greyed pin)    |

I.e. the auto-append shortcut survives only when there is nothing to choose:
exactly one candidate **and** the pin is not adjustable.

## What exists today

### Drop handling (`frontend/src/widgets/PlotView/index.jsx:103-129`)
```js
const handleDatasetDrop = useCallback((item, offset) => {
  const dict = (allDatasets || []).find(d => d.id === item.datasetId);
  if (!dict) return;
  const layers = configPropRef.current?.layers || [];
  const data = plotDataRef.current;
  const cands = compatibleLayerTypes(dict, layers, data);
  if (cands.length === 0) return;                 // ← D1: becomes red message
  if (cands.length === 1) {                        // ← D5: gated on pin-fixed
    appendLayerRef.current(buildLayer(cands[0], item.datasetPath, data));
    return;
  }
  setDropMenu({ x, y, datasetPath: item.datasetPath, items: ... });  // ← D3/D4
}, [allDatasets]);
```
`handleDropPick` (`:126`) appends `buildLayer(item, dropMenu.datasetPath, …)`.
`buildLayer` (`PlotView/datasetDrop.js:67`) just writes the given path into the
layer's `x-format: datasetPath` field.

### Drag payload (`frontend/src/dnd/datasetDnd.js`, `FlowView/ProcessNode.jsx`)
Payload today: `{ datasetId, datasetPath, datasetName }`, where `datasetPath =
`${encodeSeg(process.name)}.${selectedVersion}.${encodeSeg(name)}`` (pinned
form, `ProcessNode.jsx:154`). `DatasetOutputBox` (`ProcessNode.jsx:16`) has
`process.id` and `selectedVersion` in scope.

### Path forms (`frontend/src/datamodel/datasetPath.js`)
`current.<dsName>[.col…]` vs `<procName>.<version>.<dsName>[.part][.col…]`. Name
segments are `encodeSeg`'d (dots → commas). The unpinned path is therefore
`current.<encodeSeg(dsName)>` — reuse the already-encoded 3rd segment of
`datasetPath`, no re-encoding needed.

### "Current process" (`frontend/src/ProcessContext.jsx`)
`activeProcess = { processId, version }` (`:131`, `:549`), already in
`ProcessContext`. PlotView does **not** destructure it yet (`:31-32`).

### Readout bar (`plotReadoutStore.js`, `PlotStatusBar.jsx`, per-plot mirror)
- Store (`plotReadoutStore.js`): `publish(obj)` broadcasts; subscriber updates
  only the keys present.
- Shared bar (`PlotStatusBar.jsx:14-18`): subscribes, sets `coordsRef`/`pickRef`
  `.textContent`. Outer div background `#f8f9fa`, text `#495057` (`:29,33`).
- Per-plot mirror (`index.jsx:462-477`, gated on `config.statusBar`): identical
  markup; written **imperatively** in the gladly handlers via
  `statusCoordsRef`/`statusPickRef` (`:176`, `:209`) — **not** via the store.
- Producers: mouse-move `publishReadout({ coords })` (`:177`), click
  `publishReadout({ pick })` (`:210`).

### Icons
No `react-icons`. Font Awesome Free is global (`index.jsx:10`); the app renders
`<i className="fas fa-…" />`. Pin = `fas fa-thumbtack`.

## Implementation

### 1. Readout color channel (D1, D2)

**`plotReadoutStore.js`** — no code change needed (payload is opaque); update the
doc comment to mention `coordsColor`/`pickColor`.

**`PlotStatusBar.jsx`** — track two color refs; recompute background on every
message:
```js
const barRef = useRef(null);
const colorsRef = useRef({ coords: undefined, pick: undefined });
const DEFAULT_BG = '#f8f9fa';
useEffect(() => subscribeReadout(({ coords, coordsColor, pick, pickColor }) => {
  if (coords !== undefined) { coordsRef.current.textContent = coords;
                              colorsRef.current.coords = coordsColor; }
  if (pick   !== undefined) { pickRef.current.textContent   = pick;
                              colorsRef.current.pick   = pickColor; }
  if (barRef.current)
    barRef.current.style.background =
      colorsRef.current.pick ?? colorsRef.current.coords ?? DEFAULT_BG;
}), [subscribeReadout]);
```
Attach `barRef` to the outer `<div>`; keep its static `background` as the
default.

**Per-plot mirror (`index.jsx`)** — the mirror is written imperatively, so give
it the same treatment with a `statusBarRef` outer-div ref + a
`statusColorsRef = useRef({ coords: undefined, pick: undefined })` and a tiny
local `applyStatusBg()` helper that sets
`statusBarRef.current.style.background = pick ?? coords ?? DEFAULT_BG`. Call it
wherever the mirror text is set:
- mouse-move handler (`:176`): `statusColorsRef.current.coords = undefined;
  applyStatusBg()`.
- click handler (`:209`): `statusColorsRef.current.pick = undefined;
  applyStatusBg()`.
- incompatible-drop (new, below): `statusColorsRef.current.pick = ERROR_BG;
  statusPickRef.current.textContent = ERROR_MSG; applyStatusBg()`.

Define module constants:
`const ERROR_MSG = 'Dataset not compatible with existing layers';`
`const ERROR_BG = '#f8d7da';` `const DEFAULT_BG = '#f8f9fa';`.

### 2. Incompatible drop message (D1)

In `handleDatasetDrop`, replace the `cands.length === 0` no-op with:
```js
if (cands.length === 0) {
  publishReadout({ pick: ERROR_MSG, pickColor: ERROR_BG });
  if (statusPickRef.current) statusPickRef.current.textContent = ERROR_MSG;
  statusColorsRef.current.pick = ERROR_BG; applyStatusBg();
  return;
}
```
On every **successful** append (the auto-append branch and `handleDropPick`),
clear the red by publishing a no-color pick:
```js
publishReadout({ pick: '' });            // clears shared-bar red
statusColorsRef.current.pick = undefined; applyStatusBg();   // clears mirror
```
(Clicking a point already clears it via the existing click handler once that
handler stops carrying a color — which it never does.)

### 3. Drag payload carries process identity (D4)

**`FlowView/ProcessNode.jsx:16,154-156`** — add to the drag item:
`processId: process.id, processVersion: selectedVersion`. (Keep `datasetPath`
as the pinned form.)

### 4. Current-vs-other + menu gating (D4, D5)

In `handleDatasetDrop`, after computing `cands`:
```js
const isCurrent =
  item.processId === activeProcess?.processId &&
  String(item.processVersion) === String(activeProcess?.version);
const pinnedPath  = item.datasetPath;                       // proc.ver.ds
const currentPath = 'current.' + item.datasetPath.split('.')[2];  // current.ds

if (cands.length === 0) { /* D1 */ return; }
if (cands.length === 1 && !isCurrent) {                     // D5 auto-append
  appendLayerRef.current(buildLayer(cands[0], pinnedPath, data));
  clearDropError();                                          // §2 clear
  return;
}
setDropMenu({ x, y, pinnedPath, currentPath, pinnable: isCurrent,
              items: cands.map(c => ({ ...c, label: c.name })) });
```
Add `activeProcess` to the `ProcessContext` destructure (`index.jsx:31-32`).

`handleDropPick(item, path)` → `appendLayerRef.current(buildLayer(item, path,
plotDataRef.current)); clearDropError(); setDropMenu(null);`

### 5. Pin UI in the menu (D3)

**`dnd/DatasetDropMenu.jsx`** — new props `pinnable`, `pinnedPath`,
`currentPath`; internal `const [pinned, setPinned] = useState(!pinnable)` (other
process starts pinned; current process starts unpinned). Render a header strip
with the thumbtack in the top-right:
```jsx
<div className="pane-menu-dropdown" ...>
  <div style={{ display:'flex', justifyContent:'flex-end', padding:'2px 4px' }}>
    <i
      className="fas fa-thumbtack"
      title={pinnable
        ? (pinned ? 'Pinned to this process version (click to follow current)'
                  : 'Following current process (click to pin)')
        : 'Pinned: dataset belongs to another process'}
      style={{
        cursor: pinnable ? 'pointer' : 'not-allowed',
        opacity: pinned ? 1 : 0.4,
        transform: pinned ? 'none' : 'rotate(45deg)',
        color: pinnable ? undefined : '#adb5bd',
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={pinnable ? (e => { e.stopPropagation(); setPinned(p => !p); }) : undefined}
    />
  </div>
  <div className="pane-menu-widget-list">
    {items.map(item => (
      <button key={item.name} type="button"
        onClick={() => onPick(item, pinned ? pinnedPath : currentPath)}>
        {item.label || item.name}
      </button>
    ))}
  </div>
</div>
```
(`onMouseDown`/`onClick` on the icon stop propagation so toggling neither closes
the menu nor triggers a pick. Greyed state = `pinnable === false`: no `onClick`,
`not-allowed` cursor, muted color, always `pinned`.)

Update the render site (`index.jsx:478-485`) to pass the new props and the
2-arg `onPick`.

## Files touched
- `frontend/src/widgets/PlotView/index.jsx` — drop handler (D1/D4/D5), mirror-bar
  color, `activeProcess`, menu props.
- `frontend/src/dnd/DatasetDropMenu.jsx` — pin icon + pinned-state path.
- `frontend/src/dnd/datasetDnd.js` — doc comment for the enlarged payload.
- `frontend/src/widgets/FlowView/ProcessNode.jsx` — add `processId`/`processVersion`.
- `frontend/src/PlotStatusBar.jsx` — bar-background color channel.
- `frontend/src/plotReadoutStore.js` — doc comment only.

## Out of scope / notes
- No change to `compatibleLayerTypes` / `buildLayer` matching logic.
- The coords-color channel is wired but unused (no producer yet).
- Exact error shade (`#f8d7da`) and pin glyph styling are cosmetic; adjust in
  review.
```

## Test plan (manual)
1. Drag an output of the **active process's active version** onto a plot with a
   single compatible layer → menu appears with an **unpinned** (rotated, faded)
   thumbtack; pick → layer uses `current.<ds>`. Toggle pin → `proc.ver.ds`.
2. Drag an output of **another process** with >1 candidate → menu with a
   **greyed, solid** thumbtack; pick → `proc.ver.ds`; thumbtack not clickable.
3. Drag an output of another process with exactly **1** candidate → **auto-adds**
   (no menu), pinned path.
4. Drag a dataset **no layer** accepts → bar turns red with the message; it
   survives mouse-move; a successful subsequent drop or a point-click clears it.
5. Non-active version of the active process behaves like "other" (greyed pin).

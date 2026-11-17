# FlightlinePlot: highlight & select the current part / sounding

**State:** decided 2026-11-16, ready to implement
**Labels:** enhancement, frontend, PlotView, plot-elements
**Repos touched:** main (`frontend/`)

## Motivation

`FlightlinePlot` draws a dataset's soundings as a map (x/y points/lines) in a
single flat color. It gives no visual feedback about **which flightline is the
current part** or **which sounding is selected**, and clicking it does not drive
that selection — it only nudges `currentSounding` by pick index
(`PlotView/index.jsx:190-194`).

We want the Flightlines layer to act as the survey-map selector:

1. When it shows a **current** dataset, highlight the soundings of the current
   flightline and mark the current sounding.
2. Clicking a sounding sets **both** the current part (the clicked sounding's
   line) **and** the current sounding — gated to layers whose dataset is one of
   the `current.*` datasets (not a pinned process output).

## Decisions (agreed with user)

1. **Always full dataset.** The map must stay stable. Today `current.*` data is
   scoped to the selected part (`ProcessContext.jsx:511` → `fetchData(currentPart)`),
   so once a line is selected the `current.*` data shrinks to that one line and the
   map would collapse. FlightlinePlot will instead render the **full (all-parts)**
   dataset, loaded independently, so selecting a part does not shrink this plot.
2. **Highlight by the current sounding's line.** The highlighted flightline is the
   line of the current sounding (`lineColumn(_currentFlightlines)[_currentSounding]`),
   not the `currentPart` string (which is `"all"` in the map view and would
   highlight nothing). The two converge once a specific part is selected.
3. **Recolor line + marker dot.** Base layer = all soundings in the `color` param;
   an overlay recolors the current line's soundings (larger points, highlight
   color); a top marker draws the current sounding as a single enlarged dot.

## What exists today

### FlightlinePlot (`frontend/src/widgets/PlotView/elements/FlightlinePlot.js`)
- `createLayer` resolves `parameters.dataset` against `plot._rawData`
  (`resolveDataPath`), reads `.flightlines`, and emits one (markers) or two
  (markers+lines) sub-layers, all one flat color (`fillColorArrays(n, rgb)`).
- Axis QKs come from `pickColumns` (`x_web`/`lon` → `epsg_3857_x`/`epsg_4326_x`, etc.).

### Current sounding / part plumbing
- `PlotView/index.jsx` merges onto the plot data object:
  `_currentSounding` (= `currentSounding`), `_currentFlightlines`
  (the **part-scoped** current flightlines), plus `current` (part-scoped raw data).
- `currentSounding` is a **row index into the part-scoped** current flightlines
  (`ProcessContext.jsx:136`). It is **not** a row index into the full dataset.
- `soundingMatch.js` maps a current-sounding row to another dataset's row by
  **line + gtime** (`matchSounding`); `lineColumn(fl)` finds the line column
  (`title`/`Line`/`line`/`line_id`/`line_no`, case variants). `matchSounding` is
  exported; `lineColumn` is **not** (module-private).
- `SoundingMarker.js` already demonstrates the pattern: read
  `soundingIndex(rawData, dataset)` and draw a marker for it.

### Pinned / lazy loading (`PlotView/pinnedDatasets.js`)
- `loadPinnedData` creates a **fresh** `Dataset` object per pinned part
  (`loadDataset(dsId, projectId)` + `fetchData(name)`) and stores the raw data at
  a path in the plot data. This is the template for loading the full current
  dataset **without** disturbing the shared `datasetObjects[dsName]` (whose
  internal "last fetched part" is the part-scoped one other plots rely on).

### Click handling (`PlotView/index.jsx:131-195`)
- `plot.on('click')` → `plot.pick()`. The xdist branch finds the nearest sounding
  by `coords.xdist_m` over a layer's `flightlines.xdist` and maps pinned→current
  with `currentSoundingFrom`. The non-xdist branch (FlightlinePlot) uses the pick
  vertex index directly. `configRef.current.layers[configLayerIndex]` recovers the
  config spec for a picked layer; `params.dataset` is its dataset path.

### Setters (`ProcessContext.jsx:218-226`)
- `setCurrentPart(part)` navigates with `sounding=null` (resets sounding to 0).
- `setCurrentSounding(sounding)` navigates with the existing part.
- Both call `navigate()`. Calling both back-to-back would fire two navigations and
  race — we need a **single combined setter**.

## Design

### 1. Load the full (all-parts) current dataset — `pinnedDatasets.js` + `index.jsx`

Add a small lazy loader, mirroring `loadPinnedData`, that for each **FlightlinePlot**
layer whose `dataset` is `current.<ds>`:
- resolves the dataset id from `datasetObjects[dsName].id` (expose `datasetObjects`
  to PlotView via `ProcessContext` — already in the context value, `ProcessContext.jsx:606`),
- loads a **fresh** `Dataset` object and `fetchData("all")`,
- stores the raw full data in a new state map, merged onto the plot data as
  `_fullCurrent[encodeSeg(dsName)] = rawFullData`.

Optimisation: when `currentPart === "all"`, `fetchedData[dsName]` **is** the full
data — alias it into `_fullCurrent` instead of re-fetching. Only fetch separately
when a specific part is selected.

Keying/caching follows the `lazilyLoadedData` pattern: key by `dsName`, re-use
across renders, invalidate when the active process/version changes (the dataset id
changes). Loading state: until `_fullCurrent[seg]` is present, FlightlinePlot falls
back to the part-scoped `current.<ds>` data (so it still draws something during the
brief load).

### 2. FlightlinePlot renders base + highlight + marker — `FlightlinePlot.js`

In `createLayer`:
- Determine `isCurrent = parameters.dataset?.startsWith('current.')`.
- `flightlines` source: if `isCurrent` and `rawData._fullCurrent[seg]?.flightlines`
  exists, use that (full dataset); else the existing `resolveDataPath(...).flightlines`.
- **Base layer:** unchanged — all soundings, `parameters.color`.
- **Highlight + marker** only when `isCurrent` and `_currentSounding != null`:
  - `curFl = rawData._currentFlightlines`, `cs = rawData._currentSounding`.
  - `line = lineValueAt(curFl, cs)` (new exported helper on `soundingMatch.js`).
  - **Highlight layer:** build index list of full-data rows where
    `lineValueAt(fullFl, k) === line`; emit those x/y as points with a larger
    `pointSize` and a highlight color. New optional params
    `highlightColor` (default e.g. `#ff8800`) and we reuse pointSize bump.
  - **Marker layer:** `markerRow = (fullFl === curFl) ? cs : matchSounding(curFl, cs, fullFl)`;
    if non-null, emit a single enlarged dot at that row (new `markerColor`,
    default `#ff0000`), matching `SoundingMarker`'s role.
- Guard every lookup (missing columns, `cs` out of range, no line column) and fall
  back to just the base layer.

New exported helpers in `soundingMatch.js`:
```js
export const lineColumn = fl => LINE_COLUMNS.find(c => fl?.[c] !== undefined);
export function lineValueAt(fl, i) {            // String()-normalised line value, or null
  const c = lineColumn(fl);
  return (c && i != null && i >= 0 && i < fl[c].length) ? String(fl[c][i]) : null;
}
```

Schema additions (optional, with defaults) on FlightlinePlot: `highlightColor`,
`markerColor`. Keep them optional so existing saved layers keep working.

### 3. Click → set part + sounding — `index.jsx`

Replace the non-xdist (`else if (result)`) FlightlinePlot branch with a
FlightlinePlot-aware branch:
- Recover the picked layer spec via `configRef.current.layers[result.configLayerIndex]`;
  proceed only if it is a `FlightlinePlot` and `params.dataset?.startsWith('current.')`
  (the gating). Otherwise keep the old pick-index fallback.
- Find the nearest **full-dataset** row by distance in the click `coords` x/y
  (the layer's axis QKs), scanning `fullFl` x/y columns — **not** the pick vertex
  index. This avoids sub-layer ambiguity (base vs highlight vs marker all share one
  `configLayerIndex`, and pick may return any of them). Mirrors how the xdist branch
  scans by coordinate rather than trusting the vertex index.
- `line = lineValueAt(fullFl, j)`.
- `ordinal = count of rows k < j with lineValueAt(fullFl, k) === line` — the index
  of the clicked sounding **within its line's soundings**, i.e. the row index into
  the part data that will load after the part switch.
- Call the new combined setter `setCurrentPartAndSounding(line, ordinal)`.
- If `fullFl` has no line column, fall back to the current behaviour (set sounding
  only; no part switch).

### 4. Combined setter — `ProcessContext.jsx`

Add:
```js
const setCurrentPartAndSounding = useCallback((part, sounding) => {
  const path = buildUrlPath(selectedEnvironment, selectedEnvironmentVersion,
    currentProject, activeProcess?.processId, activeProcess?.version,
    part === "all" ? null : part, sounding);
  navigate(path);
}, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentProject, activeProcess]);
```
Expose it in the context value next to `setCurrentPart` / `setCurrentSounding`.

## Assumptions & risks

- **Ordinal == part row index.** Setting `currentSounding` to the clicked sounding's
  ordinal-within-line assumes the single-part (`fetchData(line)`) data lists that
  line's soundings in the **same order** as the full (`"all"`) data. Both derive
  from the same stored parts (a part file holds one line's soundings; `"all"`
  concatenates parts), so order should match. If it ever doesn't, the selected
  sounding in the *other* plots (ChannelPlot etc.) would be off; the FlightlinePlot
  marker itself stays correct because it re-derives via `matchSounding`. Acceptable;
  documented here.
- **Extra fetch when a part is selected.** One additional `fetchData("all")` per
  current FlightlinePlot dataset while a specific part is selected. Skipped entirely
  in the common `"all"` view (aliased from `fetchedData`). Fresh `Dataset` object so
  the shared part-scoped object is untouched.

## Out of scope

- Pinned FlightlinePlot layers get **no** highlight/marker and are **not**
  click-selectable (gated to `current.*`). A pinned-marker-via-`matchSounding`
  (like `SoundingMarker`) could be a later addition.
- `mode: 'lines'` highlight: the highlight overlay draws points for the current
  line; drawing a highlighted *line strip* for it can follow if wanted.

## Files touched

- `frontend/src/widgets/PlotView/elements/FlightlinePlot.js` — base+highlight+marker,
  full-data source, new optional color params.
- `frontend/src/widgets/PlotView/soundingMatch.js` — export `lineColumn`, add
  `lineValueAt`.
- `frontend/src/widgets/PlotView/pinnedDatasets.js` (or a sibling) — full-current
  lazy loader.
- `frontend/src/widgets/PlotView/index.jsx` — merge `_fullCurrent`, drive the full
  loader, new click branch, use `datasetObjects`.
- `frontend/src/ProcessContext.jsx` — `setCurrentPartAndSounding`.

## Test / verify

- `"all"` view: current line's soundings recolored, current sounding dotted; no
  extra fetch (aliased).
- Specific part selected: map still shows all lines (full load), current line
  highlighted; selecting a different part via the top bar moves the highlight.
- Click a sounding on a current FlightlinePlot: top-bar part switches to that line,
  the clicked sounding becomes current, ChannelPlot/SoundingMarker follow.
- Click a **pinned** FlightlinePlot: no part/sounding change (gated out).
- Dataset with no line column: no crash; click sets sounding only.
```

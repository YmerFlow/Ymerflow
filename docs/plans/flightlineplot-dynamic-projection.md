# FlightlinePlot — per-column projection & auto-range — Plan

## Context

`FlightlinePlot` plots all flightlines of an XYZ dataset on a map. It lets the user choose
which columns feed the X and Y axes (`x_column` / `y_column`), but it has two coupled bugs
that make a map-only workspace render empty with a dead "Reset view".

Reproduced live on a public workspace (`/app/w/cdc3c50f-…/wv/1/p/e9f89b62-…`, project
`LPNNRD2018`, dataset `Import LPNNRD2018 409001` v4):

- The layer is configured with `x_column: x_web`, `y_column: y_web` — **EPSG:3857 Web
  Mercator metres** (confirmed ranges: `x_web ∈ [-10,762,300, -10,761,700]`,
  `y_web ∈ [4,997,880, 5,032,910]`).
- The saved axes are `quantity_kind: epsg_4326_x / epsg_4326_y` with a persisted domain of
  ~`[-6.5e10, -5.9e10]` on X — garbage. The real point values (~-10.76M) sit far outside it,
  so every point is off-screen → **empty plot**.
- "Reset view" does nothing because the layer reports **no data domain** to gladly, so there
  is nothing to auto-fit or reset to.

### Root cause (confirmed by reading the code)

`frontend/src/widgets/PlotView/elements/FlightlinePlot.js`:

1. **`getAxisConfig` hardcodes the axis quantity kind** to `epsg_4326_x` / `epsg_4326_y`
   regardless of which column the user selected. Selecting the Web-Mercator `x_web`/`y_web`
   columns still tells gladly the axis is in degrees, so the metre values are mis-scaled
   against the axis.

2. **`createLayer` returns `attributes` but never returns `domains`.** gladly's
   `applyAutoDomainsFromLayers` (`gladly-plot/src/axes/AxisRegistry.js`) builds each axis's
   extent *only* from `layer.domains[qk]` — there is no fallback that scans attribute buffers
   (verified: `domains: gpuConfig.domains ?? {}` in `core/LayerType.js`, and `core/Layer.js`
   never computes an extent). With no domain reported:
   - `dataExtent` for the axis is never set, so `resetAxes()` (`core/Plot.js:1004`) has nothing
     to reset to → **Reset view is a no-op**.
   - The only domain present is whatever (garbage) override was persisted in the saved axes.
   The basemap `TileLayer` does not rescue this — it also returns `domains: {}`
   (`gladly-plot/src/layers/gis/TileLayer.js`). This workspace has no basemap anyway, so
   nothing anchors the axis.

Other datasets expose their coordinates under different columns with different CRSs
(`lon`/`lat` = 4326; `UTMX`/`UTMY`, `easting`/`northing`, `x`/`y` = the dataset's own
projected EPSG). The layer must honour the column's actual projection, not assume one.

## Current state (confirmed by reading the code)

- **Quantity kinds already exist per column.** Every dataset class implements
  `getQuantityKind(col)` (`frontend/src/datamodel/dataset.js`): `x_web`→`epsg_3857_x`,
  `y_web`→`epsg_3857_y`, `lon`→`epsg_4326_x`, `lat`→`epsg_4326_y`, and projected columns
  (`UTMX`/`UTMY`/`easting`/`northing`/`x`/`y`) → `epsg_<code>_x/_y` resolved from the
  dataset's own CRS (`XyzDataset.getQuantityKind`, `dataset.js:778`).
- **Those QKs are reachable from both layer hooks.** `DatasetCollectionAdapter.toDataGroup()`
  (`dataset.js:941`) bakes each column's `quantity_kinds` into the `DataGroup` child for the
  current dataset; `addPinnedData`/`PinnedGroup.getQuantityKind`
  (`frontend/src/widgets/PlotView/pinnedDatasets.js:93`) delegate to the `Dataset`'s
  `getQuantityKind` for pinned (`<proc>.<ver>.<ds>`) datasets. `Plot._processLayers` passes
  `this.currentData` to **both** `resolveAxisConfig(parameters, data)` and
  `createLayer(regl, parameters, data, plot)` (`core/Plot.js:1133`, `:1149`), and
  `currentData._children` is a shallow copy of `_rawData._children`, so the QK-aware
  `_children` chain is preserved. Therefore
  `resolveQuantityKind(\`${parameters.dataset}.${column}\`, data)` resolves the correct QK for
  **both** current and pinned datasets, in both hooks.
- `resolveQuantityKind` is exported from `gladly-plot`
  (`core/ComputationRegistry.js`, re-exported in `gladly-plot` index). For a plain string
  `expr` it returns `data.getQuantityKind(expr)`.
- Schema defaults today: `x_column` default `'lon'`, `y_column` default `'lat'`
  (`FlightlinePlot.js` `schema()`), and `createLayer` falls back to `'lon'`/`'lat'` when a
  column param is missing.

## Decisions (agreed with operator)

1. **Default columns → `x_web` / `y_web` (EPSG:3857)**, so a workspace with an OSM
   `TileLayer` basemap (also 3857) lines up out of the box. Because `x_web`/`y_web` are only
   present when the libaarhusxyz normalizer added them (not guaranteed on every dataset),
   **fall back to `lon`/`lat`** when the preferred columns are absent.
2. **No stale-workspace migration.** Once the layer reports domains, the existing broken
   "Map test" workspace is fixed by the user pressing **Reset view** once. We do not add code
   to drop persisted out-of-range axis min/max.

## Plan

All changes are confined to
`frontend/src/widgets/PlotView/elements/FlightlinePlot.js` — no gladly or PlotView changes.

### 1. Resolve the column → quantity kind in one helper

Add a small helper used by both hooks:

```js
import { resolveQuantityKind } from 'gladly-plot';

// Preferred columns in priority order, with the QK we fall back to when the data
// isn't resolvable yet (axis still needs *a* QK at resolveAxisConfig time).
function pickColumns(parameters, data) {
  const dataset = parameters.dataset;
  const tryCol = (explicit, prefs) => {
    if (explicit) return explicit;
    for (const c of prefs) {
      if (dataset && resolveQuantityKind(`${dataset}.${c}`, data) != null) return c;
    }
    return prefs[0];                     // nothing resolved yet — default
  };
  const xCol = tryCol(parameters.x_column, ['x_web', 'lon']);
  const yCol = tryCol(parameters.y_column, ['y_web', 'lat']);
  const xQK  = (dataset && resolveQuantityKind(`${dataset}.${xCol}`, data)) || 'epsg_3857_x';
  const yQK  = (dataset && resolveQuantityKind(`${dataset}.${yCol}`, data)) || 'epsg_3857_y';
  return { xCol, yCol, xQK, yQK };
}
```

Notes:
- Explicit user choices always win; the fallback list only applies when a column param is
  unset. This honours decision 1 (prefer `x_web`/`y_web`, else `lon`/`lat`) without silently
  overriding an explicit pick.
- The `|| 'epsg_3857_x'` guard covers the first render before data is ready, so
  `resolveAxisConfig` always returns a concrete QK (gladly needs one to create the axis slot).

### 2. `getAxisConfig` — dynamic QK instead of hardcoded 4326

```js
getAxisConfig: (parameters, data) => {
  const { xQK, yQK } = pickColumns(parameters, data);
  return {
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: xQK,
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: yQK,
  };
},
```

### 3. `createLayer` — use the resolved columns and return domains

- Replace the hardcoded `parameters.x_column || 'lon'` / `|| 'lat'` reads with the
  `xCol`/`yCol` from `pickColumns(parameters, plot?._rawData ?? data)` (so the fallback matches
  what the dataset actually has).
- After building `x`/`y` `Float32Array`s, compute finite min/max and return a `domains` map
  **keyed by the same QKs** `getAxisConfig` returns:

```js
const { xCol, yCol, xQK, yQK } = pickColumns(parameters, rawData);
// …existing xRaw/yRaw/x/y/rgb build, using xCol/yCol…
const xDom = finiteExtent(x);     // [min, max] skipping NaN/Inf, or null
const yDom = finiteExtent(y);
const domains = {};
if (xDom) domains[xQK] = xDom;
if (yDom) domains[yQK] = yDom;
// attach `domains` to each pushed result object
results.push({ attributes: attribs, uniforms: { pointSize: 3.0 }, primitive: 'points', domains });
```

`finiteExtent` is a 5-line local scan (`for` over the array, skip non-finite). Keep it local to
the file — no new dependency.

**Invariant:** the QK keys in `domains` must equal the QKs returned by `getAxisConfig`, because
`applyAutoDomainsFromLayers` matches `layer.domains[qk]` against `layer.xAxisQuantityKind`.
`pickColumns` is the single source of truth for both, so they can't drift.

### 4. Schema defaults

Update `schema()` defaults: `x_column` default `'x_web'`, `y_column` default `'y_web'`
(decision 1). Keep the `enum`-free string fields as-is (columns are free-form).

## What this fixes

- **Empty plot:** the axis QK now matches the data (3857 for `x_web`/`y_web`, 4326 for
  `lon`/`lat`, projected EPSG for UTM), and the layer reports a real domain, so auto-range fits
  the data on first load (for a fresh workspace) instead of leaving a mismatched axis.
- **Dead Reset view:** `createLayer` now contributes `domains`, so `applyAutoDomainsFromLayers`
  sets `dataExtent` and `resetAxes()` fits the data. Pressing Reset view on the existing broken
  workspace recovers it (decision 2).
- **Correct basemap alignment:** with `x_web`/`y_web` + an OSM `TileLayer` (both 3857) the
  flightlines overlay the tiles; with `lon`/`lat` the axis is correctly labelled 4326.

## Testing

- Open the repro workspace, switch nothing, press **Reset view** → flightlines appear, axes
  show EPSG:3857 extents matching the data.
- New PlotView + FlightlinePlot on an XYZ dataset with default columns → renders without manual
  zoom; "Reset view" re-fits after panning.
- A dataset lacking `x_web`/`y_web` (e.g. one not run through the normalizer) → falls back to
  `lon`/`lat`, axis labelled EPSG:4326, still auto-ranges.
- A projected dataset where the user picks `UTMX`/`UTMY` → axis QK is `epsg_<crs>_x/_y` from the
  dataset CRS, auto-ranges.
- Add an OSM `TileLayer` beneath a `x_web`/`y_web` FlightlinePlot → tiles and flightlines
  co-register.

## Out of scope

- Reprojecting a layer's coordinates into a single shared plot CRS (gladly `reproject` exists
  but per-layer reprojection is a larger change). This plan reports the correct per-column QK
  and relies on axis-sharing by QK, matching how built-in scatter layers behave.
- Auto-healing persisted out-of-range axis domains in old workspaces (decision 2).
- `MagLinePlot` and other custom layers that also hardcode their QK and omit `domains`; they
  can adopt the same pattern later if needed, but are not part of this fix.

# Current Sounding as a Fast-Path Uniform

## Motivation

Clicking a sounding (or moving the selection) currently triggers a **full
`plot._initialize()` rebuild of every layer in every plot**. For a pane holding a
ResistivityCurtain (hundreds of thousands of instanced cells) or a GateAnomaly section,
that is a visible stall on every click — all the cell geometry, color textures, pick ids
and draw commands are recomputed and re-uploaded, even though the only thing that changed
is where a thin red marker sits.

gladly 0.0.28 adds a **config-only fast path** (`Plot._applyUpdate` →
`_classifyConfigChange` → `_applyLayerParamDeltas`): when the `data` reference is unchanged
and the only config differences are *uniform parameters*, the change is applied in place via
`LayerHandle.set()` — mutating the live `parameters` object the layer's uniform closures
captured — and a re-render is scheduled. No `_initialize()`, no geometry rebuild.

This plan moves "current sounding" onto that fast path so that **every** current-sounding
change, in **every** layer type, is a uniform update with no plot reinit.

---

## Why current sounding does not use the fast path today

Two things both force a rebuild on every sounding change:

1. **It lives on the data object, not in config.** PlotView sets
   `dataForPlot._currentSounding = currentSounding` and each layer reads it via
   `soundingIndex(rawData)` inside `createLayer`. gladly's fast path is *config-only*: any
   `data` change (`data !== this._lastRawDataArg`) always rebuilds.
2. **PlotView builds a brand-new `DataGroup` every render** and passes it as `data`, so even
   a pure sounding change trips `dataChanged` and rebuilds.

So the marker position / selected-curve is baked into GPU **attributes** at `createLayer`
time, and the only way to move it is to rebuild.

### The fast-path contract (verified against gladly 0.0.28 source)

- A layer parameter is a **uniform parameter** iff it is a `schema().properties` key **and**
  either (a) the schema property carries `x-uniform: true`, or (b) the built layer exposes a
  closure-form uniform `u_<name>` (a function) — `LayerHandle.uniformParameterNames()`.
- `_classifyConfigChange` strips all uniform params + carved axis fields from both configs;
  if the structural remainder is byte-identical → `'uniforms'` (fast path), else `'rebuild'`.
- `_applyLayerParamDeltas` calls `handle.set(name, value)` for each changed uniform param,
  which **mutates the exact `parameters` object** `createLayer` received
  (`_processLayers` passes `currentConfig.layers[i][type]` by reference; line 1365), then
  `scheduleRender()`.
- `_commitUniformConfig` keeps the existing `currentConfig.layers` objects, so the closures
  keep reading the same (now-mutated) object. Function-valued entries in a layer's
  `uniforms` are invoked by regl **every draw** (`LayerType.createDrawCommand` spreads
  `...layer.uniforms`), so a closure `() => f(parameters.currentSounding)` picks up the new
  value on the next render.

**Consequence:** if (1) current sounding is a config parameter marked `x-uniform: true` on
every layer, (2) each layer draws its marker / selected curve from a uniform closure that
reads `parameters.currentSounding`, and (3) PlotView passes a **stable `data` reference**
across sounding-only changes, then a sounding change classifies as `'uniforms'` and skips
`_initialize()` entirely.

---

## Design

### 1. A layer *declares* it wants the current sounding (`x-format: "currentSounding"`)

The current sounding must be threaded into a layer's config **only for layer types that opt
in** — gladly's built-in layer types (and any custom layer that does not care) must never
receive it, because their schema has no matching property and `LayerHandle.set()` would throw
"not a uniform parameter".

A layer opts in by exposing **one schema property that carries both markers**:

```js
currentSounding: {
  type: 'integer',
  'x-format': 'currentSounding',  // discovery key: PlotView injects/strips this property
  'x-uniform': true,              // fast-path: gladly treats it as a uniform parameter
  default: null,
}
```

- `x-format: 'currentSounding'` is how **PlotView discovers** which layers want the value
  and which property name to write it into. The property name is conventionally
  `currentSounding`, but discovery is by `x-format`, not by name, so it stays flexible.
- `x-uniform: true` is what makes **gladly** fast-path it (`_classifyConfigChange` →
  `'uniforms'`, `_applyLayerParamDeltas` → `handle.set()`).
- `showCurrentSounding` also becomes `x-uniform: true` (it already exists on the marker
  layers) so toggling the marker is fast-pathed too, and a hidden vs moved marker share one
  code path. It stays a normal, user-visible, persisted toggle (no `x-format`).
- The current sounding is a **single workspace-global row index** (into the current
  dataset's current line), identical for every opted-in layer — matching today's
  `soundingIndex(rawData)`, which ignores its dataset argument.

### 2. PlotView plumbing: inject on `plot.update()`, strip everywhere else

The `x-format: "currentSounding"` property is a **runtime-only** field: it is present only in
the config object handed to `plot.update()`, and is **absent** from the persisted workspace
layout and from the config shown in the JSON/rjsf editor.

**Discovery.** PlotView imports `getLayerType` from gladly and, for a layer spec
`{ [typeName]: params }`, finds the schema property whose `x-format === 'currentSounding'`
(helper `soundingParamName(typeName, data)` → property name or `null`). Only layers for which
this returns non-null are touched.

**Inject (add before update).** A single shared helper sets the property to a given sounding
value on each opted-in layer:

```js
// injectSounding(config, data, soundingValue) → new config with x-format:"currentSounding"
// properties set on every opted-in layer.
const name = soundingParamName(typeName, data);     // e.g. 'currentSounding', or null
const injected = name ? { ...params, [name]: soundingValue } : params;
```

A fresh params object per render is fine: the fast path compares values, then
`_commitUniformConfig` discards the new object and keeps the mutated live one. This helper is
the **single** place injection happens; it is called from both `plot.update()` call sites
(see "Two update paths" below).

**Strip (remove everywhere else).** A single helper
`stripSoundingParam(config, data)` deletes every `x-format: "currentSounding"` property from
every layer. It is applied:
- before any **workspace save / layout write-back** (`saveConfig`, the
  `lastSavedRef`/`lastPropConfigRef` JSON comparisons, `parentUpdate`), so the selection is
  never persisted and a sounding change never triggers a spurious layout write-back; and
- in **`PlotView.get_schema`**, so the property is dropped from the schema the JSON/rjsf
  editor renders — the user never sees or edits it.

Because the field is stripped before save and before the editor, and only ever re-added on
the way into `plot.update()`, there is no separate "hide from form" mechanism needed and the
saved layout stays clean. (`showCurrentSounding` is *not* stripped — it is a genuine user
toggle.)

**Two update paths (the sounding never touches `data`).** Current sounding is config, not
data, so it is kept entirely off the data-building path. There are two `plot.update()` call
sites, both routing their config through `injectSounding`:

1. **Rebuild path — the main data/config effect.** Its dependency array **excludes**
   `currentSounding`, so a sounding change never re-runs it (and never rebuilds `dataForPlot`
   or the layers). When it *does* run (real data/config change), it injects the latest
   sounding — read from a `currentSoundingRef` (updated every render) — so the rebuilt layers
   immediately draw the marker/curve at the right place:
   `plot.update({ data: dataForPlot, config: injectSounding(baseConfig, data, currentSoundingRef.current) })`.
2. **Fast path — a dedicated `useEffect([currentSounding])`.** On a sounding change it calls
   `plot.update({ config: injectSounding(plot.getConfig(), plot.currentData, currentSounding) })`
   with **no `data`** → `dataChanged` is false → the config differs only in a uniform param →
   `'uniforms'` fast path, no `_initialize()`. `plot.getConfig()` carries live pan/zoom and
   the other params, so nothing else is disturbed.
   - **Guard:** no-op until the plot has been built with a config (`if (!plot ||
     !plot.currentConfig?.layers?.length) return`). On mount the initial sounding is applied
     by the rebuild path's first update, so the fast-path effect skipping the very first tick
     is harmless; this also avoids the two effects issuing concurrent `update()`s in one
     commit.

- Remove `_currentSounding` from the data object entirely.
- Keep the **write** action reachable: assign a stable wrapper
  `_setCurrentSounding: v => setCurrentSoundingRef.current(v)` onto `dataForPlot` (stable
  identity), so layer `onClick` and PlotView's click handler keep calling
  `plot._rawData._setCurrentSounding(row)` unchanged.
- Because the rebuild effect no longer depends on `currentSounding`, `dataForPlot` need not be
  memoized for correctness; it is simply rebuilt only when the real data inputs change.

### 3. Marker layers (position fed by a uniform)

Layers where the selection only moves/positions a marker:
`ChannelPlot`, `ResistivityCurtain` (2D + 3D), `ResistivityCurtainLines`, `GateAnomalyPlot`,
`FlightlinePlot`.

Change `soundingLineMarker.js` and each layer so the marker is **always-present geometry**
whose position comes from a uniform:

- `createLayer` always appends exactly one marker tile/instance (with a placeholder
  position and `isMarker = 1`) — no longer gated on the current sounding. Marker geometry is
  built once and never rebuilt.
- Each layer adds uniform closures carrying the marker's position for the current sounding,
  computed from `parameters.currentSounding` and the position arrays captured in
  `createLayer`:
  - 1D xdist layers (ChannelPlot, RC2D, RCLines, GateAnomaly): `u_markerX = () => xdist[cs]`.
  - RC3D (geo): `u_markerGx`, `u_markerGz` from `gxFull[cs]`, `gzFull[cs]`.
  - FlightlinePlot (2D geo): `u_markerX`, `u_markerY` from `x[cs]`, `y[cs]`.
  - A `u_markerVisible = () => (showCurrentSounding !== false && cs valid) ? 1 : 0` closure;
    when 0 the marker vertices are pushed offscreen in the vert shader.
  - `cs` is read live each render: `const cs = parameters.currentSounding`.
- The marker vert branch (`isMarker > 0.5`) reads the position uniform(s) instead of the
  baked `x`/`gx`/`gz` attribute, and returns an offscreen clip position when
  `u_markerVisible < 0.5`. The shared `MARKER_VERT_BRANCH` / instanced-marker branches in
  `soundingLineMarker.js` and the two curtain/gate vert shaders are updated accordingly.

Because `u_markerVisible` / `u_markerX…` are closure uniforms whose names match no schema
property, detection of the uniform parameter itself rides on the explicit
`currentSounding: { 'x-uniform': true }` flag (path (a) above); the closures just consume the
mutated value.

### 4. Whole-geometry layers (selected curve fed by a uniform, all-soundings data model)

`SoundingPlot` and `SoundingResistivityPlot` plot the *entire* selected sounding, so there
is no marker — the geometry itself is the sounding. To avoid a rebuild we upload **all**
soundings once and index by the uniform in the shader, using gladly's nD columns
(`ArrayColumn(flat, { shape: [k, nSoundings] })` → a `sample_<key>(ivec2 idx)` GLSL
function + `u_col_<key>_shape` uniform, wired automatically by `createDrawCommand`).

**Design for extensibility — all soundings are the primary data model.** Uploading every
sounding is not just a fast-path trick: structure both layers so that "the current sounding"
is one *mode* over an all-soundings dataset, leaving a clean path to a future **heatmap /
ensemble mode** that draws *all* soundings at once (e.g. a `display: 'current' | 'all'`
parameter), optionally **filtered by a selection and/or a filter axis**. Concretely:

- The per-sounding dimension (`nSoundings`) is a real axis of the uploaded nD data, iterable
  on the GPU — so an "all" mode can instance over soundings instead of reading one column.
- Keep the plotted value a **color-mappable quantity** with a declared `colorAxisQuantityKind`
  (gate value / resistivity), so a future heatmap colors by it through gladly's normal
  colorscale path rather than a hardcoded color.
- Leave room for a `selection` channel and a filter axis (as ChannelPlot/GateAnomaly already
  use) to gate which soundings/samples draw, so filtering by selection, by filter axis, or
  both drops in without reworking the data upload.
- The current-sounding view is then "instance count 1, sounding index = `u_currentSounding`";
  the all/heatmap view is "instance over all soundings". Both read the same nD columns.

- **`SoundingPlot`** (gate time vs |gate value|): one vertex per gate (current mode). Upload
  the gate-value matrix as an nD column `shape [nGates, nSoundings]`; `x` (gate time) stays a
  1D per-gate attribute. Current-mode vert shader:
  `float v = sample_vals(ivec2(gateVertex, int(u_currentSounding)));` then the existing
  `y != y` offscreen branch hides invalid/zero gates (NaN uploaded for those). The current
  CPU "split into contiguous finite segments" becomes shader NaN-skipping on a single
  `line strip`, matching how other layers already drop `y != y`. (An "all" mode later renders
  gate × sounding as a heatmap/points colored by value.)
- **`SoundingResistivityPlot`** (resistivity-depth staircase, log x): reconstructed
  **entirely in the vertex shader** from raw nD tables — **no CPU-side geometry processing**
  (the existing per-sounding JS staircase builder is removed, not looped over soundings).
  - Upload `rho`, `dep_top`, `dep_bot` as nD columns `shape [nLayers, nSoundings]`, and
    `topo` as a 1D column. This is pure data marshaling into flat buffers (the only CPU work),
    not geometry construction, and is exactly the raw per-(layer, sounding) data a future
    depth-section heatmap/ensemble mode would color by resistivity and filter by
    selection/filter axis.
  - **Fixed topology, `lines` primitive.** Per layer `L`: one **vertical** segment
    `(rho[L], topo[cs] − dep_top[L]) → (rho[L], topo[cs] − dep_bot_eff[L])`; between adjacent
    layers, one **horizontal** connector at the shared boundary. Vertices carry small
    attributes (layer index, top/bottom, which-rho) and sample the nD tables at
    `(layer, int(u_currentSounding))`. A layer whose `rho`/`dep_top` is non-finite degenerates
    its own vertical offscreen; a connector degenerates offscreen unless **both** its layers
    are finite. So **every finite layer always gets its dep_top→dep_bot vertical**, and the
    staircase simply shows a gap around a non-finite layer instead of bridging it — the
    bridge/gap behavior we agreed need not match the old CPU output.
  - **Halfspace fake thickness (required), computed in-shader.** For a layer `L` whose
    `dep_bot[L]` is non-finite (the deepest finite layer), the shader scans back from `L−1`
    for the nearest finite layer `P`, takes `prevThickness = dep_bot[P] − dep_top[P]`, and sets
    `dep_bot_eff[L] = dep_top[L] + max(1.5·prevThickness, 50)` (falling back to
    `dep_top[L] + 50` when there is no previous finite layer) — reproducing the CPU
    `max(1.5·prevThickness, 50)` extension. `nLayers` is small (tens), so the backward scan is
    cheap.

### 5. Shared helpers (`soundingMatch.js`, `soundingLineMarker.js`)

- `soundingIndex(rawData)` (reads `rawData._currentSounding`) is replaced by reading
  `parameters.currentSounding` in `createLayer`; add a small `soundingParam(parameters)`
  helper and update all call sites.
- `currentSoundingMarkerTile` / `markerSounding` / `appendMarkerInstance` change from
  "build the marker at row cs, or null" to "always build one placeholder marker
  tile/instance" + the shared uniform-closure builder.
- `_setCurrentSounding` write path and all `onClick`/`pickInfo` logic are **unchanged** —
  picking still resolves a row and calls `_setCurrentSounding(row)`; only the *read/display*
  side moves to a uniform.

### 6. Schema / config form

`currentSounding` must be a `schema().properties` key for gladly to treat it as a uniform,
but it is a runtime selection, not a user-edited field. It is kept out of the editor by the
**same `x-format: "currentSounding"` strip** used for persistence (section 2):
`PlotView.get_schema` drops every property with `x-format === 'currentSounding'` from the
schema it hands rjsf, so the field never renders and the user never edits it. No separate
hidden-widget mechanism is needed. `showCurrentSounding` stays a visible toggle.

---

## Resolved design decisions

- **Data-ref stability** — a dedicated `useEffect([currentSounding])` fast-path + a rebuild
  effect that excludes `currentSounding` from its deps, both routing config through one shared
  `injectSounding` helper (section 2, "Two update paths").
- **Injection scope** — opt-in per layer via `x-format: "currentSounding"`, so gladly
  built-ins are never touched.
- **Hiding the field from the form** — the same strip as persistence (section 6).
- **`SoundingResistivityPlot`** — reconstructed in the vertex shader from raw nD tables, **no
  CPU-side geometry processing** (section 4): halfspace fake thickness is reproduced in-shader
  (backward scan for the previous finite layer's thickness); exact gap/bridge behavior is
  **not** required — every finite layer draws its dep_top→dep_bot vertical, and the staircase
  shows a gap (not a bridge) around a non-finite layer.
- **MagLinePlot** — out of scope; it draws no current-sounding marker today.

---

## Acceptance criteria

- Clicking/moving the current sounding on any plot containing any of the affected layer
  types triggers **no `_initialize()`** — verified by a temporary log/counter in
  `Plot._initialize` (or asserting `_initEpoch` is unchanged across a sounding click) and by
  the absence of the geometry-rebuild stall.
- The marker / selected curve still moves correctly and is hidden by `showCurrentSounding`
  off and when the sounding is out of range / has no value.
- Toggling `showCurrentSounding` is also fast-pathed (no reinit).
- The saved layout node never contains `currentSounding`; reloading a workspace does not
  pin the selection.
- Picking/selection (`onClick`, `pickInfo`) behaves exactly as before.
- Existing tests (`soundingMatch.test.js`, `GateAnomalyPlot.test.js`) updated to the new
  `parameters.currentSounding` read path and still pass.

---

## File-by-file task list

**Frontend — PlotView**
- `frontend/src/widgets/PlotView/index.jsx`
  - Remove `currentSounding` from the main data/config effect's deps (it no longer rebuilds
    on sounding change); rebuild `dataForPlot` only when real data inputs change.
  - Add a dedicated `useEffect([currentSounding])` fast-path that calls
    `plot.update({ config })` with no data (guarded until the plot is built).
  - Shared `injectSounding(config, data, value)` helper (discovers opted-in layers via
    `x-format: "currentSounding"` using `getLayerType(typeName).schema(data)`), called from
    both update paths; `currentSoundingRef` feeds the rebuild path the latest value.
  - Stable `_setCurrentSounding` wrapper; remove `_currentSounding` from the data object.
  - `stripSoundingParam(config, data)` used in every write-back/compare/persist path **and**
    in `PlotView.get_schema` (drops the field from the rjsf form).
- `frontend/src/widgets/PlotView/soundingMatch.js` — add `soundingParamName(typeName, data)`
  (find the `x-format: "currentSounding"` property) and `soundingParam(parameters)` (read the
  value in `createLayer`); keep the write/pick helpers.

**Frontend — marker helper + marker layers**
- `frontend/src/widgets/PlotView/elements/soundingLineMarker.js` — always-present marker
  tile/instance builders + shared `u_marker*` uniform-closure builder + updated vert branches.
- `elements/ChannelPlot.js`, `elements/ResistivityCurtain.js` (RC2D, RC3D, RCLines),
  `elements/GateAnomalyPlot.js`, `elements/FlightlinePlot.js` — add
  `currentSounding`/`showCurrentSounding` uniform params; always append marker; feed
  position via uniform closures; read `parameters.currentSounding`.

**Frontend — whole-geometry layers**
- `elements/SoundingPlot.js` — nD gate-value column `[nGates, nSoundings]` + `u_currentSounding`
  sampling; shader NaN→offscreen replaces the CPU segment split.
- `elements/SoundingResistivityPlot.js` — nD `rho`/`dep_top`/`dep_bot` `[nLayers, nSoundings]`
  + `topo` 1D column; fixed-topology `lines` staircase reconstructed in-shader with in-shader
  halfspace extension (backward scan); **remove** the CPU staircase builder.

**Schema/form**
- `PlotView.get_schema` strips `x-format: "currentSounding"` properties (section 6).

**Tests**
- Update `soundingMatch.test.js`, `GateAnomalyPlot.test.js`; add a fast-path assertion test
  if practical (sounding change does not bump `_initEpoch`).

---

## Risks

- **SoundingResistivityPlot** in-shader staircase is the main risk. The halfspace fake
  thickness must match the CPU `max(1.5·prevThickness, 50)` extension; verify against the old
  renderer on a sounding with a halfspace last layer. (Gap-vs-bridge differences around a
  non-finite middle layer are accepted by design.)
- The nD-column upload for whole-geometry layers uploads all soundings (vs one) — more GPU
  memory, but uploaded once and amortized over all sounding changes; sizes here (gates ×
  soundings, layers × soundings) are modest.
- Keep PlotView's `data` reference stable across sounding changes by construction: the rebuild
  effect excludes `currentSounding` from its deps and the fast-path effect passes **no** data,
  so a sounding change can never churn the `data` identity.

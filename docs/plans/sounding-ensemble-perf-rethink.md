# Sounding ensemble — performance rethink (precompute geometry columns on the GPU)

> **Status: DESIGN DECIDED, OPEN QUESTIONS RESOLVED. Implement in one go, then measure.** The
> decision below (four GPU column transforms, instantiated inline inside `createLayer`, feeding a
> non-instanced `lines` draw from our own custom layer) is settled. Build the whole layer +
> transform as **one file, ≤~200 lines**; if it grows past that, stop and reconsider the approach.
> Validate with headless Playwright (see below). The appendix records the earlier options
> discussion for context only.

> **Note on "our custom layer", not gladly's stock `LinesLayer`.** We keep a **custom** layer type
> (registered via `registerLayerType`, as the ensembles are today). We do **not** reuse gladly's
> built-in `lines` layer: its shader bakes in gladly's own coloring (`map_color_`) and filtering
> (`filter_`), and exposes no hook for our alpha model — whereas the ensemble needs the
> `saturationCount` source-over alpha model, the opaque current-sounding overlay, and the dual
> xdist/sounding_id culls, plus it must consume the four precomputed columns. What changes vs.
> today is **only** the vertex shader: it stops reconstructing geometry and becomes a thin
> **projection over the precomputed position columns plus the cheap xdist offscreen cull** — no
> reconstruction, no loop, no texture gathers (the single column read for the filter is trivial).
> It is **not** a literal passthrough: it still applies the filter axis. "Draw with the `lines`
> primitive" below means our layer emits `primitive: "lines"` — our existing **non-instanced
> GL_LINES over the pair topology** (verified against today's draw, `SoundingResistivityPlot.js`),
> **not** gladly's instanced line-strip `LinesLayer`.

## Why this plan exists

The shipped sounding ensemble (`SoundingResistivityPlot`, `SoundingPlot`) renders correctly but a
**current-sounding change takes ~500 ms on a real GPU** (operator report). The root cause is that
the ensemble layer **reconstructs its geometry in the vertex shader, every frame**: for each of
~1 M vertices it samples 3 nD textures (`rho`, `dep_top`, `dep_bot`) and runs a staircase
reconstruction (including a backward-scan loop for the halfspace) that produces the **exact same
positions every time**. gladly redraws all layers on any uniform change, so this static
reconstruction is re-run on every sounding/filter change.

The fix is to **stop reconstructing geometry in the vertex shader at all**. The staircase positions
are static; they should be computed **once per rebuild on the GPU** into flat position columns, and
the draw should be a `lines`-primitive pass from **our own custom layer** whose vertex shader only
projects the precomputed `(x, y)` columns and applies the xdist offscreen cull (no reconstruction,
no loop, no gathers). Then the only per-frame cost left is the honest translucent-line overdraw.

## What is actually slow (measured)

All timings are **headless Playwright + SwiftShader (software GL)**: absolute ms are ~20–50× too
slow. **Trust proportions, not absolute numbers.** (Drive via `scratchpad_token.txt`; a sounding
change is a different `/s/N` URL — see [[drive_local_app_playwright]].)

- A current-sounding change is classified `'uniforms'` by gladly (~6 ms, no rebuild). The fast path
  (no `_initialize`, no `createLayer`) already works — caching/rebuild-avoidance is the wrong
  target.
- gladly redraws **all** layers on any uniform change, so the static ~1 M-vertex ensemble is fully
  re-rasterised on every sounding change.
- The dominant costs are: **(B)** the per-vertex reconstruction (3 texture fetches + a `for(k<256)`
  halfspace scan per vertex, every frame) and **(C)** translucent-line overdraw (overlapping
  semi-transparent segments, each a blended read-modify-write; lines carry ~3× the fill of points).
- Ensemble size: ~1.06 M vertices for a 9 k-sounding resistivity model (≈118 topology verts × 9 k).

This design deletes **(B)** entirely (reconstruction moves to a once-per-rebuild GPU transform) and
leaves only **(C)**, the irreducible cost of drawing N overlapping translucent curves.

## gladly-native building blocks

Verified in gladly 0.0.28 (`node_modules/gladly-plot/src`):

- **`lines` primitive, non-instanced, pair topology** — our draw stays exactly today's structure
  (`primitive: "lines"`, `vertexCount = nVert*nS`, no instancing): GL_LINES treats each consecutive
  **pair** `(2k, 2k+1)` as an independent segment, and `buildTopology` already emits the vertices in
  that pair order (`(L,top),(L,bot)` verticals, then `(L,bot),(L+1,top)` connectors). Each vertex
  reads its **own** `(resistivity_x, elevation_y)` texel directly — **no** `a_endPoint` template,
  **no** `instanceCount`, **no** `withOffset('0.0'/'1.0')`, **no** segment-id break column. (Gladly's
  `LinesLayer` is an instanced **line-strip** — segment *i* connects row *i*→*i+1* and needs a
  `seg`-id column to break between soundings; that machinery is unnecessary for our pair topology, so
  we do not adopt it.) We keep our own vertex shader (projection + xdist cull), fragment shader
  (`saturationCount` translucency / opaque highlight), and filtering.
- **Column transforms, instantiated inline — no registry, no `config.transforms`.** `createColumn`
  is a plain method on `TextureComputation` (`Computation.js:31`), so our layer can `new` its own
  computation subclass and call it directly inside `createLayer`:
  `const col = await new SoundingGeomComputation().createColumn(regl, { rho, dep_top, dep_bot, topo,
  xdist, ...params }, plot)`, then return the resulting `ColumnData` as a layer attribute. Inputs are
  passed as `ColumnData` (the nD rho/dep tables + 1D topo/xdist we already build in `createLayer`
  today, wrapped as `ArrayColumn`s); the transform reads them via `.toTexture(regl)` and gathers.
  Registration by string name and the config `transforms: [...]` path (processed by
  `GlBase._processTransforms` → `currentData._children[name]`) are **only** needed to reference a
  transform as a config expression — for internal, layer-owned use we skip all of it. The transform
  runs on the GPU **once per rebuild, NOT per frame**, and emits output columns of **a shape we
  declare**, independent of input row count (`TextureColumn.length = rawTex._dataLength ?? rawTex.width`,
  `Computation.js:82`) — so each of the four columns is length `nVert * nS` from one shared
  `(L, isBot, sounding)` index map, structurally coherent (same length, same ordering).
- **`compute` input access — resolved.** The signature is `compute(regl, inputs, getAxisDomain)` for
  a `TextureComputation` (`Computation.js:24`); inputs arrive as the `{name: ColumnData}` we pass to
  `createColumn`. Per-sounding `topo` is therefore just another input column gathered by
  `floor(i/nVert)` — **not** an axis domain, **not** a uniform. Our geometry transform emits raw
  data-space `(x, y)` and never calls `getAxisDomain` (projection happens later in the layer vertex
  shader via `plot_pos`), so the earlier "how does topo reach the transform" worry is moot.
- **GPU-side offscreen cull** — the current filter pattern
  (`if (!filter_(fval)) { gl_Position = vec4(2,2,2,1); return; }`) is gladly's own `PointsLayer`
  cull. It is GPU-side and must not change the drawn array. It stays, and the current-sounding
  highlight reuses the same mechanism.

---

## The design — four GPU column transforms + a custom `lines`-primitive layer

### Precompute the geometry into four flat columns (once per rebuild, on the GPU)

The plottable ensemble is a fixed line topology repeated per sounding. Per sounding the topology is
`nVert = nLayers*2 + (nLayers-1)*2` vertices (two per layer for the vertical dep_top→dep_bot
segment, plus a connector to the next layer). The full ensemble is `nVert * nS` vertices.

We build **four separate column transforms**, each emitting one flat column of length
`nVert * nS`. Every output texel derives its own `(L, isBot, sounding)` from its index via the
shared topology map:

- `sounding = floor(i / nVert)`
- `v = i mod nVert`, and `(L, isBot)` from `v` by the fixed topology order (verticals first, then
  connectors) — the same map `buildTopology` encodes today.

The four transforms:

1. **`resistivity_x`** — a pure **gather, no arithmetic**: `resistivity_x[i] = rho(L(i), sounding)`.
   (A reindex-with-duplication off the input `rho` texture — each `rho(L,s)` is read by the
   layer's two verticals and the connector endpoints touching it.)
2. **`elevation_y`** — the only transform doing real math: `topo(sounding) − dep`, where
   `dep = isBot ? dep_bot_eff(L, sounding) : dep_top(L, sounding)`. It is fully **local**: a direct
   `(L, sounding)` gather plus, **only** for `isBot` on the halfspace (last) layer, one extra
   `(L−1, sounding)` sample for the extension (see below).
3. **`sounding_id`** — pure index math: `floor(i / nVert)`. Used by the current-sounding cull.
4. **`xdist`** — a gather keyed on sounding: `xdist[i] = xdist(sounding(i))`. The filtered quantity.

All four share the same `(L(i), isBot(i), sounding(i))` index function; they differ only in what
they do after the gather, and three of the four do essentially nothing.

**Halfspace extension (local, no scan).** Only the last layer (the halfspace) ever has a non-finite
`dep_bot`; every other layer is finite. So the "previous finite layer" is always exactly `L−1` —
**no backward scan loop**. For the halfspace bottom vertex:

```
dep_bot_eff = dep_top(L) + max(1.5 * (dep_bot(L-1) - dep_top(L-1)), 50.0)
```

with an `L == 0` fallback of `dep_top(L) + 50.0`. This is the single non-adjacent read in the whole
design, and it is one neighbour, not a loop.

### Draw — our custom layer, non-instanced `lines`, projection + xdist-cull vertex shader

Our layer emits a non-instanced `primitive: "lines"` draw — **exactly today's structure**
(`vertexCount = nVert*nS`, GL_LINES pairs `(2k, 2k+1)`), with our own shaders and culls. Each vertex
reads its own `(resistivity_x, elevation_y)` texel from the precomputed columns (passed directly as
per-vertex attributes, no `withOffset`/`a_endPoint`/`instanceCount`). It is built via the **shared
`GlBase`/`LayerType.createDrawCommand` path** (kept untouched), returning its `blend` and shaders
from `_createLayer` the way custom layers already do. The vertex shader is the whole change vs.
today: it stops reconstructing geometry and becomes
`if(!filter_(fval)) cull; if(res_x != res_x) cull; gl_Position = plot_pos(vec2(res_x, elev_y));`.

**Two draws (decided — see "Draw model" below).** The highlight is a second layer drawn *after* the
ensemble in config order; being opaque, it composites on top for free — gladly's intended 2D
layering ("every 2D layer draws at the same depth… 2D layers draw in config order, later ones on
top", `LayerType.js:470`). No depth buffer, no `_is3D`.

- **Ensemble:** one non-instanced `lines` draw over `(resistivity_x, elevation_y)`, translucent (the
  `saturationCount` source-over alpha model we already designed), culled by `xdist` with the
  existing `filter_` offscreen snippet. The vertex shader only projects `(x, y)` and applies the
  xdist cull — **zero reconstruction, zero texture gathers, no loop**.
- **Current sounding:** a second non-instanced `lines` draw over the **same**
  `resistivity_x`/`elevation_y` columns, culled by `sounding_id == u_currentSounding` (a
  uniform-driven offscreen cull, exactly like the xdist filter), opaque black, drawn after → on top.

Non-finite vertices (NaN rho/dep) project offscreen via the same `gl_Position = vec4(2,…)` cull the
transforms/shader already use, so gaps (not bridges) show around missing layers.

**Draw model — two draws, not single-draw z-cull (decided).** A single `lines` draw that selects
per-vertex `z` (near for the current sounding, far otherwise) and leans on the depth test to put
the highlight on top was considered and **rejected** for now: the shared `createDrawCommand`
hardwires `depth: { enable: regl.prop("depthEnable") }` with `depthEnable = plot._is3D`
(`LayerType.js:473`, `Plot.js:1119`), and the `Layer`/`gpuConfig` objects expose **no per-layer
depth hook** (only `blend` is threaded through). Enabling the depth test in 2D would require either
flipping the plot to `_is3D` (unwanted 3D camera/`axisMvp`/`fullViewport`) or a small gladly patch
to thread a per-layer `depth` (mirroring how `blend` is threaded). Since the depth buffer *does*
exist on the shared offscreen (context created with depth; cleared to `depth:1` each frame,
`Plot.js:1056`) and a custom layer *could* opt in à la `GltfLayer` (`depth:{enable:true}`), the
single-draw route stays recorded as a **future option** — but it buys little: the expensive part is
(C), drawn once either way, and the second draw adds no overdraw. If the second draw's vertex-only
cull pass over all `nVert*nS` vertices ever shows up in a profile, restrict it to the current
sounding's known vertex range — issue the draw over just that sounding's `nVert` vertices (a
contiguous slice, offset `u_currentSounding * nVert`) instead of the whole ensemble, shrinking the
second draw to ~one sounding.

### Why this hits both fast-path requirements

Both **move the filter axis** and **move the current sounding** become the *same* mechanism: a
uniform change + GPU offscreen cull over precomputed columns. Nothing is rebuilt and nothing is
resampled/reconstructed per frame. The per-frame cost is a projection-only `lines` draw (plus the
one-column xdist cull) and the honest overdraw (C) — and (C) is the same whether the geometry came
from a loop or a column, so we have removed everything that was removable without changing the look.

### Applies to both ensembles

`SoundingResistivityPlot` (resistivity-depth staircase) and `SoundingPlot` (decay-curve ensemble)
follow the same pattern; the decay ensemble is simpler (`x = gate time`, `y = |value|`, one input
texture, no halfspace), so it needs the same four-column treatment minus the halfspace special
case.

---

## Resolved during design review (gladly 0.0.28 source checked)

1. **Transform output shape — RESOLVED, confirmed.** A column transform *can* declare an output
   length independent of its inputs: `TextureColumn.length = rawTex._dataLength ?? rawTex.width`
   (`Computation.js:82`) takes the length from the texture the transform writes, not from its
   inputs, so expansion + gather are first-class. One transform emits all four columns of length
   `nVert * nS`.
2. **Transform wiring — RESOLVED: inline, no registry/config.** `createColumn` is a plain method
   (`Computation.js:31`), so the layer instantiates its own `TextureComputation` subclass inside
   `createLayer` and consumes the returned `ColumnData` directly as attributes — no
   `registerComputedData`, no `config.transforms`, no two-entry config split, no change to the
   layer's existing UX (one layer, point at a dataset). See the "Column transforms" building block.
3. **`compute` input access — RESOLVED.** Inputs arrive as the `{name: ColumnData}` passed to
   `createColumn`; per-sounding `topo` is a normal input column gathered by `floor(i/nVert)`, not an
   axis domain or uniform. The transform never calls `getAxisDomain`.
4. **Draw model — RESOLVED: two non-instanced draws.** The shared `createDrawCommand` has no
   per-layer depth hook, so the current-sounding highlight is a second, opaque `lines` draw
   composited on top by config order, not a single-draw z-cull. And the draw is **non-instanced
   GL_LINES over the pair topology** (today's structure), not gladly's instanced line-strip — the
   pair order makes each `(2k, 2k+1)` an independent segment, so no `a_endPoint`/`withOffset`/`seg`-id
   is needed. Details and the (deferred) single-draw option are in "Draw model" above.

## Open / to-confirm — all post-build (covered by the Playwright validation run)

The design is settled; nothing below blocks implementation. Build the single-file layer + inline
transform, then confirm these via headless Playwright (`scratchpad_token.txt`; a sounding change is a
different `/s/N` URL — see [[drive_local_app_playwright]]):

1. **Pick consistency.** Both draws are depth-off and composite by config order, so render and pick
   agree automatically (current-sounding layer second → its pick ids win on top). Likely leave the
   **ensemble** draw unpicked (overlapping translucent curves make per-curve pick meaningless) and
   let the existing selection path drive `u_currentSounding`; confirm that matches how selection
   works today.
2. **Measure (C) alone.** Once the draw is projection-only, confirm the sounding-change cost drops
   from ~500 ms toward the ~6 ms `'uniforms'` fast-path floor plus honest overdraw. If overlapping
   translucent-line overdraw still dominates at the target canvas size, that is a *separate*
   rendering-model question (a density raster), not a geometry-pipeline one — do not conflate the
   two.

## Non-goals / settled

- No CPU-side geometry bake (gladly anti-pattern) and no CPU filtering/striding. All geometry
  computation is a once-per-rebuild **GPU** transform.
- The xdist filter mechanism (`filter_` offscreen cull) is correct and stays; the current-sounding
  highlight reuses it keyed on `sounding_id`.
- The current ~500 ms is attributed to (B) per-frame reconstruction + (C) overdraw; this design
  removes (B). Whether (C) needs a different rendering model is deferred until measured post-(B).

## Appendix — superseded options discussion

Earlier drafts framed this as two independent axes (where geometry is computed vs how density is
rendered) with options 1a/1b/1c and 2a/2b/2c, and proposed prototyping a density raster first. That
is superseded: the decided path is precompute-geometry-columns-on-GPU (a GPU variant of "columns +
a custom `lines`-primitive layer") with the current-sounding and filter both as uniform culls. The density-raster idea
is retained only as the fallback *if* measured overdraw (C) proves too expensive after (B) is gone.
The previous per-frame-reconstruction shader (`DEP_BOT_EFF_GLSL` with the `for(k<256)` scan, the big
concatenated topology buffer, the `u_ensemble` branch) is the baseline to delete, not to preserve.

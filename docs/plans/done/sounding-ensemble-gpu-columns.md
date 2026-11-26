# SoundingPlot (decay) — move the JS data transforms onto the GPU

> **Status: READY — decisions resolved, ready to implement.** Follow-up to
> `docs/plans/done/sounding-ensemble-perf-rethink.md`. Scope is **`SoundingPlot` only** (the decay-
> curve ensemble). `SoundingResistivityPlot`'s leftover CPU data-walking (the percentile `sort()`,
> the `nLayers×nS` domain scan, `san()`, the `nVert·nS` fval expansion) was **already fixed directly**
> — not planned — alongside this plan: raw data is marshalled once, validity/geometry/fval are
> baked on the GPU, and the axis ranges are set without scanning the model (resistivity hardcoded
> `[1,5000]` Ωm; elevation from the single topo upload pass). This plan is the equivalent cleanup for
> SoundingPlot.

## Why this exists

The "gladly crime" principle: **data stays in columns and is transformed on the GPU, never walked
element-by-element in JavaScript.** SoundingPlot still violates it at build time. This is an
anti-pattern/consistency cleanup, **not a perf plan** — it all runs once per rebuild (dataset/
channel change), not on a sounding-click (that's the uniform fast path). SoundingPlot has **no**
per-frame reconstruction (its vert does one `sample_vals` fetch + `plot_pos`), so there is nothing
here as costly as SRP's old sort. The goal is to make SoundingPlot structurally identical to the
already-cleaned `SoundingResistivityPlot`: raw columns in, GPU-baked geometry, hardcoded initial
domains, zero model-sized CPU walks.

## Inventory — what `SoundingPlot.js` still does in JavaScript (`createLayer`)

- **`abs` + validity mask** (L128–138): walks the whole `Gate_ChNN` table (`nGates·nS`), computing
  `abs(value)` and masking `≤0`/non-finite → `NaN`, uploaded as the `vals` column. The clearest JS
  elementwise data transform.
- **Domain scans** (L129–145): `yMin/yMax` from the abs'd values, `xMin/xMax` from gate times.
- **`gateX` abs** (L124–125): `abs(gate_time)` per gate (`nGates`, tiny).
- **Ensemble buffer concatenation** (L168–184): expands the gate-pair topology per sounding into
  `bigX/bigG/bigS/bigF` (`nS·nSeg·2`) in JS — the SoundingPlot analogue of the geometry the SRP
  rethink moved to the GPU.

## The pattern to copy (already proven in SRP)

The SRP fix established the reusable pieces this plan reuses verbatim:
- **`RenderedColumn` + `renderPackedColumn`** (`elements/soundingGeomColumn.js`): a one-pass GPU
  column bake. A `geomAt(int i)` body derives `(vertex, sounding)` from the index and gathers/computes
  per output vertex; outputs a flat column of a length we declare.
- **In-shader `san`** (`isnan/isinf → canonical NaN` via `uintBitsToFloat`) so the marshalling copy
  does no processing and the draw culls `x != x`.
- **Hardcoded domains** so no model scan: a fixed initial window (the operator zooms from there).
- **In-shader derivations** for index-math columns (`sounding_id = floor(a_pickId/u_nVert)`), and the
  xdist/`fval` gather as a bake output column.

## Resolved decisions

All three open questions are settled (and the fixed-window numbers were measured against a real
dataset, not guessed):

| # | Decision | Resolution |
|---|---|---|
| 1 | y-domain (`dbdt_abs_pT`) | **Fixed log window** `[1e-17, 1e-5]` (native data units). Delete the `yMin/yMax` scan. |
| 2 | Ensemble geometry | **SRP-style GPU computed columns** — bake `bigX/bigG/bigS/bigF` on the GPU via `renderPackedColumn`; delete the CPU concat. |
| 3 | x-domain (`time_s`) | **Fixed log window** `[1e-7, 1e-1]` (seconds). Delete the `xMin/xMax` scan. |

### The measured-window note (do not get this wrong)

The values `SoundingPlot` uploads to `vals` are the **raw `layer_data` numbers** — there is **no
unit conversion** between `layer_data` and the plot (scalefactor 1.0 on the reference dataset), so
the `dbdt_abs_pT` quantity-kind name is a **label only**. The real amplitude magnitudes are
`~1e-16 … 1e-7`, **not** picotesla. The original draft's suggested `[1e-3, 1e5]` "pT" window would
have placed the entire ensemble off-screen. The domain arrays below are in the data's native units.

Measured on `data/aem_processed_data_foothill_central_valley.measured.xyz` (SkyTEM304, SKB), both
channels:
- `|dB/dt|`: min `1.10e-16`, max `1.04e-07` (Ch01 28 gates; Ch02 37 gates).
- gate times: min `2.25e-07 s`, max `1.04e-02 s`.

The chosen windows pad ~1–2 decades beyond those extents so other AEM systems (higher-moment early
gates, lower late-gate noise floors, longer gate schedules) don't clip:
- `dbdt_abs_pT: [1e-17, 1e-5]`
- `time_s: [1e-7, 1e-1]`

## Implementation

### Step 1 — `abs` + validity → draw shader

Upload the **raw** gate values as the `vals` nD column (`[nGates, nS]`), dropping the CPU
`abs`/mask. In the draw vertex shader, after `float v = sample_vals(ivec2(gateVertex, cs));`:
- `v = abs(v);`
- add `san` (map Inf → canonical NaN) and cull `v <= 0.0` alongside the existing `v != v` NaN cull
  (`if (v != v || v <= 0.0) { gl_Position = vec4(2.0,0,0,1); return; }`).

This deletes the L128–138 CPU transform with no extra GPU pass. The marshalling of `vals` becomes a
pure layout copy (`vals[s*nGates+g] = Number(gateData?.[s])`, no processing), matching SRP's
`rhoFlat`/`topFlat`/`botFlat` marshalling.

### Step 2 — hardcoded domains

Replace the `yMin/yMax` (L129, L136, L139) and `xMin/xMax` (L141–145) scans with:

```js
const domains = {
  time_s:      [1e-7, 1e-1],
  dbdt_abs_pT: [1e-17, 1e-5],
  xdist_m:     ensembleXdistDomain(fval),   // unchanged — per-sounding, tiny
};
```

The `vals` marshalling walk no longer accumulates min/max; it only lays out the raw column.

### Step 3 — ensemble geometry → GPU computed columns (mirror SRP)

Replace the CPU `bigX/bigG/bigS/bigF` concat (L168–184) with GPU-baked columns, reusing
`RenderedColumn` + `renderPackedColumn` from `soundingGeomColumn.js` (make `createLayer` `async`,
as SRP's is).

The expansion is `compact tables → bigN = nS·nSeg·2` per-vertex columns, `nSeg = nGates - 1`. The
transform is pure index-math + gather (nothing computed — the only per-vertex computation,
`abs(sample_vals)`, lives in the draw shader via step 1). For output vertex `i`:

- `vInSounding = i mod (nSeg*2)`, `s = i / (nSeg*2)`
- `gateVertex   = floor(vInSounding/2) + (vInSounding mod 2)`   (gate-pair `g → g+1` topology)
- `x    = sampleColumn(gateXTex, gateVertex)`                   (gather from the `[nGates]` gate-time column)
- `fval = sampleColumn(fvalTex,  s)`                            (gather from the `[nS]` per-sounding xdist column)

Bake the four flat columns with one `GEOM_BODY` selected by `uWhich` (as SRP does), over the shared
`(gate-vertex, sounding)` index map:

```glsl
float geomAt(int i) {
  int vps = i - (i / uNSeg2) * uNSeg2;   // vertex within the sounding
  int s   = i / uNSeg2;                  // sounding index
  if (uWhich == 3) return sampleColumn(fvalTex, float(s));                    // fval
  int g = vps / 2 + (vps - (vps / 2) * 2);                                    // gate index (pair topology)
  if (uWhich == 1) return float(g);                                           // gateVertex
  if (uWhich == 2) return float(s);                                           // soundingIdx
  return sampleColumn(gateXTex, float(g));                                    // x (uWhich 0)
}
```

Input textures: `gateXTex` (`[nGates]`, `abs(gate_time)`), `fvalTex` (`[nS]`, `ensembleXdist(...)`).
`vals` stays an nD `ArrayColumn([nGates, nS])` consumed directly by the draw shader (unchanged).

The draw shader's ensemble branch then reads the four baked columns as per-vertex attributes
(`x`, `gateVertex`, `soundingIdx`, `fval`), exactly as it reads them today — the attribute *names*
and shader body are unchanged; only their *source* moves from CPU arrays to baked columns. The
current-sounding line (`nSeg*2` verts) and the dot-marker (`points`, `nGates` verts) sublayers stay
as the existing tiny CPU arrays (not model-sized — no bake needed).

## Validation
- Headless Playwright render: ensemble heatmap + moving current line, **zero shader errors**, using
  the synchronous-compile hook to de-flake GLSL errors (the `flat`/reserved-keyword lesson).
- Confirm the ensemble is visible and on-screen with the hardcoded windows on the reference dataset
  (`data/aem_processed_data_foothill_central_valley.measured.xyz`) — i.e. the native-units windows,
  not pT.
- Confirm moving the current sounding is still a pure uniform update (no rebuild, no CPU geometry).

## Non-goals / settled
- Not a perf plan; build-time only. The sounding-click fast path is untouched.
- Translucent-line overdraw (cost C from the rethink) stays out of scope.
- The `vals` nD column stays the shared data source for both the ensemble and the current-sounding
  uniform fast path — it is not duplicated into a baked y column.

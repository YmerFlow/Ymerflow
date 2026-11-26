# SoundingPlot (decay) — move the JS data transforms onto the GPU

> **Status: DRAFT — needs operator decisions before implementation.** Follow-up to
> `docs/plans/done/sounding-ensemble-perf-rethink.md`. Scope is **`SoundingPlot` only** (the decay-
> curve ensemble). `SoundingResistivityPlot`'s leftover CPU data-walking (the percentile `sort()`,
> the `nLayers×nS` domain scan, `san()`, the `nVert·nS` fval expansion) was **already fixed directly**
> — not planned — alongside this draft: raw data is marshalled once, validity/geometry/fval are
> baked on the GPU, and the axis ranges are set without scanning the model (resistivity hardcoded
> `[1,5000]` Ωm; elevation from the single topo upload pass). This plan is the equivalent cleanup for
> SoundingPlot.

## Why this exists

The "gladly crime" principle: **data stays in columns and is transformed on the GPU, never walked
element-by-element in JavaScript.** SoundingPlot still violates it at build time. This is an
anti-pattern/consistency cleanup, **not a perf plan** — it all runs once per rebuild (dataset/
channel change), not on a sounding-click (that's the uniform fast path). SoundingPlot has **no**
per-frame reconstruction (its vert does one `sample_vals` fetch + `plot_pos`), so there is nothing
here as costly as SRP's old sort.

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
- **Hardcoded / upload-pass domains** so no model scan: a fixed initial window, or min/max that falls
  out of the one marshalling walk.
- **In-shader derivations** for index-math columns (`sounding_id = floor(a_pickId/u_nVert)`), and the
  xdist/`fval` gather as a bake output column.

## Proposed design

1. **`abs` + validity → shader.** Upload the **raw** gate values as the `vals` column; the layer's
   vertex shader already fetches `sample_vals` and culls `NaN` — extend it to `v = abs(sample_vals(...))`
   and cull `v <= 0.0` (+ `san` for Inf). Deletes the L128–138 CPU transform with no extra GPU pass.
   *Recommended over a `GlslColumn(abs(src))`: for one `abs` a column abstraction is indirection.*
2. **Domains without scanning.**
   - `time_s` (x): gate times are a tiny `nGates` array read once anyway — min/max falls out of that
     one pass (not a model-sized walk). (Or hardcode a decade window if preferred.)
   - `dbdt_abs_pT` (y): **decision needed.** Unlike SRP's resistivity, a sensible fixed decay-amplitude
     window is less obvious. Options: (a) a fixed log window (e.g. `[1e-3, 1e5]` pT — pick with the
     operator); (b) min/max of `|value|` folded into the single `vals` marshalling walk (one pass, no
     separate scan); (c) GPU min/max reduction. Likely (b) — it piggybacks the unavoidable upload.
3. **Ensemble geometry → GPU columns (optional, decision needed).** Mirror SRP: replace the CPU
   `bigX/bigG/bigS/bigF` concatenation with baked columns (`x` = gate time by `gateVertex`, `y` =
   `abs(vals)`, `fval` = per-sounding xdist gather) over one shared `(gate-vertex, sounding)` index
   map; derive `sounding_id` in-shader. **Or** leave the ensemble buffer as a CPU concatenation (it's
   index/layout expansion, not data processing) and only do steps 1–2. The current-sounding dot-marker
   pass (`points`, per-gate) needs its own small vertex range either way.

## Open decisions
1. **y-domain:** fixed log window vs. min/max folded into the `vals` upload pass vs. GPU reduction.
2. **Ensemble geometry:** full GPU-column mirror of SRP, or leave the CPU concat (layout, not
   processing) and only move `abs`/validity/domain?
3. **x-domain:** min/max of gate times (tiny, once) vs. a hardcoded decade window.

## Non-goals / settled
- Not a perf plan; build-time only. The sounding-click fast path is untouched.
- Translucent-line overdraw (cost C from the rethink) stays out of scope.
- Validation: headless Playwright render (ensemble heatmap + moving current line, zero shader
  errors) + the synchronous-compile hook to de-flake GLSL errors (the `flat`/reserved-keyword lesson).

# Sounding Ensemble (all soundings behind the current one, filtered by xdist)

> **Status: DRAFT — design settled; ready to finalise once the operator confirms. Do not
> implement until the plan is committed.**
>
> **Scope note:** Selection-driven dimming of the ensemble (greying/brightening soundings to
> track the cross-section's selection) is **deferred to a later plan** — see "Deferred:
> selection-dimming". A **2×-wide** current-sounding line is likewise deferred (1px for now).
> This plan ships the always-on ensemble overlay filtered by xdist.

## Motivation

`SoundingPlot` (gate time vs |gate value|) and `SoundingResistivityPlot` (resistivity-depth
staircase) currently draw **one** sounding — the current selection — reconstructed in the
vertex shader from nD columns that already hold **every** sounding
(`[nGates, nSoundings]` / `[nLayers, nSoundings]`, uploaded once as GPU textures; see
`docs/plans/done/current-sounding-uniform-fast-path.md`). That all-soundings upload was done
specifically to leave a clean path to this ensemble view.

**Target rendering (always on):** draw **all** soundings as a faint **translucent-red** overlay
whose per-line alpha is computed from the sounding count (so a set fraction of overlapping lines
saturates to full red — see A), with the **current sounding on top as a solid black line** (1px
for now; a 2×-wide variant is deferred), so the operator always sees the selected sounding against
the spread of the whole line/survey. A **filterbar on xdist** (distance along line) restricts the
red overlay to a distance window; the black current sounding always shows.

There is **no mode toggle** — both the ensemble and the current sounding are drawn every time.

---

## What the fast-path change already gives us (reused as-is)

- Both layers already upload **all** soundings as nD `ArrayColumn`s → single GPU textures,
  sampled in the vertex shader by a sounding index (today the uniform `u_currentSounding`).
- Both already reconstruct per-sounding geometry on the GPU from a **fixed topology** built once
  (`buildTopology(nLayers)` staircase; gate-pair lines + points for the decay curve). The
  ensemble reuses this exact topology, instanced over soundings.
- The current-sounding **fast path** (uniform update, no rebuild) is untouched: the black
  "current" line stays a cheap `u_currentSounding` uniform change.

---

## gladly filter-axis mechanism (verified against gladly 0.0.28 source)

A layer declares `filterAxisQuantityKinds: { suffix → qk }` (constructor field or
`getAxisConfig` return). gladly injects `bool filter_<suffix>(float value)`; the layer reads a
**normal per-primitive attribute** (the filtered quantity — its choice) and culls the primitive
offscreen when the test fails. Setting `filterbar: "horizontal"` on that axis's config gives the
operator a scrub-bar UI whose pan/zoom sets the shared filter range (open bounds by default, so
everything shows until scrubbed). The filtered quantity is independent of the plotted spatial
axes — exactly what we need: filter by **xdist** even though neither sounding plot plots xdist.

Filter bounds are stored separately from spatial domains in the axis registry, so `xdist_m`
being a *filter* axis here does not collide with `xdist_m` being a *spatial* axis on the
cross-section, even in a linked workspace.

---

## Design

Each layer returns **two groups of sublayers** on every build:

### A. Ensemble — all soundings, dimmed red, filtered by xdist

One **instanced draw** reusing the existing per-sounding topology as the instance's vertex
geometry, with `instanceCount = nSoundings` and the per-instance sounding index taken from the
built-in per-instance **`a_pickId`** (gladly already runs it `0..nSoundings-1` for an instanced
layer — no need for `gl_InstanceID`), in place of `u_currentSounding`:

- `SoundingResistivityPlot`: `vertexCount = nVert` (`buildTopology(nLayers)`),
  `instanceCount = nSoundings`; sample `rho/dep_top/dep_bot` at `(layer, int(a_pickId))`;
  `u_topo` becomes a **per-instance** attribute (topo per sounding) instead of a uniform.
- `SoundingPlot`: `vertexCount = 2·nSeg` (gate-pair lines) + a points pass,
  `instanceCount = nSoundings`; sample `vals` at `(gate, int(a_pickId))`; NaN gate → offscreen
  as today.

**Colour + count-derived alpha.** One red `ensembleColor`, drawn with standard source-over alpha
blending, whose per-line **alpha is computed from the sounding count** so that a set fraction of
overlapping lines saturates to full red. The fraction is a layer parameter:

```js
saturationFraction: { type: 'number', default: 0.1, exclusiveMinimum: 0, maximum: 1 }
```

With `N = nSoundings`, a saturation target `T` (how opaque "saturated" is — a fixed internal
constant, e.g. `T = 0.9`), and `K = max(1, saturationFraction · N)` lines overlapping, source-over
compositing gives accumulated opacity `1 − (1 − a)^K`. Solving `1 − (1 − a)^K = T` for the
per-line alpha:

```
a = 1 − (1 − T)^(1 / K)        // clamp to [tiny floor, 1]
```

So `K` overlapping lines reach opacity `T`; fewer stay translucent, more clamp at full. `a` is a
layer uniform computed once at build from `N` (recomputed only on a real rebuild). No per-sounding
colour variation and **no selection dimming** in this plan — the frag emits the flat
`vec4(ensembleColor.rgb, a)` (this is the one spot a later `v_selection` dim slots into).

*Note:* the alpha is derived from the **total** sounding count, not the count currently passing the
xdist filter — so a heavily-filtered overlay reads fainter. Acceptable for v1 (documented); a
filter-aware alpha would need the passing count, which the layer does not cheaply have.

**Filter (xdist):** each instance carries its **xdist** as a per-instance attribute (`fval`,
`divisor = 1`). The layer declares `filterAxisQuantityKinds: { '': 'xdist_m' }`, provides
`domains.xdist_m = [xmin, xmax]` so the filterbar has a range, and the vert does:

```glsl
if (!filter_(fval)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // outside xdist window
```

The operator enables the scrub UI with `filterbar: "horizontal"` on the `xdist_m` axis (standard
gladly). Default bounds open → the whole line shows until scrubbed.

The ensemble shaders are the current single-sounding shaders with the sounding index swapped
(`u_currentSounding` → `int(a_pickId)`), `u_topo`→attribute (SRP), and the filter branch added.

nSoundings is large (~9 k observed) but this is **one** instanced draw of a few-hundred-vertex
template, uploaded once and re-rendered (not rebuilt) on filter change; the data textures are
already resident.

### B. Current sounding — solid black, on top, unfiltered (1px for now)

The existing single-sounding draw, kept and drawn **after** the ensemble so it is on top:
`u_color = black`, the existing `u_currentSounding` uniform path (so moving the selection stays on
the fast path), **1px**. It is **not** filtered — the selected sounding always shows, even outside
the xdist window. Opaque black over the translucent-red ensemble reads clearly at 1px.

A **2×-wide** variant is deferred: WebGL `gl.lineWidth` is clamped to 1px on most browsers, so a
true 2× needs a screen-space ribbon (triangle strip widened perpendicular to each segment, the
same technique as the curtain outline / marker bars). Not in this plan.

---

## Per-layer specifics

**SoundingResistivityPlot:**
- Ensemble: instanced staircase, `vertexCount = nVert`, `instanceCount = nSoundings`, sounding =
  `int(a_pickId)`; `u_topo` → per-instance `topo` attribute; per-instance `fval = xdist`;
  translucent-red (count-derived alpha); xdist filter.
- Current: existing staircase, black, 1px, on top (unchanged sampling via `u_currentSounding`).
- Table sampling, halfspace scan, robust resistivity domain all unchanged; add `domains.xdist_m`.

**SoundingPlot:**
- Ensemble: instanced decay curve (lines + points), `instanceCount = nSoundings`, sounding =
  `int(a_pickId)`; per-instance `fval = xdist`; translucent-red; NaN gate → offscreen; xdist filter.
- Current: existing lines + points, black, 1px, on top.

**Shared helper (small):** per-instance xdist/topo attribute builders, the filter vert snippet, and
the count→alpha formula, so both layers stay in sync — new `elements/soundingEnsemble.js`, or inline
if it stays tiny.

---

## Deferred: selection-dimming (separate later plan)

Making the ensemble's red **selection-dependent** (full red for soundings in the cross-section's
selection, greyed otherwise, mirroring how the cross-section dims unselected cells) is **out of
scope here**. Agreed future direction (not built now): a canonical `[nFeature × nSoundings]`
selection-grid texture (feature = gate/layer) matching the sounding data textures, written by the
cross-sections and read by the sounding plots — which also means restructuring `ResistivityCurtain`
to stop compacting cells (so its instance index *is* the grid) and deciding how `ChannelPlot`
(per-vertex lines) joins the grid. Captured here only so this plan's ensemble frag leaves the
`v_selection` dim an obvious drop-in slot.

---

## Resolved design decisions

- **No mode toggle** — both plots always draw the ensemble + the current sounding.
- **Current sounding: 1px solid black**, on top, unfiltered (2× ribbon deferred).
- **Ensemble: translucent red**, alpha derived from the sounding count via a saturation model so a
  set fraction of overlapping lines saturates; the fraction is a layer parameter
  `saturationFraction` (default `0.1`). Exact red: a mid red (e.g. `rgb(200, 30, 30)`) — operator
  to confirm the hue; the hue can also be exposed as `ensembleColor` if wanted.
- **Filter: xdist only**, via a standard `filterbar` on the `xdist_m` axis; current sounding
  unaffected by the filter.
- **Selection-dimming + 2× line + grid-selection unification: deferred** to a later plan.

---

## Acceptance criteria

- Both plots always draw the full ensemble (translucent red) + the current sounding (black, 1px) on
  top, with no mode toggle.
- Changing the current sounding stays on the uniform fast path (no `_initialize`); the ensemble is
  undisturbed.
- A `filterbar: "horizontal"` on the `xdist_m` axis restricts which ensemble soundings draw, live,
  with no rebuild; open bounds show the whole line; the current sounding always shows regardless.
- Existing single-sounding behaviour (the black top line) matches today's selected-sounding curve.
- Add coverage for the ensemble instance indexing and the per-instance xdist/topo builders.

---

## Risks

- **Overdraw / fill cost** with ~9 k overlaid translucent curves; the count-derived alpha bounds
  the visual saturation, but blended fill is the cost to watch. One instanced draw keeps vertex
  cost bounded.
- **Correct source-over blending** — the ensemble must use standard src-alpha / one-minus-src-alpha
  blending for the saturation model to hold; confirm gladly's per-layer `blend` default (or set it
  explicitly on the ensemble sublayers).
- **Per-instance `u_topo`** (ensemble) vs uniform (current) — verify elevation stays correct per
  instance in `SoundingResistivityPlot`.
- **Instanced `a_pickId` as sounding index** — confirm gladly binds `a_pickId` per-instance
  (`divisor 1`, values `0..instanceCount-1`) in the instanced draw (it does for the existing
  GateAnomaly/curtain instanced cells); otherwise fall back to `gl_InstanceID`.
- **Count-derived alpha uses total nSoundings**, not the filtered count (documented above) — a
  heavily xdist-filtered overlay reads fainter than the saturation target.

---

## File-by-file task list (provisional — pending decisions)

- `elements/SoundingResistivityPlot.js` — ensemble instanced staircase (dim red, xdist filter,
  per-instance topo) + current staircase (black, 1px, on top); `domains.xdist_m`.
- `elements/SoundingPlot.js` — ensemble instanced decay curve + current (black, 1px, on top).
- `elements/soundingEnsemble.js` (new, optional) — shared per-instance attribute builders, filter
  snippet, and (if chosen) the screen-space ribbon helper.
- Tests — ensemble instance indexing; per-instance xdist/topo builders.

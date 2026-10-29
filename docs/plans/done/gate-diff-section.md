# GateDiffSection — a second editing view of the same in-use edits

**Status:** implemented. Decisions made (Ben, 2026-10-28); the ones taken during implementation are under [Implementation](#implementation).

## Motivation

Culling Estancia by hand on drawing sheets (2026-10-28), Ben found a gate-by-distance
section, each gate shown against its own running median along the line, a better culling view than
the gate profiles: coupling, fences and IP stand out as coloured columns and bands against
the decay, where on the log profiles they are small wiggles among fifty curves. He wants it in
YmerFlow as a plot layer, shown beside ChannelPlot, with in-use edits made in either view
appearing in both before saving.

Reference implementation (offline, matplotlib): `draw_sheets.py`, the "DRAW HERE" panel, in
the Estancia `processing_tests/manual_cull_L1060-L1080/scripts/`.

## Decisions

| | |
|---|---|
| **A view, computed in the browser** | the running median is computed when the layer is built; nothing is stored, and the backend does no work |
| **Window and colour range are layer parameters** | defaults: a ±500 m half-width window (1000 m end to end, what the sheets used; their "±1 km" label was wrong) and ±0.5 decades (×0.3 to ×3) |
| **The median uses in-use data only** | automatic culls do not pull the baseline |
| **Same InUse tools, either window** | freehand lasso with the InUse Editor's Enable / Disable / Clear, undo and Save, unchanged |
| **Name: `GateDiffSection`** | PascalCase, like the other layer types |

## What the layer draws

For one channel of one dataset part:

- **x** — distance along the line (`xdist`), the same axis as ChannelPlot, so the two panes line up.
- **y** — gate index, early gates at the top.
- **colour** — for each gate, `log10(value) − log10(median of that gate's in-use values over ±window m
  along the line)`, on a diverging scale (green above, brown below, white at zero), clipped at
  ±range decades. Not-in-use cells are grey.
- **edit overlay** — the same four InUse states as ChannelPlot (auto-enabled, auto-disabled,
  manually enabled, manually disabled), drawn as tints over the cells.

Layer parameters: `dataset`, `channel` (default `Ch01`), `inUseMode`, `selection`
(default `inuse_brush`, injected the same way as for ChannelPlot), `window_m` (500, the half-width),
`range_decades` (0.5), `xAxis`, `yAxis`.

The median is computed per gate per line part with a sliding window over soundings within
±`window_m` along `xdist`; a sorted-window update keeps a ~800-sounding window over ~50 gates ×
~17k soundings to about a second in JS. Recomputed when the dataset, the window or the
in-use mask changes, not on every edit.

## Editing

A lasso on the section selects cells directly: each cell is one (sounding, gate), which is
simpler than ChannelPlot's curve segments, where the mask is mapped from vertex pairs back to
soundings. The resulting entries, with the global sounding index taken through `apply_idx` (as
`Number`), go into the **same** in-memory diff store through the same `applyInMemoryEdit` call
and keys (dataset path, channel, gate, global sounding index). ChannelPlot reads that store, so
an edit in either pane redraws in both, and Save writes one diff as today. The PlotView selection
handler gains a branch for `GateDiffSection` layers beside the existing ChannelPlot one.

## Coordination with `inuse-flag-editor-gpu.md`

That plan moves the diff from JS Maps to a GPU-resident `DiffColumn`, one tile per gate. The
section layer reads whichever representation is current. If the GPU plan lands first, the
section's fragment shader samples the same DiffColumn texture, indexed by sounding (along the
line) and gate (tile), which fits the section's layout directly.

## Out of scope

- The model's proposed culls as a third overlay state (a later "proposed edits" layer).
- A dedicated trapezoid tool (click the core, drag the flanks), the shape Ben draws most; a
  possible later addition.
- Multi-channel stacking in one section.

## Work

1. `frontend/src/widgets/PlotView/elements/GateDiffSection.js`: registered layer type, schema,
   median computation, cell rendering and InUse overlay.
2. PlotView selection handler: the cell-mask branch for `GateDiffSection`.
3. A workspace layout example with ChannelPlot and GateDiffSection stacked on one x axis.
4. `docs/frontend/widgets.md`: the new layer and the two-view editing.

## Tests

- Unit: the running median per gate on a synthetic line, with culled cells excluded, against a
  numpy reference; the cell-to-(sounding, gate) mapping, including `apply_idx` on single-line parts.
- Integration: an edit made in GateDiffSection appears in ChannelPlot's overlay and the reverse; one
  Save writes one diff containing both.

## Implementation

Decided with Ben during implementation (2026-10-28):

- The y axis numbers gates from 1 (layer_data key + 1), as the sheets do; the diff keeps the key.
- In the section, manually enabled is tinted blue, since ChannelPlot's green would read as data on the brown-green scale; manually disabled is red, and cells not in use are grey 0.82, as on the sheets.
- A cell has no median, and shows grey, when fewer than a quarter of the soundings in its window are in use, as the sheets' pandas `min_periods` did.

Where it went:

- `frontend/src/widgets/PlotView/gateDiff.js`: the running median (a sorted window over `xdist`, line by line) and the per-gate column, kept free of gladly so they are unit-tested against numpy.
- `frontend/src/widgets/PlotView/inUseEdits.js`: what both layers share, the lasso-to-entries mappings for ChannelPlot's segments and the section's cells, and `soundingState`, the one lookup of pending edits. If the GPU `DiffColumn` lands, this lookup is what changes.
- `frontend/src/datamodel/inUseDiffs.js`: the in-memory store's reducer, moved out of `ProcessContext.jsx` so the two-pane test drives the real store.
- A lasso selects a cell when the cell's center is inside it: in gladly's capture pass the layer reports the center.
- The two editing layers go in separate panes. Layers in one pane share its selection channel, and PlotView skips, with a console error, a layer whose mask does not fit it. PlotViews in a workspace link selections of the same name, but each pane clears its selection inside its own handler, before the link passes it on, so the other pane receives an empty selection.

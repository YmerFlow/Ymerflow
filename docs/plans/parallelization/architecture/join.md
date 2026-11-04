# Join process

Part of the survey-parallelization architecture. The **join** process takes a
rootless dataset and produces a rooted one — it is the only thing that writes a
real whole-survey file. This document specifies what it produces and how it
blends. It is referenced by the parallelization plan; it is not itself a plan.

See also [`rootless-datasets.md`](./rootless-datasets.md) (why output is rootless
and when a join is needed) and the grid-split process (which produces the
overlapping parts join blends — its own doc).

## Output shape (uniform)

Join always produces a normal **rooted, line-partitioned** dataset — root files
plus `parts/<flightline>.*` — regardless of how the input was partitioned:

- **Line-partitioned input** (non-overlapping): join is a trivial concatenation
  of the parts into the whole; the line parts are unchanged.
- **Gridded input** (overlapping cells): join blends the overlaps into one whole
  survey (below) and then re-partitions by flightline.

In both cases the output is built by assembling one whole `libaarhusxyz.XYZ` and
handing it to the existing `write_dataset`, which already writes the root files,
the per-flightline parts (via `split_by_line`), stats and geometry
(`deps/aem-processes/aem_processes/dataset_utils.py`). So the grid-cell
partitioning is purely an inversion-compute detour; the canonical downstream
shape is always by-flightline.

Join is a **whole-survey process** — it reads all parts — so it is not
fragmentable; it is an ordinary single-fragment process.

## Blending overlapping (gridded) parts

A sounding that fell in the overlap between cells was duplicated into each
neighbouring cell, and the inversion produced a *separate model estimate* per
cell (different lateral neighbours). Join reconciles those duplicates.

### Matching duplicates

Duplicates are matched by **`sounding_id`** — the survey-global unique integer
assigned once at full rate and carried forward unchanged through split and
inversion. This is provided by the sounding-links feature (plan
`docs/plans/sounding-links-and-downline-distance.md`, branch `plan/sounding-links`,
PR YmerFlow/Ymerflow#137; decision 1 there). Join depends on that feature; it
does not invent identity of its own.

For each `sounding_id`, join gathers every cell's row for that sounding.

### Always blend — there is no separate dedup

Join **always** takes the weighted average across the contributing cells; it
never tests for equality and has no notion of "data columns" vs "model columns".
This is correct uniformly: a weighted average of equal values is that value (bar
float rounding), so the raw measurement columns — identical across cells — come
through unchanged, while the inverted model columns — differing between cells —
are genuinely blended. No column-type metadata, no equality comparison.

The one special case is **`NaN`**: a `NaN` contributor is excluded from the
average and the weights renormalise over the remaining (non-`NaN`) contributors,
so a value present in only one cell comes through as that one value. If every
contributor is `NaN`, the result is `NaN`.

### Weights

Weights come from the **core bbox** each cell recorded at split time, expressed
in the dataset's CRS (its UTM zone). For a sounding and a contributing cell, the
weight ramps **linearly from 1 at that cell's own core-bbox edge to 0 at the
adjacent cell's core-bbox edge**, normalised across the cells contributing to
that sounding. A sounding inside a single cell's core (no overlap) has weight 1
there and is taken directly.

In two dimensions this is **separable bilinear**: the weight is the product of an
x-ramp and a y-ramp, each computed by the 1-D rule above (1 at the cell's own
core-bbox edge, 0 at the adjacent cell's core-bbox edge on that axis), and the
resulting per-cell weights are normalised across the cells contributing to the
sounding. On a pure edge overlap (neighbours along one axis only) the other
axis's ramp is 1, so this reduces exactly to the 1-D ramp; through a corner
shared by cells in both axes it blends smoothly with no seams.

## Dependencies

- The **sounding-links** feature for `sounding_id` (matching duplicates).
- The **grid-split** process for the recorded per-cell core bboxes (the blend
  geometry) — see its doc.

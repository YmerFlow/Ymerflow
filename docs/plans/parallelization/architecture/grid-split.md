# Grid-split process

Part of the survey-parallelization architecture. The **grid-split** process
repartitions a survey's soundings into overlapping square grid cells, so a
spatially-constrained inversion can run one tractable, parallel fragment per
cell. This document specifies the grid and the metadata it records; it is
referenced by the parallelization plan, not itself a plan.

See also [`join.md`](./join.md) (which blends the overlapping cells back into a
whole using the core bboxes recorded here), [`rootless-datasets.md`](./rootless-datasets.md),
and [`version-fragments.md`](./version-fragments.md).

## Purpose and shape

Grid-split takes one dataset and writes a **rootless** dataset whose parts are
grid cells (rather than flightlines). A fragmentable inversion then maps over
those cell parts (one version fragment per cell, run in parallel), and a
[join](./join.md) blends the overlaps back into a rooted, line-partitioned
dataset.

Grid-split is a **whole-survey process**: it must see every sounding's position
to place it, so it is an ordinary (non-fragmentable) single-fragment process that
reads the whole input (all parts, if the input is itself rootless). It is O(survey)
but single-pass and cheap next to the inversion it feeds, so it is not on any
per-edit hot path.

It is dataset-type-aware and, for now, AEM/XYZ-specific: it grids on the
soundings' projected (x, y) in the dataset's CRS.

## The grid

- **Cell size.** A user-chosen square cell size `S` (CRS units).
- **Alignment.** Cells are aligned to the **UTM zone origin**: cell boundaries
  fall at integer multiples of `S` from the zone origin. So a sounding at
  projected `(x, y)` has core cell `(i, j) = (floor(x / S), floor(y / S))`, and
  cell `(i, j)`'s **core bbox** is `[i·S, (i+1)·S] × [j·S, (j+1)·S]`. Alignment is
  deterministic and independent of the survey's own extent (the same zone + `S`
  gives the same grid for any survey). An origin offset, if used, is expressed in
  **whole cell sizes** and does **not** include the margin.
- **Which cells exist.** A cell is generated **iff at least one sounding has its
  position in that cell's core bbox**. There are **no empty cells**, and every
  cell has ≥1 core sounding. (Cells are discovered from the data, per decision 4.)
- **CRS.** Everything is computed in the dataset's own CRS (its UTM zone), which
  the data is assumed to carry (decision 5).

## Membership and margin

Each cell part contains the soundings within **core ∪ margin**, where the margin
is a **symmetric halo of a fixed distance `d`** (CRS units) around the core bbox.
A sounding in the overlap between cells therefore appears in more than one cell
part — once as a core sounding of its own cell, and again in each neighbour whose
margin it falls into. After inversion those duplicates carry the same
`sounding_id` (survey-global; see [`join.md`](./join.md) and the sounding-links
feature) and are reconciled by join.

`d` is a user parameter and must be **≥ the inversion's lateral-constraint range**;
matching `d` to the inversion parameters is the **user's responsibility** — the
split does not read or validate inversion settings.

## Output

A rootless dataset in today's on-disk layout minus the root
(`docs/architecture/storage.md`, [`rootless-datasets.md`](./rootless-datasets.md)):

- **Part naming:** `part_path = parts/cell_<i>_<j>`.
- Each cell part is written in the usual per-part formats (msgpack, geojson,
  stats, …), exactly as flightline parts are today.
- **Recorded per part:** the cell's **core bbox** (in the dataset CRS), stored
  alongside the part's `files` in `info.json`. This is the geometry
  [join](./join.md) uses to compute blend weights (weight 1 at a cell's own
  core-bbox edge, 0 at the adjacent cell's core-bbox edge). The margin distance
  `d` is a split parameter and is recorded as provenance; join does not need it.

No root file is written — producing a whole survey from these overlapping parts
requires the blend, which is [join](./join.md)'s job.

## Dependencies

- The dataset must carry a **CRS / UTM zone** (decision 5).
- The **sounding-links** feature's survey-global `sounding_id` must be present and
  carried through inversion, so join can match the duplicated overlap soundings
  (plan `docs/plans/sounding-links-and-downline-distance.md`).

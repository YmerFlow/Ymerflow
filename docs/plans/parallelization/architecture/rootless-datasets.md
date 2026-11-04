# Rootless datasets

Part of the survey-parallelization architecture. This document specifies **what a
rootless dataset is, and where the whole survey gets assembled when something
needs it**. It is referenced by the parallelization plan; it is not itself a
plan.

See also [`version-fragments.md`](./version-fragments.md) (how fragmentable
processes produce these datasets) and the join process (how a rootless dataset is
turned into a rooted one — its own doc).

## What a rootless dataset is

A dataset on disk is `processes/{process_id}/{version}/datasets/{dataset_id}/`
with `root.*` files (the whole survey), `parts/<flightline>.*` files (one per
part), and an `info.json` whose `files` map lists the root and whose `parts` map
lists the parts (`docs/architecture/storage.md`,
`deps/aem-processes/aem_processes/dataset_utils.py`).

A **rootless dataset** is exactly that layout **minus the `root.*` files**: `parts`
is populated, the top-level `files` map is empty/absent. Nothing else differs.

A fragmentable process produces rootless output: each version fragment writes its
one part, and no fragment writes a root (see
[`version-fragments.md`](./version-fragments.md)). The reason output is rootless
is cost — regenerating the whole-survey file on every re-run would re-touch the
entire survey and defeat per-fragment reuse, where the whole point is to only
recompute the flightlines that actually changed.

A non-fragmented process still produces a normal **rooted** dataset (its single
fragment is the root part), so rootless datasets arise only from fragmentable
processes.

## Where the whole survey is assembled

**Readers assemble it on demand; the backend never assembles anything.** This
keeps the backend a lightweight byte-proxy (it must not read and concatenate a
whole survey — against the no-expensive-backend-ops rule, and a large survey may
not even fit in memory).

Concretely:

- **Backend — no change needed.** The `/files/{path}` proxy and the per-part
  `/{part_path}/data` endpoints are path-based and serve a part file exactly like
  a root file; they never assume a root exists and never parse survey bytes. The
  only root-assuming endpoints (`/dataset/{id}/data`, `/geography`, the
  `part_path == ""` branches) currently have no callers.

- **Frontend — assembles for whole-survey views.** The default fetch path asks
  for the whole survey (`"all"`). For a rootless dataset that path **falls back to
  fetching the parts and merging them in the browser**, reusing primitives that
  already exist in the frontend (`Dataset._mergePartGeographies`, the JS `XYZ`
  merge constructor, and the "merge parts if all cached" branch already present
  in `getGeography("all")`). This is no heavier than today: the root file *is* the
  concatenation of the parts, so client-side assembly moves the same total bytes —
  just as N requests plus an in-browser merge.

- **Processes — per-part, or consume a rooted dataset.** A fragmentable process
  runs per-part and never needs the whole survey. A process that genuinely needs
  the whole survey (a non-fragmented whole-survey consumer — e.g. a step that
  `msgpack.load`s the entire input) must read a dataset that actually has a root,
  i.e. the output of a **join** (below). A rootless dataset simply has no "root
  part," so narrowing such a consumer's input to the root part only works when a
  root exists.

## The join process

Users can add an explicit **join** process: it takes a rootless dataset and
produces a rooted one (copies/derives the whole-survey `root.*` from the parts).
It is the only thing that writes a real whole-survey file.

- For **non-overlapping line parts**, join is a trivial concatenation of the
  parts into the root. It is *optional* here — reader-side assembly already
  covers viewing; you run join when you want a persisted root (export, or to feed
  a non-fragmented whole-survey process).
- For **gridded datasets**, the parts are grid cells with overlapping margins, so
  a plain concatenation would double-count the overlaps. Join is *required* here:
  it **blends** the overlaps (linear gradient across the overlap) to produce a
  correct whole. Reader-side naive assembly is not valid for overlapping parts, so
  viewing a gridded survey as a whole goes through a join first.

The join process's mechanics (blend, and whether it re-partitions its output back
into line parts) are specified in its own architecture doc.

## The `url` field

A dataset's derived `url` (`backend/models/dataset.py`) is its primary
whole-survey file, i.e. the root, and is `null` for a rootless dataset. Rather
than cope with a null value, a **dataset input is referenced by its `info.json`
file URL** (`/files/.../datasets/{id}/info.json`) — uniformly, for rooted and
rootless datasets alike. This is the right reference for three reasons:

- `info.json` **always exists** (even when there are no root files), so there is
  no null to handle;
- its path embeds the dataset **id**, so dependency extraction resolves the
  dependency with its existing `/files/.../datasets/{id}/...` match, unchanged;
- it **is the manifest** — exactly what the coordinator reads at fan-out to
  enumerate the parts (the union across inputs; see [`reuse.md`](./reuse.md)) and
  narrow each fragment to its part's data-file URL(s). So the pod still receives
  concrete data-file URLs (today's process contract), while the stored and
  selected value is the manifest.

The derived root `url` being null then only matters for a literal "download the
whole survey" affordance (the MCP hint, an export) — which is precisely what a
[join](./join.md) produces.

## Scope of the reader-side work

Small and concentrated — essentially the frontend `"all"` fetch path:

- `Dataset` fetch layer: make the `"all"` / root request fall back to
  fetch-parts-and-merge (data and geography) via the existing merge primitives.
- `webxtile.js`, which currently always opens the root tile.
- `DatasetSelector`'s use of the now-nullable `url`.

Already rootless-safe and needing nothing: the backend proxy and per-part
endpoints, the part selector (`getParts()` already omits the root), the Export
tree, and the plot layer elements (they consume already-loaded data and are
indifferent to root vs part).

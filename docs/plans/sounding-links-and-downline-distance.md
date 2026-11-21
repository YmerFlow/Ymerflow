# Sounding links and downline distance

**State:** proposed 2026-10-31; revised 2026-11-11. Decisions 1–5 taken (see below); the row-order/midnight-sort problem is split out to a separate ticket (see "Not in scope").
**Labels:** enhancement, data model, processing, frontend

## Motivation

The same line is plotted at several stages of processing: full-rate data, averaged data, the inversion model. Two things have to hold: the plots line up along the line, and a sounding picked in one is found in the others.

The first is already solved. Plotting against `xdist` lines the stages up on its own, as long as `xdist` is carried forward rather than recomputed from whatever soundings a dataset holds (libaarhusxyz#16, below). **This plan is about the second: once a step drops or merges soundings, nothing says which input sounding an output sounding came from.**

- xdist was recomputed from whatever soundings a dataset holds. `libaarhusxyz.normalizer.calculate_xdist` is a cumulative sum of the distances between neighboring soundings, starting at 0 at each line's first sounding in that dataset. A thinned dataset gets a shorter line, because a cumsum over fewer points cuts the corners of every turn and loses the length that position noise adds over thousands of full-rate steps, and a dataset whose first sounding was dropped starts its distance somewhere else. On an eight-line test block (98,865 full-rate soundings) the inversion model's recomputed xdist was up to 219 m off the full-rate value. libaarhusxyz#16 (merged 2026-10-30, `4f5a2f69`) keeps an xdist that is already present — `normalize()` now recomputes only when the column is missing or all-NaN — which fixes datasets that carry one forward. Two gaps remain: `normalize_coordinates` still deletes and recomputes it on reprojection (#16 added that delete, so it recomputes in the new CRS's units rather than converting), and data made outside the platform has nothing to carry. The `deps/libaarhusxyz` checkout now carries the fix (`master` is at `56c7da6`, past `4f5a2f69`), so the pin bump is already done.
- Nothing records which input sounding an output sounding came from once a step drops or merges soundings. `apply_idx` is a dataset's own row number, not a link to another dataset. Matching across datasets then falls back to joining on a value, and the available values are weak: a delivered *time of day* recurs on every day of a multi-day survey, so it is not unique across lines — on the test block 7,915 full-rate rows share their time with a row on another line — and `xdist` restarts at 0 on every line, so it is unique only within a line, never across the survey. Neither is a survey-wide key on its own.

What changes which soundings exist today:

- `average_along_line` with `decimate_to` (ymerflow-processing) keeps soundings by spacing and drops the rest;
- `select_lines` drops whole lines;
- `split_by_line` (libaarhusxyz) makes parts, with `apply_idx` mapping back to the whole;
- any step, export or outside program that leaves out soundings with no usable data. Any filter can disable a whole sounding, and in the platform that only switches off its gates, but an inversion input or an export that skips such soundings removes them;
- data imported from outside the platform, such as contractor deliveries or models made elsewhere.

## Background: why `apply_idx` is not the identity

`apply_idx` is the same idea as `sounding_id` — "which input row did this come from" — and was meant to be it. In practice it can't be, and the libaarhusxyz code says so directly. This is recorded here so the next reader doesn't re-propose reusing `apply_idx` as the cross-dataset key.

`apply_idx` is a dataset's own row position, consumed as a **within-frame row address**:

- `diff(self, other)` compares the two frames *positionally*, row-for-row (`diff_df` zips `self.flightlines` and `other.flightlines` by position), and stamps the diff's `apply_idx` via `reset_index(names="apply_idx")` on the frame being diffed.
- `apply_diff(self, diff)` writes back with `df.loc[rows]` where `rows = diff.flightlines.apply_idx.values` — i.e. `apply_idx` is used as **label indices into the frame the diff is applied to**. For this to land on the right soundings, that frame must be the *same* frame (same rows, same index) the diff was taken against. The assumption is that the right is a diff of the left, not of a larger dataset the left was derived from.

Two conflicting meanings of `apply_idx` coexist in `xyz.py`, and the diff path had to pick one:

1. **Within-frame row address** — used by `diff`/`apply_diff`. Valid only inside one version-pair; must be re-derived from the frame in hand.
2. **Pointer into the parent whole** — `split_by_line` stamps `apply_idx = flightlines.index` (the row number in the whole survey) onto each single-line part, and the concat constructor consumes it (`argsort`) to merge parts back into global order.

These collided once `split_by_line` (Benjamin, Jul 2024) began feeding frames that *already carried* an `apply_idx` into `diff`. The `extract_df` annotate path then evolved through three bugfix commits (Egil, Aug 2024), with no design doc:

- **Original** (`df5b6d6`): always `reset_index(names="apply_idx")` → **crashed** on a frame that already had the column ("cannot insert apply_idx, already exists").
- **`76764ab`** ("Bugfixes"): guarded with `and "apply_idx" not in res.columns` → **preserved** the carried one (meaning 2 leaking into the diff: a diff of a part would key to the global whole).
- **`5f5487e`** ("Bugfix", current code): **drop and regenerate** —

  ```python
  if annotate:
      if "apply_idx" in res.columns:
          res.drop('apply_idx', axis=1, inplace=True)
      res.reset_index(names="apply_idx", inplace=True)
  ```

  ruling that **at diff time, meaning (1) wins**: a diff is always a diff of the immediate left/right pair, and any parent-pointer `apply_idx` riding along is discarded and re-derived from the current frame.

So `apply_idx` is, by construction, "a row index into *this* dataframe," re-anchored to the here-and-now on every diff. That is exactly why it cannot double as a durable identity that survives a step dropping or merging rows, a reprojection, or an external import — and why this plan stops overloading it. `apply_idx` stays the within-frame address the diff/apply roundtrip needs (see "Not changing"), and `(Line, sounding_id)` becomes the carried, value-joined identity that `split_by_line`'s parent-pointer use of `apply_idx` was straining to provide.

## Design

### 1. A sounding id, assigned once at full rate

A full-rate importer gives every sounding an integer `sounding_id`, a line-local index assigned once at full rate. The identity key is `(Line, sounding_id)`: `sounding_id` restarts per line, and `Line` — carried on every sounding in every dataset anyway — scopes it. Every process carries both columns forward unchanged. An averaged sounding keeps the id of the full-rate sounding its row was taken from, since averaging already copies that sounding's flightline row.

The id is deliberately *not* a survey-global integer (decision 1). An importer sees one delivered file; it cannot number soundings consistently across a survey that arrives as several files, because it has no sight of the others. A minted global counter is therefore unique only within a single import — exactly the scope of `(Line, sounding_id)` — while buying nothing a line-local index doesn't. `(Line, xdist)` already discriminates every sounding within an import; the only thing an integer index adds over it is exact equality that survives reprojection (where `xdist`, a float, is unit-converted) and the degenerate case of two soundings at one position (`separation` 0, equal `xdist`). It needs `Line`, but that costs nothing — `Line` is part of every key regardless.

Across independently-imported files, no minted id helps on its own: a counter assigned in one import means nothing in another. `Line` numbering and geometry are survey-consistent instead, so `(Line, xdist)` is the *more* portable identifier between separate deliveries. Reconciling two independent imports of the same line is the link builder's job (section 5), not the importer's.

Only a full-rate importer assigns ids. `normalize()` never invents them, because a dataset that arrives without ids may already be thinned, and fresh ids would link it wrongly. A dataset without ids gets them through the link builder (section 5).

### 2. Absolute time, as a weak match value

Where the data already carries an unambiguous absolute time, the importer stores it (seconds since 1970-01-01 UTC, [s]) beside the delivered columns, purely as something `link_soundings` can match on (section 5, method 2) when bringing in external data that has a time but no id. It is never the link key — a line can be re-flown, files can be cut differently, and data can have no time at all — and it plays no part in ordering soundings.

Reconstructing a correct absolute time from a *time of day* that wraps at midnight, and the row-order problems that wrap interacts with, are out of scope here (see "Not in scope"). This plan uses absolute time only where it is already unambiguous.

### 3. Downline distance

`xdist` and its per-step increment are a single number per sounding, so they live as `flightlines` columns — there is no separate per-line table (decision 2). At import, from the full-rate data, each sounding gets two columns, in the linear unit of the dataset's CRS (m or ft):

- `separation`, the distance to the previous full-rate sounding on the same line (0 for the first);
- `xdist`, the downline distance: the cumulative sum of `separation` from the line's start.

Preserving `xdist` is all that is needed for plots of different stages to line up visually. Each sounding is drawn at its own carried `xdist`, so a dataset that dropped soundings — even the start or end of a line — still places every sounding it keeps at the correct position relative to the others. The panels' axis *limits* line up too when the plots share a linked x-axis, which takes the common range from the union of what is shown; nothing extra needs to be carried for that.

Both columns are computed once, at full rate, and carried forward. No step recomputes them from the soundings it holds — libaarhusxyz#16 already enforces this for `xdist` in `normalize()` (recomputing only when the column is missing or all-NaN), and the same guard applies to `separation`. A sounding that a filter disables keeps its row and its values, so the line stays continuous. On reprojection to a CRS with another linear unit, `separation` and `xdist` are converted by the unit factor instead of being recomputed (changing #16's current reproject behaviour, which deletes and recomputes — see decision 3).

### 4. Steps that drop or merge soundings record their source

A step that removes or merges soundings keeps `Line`, `sounding_id`, `separation` and `xdist` on the soundings it keeps, which `average_along_line`, `select_lines` and `split_by_line` already do for every flightline column, and records its source dataset (process, version and dataset name) in `model_info`. A step or export that leaves out disabled soundings must keep the same columns on the rest.

Inversion keeps one model sounding per input sounding today. If an inversion process ever leaves out soundings with no usable data, the same rule applies to its output.

### 5. The link builder

`libaarhusxyz` gets a function that links a target dataset to a source dataset made earlier in the chain or elsewhere:

```
link_soundings(source, target, time_tolerance=..., distance_tolerance=...)
  -> a copy of target with sounding_id set from the matched source row,
     plus a match_quality column in [0, 1]
```

It returns no new container: the link is expressed in the data's own terms, as the target carrying the source's `(Line, sounding_id)`. Matching is attempted, strongest first:

1. `Line` and `sounding_id`, when both datasets carry them;
2. absolute time on the same line, within `time_tolerance` [s];
3. fiducial on the same line, where both have one;
4. the nearest position on the same line, within `distance_tolerance` (in the CRS's linear unit).

`match_quality` records confidence in one number so consumers can threshold or weight without knowing the method taxonomy: near 1.0 for an id match, lower for the weaker methods, and reduced further when more than one source candidate falls within tolerance (ambiguous). An unmatched target row gets a null `sounding_id` and `match_quality` 0, which is self-documenting everywhere downstream — no separate "unmatched rows" report.

Once the target carries the source's `sounding_id`, `separation` and `xdist` are reachable by id from the source, which brings outside data into the same frame; a step may also copy them onto the target by an id join for a self-contained dataset. The same function backs a platform process type, "Link to full-rate data", that takes an input and an output dataset and writes the linked target — now almost a passthrough of `link_soundings`.

### 6. Plots use the link

PlotView matches a pinned dataset's soundings to the current dataset's by `(Line, sounding_id)` when both carry it, and falls back to `Line` and time where they don't (the matching added for pinned panels in #132). Panels of different stages already line up on their carried `xdist`; a linked x-axis gives them shared limits (section 3).

## Where the work goes

- libaarhusxyz: store absolute time where it is already unambiguous, as a match value (no midnight reconstruction — out of scope); `normalize_coordinates` stops deleting `xdist` on reprojection and converts units instead (on top of #16, which is merged and already guards the recompute in `normalize()`); the same guard for `separation`; `normalize()` never assigns `sounding_id`; `link_soundings` (returns the target with `sounding_id` set and `match_quality`).
- deps: ~~bump the `deps/libaarhusxyz` pin to include `4f5a2f69` (#16)~~ — done; `master` is at `56c7da6`, past `4f5a2f69`.
- aem-processes: full-rate importers assign a line-local `sounding_id`, `separation`, `xdist` and (where unambiguous) absolute time; a "Link to full-rate data" process type.
- ymerflow-processing: a test that every step which drops or merges soundings keeps the four columns, and source recording in `model_info` for `average_along_line` and `select_lines`.
- Ymerflow frontend: id matching for pinned panels and sounding sync.

## Decisions (2026-10-31, 2026-11-02, 2026-11-11)

| # | Question | Options | Decision |
|---|---|---|---|
| 1 | Form of the sounding id | A: a line-local index assigned at full rate, keyed `(Line, sounding_id)`. B: a survey-global unique integer. C: absolute time. | A (2026-11-11, reversing B of 2026-11-02). B is impossible for a survey delivered as several files — an importer sees one file and cannot number across them — and buys nothing over `(Line, sounding_id)`, which `Line` (carried everywhere) already scopes. An integer index over `(Line, xdist)` only adds exact equality that survives reprojection and the `separation`-0 case; `Line` being "needed" costs nothing. |
| 2 | Where the downline distance lives | A: in `model_info`, keyed by line. B: a separate table beside `flightlines`. C: `flightlines` columns. | C (2026-11-02). `xdist`/`separation` are one number per sounding, so the only sensible place is a `flightlines` column. No new container. |
| 3 | `xdist` on reprojection | A: convert by the unit factor. B: recompute. | A. Recomputing is what this plan removes; #16 currently recomputes on reprojection, to be changed to conversion. |
| 4 | Averaging windows | A: link through the anchor sounding only. B: also record the first and last full-rate sounding in each average's window. | A for now. The window differs per gate, so B needs more than two ids, and nothing uses it yet. |
| 5 | Where the link builder runs | A: libaarhusxyz function plus a platform process type. B: frontend only. | A, so the CLI, processes and plots share one matcher. |

## Not changing

- `apply_idx` stays a dataset's own row number. Manual edit diffs keep addressing rows, and the save-point work (ymerflow-processing#42, #125) is unaffected. Keying diffs on `Line` and `sounding_id` instead would let an edit survive a change upstream that alters which rows exist; that is a later plan.
- Filters keep disabling soundings by switching off gates. Nothing here changes in-use masks.

## Not in scope

These were considered and deliberately left out; recorded so the next reader doesn't re-open them.

- **Row order / the midnight re-sort → separate ticket.** `normalize_sort_datetime` re-sorts a line by timestamp, and a file whose date column stays at the flight's start date past midnight (while the time of day wraps) gets its after-midnight soundings sorted to the front. This plan does not fix it, because it *can't* be fixed here: correcting a midnight-wrapped time needs the rows already in acquisition order, which is exactly what the sort is for — so either the data is already ordered (the sort is redundant) or it can't be reliably reordered at all. The likely resolution in its own ticket is to drop the resort stage entirely: once `(Line, sounding_id)`, `xdist` and the rest ride on every row, physical row order carries no meaning, so a sort neither helps nor (with ids carried) breaks anything. Note that this is also why the ids are unaffected by the bug — they would be assigned per full-rate sounding regardless of what order the rows are in.
- **A survey-global integer id → impossible, and unnecessary.** An importer sees one delivered file and cannot mint ids that mean anything across other files of the same survey, so a "global" counter is global only within one import. `(Line, sounding_id)` has that same scope and needs nothing coordinated; across independent deliveries, `Line` + geometry (`xdist`) is the portable identifier, and reconciliation is `link_soundings`'s job. Don't reach for a global counter. (Decision 1.)
- **`time` or bare `xdist` as a global key → neither is unique.** A delivered time of day recurs every day of a multi-day survey; `xdist` restarts at 0 on every line. Both only discriminate once scoped to a line, which is why every weak `link_soundings` method matches "on the same line" first.

## Tests

- Average and decimate a line: every kept sounding's `xdist` equals its full-rate value, and `(Line, sounding_id)` is carried.
- Disable every gate of a sounding with a filter: its row, id and `xdist` remain.
- Reproject between a meter and a foot CRS: `xdist` is converted, not recomputed.
- Carry a dataset that already has `xdist` through `normalize()`: it is preserved, not recomputed (covered by libaarhusxyz#16; add the `separation` counterpart).
- `link_soundings`: an exact `(Line, sounding_id)` match gives `match_quality` near 1.0; a time match where the same time occurs on two lines; a position match within tolerance; an ambiguous match (two candidates in tolerance) gets a reduced `match_quality`; an unmatched row gets null `sounding_id` and `match_quality` 0.
- PlotView: a pinned averaged dataset follows the selected line and finds the same sounding by `(Line, sounding_id)`.

Rough size: libaarhusxyz two days, importers and the link process type one day, ymerflow-processing half a day, frontend half a day.

# Sounding links and downline distance

**State:** proposed 2026-10-31, decisions open
**Labels:** enhancement, data model, processing, frontend

## Motivation

The same line is plotted at several stages of processing: full-rate data, averaged data, the inversion model. Those plots should line up along the line, and a sounding picked in one should be found in the others. Today that works only when nothing in between changed which soundings exist.

- xdist is recomputed from whatever soundings a dataset holds. `libaarhusxyz.normalizer.calculate_xdist` is a cumulative sum of the distances between neighboring soundings, starting at 0 at each line's first sounding in that dataset. A thinned dataset gets a shorter line, because a cumsum over fewer points cuts the corners of every turn and loses the length that position noise adds over thousands of full-rate steps, and a dataset whose first sounding was dropped starts its distance somewhere else. On an eight-line test block (98,865 full-rate soundings) the inversion model's recomputed xdist was up to 219 m off the full-rate value. libaarhusxyz#16 keeps an xdist that is already present, which fixes datasets that carry one forward, but `normalize_coordinates` still deletes and recomputes it on reprojection, and data made outside the platform has nothing to carry.
- Nothing records which input sounding an output sounding came from once a step drops or merges soundings. `apply_idx` is a dataset's own row number, not a link to another dataset. Matching across datasets falls back to joining on time, and time is not unique: on the test block 7,915 full-rate rows share their time with a row on another line, and a time of day wraps at midnight.
- Row order can change on load. `normalize_sort_datetime` re-sorts the flightlines by timestamp whenever they are not already in time order. If a delivered file's date column stays at the flight's start date after midnight while the time of day wraps, the soundings flown after midnight are sorted to the front of their line.

What changes which soundings exist today:

- `average_along_line` with `decimate_to` (ymerflow-processing) keeps soundings by spacing and drops the rest;
- `select_lines` drops whole lines;
- `split_by_line` (libaarhusxyz) makes parts, with `apply_idx` mapping back to the whole;
- any step, export or outside program that leaves out soundings with no usable data. Any filter can disable a whole sounding, and in the platform that only switches off its gates, but an inversion input or an export that skips such soundings removes them;
- data imported from outside the platform, such as contractor deliveries or models made elsewhere.

## Design

### 1. A sounding id, assigned once at full rate

A full-rate importer gives every sounding an integer `sounding_id`: its index within its line in flight order, starting at 0. Together with `Line` it identifies the sounding in every dataset made from it. Every process carries both columns forward unchanged. An averaged sounding keeps the id of the full-rate sounding its row was taken from, since averaging already copies that sounding's flightline row.

Only a full-rate importer assigns ids. `normalize()` never invents them, because a dataset that arrives without ids may already be thinned, and fresh ids would link it wrongly. A dataset without ids gets them through the link builder (section 5).

### 2. Absolute time, where there is a time

When the data has a time, the importer stores an absolute time (seconds since 1970-01-01 UTC, [s]) beside the delivered columns:

- with a date and a time, from both, after checking that the time does not wrap within a flight while the date stays put; if it does, the date is advanced at the wrap;
- with only a time of day, by adding a day wherever the time jumps backward by more than half a day within a flight, starting from the flight's date where one is known.

The absolute time is used for ordering and for matching data from outside. It is never the link key, because a line can be re-flown, files can be cut differently, and data can have no time at all.

### 3. Line geometry and downline distance

At import, from the full-rate data, each dataset gets a per-line table: `Line`, start and end coordinates, CRS, and the full-rate line length. Each sounding gets two columns, in the linear unit of the dataset's CRS (m or ft):

- `separation`, the distance to the previous full-rate sounding on the same line (0 for the first);
- `xdist`, the downline distance: the cumulative sum of `separation` from the line's start.

Both are computed once, at full rate, and carried forward. No step recomputes them from the soundings it holds. A sounding that a filter disables keeps its row and its values, so the line stays continuous. On reprojection to a CRS with another linear unit, `separation` and `xdist` are converted by the unit factor instead of being recomputed.

The line table lets a plot draw the whole line, from start to end, even where a dataset has gaps, so panels showing different stages share one x range.

### 4. Steps that drop or merge soundings record their source

A step that removes or merges soundings keeps `Line`, `sounding_id`, `separation` and `xdist` on the soundings it keeps, which `average_along_line`, `select_lines` and `split_by_line` already do for every flightline column, and records its source dataset (process, version and dataset name) in `model_info`. A step or export that leaves out disabled soundings must keep the same columns on the rest.

Inversion keeps one model sounding per input sounding today. If an inversion process ever leaves out soundings with no usable data, the same rule applies to its output.

### 5. The link builder

`libaarhusxyz` gets a function that links a target dataset to a source dataset made earlier in the chain or elsewhere:

```
link_soundings(source, target, time_tolerance=..., distance_tolerance=...)
  -> table of (target row, source row, matched_by)
```

It matches, in order:

1. `Line` and `sounding_id`, when both datasets carry them;
2. absolute time on the same line, within `time_tolerance` [s];
3. fiducial on the same line, where both have one;
4. the nearest position on the same line, within `distance_tolerance` (in the CRS's linear unit).

It reports unmatched and ambiguous target rows instead of guessing. With a link in hand, `sounding_id`, `separation` and `xdist` can be copied from source to target, which brings outside data into the same frame. The same function backs a platform process type, "Link to full-rate data", that takes an input and an output dataset and writes the linked output.

### 6. Plots use the link

PlotView matches a pinned dataset's soundings to the current dataset's by `Line` and `sounding_id` when both carry them, and falls back to `Line` and time where they don't (the matching added for pinned panels in #132). Panels on one line can take their x range from the line table.

## Where the work goes

- libaarhusxyz: the per-line table and where it is stored; absolute time with the midnight check; `normalize()` stops deleting `xdist` on reprojection and converts units instead; `normalize()` never assigns `sounding_id`; `link_soundings`.
- aem-processes: full-rate importers assign `sounding_id`, `separation`, `xdist`, absolute time and the line table; a "Link to full-rate data" process type.
- ymerflow-processing: a test that every step which drops or merges soundings keeps the four columns, and source recording in `model_info` for `average_along_line` and `select_lines`.
- Ymerflow frontend: id matching for pinned panels and sounding sync; x range from the line table.

## Decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | Form of the sounding id | A: index within the line at full rate. B: absolute time. | A, with the absolute time stored beside it, so a later import of the same line cut differently can be re-linked by time. |
| 2 | Row order on load | A: keep the order in the file. B: keep today's sort by timestamp, built from the absolute time. | B. Once ids are carried, a sort no longer breaks links, and some delivered files are out of order. |
| 3 | Where the per-line table lives | A: in `model_info`, keyed by line. B: a separate table in the dataset beside `flightlines`. | Open; this is a libaarhusxyz format question. If A, keys must be strings, since `model_info` reads integers back as floats. |
| 4 | `xdist` on reprojection | A: convert by the unit factor. B: recompute. | A. Recomputing is what this plan removes. |
| 5 | Averaging windows | A: link through the anchor sounding only. B: also record the first and last full-rate sounding in each average's window. | A for now. The window differs per gate, so B needs more than two ids, and nothing uses it yet. |
| 6 | Where the link builder runs | A: libaarhusxyz function plus a platform process type. B: frontend only. | A, so the CLI, processes and plots share one matcher. |

## Not changing

- `apply_idx` stays a dataset's own row number. Manual edit diffs keep addressing rows, and the save-point work (ymerflow-processing#42, #125) is unaffected. Keying diffs on `Line` and `sounding_id` instead would let an edit survive a change upstream that alters which rows exist; that is a later plan.
- Filters keep disabling soundings by switching off gates. Nothing here changes in-use masks.

## Tests

- Import a line that crosses midnight, once with a time of day only and once with a date that stays at the flight's start date: absolute time increases monotonically and no rows move.
- Average and decimate a line: every kept sounding's `xdist` equals its full-rate value, and `sounding_id` is carried.
- Disable every gate of a sounding with a filter: its row, id and `xdist` remain.
- Reproject between a meter and a foot CRS: `xdist` is converted, not recomputed.
- `link_soundings`: an exact id match; a time match where the same time occurs on two lines; a position match within tolerance; unmatched rows reported.
- PlotView: a pinned averaged dataset follows the selected line and finds the same sounding by id.

Rough size: libaarhusxyz two days, importers and the link process type one day, ymerflow-processing half a day, frontend half a day.

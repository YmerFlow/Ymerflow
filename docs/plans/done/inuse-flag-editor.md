# InUse Flag Manual Editor

## Overview

A UI for manually overriding InUse flags on AEM gate data (dbdt ChannelPlot). Users select points via lasso, apply enable/disable/clear overrides, and save as a libaarhusxyz diff. The diff is applied in-pipeline via a compound filter step.

## Four Visual States

Each gate×sounding cell has one of four states, derived by combining the pre-diff data's InUse column with the current diff:

| State | Source | Visual |
|---|---|---|
| Auto-enabled | InUse=1, no diff entry | No overlay (default) |
| Auto-disabled | InUse=0, no diff entry | Grey tint |
| Manually enabled | Diff entry = 1 | Green tint |
| Manually disabled | Diff entry = 0 | Red tint |

## Components

### 1. Compound Filter (`emeraldprocessing.pipeline_step`)

A new pipeline step type that:
- Takes `input`, `output`, and optional `diff` (storage URL) parameters
- Applies the diff to the input data if `diff` is specified; absent/null = pass-through (equivalent to empty diff)
- Always saves the (possibly modified) intermediate result to `output`

Every dataset except the final pipeline output necessarily passes through a compound filter step (there is no other way to produce a named intermediate dataset). The one special case is the final output dataset: if the user opens the InUse Editor against it, a new compound filter step is automatically appended to the end of the pipeline so a stable intermediate exists to edit against.

### 2. ChannelPlot Layer Extension

The existing ChannelPlot plot layer gains an optional InUse overlay mode.

**On mount/data change:**
- Inspects the current process config for the compound filter step whose output name matches this layer's dataset name
- Loads the diff dataset from that step's `diff` URL (null/absent → treat as empty)
- Renders the four-state overlay on top of normal gate value rendering

**Selection and editing — gladly integration:**

Gladly (v0.0.16) provides a GPU-driven lasso selection system. The ChannelPlot layer opts in by adding `selection: 'inuse_brush'` to its layer spec. The config also declares `interactions.lasso` to attach mouse event handlers:

```js
// In plot.update() config
{
  layers: [{ channelPlot: { ..., selection: 'inuse_brush' } }],
  interactions: {
    lasso: [
      { selection: 'inuse_brush', trigger: 'shift' }
    ]
  }
}
```

On every mouseup after a shift-drag, gladly runs its two-pass GPU pipeline and calls `selection.subscribe` callbacks with a `Float32Array` mask (`selection.array`): `1` for selected data points, `0` otherwise. The mask is indexed by the layer's data order (flattened gate×sounding index).

**Transient selection model:**

Selections are applied immediately and cleared — there is no persistent "selected" visual state separate from the four InUse states. The workflow per lasso stroke:

1. User shift-drags a freehand polygon (gladly draws SVG polyline overlay during drag)
2. On mouseup, `selection.subscribe` fires with the mask
3. The callback converts the flat mask indices back to `(sounding_index, gate_index)` pairs using the layer's column layout
4. The current action (Enable / Disable / Clear) is read from the widget's active mode
5. That action is applied to `ProcessContext.inMemoryDiffs[datasetName]`
6. `selection.clear()` is called immediately — the overlay disappears and all points return to their InUse rendering

This keeps the visual state simple: only the four InUse states are ever shown; there is never a persistent "selected but not yet acted on" state.

**Selection mode:**

Freehand lasso (shift+drag) via gladly's built-in `interactions: { lasso: true }`. Gladly draws an SVG polyline overlay during the drag and runs the two-pass GPU selection on mouseup.

**Active action mode:**

The InUse Editor widget exposes three mutually exclusive action buttons (Enable / Disable / Clear) that act as the "active mode". Whichever is active determines what happens when a lasso completes. Keyboard shortcuts (`E`, `D`, `C`) switch the active mode.

**State-based selection:**
- A right-click context menu (or toolbar button) offers "Select all auto-disabled in view" and "Select all manually disabled in view", allowing bulk re-enable of points that were flagged by the automatic QC. These synthesise a selection mask on the CPU from the current diff state and apply the active action directly, bypassing the lasso path.

### 3. ProcessContext Additions

- `inMemoryDiffs`: `{ [datasetName]: sparseEditState }` — accumulates edits across lasso operations before saving
- `inMemoryDiffHistory`: `{ [datasetName]: sparseEditState[] }` — per-dataset undo stack; each entry is a snapshot of the diff state before the most recent edit action
- Helper to update a dataset's in-memory diff given a set of (sounding, gate) index pairs and a value (1 / 0 / NaN); pushes previous state onto the undo stack before mutating
- Helper to undo the last edit for a given dataset (pop from history stack)
- Helper to clear a dataset's in-memory diff (also clears its undo stack)
- Helper to count total manually-set gate×sounding pairs across all datasets with pending edits

### 4. InUse Editor Widget

A separate widget (distinct from the ChannelPlot layer) that owns the save interaction. Each ChannelPlot layer independently accumulates edits into `ProcessContext.inMemoryDiffs` keyed by its dataset name; the editor widget acts on all of them together. This allows concurrent editing of multiple datasets (e.g. raw and averaged data with different filter choices applied to each) within a single session.

**Toolbar buttons:**

Three action-mode buttons act as a radio group — exactly one is always active:
- **Enable** (active mode) — next lasso stroke forces selected points to InUse=1
- **Disable** (active mode) — next lasso stroke forces selected points to InUse=0
- **Clear** (active mode) — next lasso stroke removes selected points from diff (restore pass-through)

Plus one stateless action button:
- **Undo** — revert the last edit action on the most recently edited dataset (Ctrl+Z)

The active mode is shown with a pressed/highlighted state. After each lasso stroke, the active mode stays set (no automatic reset) so the user can keep applying the same action across multiple selections without re-clicking.

**Keyboard shortcuts** (global while the InUse Editor widget is open, not focus-dependent):
- `E` — switch active mode to Enable
- `D` — switch active mode to Disable
- `C` — switch active mode to Clear
- `Ctrl+Z` — Undo

**Edit statistics display:**

A live counter in the widget header shows the aggregate impact of all pending edits, e.g.:
> 2,341 gate-sounding pairs manually edited across 2 datasets (↑ 412 enabled, ↓ 1929 disabled)

This updates after every lasso/undo action so the practitioner understands the scope of in-memory edits before saving.

**Save button:**

Commits all pending edits in a single atomic operation:
1. For each dataset with pending edits in `inMemoryDiffs`:
   a. Serialize in-memory edits to libaarhusxyz diff format
   b. Create a new version of the diff dataset
   c. Update the corresponding compound filter step's `diff` parameter in the process config
2. Create **one** new version of the processing process with all compound filter step updates applied together

All dirty datasets are included in the same new process version, so the pipeline remains consistent after save.

## libaarhusxyz Diff Format (existing)

The existing sparse format is used as-is:
- Only gates that have at least one manually-set sounding are included
- Only sounding indices that have at least one manually-set gate are included
- Non-set values within those sparse slices are NaN
- Values: `1` = force enable, `0` = force disable, `NaN` = pass-through (unset)

## Data Flow

```
Processing pipeline
  └─ compound filter step
       ├─ input: upstream dataset
       ├─ diff: diff dataset URL (optional)
       └─ output: intermediate dataset  ←── ChannelPlot displays this
                                             (pre-diff gate values + diff overlay)
```

The ChannelPlot receives the pre-diff data (gate values as they exist at that pipeline stage, e.g. pre-averaging) plus the diff. This is intentional — edits are made against the actual data at that point, not a later transformed version.

## User Workflow

1. User opens a ChannelPlot pointing at any intermediate dataset (which already passes through a compound filter step by construction) or the final output dataset (which triggers auto-insertion of a trailing compound filter step)
2. User opens the InUse Editor widget alongside the ChannelPlot(s)
3. User selects gates×soundings using freehand lasso, rectangle, or gate-axis range selection
4. User clicks Enable / Disable / Clear (or uses keyboard shortcuts); edit statistics update live
5. User presses Ctrl+Z to undo if the selection was wrong
6. Repeat 3–5 across multiple areas and/or multiple ChannelPlot layers (including different datasets)
7. User clicks Save — all pending edits are written as a single new process version
8. Pipeline reruns with the updated diffs applied

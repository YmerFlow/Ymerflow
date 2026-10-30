# Save in-use edits onto a pipeline's save-point step

**Status:** planned. Not started. Frontend only.

**Ticket:** ymerflow-business#125.

## What this is

The InUse editor lets a person edit a dataset's in-use masks, Save, and have the re-run replay
the edit. Today Save understands exactly one place to put a saved edit: a **process-level `diff`
array** on the version's parameters, which it appends a diff URL to. That is the shape
`apply_manual_edits` uses, and the shape `yf_process_tem` uses *as built today*.

Pipeline process types carry edits differently — on a **`save_intermediate_and_apply_diff` step
inside the pipeline**, which holds the edit as a single `diff` URL on the step itself, keyed to a
named save point. Two pipeline libraries use this step:

- **emerald-processing-em** (process type `process_tem`) already ships it — `emeraldprocessing/
  diff.py:save_intermediate_and_apply_diff(processing, name, diff=None)`.
- **ymerflow-processing** (process type `yf_process_tem`) gains it in its edit-points plan
  (`deps/ymerflow-processing/docs/plans/edit-points.md`, YmerFlow/ymerflow-processing#42), which
  also **removes** `yf_process_tem`'s current process-level `diff` array (`takes_edits`,
  `properties["diff"]`, `_replay_edits`, `EDIT_CHECKPOINT` in `aem_processes/
  yf_processing_process.py`).

Both register the step with the *identical* `name` + `diff` signature and the byte-identical
`ManualEditUrl` annotation (`x-url-media-type: application/x-geophysics-xyz-model`). After
edit-points.md lands, `yf_process_tem` has no process-level `diff` for Save to append to, and its
edits live on a step — the same place emerald's already do.

This plan teaches the frontend Save to write a saved edit onto a `save_intermediate_and_apply_diff`
step, **in addition to** the process-level array it already handles. Nothing about the editing
experience changes — same lasso, same Save button, same re-run-replays-the-edit. The change is
purely *where* Save writes the URL. Because the step is matched by its argument shape, one code
path serves both libraries' pipelines.

## What exists (verified against the source)

- **The save loop** is `saveAllDiffs`, `frontend/src/ProcessContext.jsx:349-418`. Per edited
  dataset it: `resolveEditTarget` → `{ process, versionObj, datasetName }`; fetches the
  environment's process types and gates on `acceptsEdits(processTypes, type)` (true iff the type's
  schema declares a top-level `diff`) **before uploading** the diff; builds and uploads the msgpack
  diff; then `createProcess` with `params: { ...editedVer.parameters, diff:
  appendDiff(editedVer.parameters?.diff, diffUrl) }`. A refusal/failure calls `notSaved` and
  `continue`s, keeping the edits in the editor; only saved datasets are cleared.
- **Helpers** in `frontend/src/datamodel/inUseDiffs.js`: `resolveEditTarget`, `buildDiffColumns`
  (unchanged here); `appendDiff` (process-level array builder, kept); `acceptsEdits` (the
  pre-upload gate, generalised here).
- **The process types** (registered by `aem-processes` under `ymerflow.process_types`):
  - `apply_manual_edits` — standalone; schema has a top-level `diff` **array** (append per save,
    replayed oldest-first). *Keeps* this shape. Already works.
  - `process_tem` — **emerald-processing-em** pipeline; schema is `input_data` + `steps`, **no
    top-level `diff`**. Its steps can include emerald's `save_intermediate_and_apply_diff`.
  - `yf_process_tem` — **ymerflow-processing** pipeline; *today* `input_data` + `steps` + top-level
    `diff` array + `label`. edit-points.md removes the array and moves edits onto the step.
  - `yf_qc_tem` — no edits.
- **A step's on-the-wire shape.** The pipeline param `steps` is swaggerspect's `multi=True`
  encoding: an **array** of single-key objects `{ "<step key>": { ...grouped args } }`
  (`deps/swaggerspect/swaggerspect/__init__.py:124-128`). The step key is the **entry-point name**
  (`get_apis_entrypoints` uses `local_names=True`), which differs between the libraries:
  - emerald: `{ "Save intermediate results and apply manual edits": { "name": ..., "diff": ... } }`
  - ymerflow: `{ "save_intermediate_and_apply_diff": { "name": ..., "diff": ... } }`

  So the frontend **must not** key on the step name. Both carry the same args — a `name` (the
  save point's output dataset name) and a `diff` (one optional URL) — and that argument shape is
  what the frontend matches on.

## Design

### Match a save-point step by its arguments, not its key

A save-point step, for an edited dataset, is the step entry in `parameters.steps` whose args carry
a `name` equal to the edited dataset's name **and** a `diff` field (present, possibly null). The
`name` is the save point's output dataset name (the runner writes the snapshot under it), so
`name === datasetName` is the discriminator; the `diff` field confirms the step takes an edit.
This matches emerald's and ymerflow's steps alike without naming either key.

```
saveIntermediateStep(steps, datasetName)
  -> { step, key, args }   // the matching entry, its single key, and its args object
   | null
```

It tolerates a missing/non-array `steps` (returns `null`), and ignores a step whose args lack a
`diff` field or whose `name` differs.

### `acceptsEdits` becomes step-aware (the pre-upload gate)

```
acceptsEdits(processTypes, editedVer, datasetName)
  -> saveIntermediateStep(editedVer.parameters?.steps, datasetName) is non-null      // step shape
   || processTypes?.[editedVer.type]?.schema?.properties?.diff is present             // array shape
```

It needs no diff URL, so it stays the pre-upload gate exactly where it is today
(`ProcessContext.jsx:377`). It gains `editedVer` and `datasetName` because the step case depends on
the version's parameters, not only on the type schema.

### `editedParameters` builds the new version's parameters

```
editedParameters(editedVer, datasetName, diffUrl)
  -> the new `params` object for createProcess
```

- **Save-point step** (emerald `process_tem`, ymerflow `yf_process_tem`): if `saveIntermediateStep`
  matches, return a copy of `editedVer.parameters` with **that one step's `diff` set to `diffUrl`**
  (a single string), leaving every other step, that step's other args, and all other parameters
  untouched, and not mutating the input. The step carries **one** edit per point and its snapshot
  is the fixed pre-edit state, so a second Save **replaces** the step's `diff` rather than appending
  (Decision 2).
- **Process-level array** (`apply_manual_edits`): otherwise return `{ ...editedVer.parameters, diff:
  appendDiff(editedVer.parameters?.diff, diffUrl) }` — exactly today's behaviour.

`acceptsEdits` gated the call with the same `saveIntermediateStep`, so the builder always has a
target; it does not re-decide refusal.

### `saveAllDiffs` wires them in

Two edits to `ProcessContext.jsx`, structure otherwise unchanged:

- The gate at line 377 → `acceptsEdits(processTypes, editedVer, datasetName)`, with the refusal
  message generalised (e.g. `${editedVer.type} has no edit point for "${datasetName}", so a re-run
  would drop the edits`).
- The `params` at line 407 → `params: editedParameters(editedVer, datasetName, diffUrl)`.

The refuse-before-upload ordering is preserved: the gate is unchanged in position and needs no URL.

### What a person edits

A `save_intermediate_and_apply_diff` step emits its save point as an output dataset named after the
step's `name` (ymerflow's runner sink; emerald already dumps it, pending its wrapper exposing it as
a platform output — see Dependencies). `processed_data` and `output` are reserved and cannot be
save-point names. That output opens in a plot like any other. Editing it and Saving sets that
step's `diff`; the re-run writes the snapshot, replays the edit, and continues. A pipeline keeps its
final output editable by carrying a terminal save point. A plot of the bare `processed_data` output
has no matching step, so Save refuses it — correct, because `processed_data` is the post-edit state.

## Out of scope — explicitly not this plan

- **Any change to the editing experience.** Same lasso, action modes, undo, Save button, re-run
  semantics. No ChannelPlot/GateAnomalyPlot change, no overlay, no precedence/counter work.
- **Rendering an already-saved save-point edit as a reversible overlay.** A save point's output is
  the *pre-edit* snapshot, so after saving + re-running, reopening it shows the pre-edit state until
  the library's follow-on editor renders the step's `diff` as an overlay (edit-points.md, "the
  editor follows"). The data re-run is correct meanwhile. (On a final output, saved edits are
  already applied as the dataset's own in-use flags, today and after.)
- **Opening or editing more than one save point at once, or any per-point UI.** A save-point output
  opens like any other output.
- **Carrying cluster, resources and deadline across a Save** (the clone-endpoint change). Separate.
- **Library / aem-processes work.** `save_intermediate_and_apply_diff`, its sink, and the removal of
  `yf_process_tem`'s process-level `diff` are edit-points.md and the aem-processes plan; this plan
  assumes they ship as specified.

## Decisions (open)

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | How a save-point step is recognised | A: by **argument shape** — a step whose args have `name === datasetName` and a `diff` field. B: by a hardcoded set of step keys (`"save_intermediate_and_apply_diff"`, `"Save intermediate results and apply manual edits"`). C: by consulting the type schema for the step whose `diff` field declares `x-url-media-type: application/x-geophysics-xyz-model`. | **A** — library-agnostic and key-agnostic, so emerald's and ymerflow's steps both match with no list to maintain; `name === datasetName` is already the save-point contract. B is brittle (depends on exact registration strings); C is the most principled but needs the steps form schema and more code for no practical gain here. |
| 2 | A second Save on the same save point | A: **replace** the step's single `diff`. B: make it a list and append. | **A** — the step fixes `diff` as one optional URL and the snapshot is the pre-edit state, so each save is the whole edit for that point; a list would need a library change. |
| 3 | `acceptsEdits` when the type has no top-level `diff` but a version's steps carry a matching save point | A: step-match returns true (needs the version + dataset name). B: leave it type-only. | **A** — so the pre-upload gate matches what will actually save, keeping the refuse-before-upload property; `editedParameters` stays the authoritative builder. |

## Work (frontend only)

1. `frontend/src/datamodel/inUseDiffs.js`:
   - add `saveIntermediateStep(steps, datasetName)` (pure, matches by arg shape; returns the entry,
     its key and its args);
   - generalise `acceptsEdits(processTypes, editedVer, datasetName)` to step-match **or** top-level
     `diff`;
   - add `editedParameters(editedVer, datasetName, diffUrl)` (step-set then array-append), input not
     mutated;
   - keep `appendDiff`, `resolveEditTarget`, `buildDiffColumns` unchanged.
2. `frontend/src/ProcessContext.jsx` `saveAllDiffs`: pass `editedVer` + `datasetName` to
   `acceptsEdits`, generalise its refusal message, and build `params` via `editedParameters`. Keep
   the loop, `notSaved`, refuse-before-upload order, and clear-only-saved behaviour.
3. `docs/frontend/widgets.md`: note that Save targets a save-point step (matched by its `name`/`diff`
   args, for emerald `process_tem` and ymerflow `yf_process_tem`) or the process-level `diff` array
   (`apply_manual_edits`).

No change to data fetching or invalidation: it stays on the TanStack Query hooks and
`invalidateProject`.

## Tests (vitest, `frontend/src/datamodel/inUseDiffs.test.js`)

- `saveIntermediateStep` matches a step under the **ymerflow** key and under the **emerald**
  human-readable key when `name === datasetName` and a `diff` field is present; returns `null` for a
  non-matching `name`, a step with no `diff` field, a missing `steps`, and a non-array `steps`.
- `editedParameters` sets the matching step's `diff` to the URL and leaves every other step, that
  step's other args, and all other parameters unchanged; the input object is not mutated.
- A second `editedParameters` call on the same save point **replaces** that step's `diff` (Decision
  2).
- With no matching step but a type-level `diff`, `editedParameters` appends to the process-level
  array (today's `apply_manual_edits` behaviour) and does not mutate the input.
- `acceptsEdits` is true for a version whose steps carry a matching save point even when the type
  schema has no `diff` (`process_tem`); true for a type with a top-level `diff` (`apply_manual_edits`);
  false for a pipeline version with steps but no matching save point and no top-level `diff`; false
  for a type the environment does not list.
- Existing `appendDiff`, `resolveEditTarget`, `buildDiffColumns` tests keep passing unchanged.
- On the platform: open a `yf_process_tem` save-point output, edit, Save → the new version has the
  diff on that step, re-runs, and the output shows the edit's effect; open an `apply_manual_edits`
  output, edit, Save → the URL is appended to its process-level `diff` array, as today.

## Dependencies

- `ymerflow-processing` at the release that adds `save_intermediate_and_apply_diff` and its sink
  (YmerFlow/ymerflow-processing#42), and `aem-processes` at the merge that gives `yf_process_tem`
  the sink and removes its process-level `diff` replay. Built into the project's environment.
- For emerald `process_tem` save points to be openable, its wrapper must expose the step's dumped
  dataset as a platform output (the emerald step writes to `processing.outdir`, which the current
  `Processing.run()` does not surface). That is aem-processes work, not this plan; the frontend
  change is already correct for it because it matches the step by args, not by library.
- This frontend change ships with a platform deploy, independent of any environment: before a
  backend emits a save-point output, no dataset resolves to a save-point step, so the step branch is
  never taken and the array branch keeps `apply_manual_edits` (and today's `yf_process_tem`) working
  throughout.

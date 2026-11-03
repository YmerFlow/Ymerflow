# Edit a pipeline's save points: load the edit, Save writes it back onto the step

**Status:** planned. Not started. **Frontend only** (see "Why this is frontend-only").

**Ticket:** ymerflow-business#125.

## What this is

A pipeline carries named **save points** — `save_intermediate_and_apply_diff` steps that each
write the data as the steps above them left it, and replay one manual in-use edit against that
state. This plan makes the plot editor work against those save points, so that for **both**
pipeline libraries (emerald-processing-em's `process_tem` and ymerflow-processing's
`yf_process_tem`) manual editing works exactly this way:

1. **Only a save point can be edited.** A plot of a save-point output is editable; a plot of the
   pipeline's bare final output (`processed_data`) is not — Save refuses it, because it is the
   post-edit state with no step to write back onto. A pipeline keeps its final output editable by
   carrying a **terminal save point**.
2. **Opening a save-point plot loads that step's existing edit.** If the save point's step already
   carries a `diff` URL, the editor fetches it and loads it into the in-memory edit state for that
   plot, so the person sees and edits the edit that is already there — not a blank slate. Because
   the save point's output dataset is the *pre-edit* snapshot and the in-memory edit renders as the
   usual overlay on top of it, the plot shows the current edited state and the person modifies it in
   place (add, remove, undo).
3. **Save writes back only the save points that actually changed, in one re-run per process.** A
   save point is **changed** if its in-memory edit was touched since it loaded (or created fresh);
   a loaded-but-untouched save point is **unchanged**. On Save, each *changed* save point's full
   in-memory edit is serialised and uploaded; then, **per pipeline process**, a single new process
   version is submitted in which **each changed save point's step `diff` is replaced** by its
   freshly-uploaded URL (or set to `null` if the person emptied it). One pipeline with three changed
   save points → one new version with three step `diff`s set. **Unchanged save points are never
   re-uploaded** and their existing step `diff` carries over verbatim through the copied base
   parameters — no identical file is uploaded and no URL changes to the same content. Save points
   that were never opened likewise keep their existing `diff`. The re-run writes each snapshot,
   replays each edit, and continues.

The standalone `apply_manual_edits` process type (a process-level `diff` **array**, append per save)
is unaffected and keeps working exactly as today; it is not a pipeline and has no save-point steps.

## What exists (verified against the source)

- **The save loop** `saveAllDiffs`, `frontend/src/ProcessContext.jsx:349-418`. Per edited dataset
  path it: `resolveEditTarget` → `{ process, versionObj, datasetName }`; fetches the environment's
  process types and gates on `acceptsEdits(processTypes, type)` **before uploading**; builds and
  uploads the msgpack diff; then **one** `createProcess` with `params: { ...editedVer.parameters,
  diff: appendDiff(...) }`. It calls `createProcess` **once per edited dataset**.
- **The in-memory edit is keyed by the plot layer's literal dataset path** ("current.&lt;dataset&gt;"
  or "&lt;process&gt;.&lt;version&gt;.&lt;dataset&gt;"), the string in the layer's
  `parameters.dataset`. The lasso stores edits under that string (`applyInMemoryEdit`), and
  `ChannelPlot.createLayer` renders `rawData._inMemoryDiffs[path][channel]` as the overlay
  (`ChannelPlot.js:118-134`). So any seeded edit must use the **same path string the plot uses**, or
  the overlay will not find it.
- **Serialising / parsing a diff.** `buildDiffColumns` (`inUseDiffs.js:44-65`) turns the in-memory
  diff into `apply_idx` (sorted global sounding indices) + one `InUse_<channel>` gate→column map,
  `NaN` = no override. `XYZ.fromData(...).dump()` serialises it; `XYZ.fromURL(url)`
  (`libaarhusxyz.js:335`) loads one back — so the inverse (diff msgpack → in-memory structure) is a
  pure-frontend decode.
- **Helpers** in `frontend/src/datamodel/inUseDiffs.js`: `resolveEditTarget`, `buildDiffColumns`,
  `appendDiff`, `acceptsEdits`.
- **The process types** (registered by `aem-processes` under `ymerflow.process_types`):
  - `apply_manual_edits` — standalone; top-level `diff` **array**. *Unchanged.*
  - `process_tem` — emerald pipeline; `input_data` + `steps`, no top-level `diff`. Its steps can
    include `save_intermediate_and_apply_diff`.
  - `yf_process_tem` — ymerflow pipeline; after edit-points.md its top-level `diff` array is removed
    and edits live on `save_intermediate_and_apply_diff` steps.
  - `yf_qc_tem` — no edits.
- **A step's on-the-wire shape.** `parameters.steps` is swaggerspect `multi=True`: an **array** of
  single-key objects `{ "<step key>": { ...args } }`, the key being the entry-point name, which
  differs per library:
  - emerald: `{ "Save intermediate results and apply manual edits": { "name": ..., "diff": ... } }`
  - ymerflow: `{ "save_intermediate_and_apply_diff": { "name": ..., "diff": ... } }`

  (Verified in both `deps/` checkouts, which are what the runner image builds from.) So the frontend
  **must not** key on the step name; both carry the same args — a `name` (the save point's output
  dataset name) and an optional `diff` (one URL) — and that argument shape is what it matches on.

## Design

### Match a save-point step by its arguments, not its key

A save-point step, for an edited dataset, is the entry in `parameters.steps` whose args carry a
`name` equal to the edited dataset's name **and** a `diff` field (present, possibly null). `name`
is the save point's output dataset name (the runner writes the snapshot under it), so
`name === datasetName` is the discriminator and the `diff` field confirms it takes an edit. This
matches emerald's and ymerflow's steps alike without naming either key.

```
saveIntermediateStep(steps, datasetName)
  -> { step, key, args }   // the matching entry, its single key, its args object
   | null                  // missing/non-array steps, no matching name, or no diff field
```

### Loading an existing edit when a save point is opened

```
diffFromColumns(xyz)
  -> { [channel]: Map<gateKey, Map<soundingIndex, 0|1>> }
```

The inverse of `buildDiffColumns`: for each `InUse_<channel>` layer, for each gate column, for each
row whose value is not `NaN`, emit `soundingIndex = Number(xyz.flightlines.apply_idx[row])` →
`value`. Sounding indices are taken as `Number` (apply_idx decodes to BigInt), matching how the
lasso and `ChannelPlot` key edits.

A new idempotent ProcessContext helper does the load, keyed by the plot's **literal path**:

```
ensureSavePointEditLoaded(path)
```

- No-op if `path` was already loaded this open (tracked in a ref set) or an in-memory edit for
  `path` already exists — so a person's own edits are never clobbered and the fetch runs once.
- `resolveEditTarget(path, ...)` → `{ versionObj, datasetName }`; `saveIntermediateStep(
  versionObj.parameters?.steps, datasetName)`; if no match or `args.diff` is null → nothing to load.
- Otherwise `XYZ.fromURL(args.diff)` → `diffFromColumns` → dispatch a `LOAD` reducer action that
  sets `diffs[path]` (only if still empty) with an empty undo history, and marks the path **clean**
  (see below) — a loaded edit is not a change.

**Who calls it.** `PlotView`, on mounting/updating its layers, calls `ensureSavePointEditLoaded(
layer.parameters.dataset)` for each `inUseMode` `ChannelPlot` layer — the component that knows the
exact path string the overlay reads. No change to `ChannelPlot.createLayer` or any plot element: the
seeded edit renders through the existing `_inMemoryDiffs` overlay, identically to a live lasso edit.
The `LOAD` path is dropped from the loaded-set when its dataset is cleared (after a Save), so
reopening the re-run's save point reloads the now-current step `diff`.

### Changed vs unchanged: don't re-upload what the person never touched

So that a loaded-but-untouched save point costs no upload and no URL change, the reducer tracks a
per-path **dirty** flag beside `diffs`/`history`:

- `LOAD` seeds the path **clean** (dirty = false) — it carries exactly the step's current `diff`.
- `APPLY_EDIT` and `UNDO` mark the path **dirty** (true) — the only way an edit diverges from what
  loaded. (An edit-then-undo back to the loaded state stays dirty; a redundant re-upload of identical
  content is acceptable and far cheaper than a Map-equality check.)
- A path edited from scratch (no `LOAD`, so no prior step `diff`) is dirty from its first
  `APPLY_EDIT`, as it must be.
- `CLEAR` / `CLEAR_ALL` drop the flag with the diff.

Save uses the flag: only **dirty** paths are uploaded and written back; a clean path is skipped
entirely and its step `diff` survives through the copied base parameters unchanged.

### `acceptsEdits` becomes step-aware (the pre-upload gate)

```
acceptsEdits(processTypes, editedVer, datasetName)
  -> saveIntermediateStep(editedVer.parameters?.steps, datasetName) is non-null   // step shape
   || processTypes?.[editedVer.type]?.schema?.properties?.diff is present          // array shape
```

It needs no diff URL, so it stays the pre-upload gate. It gains `editedVer` + `datasetName` because
the step case depends on the version's parameters, not only on the type schema.

### `editedParameters` builds one process's new parameters from all its edits

```
editedParameters(editedVer, edits)   // edits: [{ datasetName, diffUrl }, ...]  (only CHANGED save points)
  -> the new `params` object for createProcess
```

`edits` carries **only the changed save points** (the save loop already filtered out clean ones), so
`editedParameters` never touches an unchanged step — its `diff` survives through the copied base
parameters. A `diffUrl` is a string for a save point that still has edits, or `null` for one the
person emptied (no upload happened for it; see the save loop). Starting from a **copy** of
`editedVer.parameters` (input never mutated), fold each edit in:

- **Save-point step** (emerald `process_tem`, ymerflow `yf_process_tem`): if `saveIntermediateStep`
  matches `datasetName`, set **that one step's `diff` to `diffUrl`** (a single string, or `null` to
  clear it), leaving every other step, that step's other args, and all other parameters untouched.
  Because the editor loaded the step's prior edit and the person edited it in place, the serialised
  edit is the whole state for that point, so Save **replaces** the step's single `diff` (Decision 2)
  — folding many edits sets many different steps.
- **Process-level array** (`apply_manual_edits`): otherwise append to the top-level `diff` via
  `appendDiff` — exactly today's behaviour. (A standalone process has one output, so at most one
  edit folds in here.)

### `saveAllDiffs` groups by process and submits one re-run per process

The loop is restructured from per-dataset to **per-process**, which is also a correctness fix: two
save points in one pipeline resolve to the *same* process version, so today's per-dataset loop would
submit two versions that clobber each other's edit. New shape:

1. Consider only **dirty** paths (`dirty[path]`); a clean loaded save point is skipped before it can
   trigger a re-run or an upload. If no path is dirty, return early — nothing changed, so no new
   version. (Replaces today's `some(m => m.size > 0)` filter.)
2. For each dirty dataset path: `resolveEditTarget`; refuse (`notSaved`, keep in editor) if it does
   not resolve. `acceptsEdits(processTypes, editedVer, datasetName)` gates **before upload**; a
   refused dataset is reported and dropped. If the path still has edits, build + upload the diff and
   carry `diffUrl`; if the person **emptied** it (dirty, zero edits), carry `diffUrl: null` and skip
   the upload. Carry `{ path, datasetName, diffUrl, editedVer, process }`. An upload failure reports
   and drops that one dataset.
3. Group the carried edits by their resolved **process version** (`process.id` + `versionObj.version`).
4. Per group: **one** `createProcess` with `params: editedParameters(editedVer, groupEdits)` — all of
   that process's *changed* save-point steps set in a single new version, unchanged steps carried
   verbatim (array-type processes have one edit, so this degenerates to today's single-append
   behaviour). On success, clear every path in the group; on failure, report every path in the group
   and keep them in the editor.

Preserved exactly: `notSaved` messaging, refuse-before-upload ordering, clear-only-saved behaviour,
and the final `invalidateProject`. Refusal message generalised, e.g. `${editedVer.type} has no edit
point for "${datasetName}", so a re-run would drop the edits`.

## Why this is frontend-only

Every change above is in `frontend/src/**` and `docs/**`. Loading an existing edit is a frontend
fetch (`XYZ.fromURL`) + decode; grouped Save is frontend control flow; the overlay already renders
in-memory edits. The step `save_intermediate_and_apply_diff`, its runner sink, and the removal of
`yf_process_tem`'s process-level `diff` are **dependencies** owned by `ymerflow-processing`
(YmerFlow/ymerflow-processing#42) and `aem-processes`; this plan assumes they ship as specified and
are built into the environment. No backend, migration, or Python change belongs to this plan.

Because the step is matched by its arg shape, **one frontend code path serves both libraries'
pipelines**, and nothing about the editing experience (lasso, action modes, undo, Save button)
changes beyond where the edit is loaded from and written to.

## Out of scope — explicitly not this plan

- **Any change to the lasso / action modes / undo / Save button / plot rendering.** No
  ChannelPlot/GateAnomalyPlot change; the seeded edit reuses the existing `_inMemoryDiffs` overlay.
- **Opening or editing more than one save point at once via any per-point UI.** Each save-point
  output opens like any other output; editing several and one Save is handled by the grouped loop,
  not by new UI.
- **Carrying cluster, resources and deadline across a Save** (the clone-endpoint change). Separate;
  flagged by edit-points.md as needed for large one-process pipelines but out of this plan.
- **Migrating existing saved processes'** process-level `diff` arrays into a terminal save point.
  A platform decision settled with the backend work, not here.
- **Library / aem-processes work.** The step, its sink, and the removal of `yf_process_tem`'s
  process-level `diff` are edit-points.md and the aem-processes plan.

## Decisions

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | How a save-point step is recognised | A: by **argument shape** — args with `name === datasetName` and a `diff` field. B: hardcoded step keys. C: consult the type schema for the step whose `diff` declares `x-url-media-type`. | **A** — library- and key-agnostic, so emerald's and ymerflow's steps both match with no list to maintain; `name === datasetName` is already the save-point contract. |
| 2 | A second Save on the same save point | A: **replace** the step's single `diff`. B: make it a list and append. | **A** — the editor loads the step's prior edit and the person edits it in place, so the serialised result is the whole edit for that point; the step holds exactly one `diff`, and a list would need a library change. |
| 3 | `acceptsEdits` when the type has no top-level `diff` but a version's steps carry a matching save point | A: step-match returns true (needs the version + dataset name). B: leave it type-only. | **A** — so the pre-upload gate matches what will actually save. |
| 4 | Loading a save point's existing edit when opened | A: **load it** — fetch the step's `diff`, decode, seed the in-memory edit for that plot's path, render via the existing overlay. B: leave the plot blank (edit-points.md's "editor follows" deferral). | **A** — this is requirement (2); the overlay mechanism already exists, so the load is a decode + a guarded seed with no plot change. |
| 5 | Where the load is triggered, and under which key | A: `PlotView` calls `ensureSavePointEditLoaded(layer.parameters.dataset)` per `inUseMode` layer (the component that knows the literal path the overlay reads). B: seed centrally in ProcessContext from the active process's outputs. | **A** — the in-memory edit is keyed by the plot's **literal** path string ("current.X" vs "pr.V.X"); only the layer knows which form it uses, so B can seed under a key the overlay never reads. |
| 6 | Scope of one Save across many save points | A: **group by process**, one new version per process with all its edited steps replaced. B: one new version per edited dataset (today's loop). | **A** — requirement (3), and a correctness fix: B submits colliding versions when a pipeline has two edited save points in one version. |
| 7 | Recognising a loaded-but-untouched save point so it is not re-uploaded | A: a per-path **dirty** flag — `LOAD` clean, `APPLY_EDIT`/`UNDO` dirty; Save skips clean paths. B: on Save, re-decode the step's `diff` and compare Maps for equality. C: re-upload everything (current rewrite). | **A** — a one-bit flag set where edits happen; no fetch, no deep compare. B needs a second `XYZ.fromURL` + structural Map comparison per save point for the same answer; C uploads identical files and churns URLs, which is what this change removes. The cost of A is re-uploading after an edit-then-undo-to-origin, which is rare and harmless. |

## Work (frontend only)

1. `frontend/src/datamodel/inUseDiffs.js`:
   - add `saveIntermediateStep(steps, datasetName)` (pure, matches by arg shape; returns the entry,
     its key and its args);
   - add `diffFromColumns(xyz)` (inverse of `buildDiffColumns`: diff msgpack → `{ [channel]:
     Map<gateKey, Map<soundingIndex, 0|1>> }`);
   - generalise `acceptsEdits(processTypes, editedVer, datasetName)` to step-match **or** top-level
     `diff`;
   - add `editedParameters(editedVer, edits)` folding a list of `{ datasetName, diffUrl }` (step-set,
     else array-append), input not mutated;
   - keep `appendDiff`, `resolveEditTarget`, `buildDiffColumns` unchanged.
2. `frontend/src/ProcessContext.jsx`:
   - carry a per-path **dirty** map in the reducer state beside `diffs`/`history`: `LOAD` sets it
     false, `APPLY_EDIT`/`UNDO` set it true, `CLEAR`/`CLEAR_ALL` drop it;
   - add a `LOAD` case to `inUseDiffReducer` (seed `diffs[path]` only if empty; empty history; clean)
     and an `ensureSavePointEditLoaded(path)` helper (idempotent via a loaded-path ref set; resolve
     target, match step, `XYZ.fromURL` + `diffFromColumns`, dispatch `LOAD`); expose it on the
     context; drop a path from the loaded set when it is cleared;
   - restructure `saveAllDiffs` to act on **dirty** paths only (early-return if none), upload per
     dirty dataset that still has edits (gate + refuse before upload as today; `diffUrl: null` for an
     emptied one, no upload), **group by process version**, and submit **one** `createProcess` per
     group via `editedParameters`. Keep `notSaved`, refuse-before-upload order, clear-only-saved, and
     `invalidateProject`.
3. `frontend/src/widgets/PlotView/index.jsx`: on layer mount/update, call
   `ensureSavePointEditLoaded(layer.parameters.dataset)` for each `inUseMode` `ChannelPlot` layer.
4. `docs/frontend/widgets.md`: document that a save point's edit loads into the editor on open and
   Save writes it back onto the step (matched by its `name`/`diff` args, for emerald `process_tem`
   and ymerflow `yf_process_tem`), one re-run per process; `apply_manual_edits` keeps its
   process-level `diff` array.

No change to data fetching or invalidation: it stays on the TanStack Query hooks and
`invalidateProject`.

## Tests (vitest, `frontend/src/datamodel/inUseDiffs.test.js`)

- `saveIntermediateStep` matches a step under the **ymerflow** key and under the **emerald**
  human-readable key when `name === datasetName` and a `diff` field is present; returns `null` for a
  non-matching `name`, a step with no `diff` field, a missing `steps`, and a non-array `steps`.
- `diffFromColumns` round-trips `buildDiffColumns`: building columns from a diff and decoding them
  back yields the same `{ channel: Map<gate, Map<sounding, 0|1>> }`, with sounding indices as
  `Number` and `NaN` columns dropped.
- `editedParameters` sets each matching save-point step's `diff` and leaves every other step, those
  steps' other args, and all other parameters unchanged; the input object is not mutated. Two edits
  in one call set two different steps. A second call on the same save point **replaces** its `diff`
  (Decision 2).
- With no matching step but a type-level `diff`, `editedParameters` appends to the process-level
  array (`apply_manual_edits`) and does not mutate the input.
- `acceptsEdits` is true for a version whose steps carry a matching save point even when the type
  schema has no `diff` (`process_tem`); true for a type with a top-level `diff` (`apply_manual_edits`);
  false for a pipeline version with steps but no matching save point and no top-level `diff`; false
  for a type the environment does not list.
- Existing `appendDiff`, `resolveEditTarget`, `buildDiffColumns` tests keep passing unchanged.
- `inUseDiffReducer` dirty tracking (reducer unit test, `ProcessContext` test file): `LOAD` leaves a
  path clean; `APPLY_EDIT` and `UNDO` mark it dirty; `CLEAR`/`CLEAR_ALL` drop the flag; a path edited
  from scratch is dirty from its first `APPLY_EDIT`.
- On the platform: open a `yf_process_tem` save-point output that already has an edit → the edit
  loads into the editor and renders; modify it and open a second save point in the same pipeline, edit
  it, Save → **one** new version has both steps' `diff`s replaced, re-runs, and both outputs show the
  edits' effect.
- Unchanged-not-reuploaded: open two save points in one pipeline, edit **only one**, Save → one new
  version where the edited step's `diff` is a new URL and the untouched step's `diff` is **byte-for-byte
  the previous URL** (no new upload); opening several save points and editing none makes Save a no-op
  (no new version).
- Emptied save point: open a save point with an existing edit, Clear all its gates, Save → the step's
  `diff` is set to `null` with no file uploaded.
- `apply_manual_edits` output, edit, Save → the URL is appended to its process-level `diff` array, as
  today; the pipeline's bare `processed_data` output → Save refuses it.

## Dependencies

- `ymerflow-processing` at the release that adds `save_intermediate_and_apply_diff` and its sink
  (YmerFlow/ymerflow-processing#42), and `aem-processes` at the merge that gives both pipelines the
  sink and removes `yf_process_tem`'s process-level `diff` replay. Built into the project's
  environment. Both `deps/` checkouts already carry the combined step with the `{name, diff}` shape
  this plan matches.
- This frontend change ships with a platform deploy, independent of any environment: before a backend
  emits a save-point output, no dataset resolves to a save-point step, so `ensureSavePointEditLoaded`
  finds nothing to load and the Save step branch is never taken — the array branch keeps
  `apply_manual_edits` (and today's `yf_process_tem`) working throughout.

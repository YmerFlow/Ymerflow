# Manual edit points inside one processing process

**Status:** planned. Decisions 1-9 below are open. Not started.

**Ticket:** ymerflow-business#125.

## Motivation

A real processing chain needs a person's in-use edits at more than one stage: at full rate after the automatic culls but before averaging, and again on the averaged data. Today `yf_process_tem` replays saved edits only after its last step, and the InUse Editor can only edit a process's output. So a chain with two edit points runs as several processes, one per point, and every Save means rerunning the processes downstream by hand.

ymerflow-processing is adding a `manual_edit_point` step for this (its plan: `docs/plans/edit-points.md` in that repository, YmerFlow/ymerflow-processing#42). That plan is the contract this one builds on. This plan is the platform half: `yf_process_tem` writes the state at each point as an output dataset, the editor opens it, and Save puts the new diff in that point's list, so the rerun applies it before the steps that follow.

## What exists

- **The library step (decided, not built).** `manual_edit_point: {name, diff: [url, ...]}` hands the runner the state *before* its own diffs through a sink, a callable `(name, dataset) -> None`, then replays its diffs in order. The library never writes the snapshot. The sink writes each snapshot as soon as the step calls it, so nothing is held until the end. No sink means the snapshot is skipped and the run report says so. Point names are unique and may not be `output` or `processed_data`. The end-of-pipeline `diff` list, which the library treats as an implicit last point named `output`, stays for now, deprecated: using it adds a warning to the run report, because edits replayed after the clean-up steps can leave a sounding with fewer gates than `cull_sparse_soundings` requires.
- **aem-processes PR #6.** A step parameter that reads data can be a storage URL, fetched before the run (`fetch_step_inputs` in `aem_processes/yf_processing_process.py`). It handles a single string, not a list.
- **The end list.** `_replay_edits` replays `diff` after every step with `EDIT_CHECKPOINT = "output of the steps above"`.
- **The editor and Save** (`docs/plans/done/inuse-flag-editor.md`, `docs/plans/done/accumulate-manual-edit-diffs.md`). `saveAllDiffs` in `frontend/src/ProcessContext.jsx` uploads one diff per edited dataset and creates a new version of the process that made it, with `diff: appendDiff(...)`. `resolveEditTarget` finds that version and the output's name; `acceptsEdits` refuses a process type whose form has no `diff`.
- **What ChannelPlot draws.** In `inUseMode` it draws four states from the dataset's own `InUse_<channel>` and the editor's *unsaved* edits. Saved edits are not drawn as edits anywhere today. On a final output they are already applied, so they look the same as automatic culls. (The library plan says the editor overlays saved diffs "as it does today"; it does not, and this plan adds it.)
- **The clone endpoint.** `POST /projects/{project_id}/process/{process_id}/versions/{version}/clone` copies a version's type, environment, parameters, resources, deadline and cluster, with optional overrides.

## Design

### 1. aem-processes: `yf_process_tem` writes each point as a dataset

- **The sink.** `yf_process_tem` is the runner the library plan describes. When the pipeline contains a `manual_edit_point`, `run()` passes `ProcessingRunner` a sink, the callable `(name, dataset) -> None`. Each call writes an output dataset named `name`, next to `processed_data`, with `write_dataset`, at once, and adds `{name: url}` to the version's outputs. A pipeline without a point runs exactly as now, so a new aem-processes still works with an older library for those pipelines.
- **The sink leaves the running dataset as it found it.** Before writing the final output, `run()` renames columns in place (`normalize_naming`). Doing that partway through would change column names under the steps that follow, so the sink writes a renamed copy, or restores the names after writing. A copy of the full-rate state doubles that state's memory while it is written.
- **The point's saved edits travel with the snapshot** (if Decision 2 is A). The sink is built in `run()`, which has the pipeline document, so when it is called with `name` it finds the `manual_edit_point` of that name and its diffs, which `fetch_step_inputs` has already fetched. It merges them in order into one layer per channel (1 enable, 0 disable, NaN none) and writes that layer into the output dataset, so it is split per line like every other layer. The library's sink contract stays `(name, dataset) -> None`.
- **Diff lists are fetched.** `manual_edit_point`'s `diff` is a list of URLs. `fetch_step_inputs` learns to fetch every URL in a list, and `data_parameters` to recognize a list-of-data parameter. The pipeline keeps the URLs, so the run report and the dataset's processing history name the stored diffs, as they do for a single URL today. The library's type annotation for `diff` has to be one `data_parameters` can read, for example `list[str | XYZ]`; this is agreed with the library change.
- **The end list warns.** `_replay_edits` adds the library's deprecation note to its step report, since on the platform the end list is replayed here and not by the library's runner. The `diff` property's form description says the same and points to `manual_edit_point`.

**Size.** A full-rate survey of about a million soundings is a couple of GB as XYZ text before averaging. With the msgpack, GeoJSON and per-line parts that `write_dataset` also writes, one full-rate snapshot is a few GB per version, and every Save writes it again. At blob-storage prices that is small, but it adds write time to every rerun.

### 2. Frontend: open a point, save into it

- **Opening.** A point's snapshot is an ordinary output named after the point, so a ChannelPlot or GateAnomalyPlot layer points at `current.<name>` or `<process>.<version>.<name>` like any other dataset. No layout change.
- **Where Save goes.** `resolveEditTarget` already returns the edited version and the dataset's name. A new helper, `editPointFor(parameters, datasetName)` in `frontend/src/datamodel/inUseDiffs.js`, finds the `manual_edit_point` step with that name. If there is one, the new version's parameters are the edited version's with the diff's URL appended to that step's `diff`. If the dataset is the process's final output, Save uses the end list as today, with the warning in section 4. Otherwise Save refuses and says the dataset has no edit point.
- **One new version per edited version.** Save today creates one version per edited dataset, each built from the edited version's parameters. With two points of one version edited, that makes two versions, and the second does not carry the first one's diff. Save instead groups pending edits by process version and creates one new version with every edited point's list appended (Decision 4).
- **Saved edits are drawn.** In `inUseMode`, ChannelPlot reads the point's saved edits (Decision 2) and draws them as manual states. Precedence: unsaved edit, then saved edit, then the dataset's own in-use flag. Saved edits are drawn lighter than unsaved ones, so what the next Save will write stands out, and the editor's counter counts unsaved edits only. GateAnomalyPlot, the gate-anomaly section layer, reads the same edits.
- **Clear on a saved edit** follows Decision 3.
- **`acceptsEdits`.** A snapshot accepts edits when the edited version's steps contain a point of that name. The process-type check stays for the end list.

Data fetching goes through TanStack Query hooks and invalidation through `invalidateProject`, as everywhere else.

### 3. Save keeps the version's cluster, resources and deadline

Save calls `createProcess` without resources, deadline or cluster, so the server falls back to 1 CPU, 2 Gi of memory, a one-hour deadline and the first cluster the project may use. A full-rate pipeline on a survey of that size peaks above 10 GB resident before any snapshot is written. A Save on it would fail for memory. The first allowed cluster is the first by sort order, which need not be where the edited version ran, and can be a paid one.

Save instead calls the clone endpoint with `parameter_overrides`, through a new `useCloneProcessVersion` hook (Decision 5). The server copies everything else from the edited version. If that version's cluster is no longer allowed, the create fails with a 400; the editor keeps the edits and shows the reason, and nothing falls back to another cluster. The success message names the cluster, CPU, memory and deadline of the rerun.

This part does not depend on edit points, and it fixes Saves on today's chains of processes too (Decision 6).

### 4. The end-of-pipeline list: deprecate, then remove

**Phase 1, with this plan.** Save on a `yf_process_tem`'s final output still works. While edits are pending on a final output, the editor shows: "Edits on a final output are applied after every step, including the clean-up steps, so they can leave a sounding with fewer gates than the minimum. Add a manual_edit_point before the clean-up steps and edit there." The run report carries the same note.

**Phase 2, a later change, at the point Decision 7 sets.** The editor refuses Save on a `yf_process_tem`'s final output, with that message. What happens to versions that already use the end list is Decision 7. The platform does not insert a point automatically, because it cannot tell where a pipeline's clean-up steps begin.

The `apply_manual_edits` process type keeps its `diff`: its output is the edited dataset and nothing runs after it.

**Moving a chain's diffs into one process.** A diff addresses soundings by their position in the dataset at its point. Diffs saved on a chain of processes can be moved into one process's points by copying their URLs only when the one process runs on the same input as the chain. A chain run on a subset of lines needs its diffs re-indexed first.

### 5. Environment

A project's environment needs ymerflow-processing at the release that adds `manual_edit_point` and the runner's sink, and aem-processes at the merge of section 1. The rest can stay as the project's current environment has it. aem-processes PR #6 is in any environment that pins `06894c8` or later. Which library release to build on is Decision 8.

The frontend and Save changes reach users with a platform deploy, not with an environment.

## Decisions (open)

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | What the editor shows at a point | A: the state before the point's edits, with its saved edits drawn over it (the library's decision 2). B: the state after them, as the final output is today; no overlay, and Decisions 2 and 3 fall away. | A. Reviewing a model's or a colleague's culls needs manual and automatic culls shown apart, and B draws them the same. |
| 2 | How the editor gets a point's saved edits | A: the snapshot carries them as one layer per channel, split per line; the platform's sink merges the point's diffs from the pipeline it is running, and the library's sink contract is unchanged. B: the browser fetches the point's diff files and merges them. | A. The plot already loads one line at a time. With B every view loads the whole survey's diffs, and a model-cull diff covering a few dozen lines is already tens of MB. |
| 3 | What Clear does to a saved edit | A: Clear removes unsaved edits only; a saved edit is reversed by drawing the opposite, which pins the gate. B: Save consolidates the point's list into one diff and replaces it; true undo, but the separate diff files (a person's culls, a model's culls) merge into one. C: a "revert" value in the diff format; true undo, append-only, but libaarhusxyz and ymerflow-processing change, and older readers would misread it. | A now, as the editor works on a final output today. C later if pinned gates cause trouble. |
| 4 | Edits on two points of one version, one Save | A: one new version with both lists appended; the downstream point's edits were drawn before the upstream ones were applied, and the success message says so. B: refuse, one point per Save. | A. |
| 5 | How Save keeps cluster, resources and deadline | A: Save calls the clone endpoint, and the server copies them. B: Save passes the edited version's values to `createProcess`. | A. One place decides what a rerun inherits, the same one MCP clients use. |
| 6 | Ship section 3 first, as its own change | Yes / no. | Yes. Saves on today's chains already fall back to 2 Gi and the first cluster. |
| 7 | Versions that use the end list, at removal | A: keep replaying it; the form keeps the property as read-only, the editor stops writing it, and old versions rerun unchanged. B: the next Save moves it into a trailing point. C: drop it; old versions fail on rerun. And when: after the first full edit pass done on a one-process pipeline, or a date. | A, after the first full edit pass. |
| 8 | Which ymerflow-processing release environments build on | A: a patch release on the tag the project already uses, adding only edit points, so its culls stay identical. B: current main. | A, settled with the library change. |
| 9 | Formats written for a snapshot | A: everything `write_dataset` writes, so a snapshot plots, exports and lists like any dataset. B: msgpack and per-line parts only. | A. Revisit if storage or write time hurts. |

## Found while checking

- The clone endpoint's documentation says it falls back to the first allowed cluster when the source version's cluster is no longer allowed. `Process.create_queued` raises a 400 instead. The code is the safer behavior; the documentation should say so.
- Diffs address soundings by position. If a step between two points dropped soundings depending on the data, an upstream edit would shift the downstream point's soundings, and `apply_manual_edits` only catches indices out of range. A chain that averages between its two points is safe: `average_along_line` decimates by position only, and `cull_sparse_soundings` disables soundings instead of dropping them. This belongs to the library.

## Order of merging

1. Section 3 (Save keeps cluster, resources and deadline), on its own.
2. ymerflow-processing: `manual_edit_point` and the runner's sink (YmerFlow/ymerflow-processing#42). A release.
3. aem-processes: the sink (and, with Decision 2 A, the saved-edit layer), list fetching, the deprecation note.
4. A project environment on those versions.
5. Frontend: save into a point, the saved-edit overlay, grouping by version, the deprecation warning.

The frontend can follow aem-processes safely: a point's dataset only exists once an environment writes it.

## Work

### aem-processes

1. The sink in `_PipelineProcess.run()`, passed only when the pipeline has a `manual_edit_point`; one output per point; the live dataset left unchanged.
2. `data_parameters` and `fetch_step_inputs`: lists of URLs.
3. With Decision 2 A, the saved-edit layer written into each snapshot.
4. `_replay_edits`: the deprecation note; the `diff` description.

### Frontend

1. `frontend/src/datamodel/inUseDiffs.js`: `editPointFor`, appending to a point's list without modifying the input, grouping pending edits by process version.
2. `saveAllDiffs`: one clone per edited version with the edited points' lists (and the end list) appended; refusals as above.
3. `useCloneProcessVersion` in `frontend/src/datamodel/useQueries.js` and the clone API call.
4. ChannelPlot `inUseMode`: the saved-edit overlay and its precedence; the counter counts unsaved edits.
5. InUse Editor: the deprecation warning for pending edits on a final output.
6. `docs/frontend/widgets.md`: editing at a point.

### Docs

- `docs/architecture/pipelines.md`: edit points and the sink.

## Tests

- aem-processes: a pipeline with two points writes two extra outputs named after them; a snapshot holds the state before its point's diffs; the dataset after the sink equals the dataset before it; a list of diff URLs is fetched, and the report records the URLs, not local paths; a pipeline without a point runs as before; the end list adds the deprecation note.
- Frontend (vitest): `editPointFor` finds a point by name and returns nothing for a final output or an unknown name; appending leaves the input unchanged; edits on two points of one version give one new version with both lists appended.
- On the platform: edit a point's snapshot and Save. The new version has the diff in that point's list, runs on the same cluster with the same resources and deadline, and its next point's snapshot shows the edit's effect.

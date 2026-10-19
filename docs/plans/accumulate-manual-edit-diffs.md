# Manual edits in rounds: accumulate `diff`

## Problem

Saving in-use edits from a plot (`saveAllDiffs` in `frontend/src/ProcessContext.jsx`) uploads the round's edits as a libaarhusxyz msgpack diff and creates a new version of the process that made the dataset, with `{...latestVer.parameters, diff: diffUrl}`. A second save therefore **replaces** the first diff. The new version re-runs from the process's original input with only the latest round applied, and every earlier round is lost. Manual processing is done in rounds, so this loses work.

## Decision (2026-10-18)

The frontend accumulates. `diff` becomes a list of diff URLs, and each save appends its URL to the list from the version it builds on. Each uploaded diff still holds only that round's changes, which were made on the previous version's output. Replaying the list in order therefore reproduces every round, and a later round's decision overrides an earlier one on the same gate.

## Contract for `diff`

- A list of URLs, applied in order, after the process's own steps.
- A single string is still accepted and means a list of one: it is what every version saved before this change holds, and what a person may type in a form.
- Empty or absent means no edits.

## Changes

### Frontend (this change)

- `frontend/src/datamodel/inUseDiffs.js`: `appendDiff(previous, url)` returns the earlier diffs as a list (from a list, a single string, or nothing) with `url` added.
- `saveAllDiffs` sets `diff: appendDiff(latestVer.parameters.diff, diffUrl)` instead of `diff: diffUrl`.
- `frontend/src/datamodel/inUseDiffs.test.js`: vitest cases for no previous diff, a string, a list, and that the input list is not modified.

### Process types that read `diff` (aem-processes, separate changes)

- `yf_process_tem` (`aem_processes/yf_processing_process.py`): accept a string or a list and replay in order. Being done in aem-processes.
- `compound_filter` (`aem_processes/compound_filter.py`): reads `diff` as one URL and applies one diff. It needs the same string-or-list handling, and its schema should declare an array of URLs.

`localize_urls` already handles lists. The backend does not validate process parameters against the schema, so a list is not rejected at submission.

## Order of merging

**The process types first, then this frontend change.** With the frontend first, `compound_filter` would receive a list it cannot open. Its error path prints "could not apply diff; continuing without it" and carries on, so the edits would be dropped silently.

## Found while checking (not changed here)

- `compound_filter` swallows a failed diff and continues without it. This contradicts the rule that errors must surface, and it is how saved edits could vanish unnoticed. It should raise.
- `process_tem` (`aem_processes/processing_process.py`) does not read `diff` at all. Edits saved on a `process_tem` output create a new version that re-runs without them.

## Test plan

- `npm test` (vitest) runs the `appendDiff` cases.
- After the process types accept lists: edit a plot, save; edit the new output, save again. Check that the third version's `diff` lists two URLs and that its output carries both rounds' edits.

## Affected files

- `frontend/src/ProcessContext.jsx`
- `frontend/src/datamodel/inUseDiffs.js` (new)
- `frontend/src/datamodel/inUseDiffs.test.js` (new)

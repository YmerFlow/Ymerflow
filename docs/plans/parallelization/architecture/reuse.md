# Fragment reuse & change detection

Part of the survey-parallelization architecture. This document specifies **how a
re-run of a fragmentable process decides which fragments to recompute and which
to reuse from the previous version**. It is referenced by the parallelization
plan; it is not itself a plan.

Related architecture docs (siblings): the version-fragment execution model, rootless
datasets and reader-side root reconstruction, and the grid-split and join
process types. This document assumes those concepts but only defines reuse.

## Context

A dataset is already fragmented on disk: `info.json` carries `parts`, an open map
keyed by part name (for AEM, one part per flightline), each part pointing at its
own files. See `docs/architecture/storage.md` and
`deps/aem-processes/aem_processes/dataset_utils.py`.

A **fragmentable process** runs per part rather than per whole dataset. Its
version fans out into one **version fragment** (the unit of identity and reuse;
see the version-fragment execution model) per part; fragments reuse unchanged
results across re-runs. A part, and — for AEM — a flightline, are the same thing;
a version fragment is what produces one part.

Reuse operates purely at the fragment level and is **orthogonal to execution
batching**: whether the runnable fragments are spread over many pods or packed
into a few sequential-looping pods (the `parallelism` knob; see the execution
model) changes nothing here. Reuse decides *which* fragments run; batching only
decides *how many pods* they run on. This document is only about the former.

The goal of reuse: when the user changes one thing (e.g. edits two flightlines),
only the affected fragments recompute; the rest are **linked, not copied** — the
new version references the previous version's output bytes in place.

## The fragment universe

A fragmentable process loops over the **union of part names across all of its
dataset-valued parameters**. Each such parameter is a dataset aligned to the
others **by part name** (a slug such as a flightline id — name matching, not
content or position). A parameter may be a subset of the full part set; a part
absent from a parameter is treated as **empty** for that parameter.

Consequently a version fragment may receive an empty part for some of its inputs
(e.g. a flightline with no manual edit gets the edit parameter empty for that
part). "A part may be empty for any given input" is part of the contract a
fragmentable process's `run()` must handle; what empty means is the process
author's decision.

## URL identity is content identity

Storage is write-once by convention: every produced file gets a fresh,
unique URL and is never overwritten (UUID dataset dirs under versioned paths; see
`docs/architecture/storage.md`). Therefore, for any two parts,

> **same URL ⟺ same bytes.**

Every multi-part producer in the system — a fragmentable process *and* the
manual-edit tooling — **links unchanged parts by reusing their prior URL** and
mints new URLs only for the parts whose content actually changed. A linked part
keeps the **original producer's URL** (where the bytes were first written); it is
not rewritten under the new dataset's prefix, and it is never a "see previous
version" indirection. The new `info.json` simply lists the prior URL.

Because of this, URL stability propagates through the whole DAG: editing two
flightlines changes exactly two URLs in the edit dataset, which flips exactly two
fragments in the downstream process, whose output changes exactly two URLs, and
so on. No content hashing is required anywhere — URL equality is the signal.

## The reuse rule

Each version fragment records the **set of input part URLs it consumed** (across
all dataset parameters), plus the process's non-fragment parameters. Together
these form its memoization key. Comparison is always against **N−1**, the
immediately previous version of the same process.

For fragment `F` at version N:

> `rerun(F)` ⟺ **any non-fragment parameter changed** (relative to N−1)
> **OR** the set of input part-`F` URLs differs from the set N−1's version
> fragment `F` recorded consuming (where an absent/empty part ≠ any URL, so
> present-vs-absent counts as a difference).

- Any change to a non-fragment parameter (scalars, config, a whole-dataset
  parameter with no parts) re-runs **every** fragment. This is deliberately
  coarse: there are no per-fragment parameter overrides.
- Otherwise `F` re-runs iff some dataset parameter's part named `F` changed URL.
- If `F` does not re-run, its output is **linked** to N−1's version fragment `F`
  output: the new version references those output URLs and writes nothing.

### Preconditions and edge cases

- **First version** (no N−1): every fragment runs.
- **Linkability:** a fragment can be linked only if N−1's corresponding
  version fragment is `DONE`. A failed or missing N−1 fragment forces a re-run.
- **New / removed parts:** a part name present at N but not N−1 has no prior URL
  to match → runs. A part removed at N is simply absent.
- **Reuse is always safe to skip:** if identical content ever ends up under
  different URLs (something recomputed without linking), the fragment merely
  re-runs unnecessarily. That is missed reuse, never a wrong result — linking is
  an optimization, recomputation is always correct.

## Consequences

1. **No on-disk format change.** The existing `parts` structure already carries
   everything: arbitrary part keys and per-part file URLs. Reuse needs no
   per-part hash and no new fields in the dataset.

2. **Change detection is metadata-only.** The backend compares the `parts` URL
   maps of the current inputs against those N−1 consumed. It never reads part
   bytes, keeping it a lightweight coordinator.

3. **Each version fragment persists its consumed input part-URL set** as its
   memoization key, so N can compare against N−1.

4. **No retention problem.** Linking means later versions reference earlier
   versions' byte locations by URL — but this system has **no per-version,
   per-dataset or per-process deletion**; the only delete is of a whole project,
   which removes all of its storage together. Links only ever exist within a
   single project, so a linked reference can never dangle, and no link-aware
   garbage collection is needed.

## Worked example

A processing step over a 200-flightline survey, with a manual-edit parameter:

- **v1:** no edits. The edit parameter is empty (no parts). All 200 fragments
  run. Each version fragment records the survey part URLs it consumed.
- **v2:** the user edits flightlines `L050` and `L137`. The edit tooling produces
  a new edit dataset that links the 198 unchanged edit-parts to their v1 URLs and
  writes new URLs only for `L050` and `L137` (in fact, in v1 those parts were
  empty, so present-vs-absent already differs).
- Change detection: non-fragment parameters unchanged; the survey parameter's
  part URLs unchanged; the edit parameter's part URLs differ only for `L050` and
  `L137`. So exactly those two fragments re-run; the other 198 are linked to v1
  outputs, byte-for-byte, with no copy and no compute.

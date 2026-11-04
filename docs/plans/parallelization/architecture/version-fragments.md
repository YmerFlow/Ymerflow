# Version fragments (execution model)

Part of the survey-parallelization architecture. This document specifies **how a
fragmentable process executes**: the `VersionFragment` unit, how a version fans
out over parts, how fragments run and are reused, and how their outputs assemble
back into a single on-disk dataset. It is referenced by the parallelization
plan; it is not itself a plan.

Reuse / change detection (which fragments run vs link) is specified separately in
[`reuse.md`](./reuse.md). This document covers the representation and lifecycle;
reuse supplies the per-fragment decision.

## The model

Today: `Process → ProcessVersion`, with exactly one Kubernetes Job per
`ProcessVersion`; `state`, the k8s/monitor/log fields, and output discovery all
hang off the version (see `backend/models/process.py`,
`backend/services/job_orchestrator.py`).

New: a third level, the **version fragment**.

```
Process
 └─ ProcessVersion            params, type, environment; state DERIVED
     ├─ VersionFragment        part_path "root"            (one Job)
     ├─ VersionFragment        part_path "parts/L050"      (one Job)
     └─ VersionFragment        part_path "parts/L137"      (linked — no Job)
```

A `VersionFragment` is the unit of execution. The per-run execution fields move
**down** from `ProcessVersion` to `VersionFragment`: `state`, `k8s_job_name`,
`started_at`/`completed_at`, resource requests, deadline, and log-tracking.
`ProcessVersion` keeps the parameters, type, and environment, and its state is
**derived** from its fragments (see below).

**Full unification, no fast path.** Every version has one or more fragments. A
non-fragmented process is simply a version with a single fragment whose
`part_path` is the root. Today's single-Job behaviour *is* that degenerate case —
there is no separate non-fragmented code path.

## Identity

A version fragment is identified by `(process_id, version, part_path)`.

`part_path` is the path of the part within the dataset layout — `root` for the
whole dataset, `parts/<flightline>` for a line part. **The root is not special**:
it is just another `part_path`, which is why the degenerate (non-fragmented) case
needs no sentinel and no special handling — it is the fragment at `part_path =
root`.

## Fan-out and input narrowing

When a version fans out, the coordinator builds each fragment's effective
parameters by **substituting every dataset-valued parameter with that part's
file URL(s)** — or empty if the input has no part by that name (see the union /
missing-is-empty rules in [`reuse.md`](./reuse.md)). The pod therefore receives
parameters already narrowed to its one part, and reads them through the existing
"params carry dataset URLs → pod opens them with fsspec" machinery
(`ymerflow_runner`), unchanged, just at part granularity.

Because the whole dataset is the `root` part, the same substitution produces the
correct parameters for the degenerate single-fragment case with no extra logic.

## Execution and concurrency

Each fragment that needs to run is one Kubernetes Job, created exactly as today
via `job_orchestrator` — the Job/manifest/monitor/log code is reused unchanged,
now keyed per fragment instead of per version. The coordinator creates all
non-linked fragments' Jobs at once; **Kueue** admits as many as cluster quota
allows and suspends the rest. This is precisely today's across-version
parallelism, now operating across the fragments of a single version.

A fragment that is **linked** (reused from N−1 per [`reuse.md`](./reuse.md)) runs
no Job at all; the coordinator records it directly as `DONE`.

## Output layout and assembly

**On-disk layout is unchanged from today.** A version's output dataset still
lives at `processes/{process_id}/{version}/datasets/{dataset_id}/` with
`root.*` files and `parts/<flightline>.*` files and a single `info.json`
(`docs/architecture/storage.md`, `dataset_utils.py`). A **rootless** dataset
looks identical to a today's dataset **minus the root files** — nothing else
differs.

Each fragment writes only its own slice of this layout — the root fragment writes
`root.*`, a line fragment writes its `parts/<flightline>.*` — plus a **partial
`info.json`** contributing only its slice of the final document:

- root fragment → `{ "files": { … } }`
- line fragment `L050` → `{ "parts": { "L050": { "files": { … } } } }`

The canonical `info.json` is produced by a **dumb recursive merge** of all the
partials. The merger knows nothing about datasets, parts, or fragments — it is a
generic deep JSON merge: dicts union key-by-key recursively; leaf values must
agree across partials, and a conflict (two partials asserting different values
for the same leaf) is a **hard error**, not silently resolved — nothing in the
design should ever produce one, so a conflict signals a bug. Merging the partials
above yields
exactly today's `{ id, mime_type, dataset_name, files, parts }`. A rootless
dataset is just the case where no root fragment contributed, so the top-level
`files` key is absent.

Resolved details (flag in review if any is wrong):

- **Shared dataset identity.** All fragments of one output dataset share a single
  `dataset_id`; the coordinator assigns it and supplies the identity scalars
  (`id`, `dataset_name`, `mime_type`) as the merge base, so they exist even when
  there is no root fragment — no on-disk skeleton file is needed.
- **Partial location.** Each fragment writes its partial **beside its own data**:
  a line fragment writes `parts/<flightline>.info.json` next to its
  `parts/<flightline>.*` files, and the root fragment (when there is one) writes
  `root.info.json` at the top level. The merger reads these partials and writes
  the merged result to `info.json`. The dataset-identity scalars (`id`,
  `mime_type`, `dataset_name`) are supplied by the coordinator as the merge base,
  so the generic merger stays dataset-agnostic and no skeleton file is needed on
  disk (a rootless dataset simply has no `root.info.json`).
- **Linked fragments.** A linked fragment runs no pod, so the coordinator
  synthesises its partial by copying N−1's entry for that part — whose URLs point
  into N−1's storage (link, not copy; see [`reuse.md`](./reuse.md)).
- **Who merges, when.** The backend performs the recursive merge after all
  fragments reach `DONE`. It is metadata-only (JSON, no part bytes), so it stays
  within the lightweight-coordinator rule. This replaces/extends today's
  `ProcessVersion._create_outputs` storage scan.

## State derivation and failure

`ProcessVersion` has no Job of its own; its state is derived from its fragments:

- any fragment queued/starting/running → the version is in progress;
- all fragments `DONE` (including linked) → version `DONE`, after the info.json
  merge;
- any fragment `FAILED` → version `FAILED`.

**Failure recovery is a new version, not an in-place retry.** A failed fragment
is not `DONE`, so it is not linkable; re-running the process creates version N+1
in which the previously-failed (and any genuinely-changed) fragments run while
everything else links to its last-good output. This falls straight out of the
reuse rule in [`reuse.md`](./reuse.md), so there is no separate single-fragment
retry mechanism.

## Relationship to reuse

The decision of *which* fragments run and which link — the per-fragment
memoization key and the `rerun(F)` predicate — lives entirely in
[`reuse.md`](./reuse.md). This document only provides the unit those decisions
attach to (the `VersionFragment`) and the machinery that runs and assembles them.

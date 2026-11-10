# Version fragments (execution model)

Part of the survey-parallelization architecture. This document specifies **how a
fragmentable process executes**: the `VersionFragment` unit, how a version fans
out over parts, how fragments are **batched into pods** and run, how they are
reused, and how their outputs assemble back into a single on-disk dataset. It is
referenced by the parallelization plan; it is not itself a plan.

Reuse / change detection (which fragments run vs link) is specified separately in
[`reuse.md`](./reuse.md). This document covers the representation, batching and
lifecycle; reuse supplies the per-fragment decision.

## The model

Today: `Process → ProcessVersion`, with exactly one Kubernetes Job per
`ProcessVersion`; `state`, the k8s/monitor/log fields, and output discovery all
hang off the version (see `backend/models/process.py`,
`backend/services/job_orchestrator.py`).

New: two levels below the version — the **version fragment** (the unit of
identity and reuse) and the **batch** (the unit of execution: one Kubernetes Job
/ pod, running a group of fragments one after another).

```
Process
 └─ ProcessVersion                params, type, environment, parallelism; state DERIVED
     ├─ VersionFragment parts/L001 ┐
     ├─ VersionFragment parts/L002 ├─ batch 0 → one Job/pod  (runs its fragments in sequence)
     ├─ VersionFragment parts/L003 ┘
     ├─ VersionFragment parts/L050 ┐
     ├─ VersionFragment parts/L051 ├─ batch 1 → one Job/pod
     ├─ VersionFragment parts/L052 ┘
     └─ VersionFragment parts/L137 → linked (reused from N−1; in no batch, no Job)
```

A **`VersionFragment`** is the unit of identity and reuse: one per part, it
records the input it consumed (its memoization key; see [`reuse.md`](./reuse.md))
and carries a derived state. A **batch** is the unit of execution: the
coordinator groups the fragments that must run into batches and launches **one
Kubernetes Job (one pod) per batch**; that pod processes its fragments
**sequentially**, calling the process's `run()` once per fragment.

The per-run execution fields — `k8s_job_name`, `started_at`/`completed_at`,
resource requests, deadline, log-tracking, and the billing clock — live on the
**batch** (one pod = one Job = one billable run), not on the individual fragment.
`ProcessVersion` keeps the parameters, type, environment, and the parallelism
knob; its state is **derived** from its fragments (below). A fragment carries
only its part identity, its memo key, and its derived state (DONE / FAILED /
linked).

**Full unification, no fast path.** Every version has one or more fragments
grouped into one or more batches. A non-fragmented process is simply a version
with a single fragment (whose `part_path` is the root) in a single batch — one
pod, one `run()` call, exactly today's behaviour. There is no separate
non-fragmented code path.

## Identity

A version fragment is identified by `(process_id, version, part_path)`.

`part_path` is the path of the part within the dataset layout — `root` for the
whole dataset, `parts/<flightline>` for a line part. **The root is not special**:
it is just another `part_path`, which is why the degenerate (non-fragmented) case
needs no sentinel and no special handling — it is the fragment at `part_path =
root`.

A **batch** is identified by `(process_id, version, batch_index)` and owns a
single Kubernetes Job. A fragment belongs to at most one batch (a linked fragment
belongs to none). Batch membership is recomputed fresh each version — it is an
execution grouping, not stable identity, so nothing downstream references a batch.

## Parallelism and batching

Fan-out granularity (how finely the survey is cut for reuse) is deliberately
**decoupled** from execution concurrency (how many pods run at once). The part
structure fixes the first — one fragment per part, always, so a one-line edit
re-runs exactly one fragment. The user controls the second with a
**`parallelism`** value supplied in the process's `resource_requests`, alongside
the per-pod `cpu` / `memory` / `ephemeral-storage` that size a single pod:

- **`parallelism = P`** is the maximum number of pods to spread the run across.
  The coordinator takes the set of fragments that must run (the non-linked
  fragments; see [`reuse.md`](./reuse.md)) and distributes them over
  `min(P, n_runnable)` batches, each batch one pod running its fragments in
  sequence.
- Pod **size** (`cpu`/`memory`) is per-pod and independent of `P`. Because a pod
  runs its fragments **sequentially**, peak memory is one fragment's footprint
  regardless of how many fragments the batch holds — so a batch pod is sized
  exactly like a single-fragment pod, and the existing single-node-capacity check
  at submit (`Process.create_queued`, which validates `cpu`/`memory` against one
  node) is unchanged.
- **`P` is a ceiling, not a guarantee of simultaneity.** All batch Jobs are
  created at once and **Kueue** admits as many as cluster quota allows, suspending
  the rest — exactly as today. `P` bounds how many pods exist; Kueue bounds how
  many run concurrently.
- `P` scales the run down automatically on a cheap re-run: if only two fragments
  are runnable, there are at most two batches regardless of `P`, so reuse still
  collapses the work to the edited parts.

Why the knob matters — the economics are cluster-shaped:

- On a **narrow** cluster (e.g. a single-node deployment) a large survey's first
  run should use a **small `P`**: a few fat pods each looping over many fragments,
  so pod cold-start / image-pull / credential-mint overhead is paid a handful of
  times, not once per flightline. With `P = 1` the whole survey runs in one
  sequential pod — close to today's single-Job behaviour, but now reuse-aware
  across re-runs.
- On a **wide** cluster, a large `P` (up to one pod per fragment) maximises
  wall-clock parallelism, which is the point for inversion (which must be cut up
  to be tractable at all).

`P` is a user choice because only the user knows the cluster they are running
against; the platform does not guess it. It is validated like the other resource
requests (a positive integer); `P = 1` is the always-valid default that reproduces
today's one-pod behaviour.

## Fan-out and input narrowing

When a version fans out, the coordinator builds each fragment's effective
parameters by **substituting every dataset-valued parameter with that part's
file URL(s)** — or empty if the input has no part by that name (see the union /
missing-is-empty rules in [`reuse.md`](./reuse.md)). Because the whole dataset is
the `root` part, the same substitution produces the correct parameters for the
degenerate single-fragment case with no extra logic.

The coordinator then packs the runnable fragments into batches and hands each pod
its batch as an **ordered list of per-fragment parameter sets** (each
`{ part_path, parameters }`). The runner loops over them, invoking the process's
`run()` once per entry through the existing "params carry dataset URLs → pod opens
them with fsspec" machinery (`ymerflow_runner`), unchanged — just once per
fragment instead of once per pod. The per-process `run()` contract is untouched:
it still processes a single part and is unaware it is one of several in a pod.

## Execution and concurrency

Each batch is one Kubernetes Job, created via `job_orchestrator` — the
Job/manifest/monitor/log code is reused, now keyed per **batch** instead of per
version. The coordinator creates every batch's Job at once; **Kueue** admits as
many as quota allows and suspends the rest. This is precisely today's
across-version parallelism, now operating across the batches of a single version,
with the batch count capped by `P`.

Within a pod, the runner processes its fragments in sequence: for each, it calls
`run()`, and the fragment writes its own slice of the output (its part files +
partial `info.json`, below). A fragment whose `run()` raises is logged (the
traceback goes to the pod's logs — never swallowed) and **skipped**, and the pod
continues to the next fragment; a skipped fragment simply produces no partial (see
failure, below). Pod-level setup that is per-pod rather than per-fragment —
notably the short-lived-credential re-mint and the refresher subprocess
(`runner.py`) — runs **once per pod**, so a batch of K fragments spawns one
refresher, not K.

A fragment that is **linked** (reused from N−1 per [`reuse.md`](./reuse.md)) is in
no batch and runs no Job; the coordinator records it directly as DONE.

**Cancellation.** A version now owns up to `P` Jobs rather than one, so
cancelling a version must cancel **every** batch it launched — deleting all of
those Jobs (and their pods / Kueue Workloads), not the single Job cancel handles
today. Linked fragments own no Job and need no teardown. (Fixing the
pre-existing defect where cancel leaves a Kueue Workload holding quota behind — a
manual `kubectl delete` is currently required — is **out of scope for this
plan**; the plan only requires that cancel address all `P` of a version's
batches, and does not undertake to fix that orphaning.)

The Job's `active_deadline_seconds` is a **per-pod** budget, so it must be scaled
to the batch — the per-fragment deadline times the number of fragments in the
batch. The runner additionally enforces the per-fragment budget inside its loop so
one runaway fragment cannot consume the whole pod's deadline and starve the rest.

## Output layout and assembly

**On-disk layout is unchanged from today.** A version's output dataset still lives
at `processes/{process_id}/{version}/datasets/{dataset_id}/` with `root.*` files
and `parts/<flightline>.*` files and a single `info.json`
(`docs/architecture/storage.md`, `dataset_utils.py`). A **rootless** dataset looks
identical to today's dataset **minus the root files** — nothing else differs.

Each fragment writes only its own slice of this layout — the root fragment writes
`root.*`, a line fragment writes its `parts/<flightline>.*` — plus a **partial
`info.json`** contributing only its slice of the final document, **regardless of
which batch/pod ran it**:

- root fragment → `{ "files": { … } }`
- line fragment `L050` → `{ "parts": { "L050": { "files": { … } } } }`

**The partial `info.json` is the fragment's commit marker.** A fragment MUST
write it **last** — after all of its own part files are durably written — and
**atomically** (write-to-temp-then-rename, as the storage layer already does
elsewhere). This is a hard requirement on every fragmentable `run()`, not an
incidental ordering: fragment state is derived from the partial's *presence*
(below), so a partial that exists must imply that every part file it references
is complete. Writing the partial first — or concurrently with the part files —
would let a pod that dies mid-write leave a present partial pointing at a
truncated part; that fragment would be read as DONE and would silently corrupt
downstream reuse, because `same URL ⟺ same bytes` (see [`reuse.md`](./reuse.md))
no longer holds. Written last and atomically, a crash can only ever *drop* the
partial, never leave a premature one, so the `absent-partial ⟹ FAILED` rule
stays correct.

Fragments in the same pod write distinct part files and distinct partials, and
fragments in different pods write into the same version's `datasets/{id}/` tree
without collision (write-once URLs; see [`reuse.md`](./reuse.md)) — so batching
never affects the on-disk result.

The canonical `info.json` is produced by a **dumb recursive merge** of all the
partials. The merger knows nothing about datasets, parts, or fragments — it is a
generic deep JSON merge: dicts union key-by-key recursively; leaf values must
agree across partials, and a conflict (two partials asserting different values for
the same leaf) is a **hard error**, not silently resolved — nothing in the design
should ever produce one, so a conflict signals a bug. Merging the partials above
yields exactly today's `{ id, mime_type, dataset_name, files, parts }`. A rootless
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
  the merged result to `info.json`.
- **Linked fragments.** A linked fragment runs no pod, so the coordinator
  synthesises its partial by copying N−1's entry for that part — whose URLs point
  into N−1's storage (link, not copy; see [`reuse.md`](./reuse.md)).
- **Who merges, when.** The backend performs the recursive merge after **every
  batch has reached a terminal state and every fragment is DONE**. It is
  metadata-only (JSON, no part bytes), so it stays within the
  lightweight-coordinator rule. This replaces/extends today's
  `ProcessVersion._create_outputs` storage scan.

## State derivation and failure

A fragment has no Job of its own; its state is **derived from its output
artifact** once its batch's pod reaches a terminal state:

- its partial `info.json` is present → fragment **DONE**;
- its partial is absent → fragment **FAILED**.

This rule is only sound because of the commit-marker invariant above: the partial
is written last and atomically, so its presence guarantees its part files are
complete, and a mid-write crash can only leave it absent (→ FAILED, correctly),
never present-but-premature.

Deriving fragment state from the presence of its artifact — rather than from the
pod's exit code — is what lets a single pod carry many fragments: one fragment
failing does not condemn its batch-mates. The pod logs the error, skips that
fragment, and the others still write their partials and are DONE. This fits the
existing "backend scans storage for produced datasets" model (`_create_outputs`).
(A whole-pod failure — OOM, deadline, node eviction — leaves every not-yet-run
fragment in that batch without a partial, so they are all FAILED and re-run in the
next version; the fragments the pod had already completed keep their partials and
are DONE.)

`ProcessVersion` state is then derived from its fragments:

- any fragment queued/starting/running (i.e. any non-terminal batch) → the version
  is in progress;
- all fragments `DONE` (including linked) → version `DONE`, after the info.json
  merge;
- any fragment `FAILED` → version `FAILED`.

Billing is **per batch/pod**: each batch is one billable run, its clock is the
pod's `started_at`/`completed_at` (set at the STARTING transition, as today), and
the `job_pre_run` / `job_completed` hooks fire once per batch. A version's cost is
the sum over its batches — and because linked fragments launch no pod, a cheap
re-run that re-batches only the edited parts is billed only for those pods.

**Failure recovery is a new version, not an in-place retry.** A failed fragment is
not `DONE`, so it is not linkable; re-running the process creates version N+1 in
which the previously-failed (and any genuinely-changed) fragments run — re-batched
afresh over `min(P, n_runnable)` pods — while everything else links to its
last-good output. This falls straight out of the reuse rule in
[`reuse.md`](./reuse.md), so there is no separate single-fragment retry mechanism.

## Relationship to reuse

The decision of *which* fragments run and which link — the per-fragment
memoization key and the `rerun(F)` predicate — lives entirely in
[`reuse.md`](./reuse.md). This document provides the unit those decisions attach to
(the `VersionFragment`), the **batching** that packs the runnable fragments into
pods under the `parallelism` ceiling, and the machinery that runs and assembles
them. Batching is purely an execution concern: it never changes which fragments
run, only how many pods they are spread across.

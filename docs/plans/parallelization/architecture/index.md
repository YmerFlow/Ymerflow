# Survey parallelization — architecture

These documents describe the architecture for processing and inverting surveys
**by fragment** instead of all at once, so that large surveys become tractable
and small edits become fast. They are reference docs cited by the
parallelization plan; they are not themselves a plan.

## The problem

A survey is one dataset, and today a process runs it as a single job producing a
single output. Two pains follow: big surveys are too **big** to invert at once
(memory and CPU grow supralinearly with survey size), and iterating is too
**slow** — change one flightline and the whole survey reprocesses (~20 min for a
one-line edit).

## The idea

A dataset is already fragmented on disk: its `parts` (for AEM, one per
flightline). A **fragmentable process** runs per part — one **version fragment**
per part — which buys two things:

- **parallelism** — all fragments can run at once (the win for inversion, which
  must be cut up to be tractable at all);
- **reuse** — on a re-run, only the fragments whose input actually changed
  recompute; the rest are linked, not copied (the win for fast iteration).

Crucially, fan-out granularity (one fragment per part, for reuse) is **decoupled**
from execution concurrency. The user supplies a **`parallelism`** value in the
process's resource request — the number of pods to spread the run across — and the
coordinator **batches** the fragments that must run into that many pods, each pod
running its fragments **sequentially**. So a 200-flightline survey can run as 200
pods on a wide cluster or a handful of fat looping pods on a narrow one, without
changing the part structure or the reuse behaviour. Pod size (CPU/memory) is set
separately and is unaffected by batching, since sequential execution means a pod's
peak footprint is a single fragment.

Fragment output is **rootless** (parts, no whole-survey file), so a one-line edit
never pays a whole-survey cost. Whole-survey views are assembled on demand by
readers; a real whole-survey file is produced only by an explicit **join**.
Spatial decomposition for laterally-constrained inversion is done by a
**grid-split** that cuts the survey into overlapping cells, which join blends
back together.

## The two end-to-end flows

```
Processing / LCI inversion (by flightline):
    import → process  (map over line parts; reuse unchanged; rootless out)
             └─ view: readers assemble from parts;  export/whole-survey: join

SCI inversion (spatial):
    import → grid-split → inversion → join
             (overlapping   (map over   (blend overlaps → root →
              cell parts)    cell parts   re-split by flightline)
                             in parallel)
```

A non-fragmented process is the degenerate case: one version fragment over the
whole dataset (the root part), in a single batch (one pod, `parallelism = 1`),
producing a normal rooted dataset — today's behaviour, unchanged.

## The documents, in reading order

1. [`version-fragments.md`](./version-fragments.md) — the execution model: the
   `VersionFragment` unit (identity/reuse) vs the **batch** (execution), the
   user-set `parallelism` knob that packs fragments into a bounded number of
   sequential-looping pods (Kueue-parallelised), fan-out over parts, rootless
   output assembled by a recursive `info.json` merge, artifact-derived fragment
   state, per-batch billing, failure-as-new-version. The foundation the rest
   builds on.
2. [`reuse.md`](./reuse.md) — which fragments run vs link: URL-identity change
   detection, the `rerun(F)` rule, the union fragment universe, link-don't-copy.
3. [`rootless-datasets.md`](./rootless-datasets.md) — what a rootless dataset is,
   where the whole survey is assembled (readers, on demand), and the `info.json`
   reference used for dataset inputs.
4. [`grid-split.md`](./grid-split.md) — UTM-aligned fixed square cells with a
   margin halo, no empty cells, per-cell core bbox recorded for the blend.
5. [`join.md`](./join.md) — rootless → rooted: match duplicates by `sounding_id`,
   always blend (separable-bilinear weights from the core bboxes), re-partition by
   flightline.

## Implementation note to carry forward (post-build)

Reuse rests on an unenforced invariant: **every multi-part producer — each
fragmentable process *and* the manual-edit tooling — must link unchanged parts by
reusing their prior URL, and mint new URLs only for parts whose content actually
changed** (see [`reuse.md`](./reuse.md), "URL identity is content identity"). A
producer that instead re-mints fresh URLs for unchanged parts stays *correct*
(missed reuse is always safe) but silently becomes a reuse barrier for everything
downstream of it — the fast-iteration win quietly evaporates with nothing to flag
it.

This is **easy to check by reading the code** (does the producer copy-forward
prior URLs for untouched parts?) but **hard to enforce deterministically at
runtime** (proving two differently-URL'd outputs are byte-identical is exactly the
hashing the design avoids). So it is not a build-time task. Once the SDK's
part-writing/linking path exists, **add a note to `CLAUDE.md`** recording the
invariant as a review-time check for anyone writing or modifying a fragmentable
process, pointing at the shared SDK helper that implements link-don't-copy.

## External dependency

- **sounding-links** (`docs/plans/sounding-links-and-downline-distance.md`, branch
  `plan/sounding-links`, PR YmerFlow/Ymerflow#137) provides the survey-global
  `sounding_id` that join uses to match the soundings duplicated across
  overlapping cells. It must land before grid-split/join.

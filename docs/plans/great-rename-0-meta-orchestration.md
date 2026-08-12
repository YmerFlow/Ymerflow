# Great Rename — Meta Orchestration Plan

## Goal

Drive the five `great-rename-{1..5}-*.md` subplans to completion, one at a time, each implemented
by a dedicated subagent and then committed, before the next subagent is launched. This meta-plan
is the orchestrator; the subplans are the work.

## Deliberate deviations from the normal repo rules (authorized 2026-08-12)

These override `CLAUDE.md` for this rename effort only, at the user's explicit instruction:

- **This plan DOES make git commits.** (`CLAUDE.md` rule 3 normally forbids it.)
- **Commits land directly on each repo's current branch** (the main repo's `master`, and whatever
  branch each plugin/SDK repo currently has checked out). No feature branch, no PR.
- **Commit messages are a single short sentence, with NO co-author trailer and no mention of
  Claude / AI authorship.** Form: `rename: <subplan topic>` (exact messages per subplan below).
- **Each completed subplan's plan file is `git mv`'d into `docs/plans/done/`** as part of that
  subplan's commit (normal repo convention, kept).

Everything else in `CLAUDE.md` still applies inside each subagent's work (no swallowed
exceptions, real-entropy migration ids/UUIDs, TanStack Query patterns, etc.).

## Orchestration model

Strictly sequential — never run two subplans concurrently (subplan 3 rewrites shared bridge
contracts that later subplans and verification depend on; and every step commits):

For each subplan N in order 1 → 2 → 3 → 4 → 5:

1. **Launch one subagent** (`general-purpose`) with the subplan file as its brief (prompt
   template below). The subagent **implements and verifies, but does NOT commit** — committing is
   the orchestrator's job so there's a review/verification gate between "changed" and "recorded".
2. **Subagent returns** a structured report: every file changed, grouped by which git repo it
   belongs to, plus the result of the subplan's own verification steps.
3. **Orchestrator verifies** before committing:
   - Re-run the subplan's verification (build/test/grep as applicable — see each subplan).
   - Run the scope grep: `grep -rni nagelfluh <the subplan's file scope>` should return only
     the occurrences that subplan explicitly leaves for a later subplan (e.g. subplan 1 leaves the
     bridge globals for subplan 3). If anything unexpected remains, **halt** (see Failure handling).
4. **Orchestrator commits** in each affected repo (see per-subplan table for repos + messages),
   including the `git mv` of the plan file to `docs/plans/done/` in the main-repo commit.
5. **Launch the next subplan's subagent.** Repeat.

After subplan 5's committed code changes, the **manual prod cutover** (below) is performed by the
user — it is out of the automated commit loop.

## Per-subplan execution table

| N | Subplan file | Repos committed | Commit message(s) |
|---|---|---|---|
| 1 | `great-rename-1-frontend-cosmetic.md` | main | `rename: frontend cosmetic` |
| 2 | `great-rename-2-python-local-dev-defaults.md` | main | `rename: python local dev defaults` |
| 3 | `great-rename-3-entrypoint-namespace.md` | main + SDK + 5 plugin repos (7 total) | `rename: entrypoint namespace and plugin bridge` (same message in each repo) |
| 4 | `great-rename-4-process-type-identifiers.md` | main | `rename: process type identifiers` |
| 5 | `great-rename-5-k8s-cloud-infra.md` | main | `rename: k8s and cloud infra names` |

The plan-file `git mv` to `docs/plans/done/` always goes in the **main-repo** commit for that
subplan (the plan files live only in the main repo).

## Subplan 3 is the multi-repo one — commit in each repo separately

Subplan 3 (bridge contract) is the only one that changes more than the main repo. The 7 repos are
**separate git repositories** (each has its own nested `.git`; not submodules). The subagent
edits files across all of them in one pass; the orchestrator then commits **once per repo**:

- main repo (`.`) — host frontend `window.__*` writers, `backend/`, `docker/base-runner/*_processes`,
  root `setup.py`, `tests/plugins/*`, and the plan-file move.
- `deps/Ymerflow-plugin-sdk`
- `plugins/billing`
- `plugins/ymerflow-gcp`
- `plugins/ymerflow-azure`
- `plugins/ymerflow-minikube`
- `plugins/ymerflow-plugin-tickets-github`

**Verify first how the main repo treats the nested plugin/SDK dirs** (gitignored vs. embedded).
Run `git -C . status --short plugins deps` before committing subplan 3 — if the plugin dirs show
as untracked embedded repos or gitlinks, confirm the main-repo commit does **not** accidentally
stage them; each plugin repo must get its own `git -C plugins/<name> commit`. Reinstall the
affected editable packages / rebuild the plugin `frontend_dist` bundles per the subplan before the
orchestrator's verification grep, or discovery/build checks will report stale metadata.

## Subplan 5 splits into committed code vs. manual cutover

The subagent + orchestrator only do the **code/manifest/config rename and commit** for subplan 5:
- backend defaults, the `k8s/` manifest tree, `prod/runall-production.sh`, `frontend/nginx.conf`,
  the three Alembic seed migrations, the `nagelfluh-render-backend-secret-env` script rename, and
  the `config.env.*` files. Commit as `rename: k8s and cloud infra names`.

The **operational cutover is NOT automated and NOT committed by this loop** — it's a human ops
step the user runs after the code lands: provision `ymerflow-gke` + the `ymerflow` registry,
redeploy prod from scratch via the renamed `prod/runall-production.sh`, GUI-export each project
from the old deployment and reimport into the new one, then tear down the old `nagelfluh-*`
resources. The meta-plan's job ends at "subplan 5 code committed"; note the manual cutover as the
final checklist item for the user, do not attempt it from a subagent.

## Subagent prompt template

> Implement the plan in `docs/plans/great-rename-N-<...>.md` exactly as written. Follow all
> `CLAUDE.md` rules **except** git — do NOT create any git commit; leave all changes in the
> working tree. Apply every rename the plan specifies, run the plan's own verification steps, and
> if the plan says to reinstall a package / rebuild a bundle, do it. Then report back: (a) every
> file you changed, grouped by which git repository it lives in (main repo vs. a `plugins/<name>`
> or `deps/<name>` sub-repo); (b) the exact result of each verification step you ran; (c) any
> `nagelfluh`/`Nagelfluh` occurrence you intentionally left in your scope and why (e.g. it belongs
> to a different subplan). Do not touch files outside this subplan's scope.

## Failure handling

- If a subagent reports a verification failure, or the orchestrator's own verification grep/build
  finds an unexpected residual, **halt the sequence** — do not commit, do not launch the next
  subplan. Surface the problem to the user and wait. A partially-applied subplan left uncommitted
  in the working tree is recoverable; a bad commit propagated into the next subplan's baseline is
  not.
- Because commits are direct-on-branch with no PR, each commit is the rollback boundary: if a
  later subplan reveals an earlier one was wrong, it's a follow-up commit, not a force-push.

## Ordering (from `great-rename-{1..5}` numbering)

1 → 2 → 3 → 4 → 5, sequential. The only hard cross-subplan constraint is that subplan 5's
**manual cutover** happens after every code subplan is committed (it rebuilds all images from the
renamed source). Subplans 1 and 2 are independent warm-ups; 3 is the big atomic cross-repo change;
4 folds onto 3's runner-image rebuild. See each subplan's own "Resolved decisions" for detail.

## Completion

After subplan 5's code is committed, `git mv docs/plans/great-rename-0-meta-orchestration.md
docs/plans/done/` and commit in the main repo as `rename: archive great rename meta plan`, then
hand the manual prod-cutover checklist (Subplan 5 section) to the user.

## Open Questions

- [ ] None blocking. Confirm the nested-repo staging behavior (Subplan 3 section) at execution
      time rather than assuming.

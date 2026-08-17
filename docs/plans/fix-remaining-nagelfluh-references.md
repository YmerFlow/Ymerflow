# Fix Remaining Nagelfluh References — Plan

## Goal

The Great Rename (issue #15, `docs/plans/done/great-rename-*.md`) intentionally deferred prose
docs and `debug-harness/`. A follow-up sweep (2026-08-17) found those deferred items are still
outstanding, plus four **functional bugs** that were missed by every prior pass — code that
still points at the old `nagelfluh` name where the rest of the system has already moved to
`ymerflow`, causing broken links / wrong defaults rather than just cosmetic drift.

This plan fixes: (1) the four real bugs, (2) all remaining prose documentation, (3) the
`NAGELFLUH_SKIP_FRONTEND_BUILD`/`NAGELFLUH_SKIP_MC_DOWNLOAD` env vars across every repo that uses
them, and (4) `debug-harness/`, including a genuine functional bug in its MinIO hostname found
while investigating scope (independent of naming).

## Background — current state

### A. Real bugs (broken behavior today)

1. **Broken image links** — `frontend/public/Nagelfluh.jpg` was renamed to `YmerFlow.jpg` (with
   its `.LICENSE` sidecar) during the Great Rename, but two references were never updated:
   - `README.md:3` — `<img src="frontend/public/Nagelfluh.jpg" ...>`
   - `pages/template.html:14` — `<img src="{{ root_prefix }}frontend/public/Nagelfluh.jpg" ...>`
   - `pages/build.py:134` — stale comment mentioning the old filename (cosmetic, fix while
     touching the same area).

2. **`.dockerignore` ignores nothing real** — `.dockerignore:31-34` excludes
   `nagelfluh_backend.egg-info/`, `nagelfluh.db`, `nagelfluh.db-shm`, `nagelfluh.db-wal`. The
   actual package is `ymerflow-backend` (confirmed: `ymerflow_backend.egg-info/` exists at repo
   root today) and the actual local DB file is `ymerflow.db` (per `debug-harness/extract_config.py`'s
   own path list). These patterns currently exclude nothing that exists, so the real egg-info and
   local sqlite db can leak into the Docker build context.

3. **Admin UI namespace default mismatch** — `frontend/src/ClustersAdminPanel.jsx:13` defaults a
   new cluster's namespace field to `'nagelfluh-jobs'`. Every backend default agrees on
   `'ymerflow-jobs'` instead: `backend/models/cluster.py:21`, `backend/routers/admin.py:71,140`,
   `backend/services/k8s_client.py:45`, and the seed migration
   `backend/alembic/versions/f6a7b8c9d0e1_seed_default_cluster.py:40`. The admin form is the one
   outlier.

4. **Runner container writes to a path the backend never reads** —
   `docker/base-runner/Dockerfile:42` sets
   `ENV PLUGIN_NPM_SOURCE_DIR=/var/lib/nagelfluh/plugin-npm-source`, but
   `backend/config.py:87` defaults `plugin_npm_source_dir` to `/var/lib/ymerflow/plugin-npm-source`.
   Whatever the runner Dockerfile stages under the old path is invisible to the backend's default
   config.

### B. Cosmetic-but-real code leftovers (self-consistent, not broken, but still old branding)

5. `frontend/src/widgets/AEMModelSimulator/SaveModelDialog.jsx:324` — downloaded files are named
   `nagelfluh_model_<timestamp>.msgpack`. User-visible.
6. `docker/base-runner/Dockerfile:27-30` + `docker/base-runner/fake_processes.py:6` — an internal
   helper package inside the runner image is still called `nagelfluh_runner`
   (`from nagelfluh_runner import xyz_utils`). Both sides agree, so nothing is broken, but it's
   old branding baked into the runner image.

### C. `NAGELFLUH_SKIP_FRONTEND_BUILD` / `NAGELFLUH_SKIP_MC_DOWNLOAD` — cross-repo env vars

These two env vars gate metadata-only / no-download installs of the frontend-bundling plugin
`setup.py`s. They're consistently named `NAGELFLUH_*` everywhere they appear — confirmed via
`grep -rl NAGELFLUH_SKIP` across all checked-out repos:

- `plugins/billing/{setup.py,pyproject.toml}`
- `plugins/ymerflow-minikube/{setup.py,pyproject.toml,minikube_plugin/minio_service.py}`
- `plugins/ymerflow-gcp/{setup.py,pyproject.toml}`
- `plugins/ymerflow-azure/{setup.py,pyproject.toml}`
- `plugins/ymerflow-plugin-tickets-github/{setup.py,pyproject.toml}`
- `deps/Ymerflow-plugin-sdk/docs/distributing.md`
- `tests/plugins/test-backend-plugin/{setup.py,pyproject.toml}` (this repo's own test fixture,
  intentionally mirrors the real plugins' convention)

Each `plugins/*` and `deps/Ymerflow-plugin-sdk` entry is a **separate git repo** (own `.git`,
own GitHub remote), same as the repos touched by the original Great Rename subplans. One repo
(`plugins/ymerflow-gcp/.claude/settings.local.json`) also hard-codes the var name in a permission
allowlist entry (`Bash(NAGELFLUH_SKIP_FRONTEND_BUILD=1 ...)`) — local machine config, not source;
update it if convenient but it's not load-bearing.

**Decided (per user 2026-08-17): rename in all repos**, not just this one.

### D. `debug-harness/` — what it is

A local dev tool (git-tracked, not a stub/plan) for post-mortem debugging of failed K8s process
jobs by running the runner container locally with `pdb` attached instead of in Kubernetes:

- `run_debug.sh` — active entry point; builds/runs the container locally with debug config from
  `.env` / `config.json`
- `run_debug.sh.old` — superseded by `run_debug.sh` (both were touched in the same rename
  commits, `.old` was never deleted) — **decided: delete, not rename**
- `debug_runner.py` — wraps the real runner with try/except → `pdb.post_mortem()` on crash
- `runner_debug.py` — a separate script resolving process-type entry points and making its own
  HTTP calls; out of scope here (not a naming issue, just noting the confusing near-duplicate
  name with `debug_runner.py` for whoever next touches this directory)
- `extract_config.py` — pulls a real failed job's config from the database into `config.json`
- `config.json.template` — template; `config.json` itself is untracked/gitignored
- `README.md`, `SETUP_GUIDE.md`, `CHANGELOG.md` — usage docs

**Independent functional bug found while investigating** (decided: fix, not just rename):
`run_debug.sh:68` rewrites `localhost:9000` to
`http://minio-nagelfluh.ymerflow-jobs.svc.cluster.local:9000` — half-renamed already. The
**real** current MinIO endpoint, per the authoritative source
(`plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py:59-65`, the actual
`_pod_endpoint()` translation the backend itself uses in dev) is
`minio-ymerflow.ymerflow-jobs.svc.cluster.local:9000` — an `ExternalName` Service literally named
`minio-ymerflow` in the `ymerflow-jobs` namespace (`storage_protocol.py:187-195`), pointing at the
real `minio.minio.svc.cluster.local`. So the fix is exactly `minio-nagelfluh` → `minio-ymerflow`
(the namespace segment was already correct) — this brings `run_debug.sh` back in sync with
`storage_protocol.py` rather than just renaming text. Same fix applies to
`SETUP_GUIDE.md:53`'s `kubectl port-forward -n nagelfluh-jobs svc/minio-nagelfluh` example
(both segments wrong there: namespace *and* service name).

### E. Prose documentation (mechanical rename, no functional risk)

- `docs/user-guide.md`, `docs/architecture/overview.md`, `docs/architecture/technology-stack.md`
  (check), `docs/architecture/dependencies.md` (check), `docs/architecture/environment.md`,
  `docs/architecture/processes.md`, `docs/architecture/storage.md`, `docs/architecture/registry.md`,
  `docs/development.md`, `docs/deployment.md`, `docs/quickstart.md`, `docs/frontend/widgets.md`
- `docker/base-runner/aem_processes/README.md`, `docker/base-runner/aem_processes/COMPARISON.md`
  — note `COMPARISON.md:373` shows `"nagelfluh.process_types": [` as an example entry-point
  group name in a code sample; verify against the real current entry-point group name
  (`ymerflow.process_types`, per `CLAUDE.md`) before editing so the example stays accurate, not
  just relabeled.
- `debug-harness/README.md`, `debug-harness/SETUP_GUIDE.md`, `debug-harness/CHANGELOG.md`

Not in scope (confirmed not actual leftovers, see prior investigation):
`frontend/public/YmerFlow.jpg.LICENSE` (refers to a real Wikipedia file literally named
"Nagelfluh", the geological formation — unrelated to project branding),
`tests/webxtile/.ids.json` (untracked, regenerates correctly from `setup.py`),
`backend/services/project_import_service.py` (intentional old→new import-compat translation
table), and everything in `docs/plans/done/` (historical record, left as-is by design).

## Design decisions (resolved with user, 2026-08-17)

- **Env var rename: all repos in scope**, not just this repo's test fixture. Same pattern as the
  original Great Rename subplans — a subagent per repo, commit in each repo's current branch.
- **`debug-harness`: rename text AND fix the MinIO hostname** while in the file, since the
  hostname bug was found as a direct side effect of investigating the naming issue and the
  correct value is already known from `storage_protocol.py`.
- **`run_debug.sh.old`: delete**, not rename. It's dead weight superseded by `run_debug.sh`; git
  history preserves it if ever needed.
- **Authorized deviation from CLAUDE.md rule 3, for this effort only** — same exception granted
  for the original Great Rename session (per user, 2026-08-17): implementation **does** git-commit,
  directly on each repo's current branch (no PR), in every repo touched by this plan (this repo
  and every `plugins/*` / `deps/Ymerflow-plugin-sdk` repo touched by Part 3). Commit messages are
  one short sentence, **no co-author trailer / no Claude mention** (e.g. `rename: fix remaining
  nagelfluh references`, `rename: env var in gcp plugin`). This plan's file is `git mv`'d to
  `docs/plans/done/` in its repo's commit, same as each Great Rename subplan. This exception does
  not extend beyond this plan's scope.

## Implementation Steps

Grouped so each part can be a separate implementation session if useful; independent of each
other except where noted.

**Part 1 — Real bugs (A)**
1. Fix `Nagelfluh.jpg` → `YmerFlow.jpg` in `README.md:3` and `pages/template.html:14`; fix the
   stale comment in `pages/build.py:134`.
2. Fix `.dockerignore:31-34`: `nagelfluh_backend.egg-info/` → `ymerflow_backend.egg-info/`,
   `nagelfluh.db*` → `ymerflow.db*`.
3. Fix `frontend/src/ClustersAdminPanel.jsx:13` default namespace to `'ymerflow-jobs'`.
4. Fix `docker/base-runner/Dockerfile:42` `PLUGIN_NPM_SOURCE_DIR` to
   `/var/lib/ymerflow/plugin-npm-source`.

**Part 2 — Cosmetic code leftovers (B)**
5. `SaveModelDialog.jsx:324` filename template → `ymerflow_model_${timestamp}.msgpack`.
6. Rename the `nagelfluh_runner` package → `ymerflow_runner` in
   `docker/base-runner/Dockerfile:27-30` and the import in `fake_processes.py:6`. Grep
   `docker/base-runner/` afterward for any other `nagelfluh_runner` import before considering this
   done (only `fake_processes.py` is confirmed so far; other process files may also import it).

**Part 3 — Cross-repo env var (C)**
7. In each of `plugins/billing`, `plugins/ymerflow-minikube`, `plugins/ymerflow-gcp`,
   `plugins/ymerflow-azure`, `plugins/ymerflow-plugin-tickets-github`, `deps/Ymerflow-plugin-sdk`:
   rename `NAGELFLUH_SKIP_FRONTEND_BUILD` → `YMERFLOW_SKIP_FRONTEND_BUILD` and
   `NAGELFLUH_SKIP_MC_DOWNLOAD` → `YMERFLOW_SKIP_MC_DOWNLOAD` everywhere they appear (`setup.py`,
   `pyproject.toml`, `docs/distributing.md`, `minio_service.py` docstring). Commit per-repo,
   one short sentence, no co-author trailer, directly on each repo's current branch (per the
   authorized deviation above).
8. Update `tests/plugins/test-backend-plugin/{setup.py,pyproject.toml}` in this repo to match.
9. Optionally update `plugins/ymerflow-gcp/.claude/settings.local.json`'s allowlist entry to the
   new var name (local machine config, not required for correctness).

**Part 4 — debug-harness (D)**
10. Delete `debug-harness/run_debug.sh.old`.
11. `debug-harness/run_debug.sh:68`: fix `minio-nagelfluh` → `minio-ymerflow` (namespace segment
    already correct).
12. `debug-harness/SETUP_GUIDE.md:53`: fix `-n nagelfluh-jobs svc/minio-nagelfluh` →
    `-n ymerflow-jobs svc/minio-ymerflow`.
13. Rename remaining prose in `debug-harness/README.md`, `SETUP_GUIDE.md`, `CHANGELOG.md`,
    `extract_config.py` (comment/string content only — its `possible_path` list already prefers
    `ymerflow.db` correctly, just drop the old `nagelfluh.db` fallback entries or leave as
    defensive fallback, user's call during implementation).

**Part 5 — Prose docs (E)**
14. Mechanical `nagelfluh`→`ymerflow` / `Nagelfluh`→`YmerFlow` pass over the doc list in
    Background section E. For `docker/base-runner/aem_processes/COMPARISON.md:373`, verify the
    entry-point group name against current reality before editing.
15. Manual verification: spot-check a few rendered docs pages, confirm `README.md` and
    `pages/template.html` images render (per `pages/build.py`'s mirroring step), confirm
    `debug-harness/run_debug.sh` runs against the real `minio-ymerflow` service name.

**Part 6 — Commit**
16. Commit this repo's changes (Parts 1, 2, 4, 5, and step 8) with one short sentence, no
    co-author trailer, directly on the current branch — same convention as Part 3's per-repo
    commits. `git mv` this plan file to `docs/plans/done/` in that commit.

## Open Questions

- [ ] None outstanding — all scope decisions resolved above. Flag anything new found mid-implementation
      rather than silently expanding scope.

# Great Rename — Host↔Plugin Bridge Contract (`nagelfluh.*` namespace)

## Goal

Rename the entire host↔plugin **bridge contract** from the `nagelfluh` namespace to `ymerflow`,
atomically, across the main repo **and every plugin/SDK repo**. This is the widest-blast-radius
part of the rename and the one that most needs coordinating, because the bridge identifiers are a
shared contract: a partial rename silently breaks plugin discovery/loading with no error.

The contract spans four kinds of identifier, all of which move together:

1. **setuptools entry-point group names** — `nagelfluh.hooks`, `nagelfluh.migration_dirs`,
   `nagelfluh.models`, `nagelfluh.process_types`, plus the two `swaggerspect` groups
   `nagelfluh.mag_inversion_3d_systems` / `nagelfluh.mag_equiv_source_systems`. Discovery via
   `importlib.metadata.entry_points(group=...)` returns **empty** (not an error) for an unknown
   group, so a missed rename fails silently.
2. **Frontend `window.__nagelfluh_*` globals** — `__nagelfluh_registerHook`, `__nagelfluh_hooks`,
   `__nagelfluh_api`, `__nagelfluh_widgets`, `__nagelfluh_AuthContext`, `__nagelfluh_MessageContext`.
   The host sets these on `window`; the SDK (`deps/Ymerflow-plugin-sdk/js/index.js`) and every
   plugin frontend read them to reach the host singleton. (Moved here from
   `great-rename-1-frontend-cosmetic.md` once confirmed the SDK reads them.)
3. **The `nagelfluh` `package.json` key** (`nagelfluh.remoteName` / `nagelfluh.entry`) — a plugin
   declares its Module Federation remote name and entry module under this key; the host reads it
   via `backend/plugin_assets.py:28` (`pkg.get('nagelfluh', {}).get('remoteName')`).
4. **The `NAGELFLUH_SHARED_VERSIONS` env var** — the host injects its shared-singleton versions
   under this name; the SDK's `js/vite-preset.js` and the Python `ymerflow_plugin_build.build`
   harness read it.

> **The SDK deliberately froze these as `nagelfluh`.** `deps/Ymerflow-plugin-sdk/README.md:51`
> and `docs/README.md:35` explicitly document that these bridge identifiers were "deliberately
> left on their original `nagelfluh`/`NAGELFLUH` spelling" so host and independently-authored
> plugins share a stable contract. **That freeze is lifted by decision** (2026-08-12): since the
> user controls the host + SDK + all 5 plugin repos and they're renamed together in this same
> plan, the compatibility reason for freezing no longer applies. Those SDK docs must be updated
> as part of this rename (they currently instruct plugin authors to use the `nagelfluh` spelling).

## Background — current state

Four (confirmed) `nagelfluh.*` entry-point groups exist, all discovered via
`importlib.metadata.entry_points(group='nagelfluh.X')`:

| Group | Discovered by | Registered by |
|---|---|---|
| `nagelfluh.hooks` | `backend/hooks.py:8` | root `setup.py:60-64` (3 core hooks), `plugins/ymerflow-minikube/setup.py:122`, `plugins/billing/setup.py:86`, `plugins/ymerflow-plugin-tickets-github/setup.py:88`, `plugins/ymerflow-gcp/setup.py:120`, `plugins/ymerflow-azure/setup.py:140`, `tests/plugins/test-backend-plugin/setup.py:77`, `tests/plugins/test-frontend-plugin/setup.py:10` |
| `nagelfluh.migration_dirs` | `backend/bin/yf-makemigrations:36`, `backend/bin/yf-migrate:24` | root `setup.py:57-59`, `plugins/billing/setup.py:98`, `plugins/ymerflow-gcp/setup.py:128`, `plugins/ymerflow-azure/setup.py:148` |
| `nagelfluh.models` | `backend/alembic/env.py:17` | root `setup.py:54-56`, `plugins/billing/setup.py:101`, `plugins/ymerflow-gcp/setup.py:131`, `plugins/ymerflow-azure/setup.py:151` |
| `nagelfluh.process_types` | (loaded inside the process-runner Docker image at job-run time — not by `backend/`; the exact loader lives in the runner image code, not grepped as part of this plan's background but must be located during implementation) | `docker/base-runner/aem_processes/setup.py:37`, `docker/base-runner/ymerflow_processes/setup.py:23`, `docker/base-runner/mag_processes/setup.py:19` |

Two more entry-point-like groups exist under the same namespace, discovered via `swaggerspect`
rather than `importlib.metadata` directly:
`docker/base-runner/mag_processes/mag_processes/inversion_3d_process.py:73,131` calls
`swaggerspect.get_apis("nagelfluh.mag_inversion_3d_systems")`, and
`.../equiv_source_process.py:60,120` calls `swaggerspect.get_apis("nagelfluh.mag_equiv_source_systems")`.
**Not yet located**: which package(s) register systems into these two groups — grep for
`mag_inversion_3d_systems`/`mag_equiv_source_systems` in `setup.py` files across `deps/` (likely
`deps/simpeg` or `deps/emerald-processing-em`) during implementation, before renaming these two.

Also referencing the namespace only in **comments/docstrings** (no functional change beyond
prose accuracy, but should move together with the code they describe so nothing is left
contradicting itself): `backend/migration_path.py:3`, `backend/alembic.ini:49`,
`backend/services/cluster_providers/__init__.py:9,11,147`,
`backend/services/storage_protocols/__init__.py:10,12,101`,
`backend/services/registry_protocols/__init__.py:9,11,104`, and the equivalent doc comments in
`plugins/billing/setup.py:5`, `plugins/ymerflow-plugin-tickets-github/setup.py:5`,
`plugins/ymerflow-gcp/setup.py:8`, `plugins/ymerflow-azure/setup.py:8`.

**Plugins and the SDK are SEPARATE git repos** (confirmed: each `plugins/*` and
`deps/Ymerflow-plugin-sdk` has its own nested `.git`; they are not submodules — just sibling
clones checked out under this tree, kept in sync with the main repo by hand). So although the
rename is one logical change, it lands as **coordinated commits across 7 repos** (main + SDK +
`billing` + `ymerflow-gcp` + `ymerflow-azure` + `ymerflow-minikube` +
`ymerflow-plugin-tickets-github`), not one commit. Per the user's instruction (2026-08-12),
rename everything in these repos that references the main-repo names, in this same plan/session.
Each plugin has 40–160 `nagelfluh` occurrences (mostly docs/comments plus the contract
identifiers and each plugin's own `setup.py`/`package.json` registrations).

**The operational failure mode is stale installed metadata**: every affected Python package is
**pip-installed editable** (`pip install -e .` per `CLAUDE.md`), and setuptools bakes entry-point
metadata into each package's `*.egg-info/entry_points.txt` at install time — renaming `setup.py`
alone does nothing until each affected package is reinstalled. A stale `.egg-info` still
advertising the old group name is the thing to guard against (see Implementation Steps).
Likewise each plugin frontend's built `frontend_dist/assets/*.js` bundles bake in the old
`window.__nagelfluh_*`/`remoteName` strings until rebuilt.

**Rollout**: prod is redeployed **from scratch** (no data migration — see
`great-rename-5-k8s-cloud-infra.md`), so there's no half-upgraded-plugin window to worry about:
every image is rebuilt and every package reinstalled as part of the fresh redeploy. The hard
cutover below is therefore safe.

## Design decisions

- **All bridge identifiers mirror old→new 1:1, pure prefix swap, no semantic change**: entry-point
  groups `nagelfluh.{hooks,migration_dirs,models,process_types,mag_inversion_3d_systems,mag_equiv_source_systems}`
  → `ymerflow.*`; `window.__nagelfluh_*` → `window.__ymerflow_*`; the `nagelfluh` `package.json`
  key → `ymerflow`; `NAGELFLUH_SHARED_VERSIONS` → `YMERFLOW_SHARED_VERSIONS`.
- **Hard cutover, no dual-registration period** (settled 2026-08-12). Registering entries under
  *both* old and new group names simultaneously was considered and rejected: all 7 repos are
  renamed together and prod is redeployed from scratch, so there's no window where only some
  packages are updated. The plugins/SDK being separate git repos doesn't change this — they're
  kept in sync and land together, they are not versioned/released independently of the main repo.
- **The whole bridge contract renames together, freeze lifted** (settled 2026-08-12). The SDK's
  documented decision to keep the `nagelfluh` spelling is reversed; update those SDK docs
  (`README.md`, `docs/README.md`, `docs/authoring.md`, `docs/backend-hooks.md`,
  `docs/frontend-hooks.md`) so they instruct plugin authors to use the new `ymerflow` spelling.

## Implementation Steps

1. **Locate the two unresolved registration sites** for `mag_inversion_3d_systems` and
   `mag_equiv_source_systems` (grep `deps/*/setup.py`) and the `process_types` loader inside the
   runner image, so the full set of call sites is known before editing (avoid a rename that
   silently misses one).
2. **Rename every entry-point group string** (`nagelfluh.X` → `ymerflow.X`) in one pass across:
   - Discovery/loader code: `backend/hooks.py`, `backend/bin/yf-makemigrations`,
     `backend/bin/yf-migrate`, `backend/alembic/env.py`, the runner-image `process_types` loader,
     the `swaggerspect.get_apis(...)` call sites.
   - Registration blocks: root `setup.py`, `plugins/ymerflow-minikube/setup.py`,
     `plugins/billing/setup.py`, `plugins/ymerflow-plugin-tickets-github/setup.py`,
     `plugins/ymerflow-gcp/setup.py`, `plugins/ymerflow-azure/setup.py`,
     `tests/plugins/test-backend-plugin/setup.py`, `tests/plugins/test-frontend-plugin/setup.py`,
     `docker/base-runner/aem_processes/setup.py`, `docker/base-runner/ymerflow_processes/setup.py`,
     `docker/base-runner/mag_processes/setup.py`, and whatever `deps/*/setup.py` registers the
     two `mag_*_systems` groups.
   - Comments/docstrings listed in Background, so nothing describes a group name that no longer
     exists.
3. **Rename the other three bridge-identifier kinds** across host + SDK + all 5 plugin frontends:
   - `window.__nagelfluh_*` → `window.__ymerflow_*`: host writers (`frontend/src/AuthContext.jsx`,
     `MessageContext.jsx`, `App.jsx`, `plugins/hooks.jsx`, `scripts/export-widget-schemas.mjs`),
     the SDK (`deps/Ymerflow-plugin-sdk/js/index.js`), and every plugin frontend that reads them
     (grep `__nagelfluh_` across `plugins/*/frontend/src`).
   - `package.json` `nagelfluh` key → `ymerflow`: the host reader `backend/plugin_assets.py:28`
     and every plugin's own `frontend/package.json` that declares `nagelfluh.remoteName`/`.entry`.
   - `NAGELFLUH_SHARED_VERSIONS` → `YMERFLOW_SHARED_VERSIONS`: the SDK's `js/vite-preset.js` and
     `ymerflow_plugin_build/build.py`, plus wherever the host injects it.
   - Update the SDK docs that document the (now-lifted) `nagelfluh` freeze.
4. **Reinstall every affected package** so `.egg-info/entry_points.txt` reflects the new group
   names: `pip install -e .` for core, the same for each touched plugin
   (`pip install -e plugins/ymerflow-minikube`, etc.) and each `docker/base-runner/*_processes`
   package (inside the runner image build, or locally if installed editable there too). Rebuild
   each plugin's `frontend_dist` bundle so the built `__nagelfluh_*`/`remoteName` strings update.
5. **Verify discovery end-to-end**, not just that the code imports cleanly:
   - `env/bin/python backend/bin/yf-migrate` (or equivalent) picks up every plugin's migration
     directory — confirm the same set of migration dirs is listed as before the rename.
   - Backend startup logs / a hooks-listing code path shows all expected `hooks` entries
     (storage/cluster/registry protocol handlers from core, plus each plugin's).
   - `backend/alembic/env.py`'s model discovery still finds every plugin's models (spot-check via
     `alembic -c backend/alembic.ini revision --autogenerate -m check` producing no unexpected
     diff).
   - A process-runner container build picks up all `process_types` entries (spot check the
     `import_skytem`/`process_tem`/etc. keys still resolve).
   - **Frontend plugin load**: with a rebuilt host + rebuilt plugin bundle, a plugin actually
     loads and registers its hooks/widgets through the renamed `window.__ymerflow_*` bridge (the
     failure here would be a runtime "host bridge not initialised" thrown from the SDK).
6. Update the `config.env.*` comments that mention `` `nagelfluh.hooks` `` (prose). The full
   `config.env.*` rename (registry/storage/cluster JSON, namespaces, etc.) is owned by
   `great-rename-5-k8s-cloud-infra.md`; this plan only touches the entry-point-group prose there.

## Resolved decisions

- **Rollout** (settled 2026-08-12): prod is redeployed from scratch, so no half-rolled-out state
  is possible — every image/package is rebuilt+reinstalled together. Just land the coordinated
  commits across the 7 repos, then do the fresh redeploy.
- **No plugin is versioned/deployed independently** of this repo (settled 2026-08-12): the
  `plugins/*` and SDK repos are kept in sync and released with the main repo, so the hard-cutover
  (no dual-registration shim) decision stands.

## Open Questions

- [ ] None outstanding.

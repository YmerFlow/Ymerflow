# Fix: editable backend-plugin installs never rebuild the plugin frontend bundle

## Goal

Make `runall.sh` (and every `pip install -e` of a local-path backend plugin, in dev and in the
backend Docker image) rebuild the plugin's frontend bundle from current source, so a committed
frontend fix in `plugins/*/frontend/src/` actually reaches the browser. Today it does not: the
served bundle is a stale, pre-existing build artifact that no install step regenerates.

## Background — the bug

A fix to `plugins/ymerflow-gcp/frontend/src/GkeClusterForm.jsx` was committed to the plugin's git
repo, `APP_IMAGE_VERSION` (from `backend/bin/yf-resolve-app-image-tag`, which hashes each
local-path plugin's `git rev-parse HEAD`) correctly changed, and a fresh backend image was built and
pulled — yet the browser still ran the old code. Root cause, traced end to end:

1. A backend plugin's frontend is only (re)built by the `BuildWithFrontend(build_py)` class in its
   `setup.py` (`plugins/ymerflow-gcp/setup.py:70`, `plugins/ymerflow-minikube/setup.py:69`,
   `plugins/billing/setup.py:52`), wired via `cmdclass={'build_py': BuildWithFrontend}`. Its
   `run()` calls `_build_frontend()`, which `npm pack`s `frontend/` and runs
   `ymerflow_plugin_build.build_frontend(...)` into the in-package `frontend_dist/` directory.

2. `scripts/install-backend-plugins.sh:26` installs every **local-path** plugin **editable**
   (`pip install -e "$spec"`). All three plugins declare `[build-system].build-backend =
   "setuptools.build_meta"` in their `pyproject.toml`, so `pip install -e` goes through the PEP 660
   path: setuptools' build backend runs the **`editable_wheel`** command, **not `build_py`**. In
   `editable_wheel`'s default ("lenient") mode nothing invokes the project's `build_py` over the
   package, so the `BuildWithFrontend` override never fires and `_build_frontend()` never runs.

3. The backend serves each plugin from its pre-built `frontend_dist/` via the `frontend_bundles`
   hook (`gcp_plugin/__init__.py:17`, read by `backend/plugin_assets.py:mount_plugin_assets`), and
   content-addresses the directory into the plugin's `base_url` (`/plugin-assets/<hash>/`). Because
   `frontend_dist/` was never rebuilt, its content — and therefore the URL and the served
   `remoteEntry.js` — is unchanged from an earlier build.

4. `frontend_dist/` is `.gitignore`d in each plugin repo — it is a pure local build artifact, not
   version-controlled. In the reproduction it was last built at 11:46; the fix landed at 14:06. The
   fresh backend image just `COPY plugins/ plugins/`'d that stale directory and editable-installed
   over it without rebuilding.

Net effect: the frontend build is a step that, in practice, only ever ran manually or via some past
non-editable install. The normal `runall.sh` path (dev or prod) does not rebuild it. This is **not**
prod-specific — `dev/runall.sh:107` calls the same `install-backend-plugins.sh`.

Note the tag machinery is working correctly and needs no change: `yf-resolve-app-image-tag`
already changed the tag off the plugin's git HEAD. The defect is purely that `frontend_dist/` is not
regenerated from that committed source at install time.

## Design decisions

### 1. Rebuild on editable install via a per-plugin `editable_wheel` cmdclass override (chosen)

Add an `editable_wheel` command override alongside the existing `BuildWithFrontend(build_py)` in each
plugin's `setup.py`, so the exact same pre-build steps run whether the plugin is installed normally
(`build_py`) or editable (`editable_wheel`). This keeps the build definition self-contained in the
plugin that owns it, next to the `_build_frontend()` it already defines.

Alternatives considered and rejected:
- **Central trigger in `install-backend-plugins.sh`** (run the build after `pip install -e`): one
  place, auto-covers future plugins, but the build routine lives in each plugin's `setup.py` with no
  standard entry point to invoke generically, and it would re-implement build orchestration outside
  the build backend. Rejected in favour of keeping build logic owned by the plugin.
- **Stop installing local plugins editable**: makes `build_py` run again, but loses live pickup of
  Python backend edits for local plugins in dev (the explicit reason the script uses `-e`). Rejected
  as a regression.

### 2. Factor the pre-build steps into a shared helper so `build_py` and `editable_wheel` cannot drift

`BuildWithFrontend.run()` currently inlines the pre-build work. For `ymerflow-gcp` and `billing`
that is just `_build_frontend()` (guarded by `NAGELFLUH_SKIP_FRONTEND_BUILD`). For
`ymerflow-minikube` it is **both** `_build_frontend()` **and** `_download_minio_client()` (guarded
by `NAGELFLUH_SKIP_MC_DOWNLOAD`) — see `plugins/ymerflow-minikube/setup.py:70-75`. To guarantee the
editable path runs the identical steps (and does not silently skip the `mc` download), extract them
into one module-level `_prebuild()` function per `setup.py` and call it from both command overrides,
rather than copy-pasting the guarded calls into the new class.

### 3. Only `editable_wheel` is overridden — not `develop`

All three plugins have a `pyproject.toml` with `build-backend = "setuptools.build_meta"`, so modern
pip always uses the PEP 660 `editable_wheel` path for `pip install -e`; the legacy
`setup.py develop` command is never invoked. Overriding `develop` would be dead code, so it is left
out. (If a plugin ever drops its `pyproject.toml` build-system, revisit this.)

### 4. `NAGELFLUH_SKIP_FRONTEND_BUILD` / `NAGELFLUH_SKIP_MC_DOWNLOAD` semantics are preserved

The metadata-only escape hatches keep working identically on the editable path because both command
overrides call the same `_prebuild()`, which retains the existing env-var guards. A
`NAGELFLUH_SKIP_FRONTEND_BUILD=1` editable install still produces no `frontend_dist/` (and
`frontend_bundles()` already tolerates a missing dir by returning nothing).

## Implementation steps

For each of the three plugins — `plugins/ymerflow-gcp/setup.py`, `plugins/billing/setup.py`,
`plugins/ymerflow-minikube/setup.py`:

1. Add the import: `from setuptools.command.editable_wheel import editable_wheel`.

2. Extract the guarded pre-build work into a module-level helper. For `ymerflow-gcp` and `billing`:
   ```python
   def _prebuild():
       if os.environ.get("NAGELFLUH_SKIP_FRONTEND_BUILD") != "1":
           _build_frontend()
   ```
   For `ymerflow-minikube` (must retain the `mc` download):
   ```python
   def _prebuild():
       if os.environ.get("NAGELFLUH_SKIP_FRONTEND_BUILD") != "1":
           _build_frontend()
       if os.environ.get("NAGELFLUH_SKIP_MC_DOWNLOAD") != "1":
           _download_minio_client()
   ```

3. Rewrite `BuildWithFrontend.run()` to call the helper:
   ```python
   class BuildWithFrontend(build_py):
       def run(self):
           _prebuild()
           super().run()
   ```

4. Add the editable-install counterpart running the same helper:
   ```python
   class EditableWithFrontend(editable_wheel):
       def run(self):
           _prebuild()
           super().run()
   ```

5. Register it in `cmdclass`:
   ```python
   cmdclass={'build_py': BuildWithFrontend, 'editable_wheel': EditableWithFrontend},
   ```

No change to `scripts/install-backend-plugins.sh`, the Dockerfiles, `runall.sh`, the
`frontend_bundles` hooks, `backend/plugin_assets.py`, or the tag machinery.

## Verification

1. **Editable rebuild fires (dev path).** With the current fix committed in `plugins/ymerflow-gcp`,
   delete its stale `gcp_plugin/frontend_dist/`, run `env/bin/pip install -e plugins/ymerflow-gcp`,
   and confirm `frontend_dist/remoteEntry.js` is regenerated and that
   `grep -rl apiBaseAbsolute plugins/ymerflow-gcp/gcp_plugin/frontend_dist/` now matches (the fix is
   in the built bundle). Repeat for `plugins/ymerflow-minikube`.
2. **`mc` download still runs for minikube.** Confirm the editable reinstall of `ymerflow-minikube`
   still produces `minikube_plugin/bin/minio-client` (idempotent: present if it was already there).
3. **Skip flag still works.** `NAGELFLUH_SKIP_FRONTEND_BUILD=1 pip install -e plugins/billing`
   completes without invoking npm and writes no `frontend_dist/`.
4. **End-to-end prod path.** Run `runall.sh` (production/minikube mode) and confirm in the browser
   that the GKE "Add Cluster" command now shows the absolute `http://host:port/api/...` URL and the
   copy button works — i.e. the served `remoteEntry.js` is the rebuilt one. Because the frontend
   fix's plugin commit also moved `APP_IMAGE_VERSION`, the backend image is rebuilt and the fresh
   image now editable-installs-and-rebuilds the bundle inside itself.
5. **No stale-dist reliance.** Grep confirms nothing outside the plugins' own `setup.py` builds
   `frontend_dist/`, and that a from-scratch image build (no pre-existing `frontend_dist/` in the
   context) still yields a populated bundle.

## Out of scope

- The immediate operational unblock (manually rebuilding the two stale `frontend_dist/` dirs for the
  current deploy) — a separate one-off action, not part of this pipeline fix.
- Content-addressed tagging (`yf-resolve-app-image-tag`) — already correct; unchanged.
- Any change to how the host loads remotes or to `frontend_dist` content-addressing in
  `backend/plugin_assets.py`.

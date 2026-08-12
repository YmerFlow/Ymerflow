# YmerFlow Plugin SDK (external repo)

The plugin SDK is **not** part of this repository. It lives in its own git repo and is consumed by
this project (and by third-party plugin authors) as a published dependency.

- **Repo:** `git@github.com:YmerFlow/Ymerflow-plugin-sdk.git`
  (https: `https://github.com/YmerFlow/Ymerflow-plugin-sdk`)
- **License:** MIT

> Nothing in this repository depends on a local checkout of the SDK. All consumers resolve it by git
> URL (Python) or npm (JS). If you keep a working copy under `deps/` for local development, that
> directory is gitignored and is **not** referenced by any build, test, or dependency here.

## Two halves, one repo

| Half | In the SDK repo | Distributed as | What it does |
|------|-----------------|----------------|--------------|
| Build harness | `ymerflow_plugin_build/` (repo root) + `setup.py` | pip, via git URL | Resolves an npm `name@version` (server-local dir and/or the public registry) and runs the real `npm`/`vite` Module-Federation build, with `shared` pinned to the host's singleton versions. |
| Authoring SDK | `js/` + `package.json` | npm: `ymerflow-plugin-sdk` | The `registerHook` / `hooks` / `useHook` shim (`index.js`) and the Vite federation preset (`ymerflow-plugin-sdk/vite-preset`, exporting `ymerflowFederation`). |

The two halves emit the **same** Module-Federation `shared` block. The SDK repo's own
`tests/test_vite_preset_consistency.py` asserts they never drift apart — that guard lives in the SDK
repo because it needs both source trees on disk.

## How this repo consumes it

**Python (build harness).** Declared as a git-URL dependency in the relevant `setup.py` files:

```python
install_requires=[
    "ymerflow-plugin-build @ git+https://github.com/YmerFlow/Ymerflow-plugin-sdk.git",
]
```

Consumers:
- root `setup.py` (so the backend env can `import ymerflow_plugin_build`; used by
  `backend/services/job_orchestrator.py` to read `HOST_SHARED_VERSIONS`).
- `tests/plugins/test-backend-plugin/setup.py` (its `build_py` calls `build_frontend` at install time).
- `docker/base-runner/Dockerfile` — `pip install "git+https://…/Ymerflow-plugin-sdk.git"`. The repo
  is public, so https needs no build credentials; for a private repo use a BuildKit ssh mount or a
  token. The `build_frontend_plugin` process type then imports and calls
  `ymerflow_plugin_build.build_frontend()` in-pod (the CLI/`python -m` form is only used for the
  Dockerfile's build-time warmup smoke-test).

**JavaScript (plugin authors).** A plugin's `package.json`:

```jsonc
"devDependencies": { "ymerflow-plugin-sdk": "^1.0.0" }
```

```js
import { registerHook } from 'ymerflow-plugin-sdk'
registerHook('widgets', () => [{ name: 'MyWidget', component: MyWidget }])
```

See the [Plugin Author Guide](../../deps/Ymerflow-plugin-sdk/docs/README.md) (in the
`ymerflow-plugin-sdk` repo) for the full authoring walkthrough and the complete frontend/backend
hook reference.

## Host-contract names (intentionally NOT renamed)

The YmerFlow→YmerFlow rename covered the SDK's **package** surface only. The runtime bridge and
build markers shared between host, plugins, and the build pipeline keep their original spelling, on
purpose — renaming them would break the running cluster and already-built plugins:

- `window.__nagelfluh_registerHook`, `window.__nagelfluh_hooks` — host ↔ plugin window bridge
  (set in `frontend/src/plugins/hooks.jsx`).
- `nagelfluh.remoteName` — the `package.json` key a plugin uses to declare its MF remote name
  (read by the build harness).
- `NAGELFLUH_SHARED_VERSIONS` — env var read as a fallback by the SDK's own Vite preset
  (`js/vite-preset.js`) when a plugin is built directly with `vite build` outside the Nagelfluh
  pipeline. Nagelfluh's own build path doesn't use it: `backend/services/job_orchestrator.py` sets
  a differently-named `PLUGIN_SHARED_VERSIONS` env var on the build job, and
  `build_frontend_plugin.py` reads that and passes it straight into
  `ymerflow_plugin_build.build_frontend()` as the `shared_versions=` keyword argument — an in-process
  Python call, not another env var the JS side reads.
- `PLUGIN_NPM_SOURCE_DIR` / `/var/lib/nagelfluh/plugin-npm-source` — server-local npm source path.

## Releasing / pinning

The git-URL dependencies currently track the default branch. Once the SDK starts cutting tags,
pin them (`…YmerFlow-plugin-sdk.git@v0.2.0`) in the `setup.py`s and the Dockerfile, and publish the
npm half with `npm publish` from `js/`.

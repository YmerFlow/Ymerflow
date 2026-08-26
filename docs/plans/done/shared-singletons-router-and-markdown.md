# Add `react-router-dom` and `markdown-to-jsx` to the Module-Federation shared singletons

## Goal & scope

Add two host dependencies — **`react-router-dom`** and **`markdown-to-jsx`** — to the set of
Module-Federation (MF) **shared singletons** so that federated frontend plugins can `import` them
and get the *host's* instance instead of bundling their own private copy.

Today only three packages are shared: `react`, `react-dom`, and `@tanstack/react-query`
(`frontend/vite.config.js`). Everything else a plugin imports is bundled into the plugin's own
remote. For `markdown-to-jsx` that "works" but ships a duplicate copy; for `react-router-dom` it
is **broken by construction** — see below.

This is a **host + SDK change only**. No plugin ships in this change. It unblocks the
`plugins/ymerflow-cms` plugin (`plugins/ymerflow-cms/docs/plans/ymerflow-cms-plugin.md`), whose
`CmsPageView` must read the current route and whose `CmsMenuRegistrar` must navigate on menu
clicks — both of which require `react-router-dom` hooks that resolve against the host's live
`<BrowserRouter>`.

## Why `react-router-dom` *must* be shared (not just "nice to dedupe")

`react-router-dom`'s hooks (`useNavigate`, `useLocation`, `useParams`, `<Routes>`, `<Link>`, …)
communicate through React **context objects created inside the `react-router` module** (e.g.
`NavigationContext`, `LocationContext`). Context identity is per *module instance*, not per React
instance.

The host mounts a single `<BrowserRouter>` at the app root (`frontend/src/index.jsx:15`) and renders
plugin-contributed route elements inside its own `<Routes>` (`frontend/src/App.jsx:220`,
`frontend/src/App.jsx:354`, incl. the `logged_out_routes` splat at `App.jsx:354-359`). A plugin
element rendered there runs inside the host's Router provider tree.

But if the plugin bundles its *own* copy of `react-router-dom`, that copy's `LocationContext` /
`NavigationContext` are **different objects** than the host's. The plugin's `useLocation()` /
`useNavigate()` read *their* context, find no matching provider above them (the host provided the
*other* module's context), and throw *"useX() may be used only in the context of a `<Router>`
component."* React being a shared singleton does **not** fix this — the mismatch is in the
`react-router` module identity, not React's.

Making `react-router-dom` a shared singleton means host and every plugin resolve to **one**
`react-router` module → **one** set of context objects → plugin hooks see the host's Router. This
is the exact same reason `react`/`react-dom` are already singletons, and mirrors the existing
`window.__ymerflow_MenuContext` / `window.__ymerflow_AuthContext` bridges (which share *context
objects* across the boundary for the same reason).

`markdown-to-jsx` has **no** such hard requirement — it is a pure, context-free renderer, so a
plugin *could* bundle its own copy and it would work. It is included here only to (a) avoid shipping
a duplicate copy in every content-rendering plugin and (b) pin plugins to the exact renderer version
the host already vets (used by `LandingPage.jsx` for TOS and `hosted_version_text`). If the user
prefers to keep the shared set minimal, `markdown-to-jsx` can be dropped from this change with no
functional loss to the CMS plugin — only `react-router-dom` is load-bearing.

## Background: the two-halves single-source-of-truth

The MF `shared` block is defined in **two** code trees that must stay byte-for-byte in agreement,
guarded by a lock-step test:

1. **Host app** — `frontend/vite.config.js`, the `shared: { … }` block (`vite.config.js:19-23`).
   This is what the *host* bundle federates.
2. **SDK / plugin build harness** (`deps/Ymerflow-plugin-sdk/`), which is what every *plugin* build
   pins against. Two mirrored definitions here:
   - `js/vite-preset.js` → `DEFAULT_SHARED` (`vite-preset.js:21-25`) — the documented Vite preset.
   - `ymerflow_plugin_build/build.py` → `HOST_SHARED_VERSIONS` (`build.py:39-43`) — the Python
     build harness billing/CMS/etc. call from their `setup.py` via `build_frontend(...)`
     (`build.py:331`: `shared_versions = dict(shared_versions or HOST_SHARED_VERSIONS)`).
   - `tests/test_vite_preset_consistency.py` asserts `DEFAULT_SHARED == HOST_SHARED_VERSIONS` and
     that `sharedConfig(v)` and `_shared_block(v)` render an identical block for a given `v`.

`YMERFLOW_SHARED_VERSIONS` (env var read by the preset, `vite-preset.js:28`) is an *override* seam;
nothing in this repo currently injects it, so `HOST_SHARED_VERSIONS` is the effective source of truth
for plugin builds.

**Every one of the four spots above must be updated together**, or the consistency test fails (or,
worse, the host and plugins silently pin different sets).

## Decisions

1. **Include both `react-router-dom` and `markdown-to-jsx`** (settled with the user 2026-08-26).
   `react-router-dom` is mandatory (context sharing); `markdown-to-jsx` is included as a
   dedupe/version-pinning convenience.
2. **Version pinning values.** The existing entries pin *exact* strings (`react: "18.2.0"`,
   `@tanstack/react-query: "5.90.19"`). Match that style with the currently-installed versions:
   - `react-router-dom`: **`7.18.0`** (installed; `frontend/package.json` declares `^7.12.0`)
   - `markdown-to-jsx`: **`9.8.2`** (installed; declares `^9.8.2`)
   See the drift note below before finalizing exact vs. caret.

## Exact edits

### 1. `frontend/vite.config.js` — host shared block

```js
shared: {
  react:                   { singleton: true, requiredVersion: '^18.2.0' },
  'react-dom':             { singleton: true, requiredVersion: '^18.2.0' },
  '@tanstack/react-query': { singleton: true },
  'react-router-dom':      { singleton: true, requiredVersion: '^7.12.0' },
  'markdown-to-jsx':       { singleton: true, requiredVersion: '^9.8.2' },
},
```

(Keep the caret style already used for `react` here; the harness side uses exact strings — the two
files have *always* differed in this respect and the consistency test does not compare against these
literals, only `DEFAULT_SHARED == HOST_SHARED_VERSIONS`.)

### 2. `deps/Ymerflow-plugin-sdk/js/vite-preset.js` — `DEFAULT_SHARED`

```js
export const DEFAULT_SHARED = {
  react: '18.2.0',
  'react-dom': '18.2.0',
  '@tanstack/react-query': '5.90.19',
  'react-router-dom': '7.18.0',
  'markdown-to-jsx': '9.8.2',
}
```

### 3. `deps/Ymerflow-plugin-sdk/ymerflow_plugin_build/build.py` — `HOST_SHARED_VERSIONS`

```python
HOST_SHARED_VERSIONS = {
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "@tanstack/react-query": "5.90.19",
    "react-router-dom": "7.18.0",
    "markdown-to-jsx": "9.8.2",
}
```

`DEFAULT_SHARED` (step 2) and `HOST_SHARED_VERSIONS` (step 3) **must be identical** — the test
asserts it.

### 4. `deps/Ymerflow-plugin-sdk/tests/test_vite_preset_consistency.py` — test input

The `versions` dict in `main()` is a fixed sample used to compare the preset vs. harness renderers.
Extend it to include the new packages so the render comparison actually exercises them:

```python
versions = {
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "@tanstack/react-query": "5.90.19",
    "react-router-dom": "7.18.0",
    "markdown-to-jsx": "9.8.2",
}
```

(The `DEFAULT_SHARED == HOST_SHARED_VERSIONS` assertion already covers the constants; this keeps the
per-key render assertion meaningful for the new entries too.)

### 5. Docs touch-ups (SDK)

- `deps/Ymerflow-plugin-sdk/docs/authoring.md` — the "Shared deps go in `peerDependencies`" section
  (`authoring.md:21`): note that `react-router-dom` and `markdown-to-jsx` are now host singletons, so
  a plugin using them lists them in **`peerDependencies`** (not `dependencies`), exactly like
  `react`/`@tanstack/react-query`.
- Optionally mention the pair in `docs/frontend-hooks.md` near `menu_registrars` /
  `logged_out_routes` (those hooks' examples call `navigate(...)` / read the URL, which now resolves
  against the host Router via the shared singleton).

## Consumer impact (what plugins do after this lands)

A plugin that wants host-routed navigation or markdown rendering adds to its
`frontend/package.json`:

```jsonc
"peerDependencies": {
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "react-router-dom": "^7.12.0",
  "markdown-to-jsx": "^9.8.2"
}
```

and then imports normally: `import { useNavigate, useLocation } from 'react-router-dom'`,
`import Markdown from 'markdown-to-jsx'`. The harness pins these to the host's versions in the MF
`shared` block; declaring them as peers (not deps) keeps npm from bundling a private copy. No plugin
change is required for plugins that don't use these packages — the extra shared entries are inert for
them.

## Compatibility / risk notes

- **Eager-eval concern does NOT apply to plugins.** `frontend/vite.config.js:14-18` warns that
  `gladly-plot` can't be shared because the *host* subclasses its base classes at module-eval time,
  and MF/vite doesn't make a shared singleton synchronously available during the host's own eager
  eval. That is a *host-eager-consumer* problem. Plugins are loaded via async `import()` **after**
  the shared scope is populated, so a plugin consuming `react-router-dom` resolves it the same way it
  already resolves the `react` singleton at its module top (proven working by `billing`). The host
  itself already eager-imports `react`/`react-dom` as shared singletons without issue;
  `react-router-dom` (eager-imported by `index.jsx`/`App.jsx`) is analogous — no `extends undefined`
  class-eval hazard, because nothing subclasses a `react-router` export at eval.
- **Single Router instance is the whole point.** After this change there is exactly one
  `react-router` module; the host's `<BrowserRouter>` is the one provider, and plugin route elements
  + menu-registrar navigation resolve against it. This is required for the CMS plugin and is
  strictly more correct than today.
- **Version-drift footgun (pre-existing).** `@tanstack/react-query` is *installed* at `5.101.1`
  (`frontend/node_modules`) but pinned to `5.90.19` in both shared configs. Singletons only *warn*
  on `requiredVersion` mismatch (they don't hard-fail), so this has been benign — but it means the
  pinned strings are already allowed to lag the lockfile. Pin the two new packages to the
  **installed** versions (`react-router-dom 7.18.0`, `markdown-to-jsx 9.8.2`) to start aligned.
  Realigning the stale react-query pin is **out of scope** here (call it out, don't fix it in this
  change). Whenever the host bumps any shared package, update all four spots together.
- **react-router v7 surface.** Sharing a whole major version as a singleton means the plugin's
  peer range (`^7.12.0`) must remain satisfiable by the host's version across host upgrades. A host
  jump to react-router v8 would be a breaking change for plugins pinning `^7` — same contract as
  react/react-query, acceptable and expected.

## Verification

1. **Consistency test:** `cd deps/Ymerflow-plugin-sdk && python tests/test_vite_preset_consistency.py`
   → prints `PRESET/HARNESS CONSISTENCY OK` (requires `node` on PATH).
2. **Host build/serve:** host frontend still builds and the app renders (dev server auto-reload; do
   not start servers per repo rules — just confirm no build error surfaces).
3. **Plugin smoke test (once CMS plugin exists):** a plugin importing
   `useNavigate`/`useLocation`/`Markdown` builds via `build_frontend`, loads, and its hooks resolve
   against the host Router without the "may be used only in the context of a `<Router>`" error.
   Concretely: a `logged_out_routes` splat element that calls `useLocation()` renders on the landing
   page, and a `menu_registrars` entry whose action calls `navigate(...)` changes the route without a
   full reload.

## Non-goals

- Not fixing the pre-existing `@tanstack/react-query` `5.90.19` → `5.101.1` pin drift.
- Not adding a `window.__ymerflow_*` router bridge — sharing the singleton is the cleaner mechanism
  and makes plugin routing code look identical to host code.
- Not sharing any additional packages (react-dnd, bootstrap, fontawesome, gladly-plot, etc.).
- No changes to the CMS plugin here; this only unblocks it.
```

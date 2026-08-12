# Plugin System — Complete Plan

## Goal

Make YmerFlow pluggable at runtime: plugins can register new dataset types, layer types, widget
types, quantity kinds, full pages, and frontend hook callbacks without modifying or rebuilding the
main application. Backend plugins can also add API routers, database models, and billing/quota
logic. The first backend plugin is the `billing/` module, extracted from the core backend.

---

## Two Kinds of Plugins

YmerFlow has two plugin delivery mechanisms that converge on **one frontend artifact format** — a
Module Federation remote **built by YmerFlow from an npm source package** against the host's exact
shared-dependency versions. Plugins are distributed as npm **source** packages; YmerFlow **builds**
them (running the real `npm`/`vite` resolver), it never trusts a pre-built blob. They differ only
in *where the build runs*:

| | **Frontend plugin** | **Backend plugin** |
|---|---|---|
| Packaged as | an npm source package | pip-installed Python package |
| Installed by | run a build Process in a project, then register; user enables per-account | admin (`pip install`) — system-wide |
| Can provide | frontend extensions only | backend models, hooks, API routers, **and** a frontend package |
| Frontend **build** | in a `build_frontend_plugin` **Process** (pod), output dataset in the project bucket | **at `pip install` time, from the plugin's `setup.py`** (admin-installed ⇒ trusted) |
| Frontend **serve** | content-addressed from the project-bucket dataset | content-addressed from the package's bundled `frontend_dist/` |

A backend plugin is a **superset** of a frontend plugin: it can register everything a frontend
plugin can — by declaring the same kind of npm frontend source — and additionally contributes Python
hooks, models, and API routers that frontend plugins cannot. Because a backend plugin is
admin-installed and therefore trusted, its `setup.py` builds the frontend source at install time
rather than in a Process. The asymmetry is intentional and one-directional: a frontend plugin is
pure JS and cannot run backend code.

Both kinds register their extensions through the same registries, the same frontend hook system,
and the same SDK, and both serve content-addressed from `/plugin-assets/{content_hash}/…`.

---

## Architecture Summary

- **Build system**: Migrate from CRA (`react-scripts`) to Vite + `@module-federation/vite`
- **Plugin format**: Module Federation remotes, **built by YmerFlow from an npm source package**;
  shared deps declared as `peerDependencies` and pinned **to the host's versions at build time**
- **Shared deps**: React, react-dom, gladly-plot declared as MF singletons — one instance shared
  between host and all plugins; the build injects the host's exact versions into the MF `shared`
  config
- **Registries** (keyed — one value per key): dataset types, layer types, quantity kinds, widgets,
  and pages, replacing hardcoded switch statements and plain objects
- **Frontend hook system** (fan-out — many callbacks per name): mirrors the backend hook runner;
  lets plugins contribute menu items, account tabs, context providers, routes, and per-object
  actions
- **Backend hook runner**: `hooks.run` / `hooks.run_async` — attribute-access Proxy namespaces over
  setuptools `nagelfluh.hooks` entry points; enables billing, model registration, and API router
  injection without backend depending on any plugin
- **Plugin lifecycle (frontend)**: installer picks a project + `npm name@version` → a
  `build_frontend_plugin` Process runs in that project → its output dataset (built `dist/`) lands
  in the project bucket → registered as a `Plugin` → served content-addressed from
  `/plugin-assets/{content_hash}/…` → users enable + pin per-account → frontend loads at startup
  via MF runtime
- **Plugin lifecycle (backend plugin)**: admin `pip install`s the backend plugin → its `setup.py`
  builds the npm frontend source at install time and ships it as package data → at startup the
  backend content-addresses that built dir and lists it in `GET /plugins/me` → loads through the
  identical `/plugin-assets/{content_hash}/…` path (always on, not user-toggled)

---

## Phase 1 — Migrate CRA to Vite

CRA (`react-scripts 5`) must be replaced. It bundles all deps internally and provides no
mechanism to share module instances with dynamically loaded code, which Module Federation requires.

### 1.1 Remove CRA, add Vite

```
npm uninstall react-scripts
npm install --save-dev vite @vitejs/plugin-react @module-federation/vite
```

### 1.2 Create `frontend/vite.config.js`

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'nagelfluh_host',
      remotes: {},          // populated dynamically at runtime, not statically here
      shared: {
        react:              { singleton: true, requiredVersion: '^18.2.0' },
        'react-dom':        { singleton: true, requiredVersion: '^18.2.0' },
        'gladly-plot':      { singleton: true, requiredVersion: '^0.0.15' },
        '@tanstack/react-query': { singleton: true },
      },
    }),
  ],
  build: {
    target: 'esnext',      // required for top-level await used by MF runtime
  },
  server: {
    port: 3000,
  },
})
```

### 1.3 Update `frontend/index.html`

Move `public/index.html` to `frontend/index.html` (Vite root). Replace CRA placeholders:

- `%PUBLIC_URL%/` → `/`
- `%PUBLIC_URL%/favicon.ico` → `/favicon.ico`

Add the app entry point (Vite convention):

```html
<script type="module" src="/src/index.js"></script>
```

### 1.4 Update environment variable references

CRA uses `process.env.REACT_APP_*`; Vite uses `import.meta.env.VITE_*`.

Grep and replace throughout `frontend/src/`:

```
process.env.REACT_APP_API_URL  →  import.meta.env.VITE_API_URL
```

Update `frontend/.env` / `frontend/.env.local` key names accordingly.

### 1.5 Fix CRA-specific import patterns

- **SVG as React component**: CRA's `import { ReactComponent as Foo } from './foo.svg'` does not
  work in Vite. Install `vite-plugin-svgr` and update imports to:
  `import Foo from './foo.svg?react'`
- **CSS Modules**: no change needed; Vite supports `*.module.css` natively.
- **`require()` calls**: convert any remaining CommonJS `require()` to ESM `import`. One known
  case: the lazy `require('./webxtile')` in `dataset.js:1010` → use dynamic `import()`.

### 1.6 Update `frontend/package.json` scripts

```json
"scripts": {
  "start": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "test": "vitest"
}
```

If Jest tests exist, migrate to Vitest (`npm install --save-dev vitest @vitest/ui`). The APIs
are compatible; only the config location changes.

### 1.7 Update Docker / CI build commands

Any `npm run build` invocations continue to work. The output lands in `frontend/dist/` instead
of `frontend/build/` — update the backend's static file serving path accordingly.

---

## Phase 2 — Create Frontend Registries

Replace hardcoded switch statements and plain objects with explicit registries that plugins can
call into.

### 2.1 Dataset Type Registry

**New file: `frontend/src/datamodel/datasetRegistry.js`**

The registry is built at startup from the `dataset_types` hook. Plugins contribute entries via
`registerHook`; the host collects them into a Map.

```js
import { hooks } from '../plugins/hooks'

let registry = null   // built once at startup, before first render

export function buildDatasetRegistry() {
  registry = new Map(
    hooks.run.dataset_types().map(({ mimeType, cls }) => [mimeType, cls])
  )
}

export function createDatasetInstance(metadata) {
  const Cls = registry.get(metadata.mime_type)
  if (!Cls) throw new Error(`Unknown dataset mime type: ${metadata.mime_type}`)
  return new Cls(metadata)
}
```

`buildDatasetRegistry()` is called once in `App.js` after `loadPlugins` resolves (§ 3.2), before
the first render. The built-in dataset types are registered by the core app:

```js
import { registerHook } from './plugins/hooks'
import { JsonDataset, XyzDataset, MagDataset, WebxtileDataset } from './datamodel/dataset'

registerHook('dataset_types', () => [
  { mimeType: 'application/json',                cls: JsonDataset },
  { mimeType: 'application/x-aarhusxyz-msgpack', cls: XyzDataset },
  { mimeType: 'application/x-magdata-msgpack',   cls: MagDataset },
  { mimeType: 'application/x-webxtile',          cls: WebxtileDataset },
])
```

### 2.2 Widget Registry

The widget map is built at startup from the `widgets` hook. No separate registry file is needed —
the map is assembled in `App.js` after plugins load:

```js
import { hooks } from './plugins/hooks'
import { PlotView, FlowView, ProcessEditor, /* ... */ } from './widgets'

// Built-in widgets contributed by the host
registerHook('widgets', () => [
  { name: 'PlotView',      component: PlotView },
  { name: 'FlowView',      component: FlowView },
  { name: 'ProcessEditor', component: ProcessEditor },
  // ... all existing widgets
])

// After loadPlugins() resolves:
const widgets = Object.fromEntries(
  hooks.run.widgets().map(({ name, component }) => [name, component])
)
// passed to LayoutProvider as before
```

### 2.3 Layer Type Registry

`gladly-plot` already provides `registerLayerType`. Rather than re-exporting it, the host
collects `layer_types` hook results at startup and calls `registerLayerType` for each — plugins
never touch gladly-plot directly:

```js
import { registerLayerType } from 'gladly-plot'
import { hooks } from './plugins/hooks'

// called once after loadPlugins() resolves, before first render
export function buildLayerTypeRegistry() {
  hooks.run.layer_types().forEach(({ name, layerClass }) => registerLayerType(name, layerClass))
}
```

Built-in layer types continue to call `registerLayerType` directly (they are not plugins).

### 2.4 Quantity Kind Registry

Same pattern — the host collects `quantity_kinds` hook results and calls
`registerAxisQuantityKind` for each:

```js
import { registerAxisQuantityKind } from 'gladly-plot'
import { hooks } from './plugins/hooks'

export function buildQuantityKindRegistry() {
  hooks.run.quantity_kinds().forEach(({ name, descriptor }) =>
    registerAxisQuantityKind(name, descriptor)
  )
}
```

Built-in quantity kinds in `dataset.js` and `quantityKinds.js` continue to call
`registerAxisQuantityKind` directly.

### 2.5 Page (Route) Registry

The app uses `react-router-dom` v7 with top-level `<Routes>` in `App.js`. Plugins contribute
**full pages** as routes — distinct from **widgets** (2.2), which live inside draggable flexout
panes. Pages are standalone screens: settings, dashboards, admin tools, billing transaction
history, etc.

No separate registry file is needed. `App.js` collects `pages` hook results and spreads them
directly into the router, namespaced under `/app/plugin/`:

```jsx
import { hooks } from './plugins/hooks'

// inside the main <Routes> block:
{hooks.run.pages().map(({ path, component: C, title }) => (
  <Route key={path} path={`/app/plugin/${path}`} element={<C />} />
))}
```

A plugin contributes both `pages` and `nav_items` in a single `registerHook` call each, so the
page is reachable from the menu bar without any extra pairing step.

### 2.6 Frontend Hook Registry

A fan-out callback system that **mirrors the backend hook runner** (Phase 5). The registries above
are *keyed* (one value per key); hooks are *lists* — many callbacks under one name, results
concatenated. This is the right shape for "every plugin contributes some menu items / account tabs
/ context providers".

**Frontend hook callbacks can return JSX/components, not just data.** Three methods, one rule of
thumb — `run_jsx` for anything consumed during render, `run` / `run_async` for data computed off
the render path:

- `hooks.run.name(...)` — sync data fan-out; errors re-raise (never swallowed).
- `await hooks.run_async.name(...)` — async data fan-out; errors re-raise.
- `hooks.run_jsx.name(...)` — sync render fan-out; per-callback errors are isolated (logged and
  skipped) so one broken plugin can't blank the render. Items that are React elements are
  auto-keyed and `HookBoundary`-wrapped; non-element items pass through untouched.

**New file: `frontend/src/plugins/hooks.js`**

```js
import React from 'react'
import { HookBoundary } from './HookBoundary'   // small error-boundary component

const registry = new Map()   // name -> [fn, ...]

export function registerHook(name, fn) {
  if (!registry.has(name)) registry.set(name, [])
  registry.get(name).push(fn)
}

export function getHookFns(name) {
  return registry.get(name) || []
}

// Backend-parity error handling: every callback runs; the first error is
// re-raised with the rest chained as `.cause`. Shared by run + run_async.
function rethrow(errors) {
  if (errors.length) {
    errors.slice(1).forEach(e => { e.cause = errors[0] })
    throw errors[errors.length - 1]
  }
}

function runSync(name, ...args) {
  const out = [], errors = []
  for (const fn of getHookFns(name)) {
    try { out.push(...(fn(...args) || [])) }
    catch (e) { errors.push(e) }
  }
  rethrow(errors)
  return out
}

async function runAsync(name, ...args) {
  const out = [], errors = []
  for (const fn of getHookFns(name)) {
    try { out.push(...((await fn(...args)) || [])) }
    catch (e) { errors.push(e) }
  }
  rethrow(errors)
  return out
}

function runJsx(name, ...args) {
  const out = []
  getHookFns(name).forEach((fn, i) => {
    let items
    try { items = fn(...args) || [] }
    catch (e) { console.error(`hook "${name}" #${i} threw`, e); return }
    items.forEach((item, j) => {
      if (React.isValidElement(item)) {
        const key = item.key ?? `${name}:${i}:${j}`
        out.push(<HookBoundary key={key} name={name}>{item}</HookBoundary>)
      } else {
        out.push(item)   // plain data (descriptors, providers, route specs, …)
      }
    })
  })
  return out
}

const ns = impl => new Proxy({}, { get: (_t, name) => (...args) => impl(name, ...args) })
export const hooks = {
  run:       ns(runSync),
  run_async: ns(runAsync),
  run_jsx:   ns(runJsx),
}
```

| Purpose | Backend (Python) | Frontend (JS) | On error |
|---|---|---|---|
| sync data | `hooks.run.name(...)` | `hooks.run.name(...)` | re-raise |
| async data | `await hooks.run_async.name(...)` | `await hooks.run_async.name(...)` | re-raise |
| render (JSX) | — (no rendering on the server) | `hooks.run_jsx.name(...)` | isolate |

**Optional memoized wrapper — `useHook`** (`frontend/src/plugins/useHook.js`):

```js
import { useMemo } from 'react'
import { hooks } from './hooks'

export function useHook(name, ...args) {
  return useMemo(() => hooks.run_jsx[name](...args), [name, ...args])
}
```

**Built-in hook points** (open-ended — a host component adds a new point simply by calling
`hooks.run_jsx.my_point(ctx)` and dropping the result into JSX):

| Hook | Shape | Call via | Host call site | Each callback returns |
|---|---|---|---|---|
| `dataset_types` | descriptor | `run` | `App.js` startup (builds Map) | `[{ mimeType, cls }]` |
| `widgets` | descriptor | `run` | `App.js` startup (builds Map) | `[{ name, component }]` |
| `layer_types` | descriptor | `run` | `App.js` startup (calls gladly `registerLayerType`) | `[{ name, layerClass }]` |
| `quantity_kinds` | descriptor | `run` | `App.js` startup (calls gladly `registerAxisQuantityKind`) | `[{ name, descriptor }]` |
| `pages` | descriptor | `run` | `App.js` `<Routes>` | `[{ path, component, title }]` |
| `app_providers` | descriptor | `run_jsx` | `App.js`, wrapping `<AuthenticatedApp>` | `[{ Component }]` — context providers nested around the app |
| `app_routes` | descriptor | `run_jsx` | `App.js` `<Routes>` | `[{ path, element }]` — react-router routes |
| `nav_items` | descriptor | `run_jsx` | menu bar (bridges to `MenuContext`) | `[{ menuPath, label, to | onSelect }]` — menu entries |
| `account_tabs` | descriptor | `run_jsx` | `AccountPage.js` | `[{ id, title, content }]` — `content` is JSX |
| `process_actions` | slot | `run_jsx` | process toolbar | `[<button .../>, …]` — JSX rendered inline |
| `plot_overlays` | slot | `run_jsx` | `PlotView` | `[<Overlay .../>, …]` — JSX rendered inline |

> **Note for billing**: the billing transaction-history UI currently lives hardcoded in
> `AccountPage.js`. With this system it moves into an `account_tabs` callback shipped by billing's
> frontend bundle — so when billing is not installed there is no billing tab, matching the
> "no billing → no balance anywhere" guarantee end-to-end.

The existing `MenuContext` (`useRegisterMenu` / `useRegisterMenuComponent`) is React-hook-based
and only usable from mounted host components. Plugins register at module-load time as side effects
and cannot call React hooks, which is precisely why the `nav_items` frontend hook is needed.

---

## Phase 3 — Module Federation Plugin Loading

### 3.1 Dynamic remote loading at startup

**New file: `frontend/src/plugins/loadPlugin.js`**

```js
import { init, loadRemote } from '@module-federation/runtime'

let mfInitialised = false

async function ensureInit(remotes) {
  if (mfInitialised) return
  await init({
    name: 'nagelfluh_host',
    remotes,
    shared: {
      react:         { version: '18.2.0', lib: () => import('react'),    singleton: true },
      'react-dom':   { version: '18.2.0', lib: () => import('react-dom'), singleton: true },
      'gladly-plot': { version: '0.0.15', lib: () => import('gladly-plot'), singleton: true },
    },
  })
  mfInitialised = true
}

export async function loadPlugins(plugins) {
  // plugins: [{ name, base_url, source }] from GET /plugins/me
  // source is "remote" or "backend" — both kinds are loaded identically
  const remotes = plugins.map(p => ({
    name: p.name,
    entry: p.base_url + 'remoteEntry.js',
  }))

  await ensureInit(remotes)

  await Promise.all(
    plugins.map(p => loadRemote(`${p.name}/index`))
    // each plugin's index.js registers extensions as side effects
  )
}
```

### 3.2 Gate rendering on plugin load

In `App.js`, fetch the user's plugin list from `GET /plugins/me` before rendering. That endpoint
returns the **union** of backend-bundled plugins (`source: "backend"`, always present) and the
user's enabled remote plugins (`source: "remote"`). `loadPlugins` treats them identically.

```js
function App() {
  const [pluginsReady, setPluginsReady] = useState(false)
  const { data: enabledPlugins } = useEnabledPlugins()   // GET /plugins/me

  useEffect(() => {
    if (!enabledPlugins) return
    loadPlugins(enabledPlugins).then(() => setPluginsReady(true))
  }, [enabledPlugins])

  if (!pluginsReady) return <LoadingScreen />

  const widgets = getWidgets()
  const providers = hooks.run_jsx.app_providers()

  return providers.reduceRight(
    (children, { Component }) => <Component>{children}</Component>,
    <AuthenticatedApp widgets={widgets} />
  )
}
```

Registered pages (2.5) and `app_routes` hook results are spread into the `<Routes>` block inside
`AuthenticatedApp`; `nav_items` feed the menu bar; `account_tabs` extend `AccountPage`. Gating on
`pluginsReady` ensures every dataset type, layer type, widget, page, and hook callback is
registered before any saved layout is restored or any process output is rendered.

### 3.3 Plugin SDK package

**Package: `ymerflow-plugin-sdk`** — exposes a single registration API. Everything a plugin
registers goes through `registerHook`; the host's collectors translate hook results into whatever
internal structure they need (Maps, gladly-plot calls, router entries):

```js
// index.js
export { registerHook, hooks, useHook } from 'nagelfluh/plugins/hooks'
```

The SDK also ships the **Vite federation preset** the build harness uses (§ 4.5): it reads the
host's shared-singleton versions (injected at build time) and emits the MF `shared` config pinned
to them. This is why a plugin author writes no MF/Vite config. The same SDK is used by every
plugin regardless of whether it is built in a Process or by a backend plugin's `setup.py`.

---

## Phase 4 — Plugin Data Model & API

### 4.1 `Plugin` model

**New file: `backend/models/plugin.py`**

Identity is split from version: a `Plugin` is the stable identity (by MF remote `name`); each
installed/updated build is an immutable, content-addressed `PluginVersion`. The `Plugin` row just
points at the currently-active version.

```python
class Plugin(Base):
    """Stable plugin identity. Code lives in immutable PluginVersion rows (below)."""
    __tablename__ = "plugins"

    id                = Column(UUID, primary_key=True, default=uuid4)
    name              = Column(String(255), unique=True, nullable=False)   # MF remote name
    display_name      = Column(String(255), nullable=False)
    description       = Column(Text, nullable=True)
    latest_version_id = Column(UUID, ForeignKey("plugin_versions.id", use_alter=True),
                               nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)
    created_by        = Column(Integer, ForeignKey("users.id"), nullable=True)

    latest_version = relationship("PluginVersion", foreign_keys=[latest_version_id],
                                  post_update=True)
    versions       = relationship("PluginVersion", back_populates="plugin",
                                  foreign_keys="PluginVersion.plugin_id",
                                  cascade="all, delete-orphan")
    user_plugins   = relationship("UserPlugin", back_populates="plugin",
                                  cascade="all, delete-orphan")


class PluginVersion(Base):
    """One built version of a plugin: a thin reference to a build Process's output dataset."""
    __tablename__ = "plugin_versions"

    id                = Column(UUID, primary_key=True, default=uuid4)
    plugin_id         = Column(UUID, ForeignKey("plugins.id", ondelete="CASCADE"), nullable=False)
    project_id        = Column(UUID, ForeignKey("projects.id"), nullable=False)
    process_id        = Column(String(255), nullable=False)   # the build Process
    process_version   = Column(Integer, nullable=False)
    output_dataset_id = Column(String(255), nullable=False)   # built dist/ directory dataset
    npm_name          = Column(String(255), nullable=False)
    npm_version       = Column(String(64),  nullable=False)
    content_hash      = Column(String(64), nullable=False, index=True)  # hash of output dataset
    built_against     = Column(JSON, nullable=False, default=dict)  # host shared versions used
    created_at        = Column(DateTime, default=datetime.utcnow)

    plugin = relationship("Plugin", back_populates="versions", foreign_keys=[plugin_id])

    __table_args__ = (UniqueConstraint("plugin_id", "content_hash"),)
```

`content_hash` (sha256 over the output dataset's `path → sha256` manifest) is what the system keys
the asset URL and per-user pinning on. There is **no peer-dep hard-block**: compatibility is
*constructed* at build time by pinning `shared` to the host's versions, so an incompatible plugin
**fails the build** (with logs) rather than being rejected at an API gate. `built_against` records
the host versions, so a later host upgrade can flag versions that warrant a rebuild.

`latest_version_id` is the newest version, not "the version everyone runs". Each user is pinned to
the specific version that was latest when they enabled the plugin and stays there until they
explicitly upgrade. Installing a new version never changes what already-enabled users load.

`PluginVersion` is a **thin pointer** to a completed build: `content_hash` is immutable once
computed. `UniqueConstraint(plugin_id, content_hash)` makes re-registering an identical build a
no-op. Versions are never garbage-collected while a user pins them.

### 4.2 `UserPlugin` model

```python
class UserPlugin(Base):
    __tablename__ = "user_plugins"

    id                = Column(UUID, primary_key=True, default=uuid4)
    user_id           = Column(Integer, ForeignKey("users.id"), nullable=False)
    plugin_id         = Column(UUID, ForeignKey("plugins.id"), nullable=False)
    plugin_version_id = Column(UUID, ForeignKey("plugin_versions.id"), nullable=False)  # PINNED
    enabled           = Column(Boolean, default=True, nullable=False)
    installed_at      = Column(DateTime, default=datetime.utcnow)

    user           = relationship("User",          back_populates="plugins")
    plugin         = relationship("Plugin",        back_populates="user_plugins")
    plugin_version = relationship("PluginVersion")

    __table_args__ = (UniqueConstraint("user_id", "plugin_id"),)
```

On enable, `plugin_version_id` is set to the plugin's `latest_version_id` at that moment; the user
then loads exactly that version until they upgrade (which re-pins to current latest). Add the
reverse relationship to `User`:

```python
plugins = relationship("UserPlugin", back_populates="user", cascade="all, delete-orphan")
```

### 4.3 Alembic migration

```
alembic -c backend/alembic.ini revision -m "add plugin, plugin_version, user_plugin tables"
```

`plugins.latest_version_id` and `plugin_versions.plugin_id` form a circular FK, so the migration
creates the tables first and adds `plugins.latest_version_id`'s FK with `use_alter=True`. No
changes to existing tables except the ORM-only `plugins` relationship on `User`.

**Admin gating prerequisite**: the `User` model currently has no `is_admin` field. Registering a
system plugin requires adding a simple `is_admin` boolean to `User` — a small migration, called out
here because it is a hard dependency for the system-scope register/delete endpoints.

### 4.4 API endpoints

**New file: `backend/routers/plugins.py`**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/plugins` | any user | List all installed plugins (with latest version) |
| `POST` | `/plugins/build` | project member | Start a `build_frontend_plugin` Process in a project |
| `POST` | `/plugins` | admin / project member | Register a completed build's output dataset as a plugin |
| `DELETE` | `/plugins/{id}` | admin / owner | Unregister a plugin (build dataset left in project) |
| `GET` | `/plugins/me` | current user | List plugins with user's enabled state + pinned version |
| `GET` | `/plugin-assets/{hash}/{path:path}` | per visibility | Stream a content-addressed plugin file |
| `POST` | `/plugins/{id}/enable` | current user | Enable for self; pin to current latest version |
| `POST` | `/plugins/{id}/upgrade` | current user | Re-pin self to the current latest version |
| `POST` | `/plugins/{id}/disable` | current user | Disable plugin for self |

#### Build — a `build_frontend_plugin` Process (§ 4.5)

`POST /plugins/build` creates a `build_frontend_plugin` Process in a project the caller has
access to, parameterised by `{ npm_name, npm_version }`. It runs in a pod exactly like an
inversion — `npm install` + MF build with `shared` pinned to the host's versions — and writes one
output dataset: the built `dist/` directory in the project bucket. A build that can't satisfy the
host's shared versions simply **fails with logs**; there is no separate API-level dep gate.

#### Register / update — point a `Plugin` at a build output (`POST /plugins`)

`POST /plugins { process_id, process_version, scope: "system" | "user" }` registers a completed
build as a plugin. The backend:

1. validates the referenced output dataset is a built MF remote and reads its embedded
   `package.json` for `nagelfluh.remoteName` and `built_against`;
2. computes `content_hash` over the output dataset's `path → sha256` manifest;
3. upserts a `PluginVersion` and moves `plugin.latest_version_id` to it. A brand-new plugin also
   creates the `Plugin` identity row.

Updating is the same call pointing at a newer build version: a new `PluginVersion` is added and
`latest_version_id` advances. Rollback is re-pinning to an earlier `PluginVersion`.

#### Serve — stream from the build's output dataset (`GET /plugin-assets/{hash}/{path:path}`)

Resolves `{hash}` → the `PluginVersion` → its output dataset, and streams
`{dataset_dir}/{path}` from the project bucket via fsspec, with
`Cache-Control: public, max-age=31536000, immutable`.

**Authorization is by plugin visibility, not project membership**: a `system` plugin streams to any
authenticated user; a `user` plugin only to its owner. This deliberately crosses the project
boundary — a system plugin built in one project is readable by everyone.

MF chunk URLs resolve **relative** to `remoteEntry.js`, so this single hash-prefixed route serves
the whole bundle. Per-file presigned URLs are avoided — a signed query string breaks MF's relative
chunk resolution.

This is the **same route backend-plugin frontends use** (Phase 5). Those are built by the plugin's
`setup.py` at install and served from the package's `frontend_dist/`, but resolve through the
identical `/plugin-assets/{hash}/…` path, so the frontend loads both kinds indistinguishably.

#### `GET /plugins/me` — union of sources

Returns the **union** of two sources, each entry carrying `{ name, display_name, base_url,
source, upgrade_available }`:

| `source` | Origin | Toggle |
|---|---|---|
| `"backend"` | `app.state.backend_frontend_plugins` (Phase 5) | always enabled — present iff backend plugin is installed |
| `"remote"` | DB `UserPlugin` rows with `enabled=true` | per-user enable/disable |

`base_url` is the directory URL for the plugin's built assets (e.g. `/plugin-assets/{content_hash}/`).
The frontend appends filenames to it — `remoteEntry.js` for MF loading, or any other asset
(`styles.css`, `myLogo.jpg`, etc.) as needed. The frontend is agnostic about the serving
mechanism; the backend computes the correct `base_url` regardless of where assets are stored.

For remote plugins, `base_url` reflects the **user's pinned** version; `upgrade_available` is
`true` when the pin differs from the plugin's `latest_version_id`. Backend bundles always serve
their current installed version and set `upgrade_available: false`.

#### Delete — uninstall identity, retain versions (`DELETE /plugins/{id}`)

Removes the `Plugin` identity and its `PluginVersion` + `UserPlugin` rows. Does **not** touch the
build Process or its output datasets — those are normal project artefacts that stay in their
project. There is no blob GC: bytes are dataset-owned and live/die with their project.

### 4.5 The `build_frontend_plugin` Process type

A new process type registered in `nagelfluh.process_types`, run in a pod like any other:

- **Parameters**: `{ npm_name, npm_version }`. The host's shared-singleton versions are injected by
  the runner (env/mounted manifest) — the plugin does not get to choose them.
- **Run**: `npm install <npm_name>@<npm_version>` in the pod, then build it as a Module Federation
  remote whose `shared` block is pinned to the injected host versions. Non-shared dependencies are
  bundled normally.
- **Output dataset**: `dist` — the built `remoteEntry.js` + chunks, written as a directory dataset
  (mime: `application/x-mf-remote`) to the project bucket via `storage_context`. The built
  `package.json` (carrying `nagelfluh.remoteName` and `built_against`) is included so registration
  can read it back.
- **Failure**: an unsatisfiable host-version constraint, a broken source package, or a failing build
  script surfaces as a normal **process failure with logs**.

Because it is an ordinary Process: project **membership** controls who can build, the **billing
hooks** (`job_pre_run`/`job_completed`) charge the build like any job, and the **pod hardening**
is the same profile as inversions — registry-only egress (`PLUGIN_NPM_REGISTRY`), no secrets,
time/resource caps.

> **Why build-in-a-Process, not fetch-a-blob.** Running `npm install` is safe inside a Process —
> the same sandbox (resource-limited pod, no DB/secrets, registry-only egress) we already run
> untrusted inversions in — so the backend never executes plugin build scripts itself. Building from
> source against the host's exact singletons makes **compatibility constructed, not checked**, runs
> the real dependency resolver (any non-shared dep is just bundled), and yields provenance by
> construction. It reuses the entire Process stack — state, logs, billing hooks, project permissions
> — for free.

---

## Phase 5 — Backend Hook System & Billing

### 5.1 Hook runner — `backend/hooks.py`

Two calling styles share the same entry-point discovery:

```python
hooks.run.hook_name(*args, **kwargs)              # sync  — returns list
await hooks.run_async.hook_name(*args, **kwargs)  # async — returns list
```

Both use the attribute-access Proxy namespace — the hook name is an attribute, not a string
argument — and differ only in sync vs async. Hooks are discovered from the `nagelfluh.hooks`
setuptools entry-point group.

- `hooks.run` returns a **sync** callable; used in the common case and for early-init where no
  event loop is available (e.g. `register_models`).
- `hooks.run_async` returns an **async** callable; `asyncio.iscoroutine` detection awaits async
  hook functions automatically.
- If no entry points match the name, both return `[]` immediately.
- Return values from each hook must be `list`; they are concatenated into one list.

**Exception handling — all hooks always run:**

```python
# pseudocode
errors = []
for hook_fn in matched_hooks:
    try:
        results.extend(await hook_fn(...))
    except Exception as e:
        errors.append(e)
if errors:
    for later in errors[1:]:
        later.__context__ = errors[0]
    raise errors[-1]
```

```
nagelfluh.hooks
  └─ <name>   one entry point per (package, hook-name) pair
```

Multiple packages can register different functions under the same `name`; all are called and their
results merged.

### 5.2 `UserError` — `backend/exceptions.py`

```python
class UserError(Exception):
    """A failure caused by the end user. The message is shown directly in the UI
    and is not treated as a software fault."""
    pass
```

FastAPI registers a global exception handler that converts `UserError` to a 400 response, while
unhandled exceptions become 500s. This applies everywhere — routes, services, and hook
implementations alike. Plugin modules subclass it for domain errors:

```python
# billing/__init__.py
from backend.exceptions import UserError

class InsufficientFundsError(UserError):
    pass
```

The backend never imports plugin-specific subclasses — hook call sites catch `UserError` for clean
user-facing failures and `Exception` for unexpected faults.

### 5.3 Billing module — `billing/`

A new top-level Python package at the project root. It depends on `backend` (imports
`backend.database.Base`, `backend.config.settings`) but the reverse is not true — the backend
never imports from `billing` directly.

```
billing/
  __init__.py      — hook functions (registered as entry points)
  models.py        — UserBalance, UserTransaction, TransactionType
  config.py        — BillingSettings (process_cost, initial_user_balance)
```

#### `billing/models.py`

```python
from backend.database import Base
from backend.models.user import User

class TransactionType(str, enum.Enum):
    credit  = "credit"
    debit   = "debit"
    hold    = "hold"
    release = "release"

class UserBalance(Base):
    __tablename__ = "user_balances"
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    balance = Column(Numeric(10, 2), default=0, nullable=False)
    user    = relationship("User", back_populates="billing_balance")

class UserTransaction(Base):
    __tablename__ = "user_transactions"
    id              = Column(Integer, primary_key=True, autoincrement=True)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    timestamp       = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    type            = Column(Enum(TransactionType), nullable=False)
    description     = Column(String(500), nullable=False)
    amount          = Column(Numeric(10, 2), nullable=False)
    process_id      = Column(String(255), ForeignKey("processes.id", ondelete="SET NULL"),
                             nullable=True)
    process_version = Column(Integer, nullable=True)
    process_name    = Column(String(255), nullable=True)
    user            = relationship("User", back_populates="billing_transactions")

# Patch back-references onto User — runs at import time, before configure_mappers()
User.billing_balance      = relationship("UserBalance",     uselist=False,
                                         cascade="all, delete-orphan")
User.billing_transactions = relationship("UserTransaction", cascade="all, delete-orphan")
```

`UserBalance` is 1-to-1 with `User` (primary key is the FK itself). `UserTransaction` is the
existing table moved verbatim from `backend/models/user.py`. SQLAlchemy supports adding
`relationship()` properties after the class body, as long as it happens before `configure_mappers()`
is called (the first DB operation).

#### `billing/config.py`

```python
from pydantic_settings import BaseSettings

class BillingSettings(BaseSettings):
    process_cost: float = 0.10
    initial_user_balance: float = 100.0
    class Config:
        env_file = "config.env"
        env_prefix = "BILLING_"

billing_settings = BillingSettings()
```

`backend/config.py` loses `process_cost` and `initial_user_balance` entirely.

### 5.4 Changes to `backend/models/user.py`

Remove entirely:
- `balance` column
- `transactions` relationship
- `TransactionType` enum
- `UserTransaction` model
- `get_held_amount()` method
- `get_available_balance()` method

Back-references are added dynamically by `billing/models.py` at import time. `User` is left
completely unaware of billing.

Remove `UserTransaction` and `TransactionType` from `backend/models/__init__.py`.

`User.to_dict()` — remove `balance` and `transactions`, then call the `user_to_dict` hook and
deep-merge all returned dicts:

```python
def to_dict(self):
    result = { "username": self.username, "email": self.email, "preferences": self.preferences }
    for extra in hooks.run.user_to_dict(self):
        result.update(extra)
    return result
```

Any query that calls `to_dict()` must also apply options from the `user_query_options` hook so that
billing relationships are eagerly loaded before `to_dict()` is called:

```python
extra_opts = hooks.run.user_query_options()
stmt = select(User).options(selectinload(User.something), *extra_opts).where(...)
```

### 5.5 Changes to `backend/models/process.py`

Remove from `ProcessVersion`:
- `max_reserved_cost` column
- `actual_cost` column
- `_calculate_max_cost()` method
- `_calculate_actual_cost()` method

These are billing concepts with no meaning in the core backend. Billing tracks costs internally in
`UserTransaction` amounts.

`Process.create_queued()` — remove the `version_obj.max_reserved_cost = ...` line.

`ProcessVersion.run_task()` — replace the balance-check + HOLD block (~30 lines) with:

```python
try:
    await hooks.run_async.job_pre_run(db, user, process, process_version)
except UserError as e:
    await process_version.add_log_entry(db, f"ERROR: {e}")
    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
    return
except Exception as e:
    logger.error(f"Unexpected error in job_pre_run hook: {e}", exc_info=True)
    await process_version.add_log_entry(db, f"Internal error: {e}")
    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
    return
```

`ProcessVersion._handle_job_completion()` — replace the actual-cost calculation + transaction
block with:

```python
await hooks.run_async.job_completed(db, process, process_version, runtime_seconds, status)
await db.commit()
```

### 5.6 Changes to `backend/routers/auth.py`

```python
# Before:
user = User(..., balance=Decimal(str(settings.initial_user_balance)), ...)
db.add(user)
await db.flush()
db.add(UserTransaction(type=TransactionType.credit, description="Welcome bonus", ...))
await db.commit()

# After:
user = User(...)
db.add(user)
await db.flush()
await hooks.run_async.user_created(db, user)
await db.commit()
```

### 5.7 Alembic / migration strategy

`register_models` is a **sync** hook called in two places:

**1. `backend/models/__init__.py` — application startup**

```python
from backend.hooks import hooks
hooks.run.register_models()
```

This runs before any SQLAlchemy session is opened, so back-references are present before
`configure_mappers()` is triggered.

**2. `backend/alembic/env.py` — migration generation**

```python
from backend.hooks import hooks
hooks.run.register_models()
target_metadata = Base.metadata
```

When billing is not installed, `Base.metadata` contains only core tables and autogenerate produces
no billing migrations. When billing is installed, the two billing tables appear in metadata and a
single `alembic revision` creates the migration.

### 5.8 Backend plugin API routers

**Sync hook** called once from `backend/main.py` after the core routers are included:

```python
# billing/__init__.py
def register_routers(app):
    from billing.router import router   # APIRouter(prefix="/billing", tags=["billing"])
    app.include_router(router)
    return []
```

`backend/main.py`:

```python
from backend.hooks import hooks
hooks.run.register_routers(app)
```

Routers may use the same `UserError` → 400 handling and the same auth dependencies as core routes.

### 5.9 Backend plugin frontend bundles

A backend plugin **triggers its own frontend build from `setup.py`**, so the build runs at
`pip install` time. A custom setuptools command fetches the declared npm source, builds it as a
Module Federation remote with `shared` pinned to the host's versions (via the SDK's federation
preset), and writes the output into the package's `frontend_dist/`, shipped as `package_data`:

```python
# setup.py
from setuptools import setup
from setuptools.command.build_py import build_py
from nagelfluh.plugin_build import build_frontend

class BuildWithFrontend(build_py):
    def run(self):
        build_frontend(npm_name='@nagelfluh/billing-frontend', npm_version='2.3.1',
                       out_dir='billing/frontend_dist')
        super().run()

setup(
    name='nagelfluh-billing', version='2.3.1',
    cmdclass={'build_py': BuildWithFrontend},
    package_data={'billing': ['frontend_dist/**']},
    entry_points={'nagelfluh.hooks': [ ... ]},
)
```

The running app server **never runs npm** — the built output ships in the package.

**`frontend_bundles()` hook** — points at the already-built frontend:

```python
# billing/__init__.py
import importlib.resources

def frontend_bundles():
    dist = importlib.resources.files('billing') / 'frontend_dist'
    return [{
        'display_name': 'Billing',
        'dist_dir':     str(dist),
        'entry':        'remoteEntry.js',
    }]
```

**`backend/plugin_assets.py`** — called from `main.py` at startup (after `register_routers`):

```python
from backend.hooks import hooks
from backend.plugins import content_address_dir

def mount_plugin_assets(app):
    descriptors = []
    for b in hooks.run.frontend_bundles():
        ch, remote_name = content_address_dir(b['dist_dir'])
        descriptors.append({
            'name':         remote_name,
            'display_name': b['display_name'],
            'base_url':     f"/plugin-assets/{ch}/",
            'source':       'backend',
        })
    app.state.backend_frontend_plugins = descriptors
```

`app.state.backend_frontend_plugins` is consumed by `GET /plugins/me` (§ 4.4).

### 5.10 Complete hook inventory

| Hook | Style | Caller | Purpose |
|------|-------|--------|---------|
| `register_models` | sync | `backend/models/__init__.py`, `alembic/env.py` | Import billing models; patch `User` back-refs |
| `register_routers` | sync | `backend/main.py` | Plugin adds its FastAPI routers |
| `frontend_bundles` | sync | `backend/plugin_assets.py` (startup) | Declare MF frontend bundles shipped as package data |
| `user_query_options` | sync | any `select(User)` that calls `to_dict()` | Return extra `selectinload` options for billing relations |
| `user_to_dict` | sync | `User.to_dict()` | Return extra fields (balance, transactions) to merge |
| `job_pre_run` | async | `ProcessVersion.run_task()` | Balance check + HOLD transaction; abort on error |
| `job_completed` | async | `_handle_job_completion()` | RELEASE + DEBIT transactions; no commit |
| `user_created` | async | `auth.py` signup | Create `UserBalance` + CREDIT transaction; no commit |

### 5.11 Billing behaviour summary

| Concern | Without billing | With billing |
|---------|-----------------|--------------|
| User balance | not stored | `user_balances` table |
| Submission fee | not checked | checked from `UserBalance` |
| Cost tracking | no cost fields anywhere | HOLD/RELEASE/DEBIT transactions |
| Transaction log | empty | full history in `user_transactions` |
| Signup | user created, no balance record | `UserBalance` created, CREDIT logged |
| Who can run | anyone, unlimited | users with sufficient balance |

### 5.12 `setup.py` at project root

```python
from setuptools import setup, find_packages

setup(
    name='nagelfluh',
    version='0.1.0',
    packages=['billing'],
    entry_points={
        'nagelfluh.hooks': [
            'register_models    = billing:register_models',
            'register_routers   = billing:register_routers',
            'frontend_bundles   = billing:frontend_bundles',
            'user_query_options = billing:user_query_options',
            'user_to_dict       = billing:user_to_dict',
            'job_pre_run        = billing:job_pre_run',
            'job_completed      = billing:job_completed',
            'user_created       = billing:user_created',
        ],
    },
)
```

Activation:

```bash
pip install -e .
alembic -c backend/alembic.ini revision --autogenerate -m "add billing tables"
alembic -c backend/alembic.ini upgrade head
```

To deactivate billing, remove the entry points from `setup.py` and reinstall. No code changes to
the backend are needed.

---

## Phase 6 — Plugin Management UI

### 6.1 Plugin list widget

**New file: `frontend/src/widgets/PluginManager.js`**

A new widget (registered in `App.js`) that shows a table of all available plugins with a toggle
per row (enabled/disabled for the current user), plus the user's pinned version and an **Upgrade**
action when `upgrade_available` is true. On toggle/upgrade, calls the relevant endpoint and shows
a "reload required" banner (since plugins are loaded once at startup).

The widget is accessible from a settings tab or menu — it does not need to be in the default
initial layout.

### 6.2 TanStack Query hooks

Add to `frontend/src/datamodel/useQueries.js`:

```js
export function usePlugins() {
  return useQuery({ queryKey: ['plugins'], queryFn: () => api.get('/plugins/me') })
}

export function useEnablePlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: id => api.post(`/plugins/${id}/enable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
}

export function useDisablePlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: id => api.post(`/plugins/${id}/disable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
}

export function useUpgradePlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: id => api.post(`/plugins/${id}/upgrade`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
}
```

---

## Phase 7 — Plugin Author Guide

### File structure for a plugin

A plugin is a plain **source** npm package — no MF/Vite config, no pre-built `dist/`. YmerFlow's
build harness federates it (§ 4.5), so the author only writes their extension code and a manifest:

```
my-nagelfluh-plugin/
  package.json        ← npm manifest: peerDependencies + nagelfluh.remoteName/entry
  src/
    index.js          ← entry point; registers everything as side effects
    MyDataset.js
    MyLayerType.js
    MyWidget.js
```

### `package.json` for a plugin

Shared deps go in `peerDependencies` (the host provides them as MF singletons — the build pins
them to the host's exact versions); any other dependency is a normal `dependency` and gets bundled.
The `nagelfluh` block names the MF remote and points at the **source** entry module.

```jsonc
{
  "name": "@skytem/nagelfluh-plugin",
  "version": "1.2.3",
  "peerDependencies": {
    "react": "^18.2.0", "react-dom": "^18.2.0", "gladly-plot": "^0.0.15"
  },
  "dependencies": { "some-lib": "^2.0.0" },
  "devDependencies": { "ymerflow-plugin-sdk": "^1.0.0" },
  "nagelfluh": {
    "remoteName": "skytem_plugin",   // MF remote name == Plugin.name
    "entry": "src/index.js"          // source entry the build harness exposes
  }
}
```

Publish with `npm publish` (ideally from CI with provenance). The author never runs an MF build,
hosts a bundle, or worries about CORS — they publish source; the `build_frontend_plugin` Process
produces and pins the served artefact.

### `src/index.js` for a plugin

```js
import { registerHook } from 'ymerflow-plugin-sdk'

import { MyDataset }   from './MyDataset'
import { MyLayerType } from './MyLayerType'
import { MyWidget }    from './MyWidget'
import { MyPage }      from './MyPage'

registerHook('dataset_types',  () => [{ mimeType: 'application/x-my-format', cls: MyDataset }])
registerHook('layer_types',    () => [{ name: 'MyLayerType', layerClass: MyLayerType }])
registerHook('widgets',        () => [{ name: 'MyWidget', component: MyWidget }])
registerHook('quantity_kinds', () => [{ name: 'my_unit', descriptor: { label: 'My Unit', scale: 'linear' } }])
registerHook('pages',          () => [{ path: 'my-page', title: 'My Page', component: MyPage }])
registerHook('nav_items',      () => [{ menuPath: 'tools', label: 'My Page', to: '/app/plugin/my-page' }])
registerHook('account_tabs',   () => [{ id: 'my-tab', title: 'My Tab', content: <MyAccountSection /> }])
registerHook('process_actions', (processId) => [
  <button key="my-action" onClick={() => doThing(processId)}>My Action</button>,
])
```

Everything is registered as a **side effect of importing `index.js`** via a single API —
`registerHook`. No separate `registerWidget`, `registerDatasetType`, etc. The host's collectors
translate each hook's results into whatever internal structure they need (Maps, gladly-plot calls,
router entries). Menu entries use `nav_items` rather than the host's React-only `useRegisterMenu`.

### Backend plugins use the identical npm package

A backend plugin (Phase 5) consumes **exactly this same npm source package**. The only difference
is **when/where the build runs**: instead of a `build_frontend_plugin` Process, the plugin's
`setup.py` builds the source at `pip install` time and ships the result as package data. At startup
the backend content-addresses that built dir and serves it from `/plugin-assets/{content_hash}/…`
with `source: "backend"`. The build needs network, but at `pip install` time — the running server
never runs npm.

A plugin author writes one frontend source package, publishes it once to npm, and it can be
consumed either as a standalone frontend plugin (built in a Process) or as the frontend half of a
backend plugin (built by its `setup.py` at install).

---

## Future Phase: User-Installed Plugins

> **Status: out of scope for now.** Nothing here is required to ship the admin-installed plugin
> system. It documents *how* to add user-installed plugins later and *why* the blast radius is
> small, so the door is designed-for without being built yet. Read Phases 4–5 first — this section
> only describes the **deltas**.

### Goal

Let an ordinary (non-admin) user install a frontend plugin **for themselves**, without admin review,
while keeping the multi-tenant security model intact.

The enabling constraint — and the reason this is cheap — is a strict scoping rule:

> **A user-installed plugin is visible only to its owner. By `name` it overrides the system plugin
> of the same name — but for that one user, and no one else.**

### Core model — a two-layer overlay

```
effective(user) = system_plugins  ⊕  user_plugins(user)        # ⊕ = override by name
```

- **System layer** — admin-installed plugins (`owner_id IS NULL`), visible to everyone.
- **User layer** — plugins installed by `user` (`owner_id == user.id`), visible only to `user`.
- **Override is by `name`**: one bundle per remote name loaded per session; resolved server-side in
  `GET /plugins/me`, so the browser still loads one remote per name.

### Why the blast radius is small

1. **No runtime name-namespacing.** With override semantics the clash cannot occur — the overlay is
   resolved server-side. The MF remote name stays clean and equal to `Plugin.name`.

2. **No sandboxing.** A private plugin runs only in its owner's browser, with that owner's auth
   token, against that owner's data. It cannot reach another user. The threat collapses from
   "supply-chain attack on all users" to "the user's own footgun" — the same class as pasting JS
   into devtools. It gains **no privilege the user doesn't already have**, provided the backend
   enforces per-user authorization on every endpoint (which it must regardless of plugins).

### What changes

**Schema — one column + one uniqueness change on `Plugin`:**

```python
owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
# NULL = system layer; set = private to this user

__table_args__ = (UniqueConstraint("owner_id", "name"),)
# + partial unique index: UNIQUE(name) WHERE owner_id IS NULL  (keep system names globally unique)
```

`PluginVersion`, `UserPlugin`, the build Process, content-addressed serving, `latest_version_id`,
and pinning are all **unchanged**.

**Resolution overlay in `GET /plugins/me`:**

```python
effective = {}
for p in candidates:    # system first, user second (user wins on name collision)
    effective[p.name] = p
return [serialize(p) for p in effective.values() if enabled_for(me, p)]
```

Response gains one field: `owner: "system" | "user"`.

**Authorization:**

- `POST /plugins` — any authenticated user may install into their own layer; only admins may
  install into the system layer. The existing `is_admin` gate generalizes to scope selection.
- `POST /plugins/{id}/upgrade`, `DELETE /plugins/{id}` — ownership check; admins may mutate
  system plugins.
- `GET /plugins` (list-all) — filters to `system ∪ owned` so users never see others' private
  plugins.

**Install path** — build in the user's own project (`build_frontend_plugin` with `scope: "user"`):

- No new ingestion/egress surface — the build pod's only egress is `PLUGIN_NPM_REGISTRY`.
- Access & compute accounting are free — the build runs in the user's project under their compute
  budget.
- Containment is structural — output dataset lives in the user's project bucket; private plugin
  served only to them.

**Quotas & GC** — no new machinery. Build outputs are ordinary project datasets; existing
per-project quota applies. A build rate-limit per user bounds abuse.

### Subtleties

- **Override = fork.** Once a user shadows system `billing`, they stop receiving admin updates
  until they remove their override. Surface this in the UI ("you are overriding the system version
  — system updates won't apply").
- **No admin audit of private bytes.** Acceptable only because the blast radius is self-contained.
  If plugins ever gain a server-side execution path, this assumption must be revisited.
- **Residual risk: social engineering.** A user can be phished into installing a malicious private
  plugin that exfiltrates their own data using their own session — identical in class to a malicious
  browser extension. Mitigation is an install-time warning, not a code change.
- **Backend plugins are unaffected.** Backend-bundled frontend plugins are inherently system-scope
  and admin-installed; users cannot install backend plugins (those run server-side).

### Implementation delta (if/when built)

1. Migration: add `Plugin.owner_id`; swap global name-unique for `UNIQUE(owner_id, name)` +
   partial `UNIQUE(name) WHERE owner_id IS NULL`.
2. `/plugins/me`: insert the overlay resolution; add `owner` to the response.
3. Authorization: scope guard on `POST /plugins`, `/upgrade`, `DELETE`, `GET /plugins`.
4. User install: allow non-admins to run `build_frontend_plugin` in their own project and register
   with `scope: "user"` (force `owner_id = caller`); add a build rate-limit.
5. UI: self-install flow in `PluginManager`, an "overriding system" badge, and the
   forking/updates warning.

No frontend-runtime, MF-loader, or extension-API changes.

### Open questions (for when this is scheduled)

- **Override visibility for admins.** Should an admin be able to see *that* a user overrides a
  system plugin (not the bytes), for support? Privacy vs. supportability.
- **Org/team layer.** A middle layer (`owner` = org, visible to members) is a natural extension
  slotting into the overlay resolution with priority order `user ⊕ org ⊕ system`. Out of scope
  here.
- **Build-output lifecycle.** Build datasets accumulate in the user's project; decide whether to
  auto-prune old build outputs not pinned by any `PluginVersion`.

---

## Implementation Order

Phases can be worked in the following order. Phases 1–2 and Phase 5 are independent and can begin
in parallel.

1. **Phase 5** (backend hook system + billing) — pure backend work; self-contained; no dependency
   on any frontend phase. Extract billing, wire hooks, run migrations.
2. **Phase 1** (Vite migration) — prerequisite for all MF frontend work; no backend changes.
3. **Phase 2** (registries + page registry + frontend hook system) — pure frontend refactor;
   immediately follows Phase 1.
4. **Phase 4** (plugin data model + API + `build_frontend_plugin` Process type) — new tables +
   routes; requires the `is_admin` prerequisite for system-scope operations.
5. **Phase 3** (MF loading infrastructure) — requires Phases 1 + 2 + 4 complete.
6. **Phase 6** (plugin management UI) — requires Phases 3 + 4.
7. **Phase 7** (plugin SDK + author guide) — written after Phases 1–3 confirm shared-dep
   resolution works end-to-end.

Backend-plugin frontends (Phase 5 hooks `register_routers`, `frontend_bundles`,
`mount_plugin_assets`) build directly on Phases 2–3: once the frontend extension API, MF loading,
and the build harness exist, the only backend additions are the two hooks and the `setup.py`-time
build, plus merging `app.state.backend_frontend_plugins` into `GET /plugins/me`. No new frontend
work — they ride the identical `/plugin-assets/{hash}` path.

---

## Open Questions

- **Plugin trust model & npm supply chain**: Registering a system plugin is admin-gated; running a
  build is project-membership-gated. Building from source in a sandboxed Process means the backend
  never executes plugin build scripts, and yields provenance by construction. Residual supply-chain
  risk is at build time. Mitigations: **pin exact versions** (no ranges), review-before-register,
  prefer scoped names, point `PLUGIN_NPM_REGISTRY` at a private registry for locked-down
  deployments. `content_hash` is computed at registration and used only as the URL token — not
  re-verified on serve.
- **Backend-plugin frontend trust**: backend plugins build their frontend from `setup.py` at
  `pip install` time, not in a Process — acceptable because they are admin-installed (running
  `pip install` is already a privileged, trusted server action).
- **Two distinct version axes** — both resolved:
  - *Build version*: which bytes. Each registered build is a content-addressed `PluginVersion`.
    Users are pinned at enable time and upgrade explicitly. Rollback = re-pin to an earlier version.
  - *Shared-dep compatibility*: **constructed at build time** — the build pins `shared` to the
    host's exact versions, so an incompatible plugin **fails the build** (with logs). `built_against`
    records those versions so a later host upgrade can flag versions that warrant a rebuild.
- **Offline / air-gapped**: built assets live in project buckets (frontend plugins) or the
  package's `frontend_dist/` (backend plugins) and are served from `/plugin-assets/{hash}/…`,
  never re-fetched at runtime. Point `PLUGIN_NPM_REGISTRY` at an internal mirror for air-gapped
  deployments.
- **Storage**: frontend-plugin bytes live in project buckets as ordinary output datasets (no new
  system store, no GC). Backend-plugin bytes live in the package's `frontend_dist/` on disk. Open:
  whether to dedup a build dataset when the identical `(npm source, host versions)` is rebuilt in a
  different project.

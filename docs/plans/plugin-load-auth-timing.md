# Load frontend plugins once, after auth state is known

## Goal

Frontend plugin bundles (which contribute widgets, cluster-provider forms, storage forms,
quantity kinds, layer types, menu/route chrome, etc.) must be loaded **once, against a known
authentication state** — never against the transient pre-hydration "logged out" render that
happens before `AuthContext` restores a session from `localStorage`. When the session genuinely
transitions logged-in ↔ logged-out within a live page (via `login()`/`logout()`, no navigation or
page reload), plugins must be reloaded in place against the new auth state.

## Symptom this fixes

On prod, the "Add cluster" dialog showed only the host built-in cluster-provider types
(`Same cluster as backend`, `Kubeconfig`) — every plugin-contributed type (Minikube, AKS, GKE)
was missing. Storage-form / widget / other plugin contributions from the private plugins are
missing for the same reason; the cluster dialog is just where it was noticed.

Diagnosis (verified against the running prod backend):

- All six backend plugins are installed, mounted, and freshly built; each of
  `minikube`/`azure`/`gcp` correctly registers `cluster_provider_forms` (Minikube/AKS/GKE).
- `GET /plugins/me` returns all 6 plugins for a valid token, but only 1 (`cms_plugin`, the sole
  `public: True` bundle) when anonymous. Verified directly with a minted admin token.
- The frontend access log showed every browser fetching **only** the `cms` bundle hash — never the
  other five — even on the one request where `/plugins/me` returned all six. So the browser
  receives the full list but fails to load the private plugins.

## Root cause

Two independently-correct facts combine into the bug:

1. **`frontend/src/AuthContext.jsx`** hydrates the session asynchronously. `token` and
   `isAuthenticated` initialize to `null`/`false` (lines 14-15); the stored token is restored in a
   mount `useEffect` (lines 26-36) that runs *after* the first render. There is no flag that
   distinguishes "localStorage not checked yet" from "checked, genuinely logged out" — both read as
   `isAuthenticated === false`.

2. **`frontend/src/plugins/loadPlugin.js`** initializes the module-federation runtime exactly once,
   guarded by a module-level `mfInitialised` latch:
   ```js
   let mfInitialised = false
   async function ensureInit(remotes) {
     if (mfInitialised) return          // one-time latch
     await init({ name: 'ymerflow_host', remotes, shared: {...} })
     mfInitialised = true
   }
   ```
   `init()` registers only the `remotes` from the **first** call. Remotes added on later calls are
   never registered, so `loadRemote(name)` for them throws (swallowed by `.catch`).

The **App.jsx** plugin-loading effect (`frontend/src/App.jsx:299-314`) keys on
`[isAuthenticated, token]`, so it runs on both the pre-hydration render and again after the token is
restored. Combined with the two facts above:

1. First render is anonymous → `/plugins/me` returns `[cms]` (public) → `loadPlugins([cms])` →
   `ensureInit` initializes the runtime with **only the cms remote** and latches
   `mfInitialised = true`.
2. `AuthContext` restores the token → effect re-fires → `/plugins/me` returns all 6 →
   `loadPlugins([6])` → `ensureInit` short-circuits → the five private remotes are never registered
   → their `loadRemote` calls fail → only `cms` ever loads → only host built-in hooks + cms hooks
   register.

The effect calls `resetHooks()` on every run (back to host built-ins), so after the failed
authenticated reload the registry holds only the host built-ins plus cms — exactly "no cluster
providers but Same as backend".

**Why it appeared "suddenly":** before the `cms` plugin was flagged `public: True`, the anonymous
first-load returned `[]`, and `loadPlugins` bails at its `plugins.length === 0` guard *before*
`ensureInit` — leaving the latch unset, so the later authenticated load performed the real `init`
with the full remote set. Adding a `public` bundle is what now trips the one-time init early with an
incomplete remote list. This is not tied to any one deploy; it recurs on every page load until
fixed.

## Current state

- **`frontend/src/AuthContext.jsx`** — `user`/`token`/`isAuthenticated` state (lines 13-15);
  mount hydration effect (lines 26-36); `login`/`logout` mutate state synchronously (lines 38-65);
  `contextValue` memo exposes `{ user, token, isAuthenticated, login, logout, updateUser,
  consumeJustAuthenticated }` (lines 72-83). No "auth resolved / hydrated" signal exists.
- **`frontend/src/App.jsx`** — plugin-loading `useEffect` at lines 299-314 keyed on
  `[isAuthenticated, token]`; calls `setPluginsReady(false)` → `resetHooks()` →
  `fetch('/plugins/me')` → `loadPlugins(...)` → rebuilds derived registries → `setPluginsReady(true)`
  in `finally`. Consumes `token` and `isAuthenticated` from `AuthContext` (line 257).
- **`frontend/src/plugins/loadPlugin.js`** — `ensureInit(remotes)` one-time latch (lines 3-19);
  `loadPlugins(plugins)` bails on empty (line 22), maps plugins → `remotes`, `ensureInit(remotes)`,
  then `Promise.all(loadRemote(...))` (lines 21-51). `@module-federation/runtime` is v2.6.0 and
  exports `registerRemotes` (confirmed).

## Change

### 1. `frontend/src/AuthContext.jsx` — add an `authReady` signal

- Add state `const [authReady, setAuthReady] = useState(false);`.
- At the **end** of the mount hydration effect (lines 26-36), set `setAuthReady(true)` on all paths
  (whether or not a stored token/user was found), so `authReady` becomes true exactly once, after
  the logged-in-or-out question is decided:
  ```js
  useEffect(() => {
    const storedToken = localStorage.getItem('auth_token');
    const storedUser = localStorage.getItem('auth_user');
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
      setIsAuthenticated(true);
      setAuthToken(storedToken);
    }
    setAuthReady(true);
  }, []);
  ```
- Add `authReady` to `contextValue` and its memo dependency array.
- `login`/`logout` need no change: `authReady` stays true across an in-session transition; the
  transition is observed via `isAuthenticated` flipping.

### 2. `frontend/src/App.jsx` — gate the load on `authReady`; reload on real transitions

- Read `authReady` from `AuthContext` alongside `isAuthenticated`/`token` (line 257).
- Change the plugin-loading effect (lines 299-314) to **return early while `!authReady`** and to key
  on `[authReady, isAuthenticated]` (drop `token` from the key — `isAuthenticated` is the identity
  that captures login/logout; keying on `token` too would re-fire on same-auth token refreshes for
  no benefit):
  ```js
  useEffect(() => {
    if (!authReady) return;            // don't load against unknown auth state
    setPluginsReady(false);
    resetHooks();
    fetch(`${API}/plugins/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
      .then(plugins => loadPlugins(plugins))
      .catch(() => {})
      .finally(() => {
        buildDatasetRegistry();
        buildLayerTypeRegistry();
        buildQuantityKindRegistry();
        setWidgets(buildWidgets());
        setPluginsReady(true);
      });
  }, [authReady, isAuthenticated]);   // token still read inside, just not a trigger
  ```
  - First run: fires once when `authReady` flips true, with the correct auth-appropriate remote set.
  - In-session `login()`/`logout()`: `isAuthenticated` flips → effect re-fires → `resetHooks()` +
    reload against the new set (see change 3 for how the runtime picks up the new remotes).
  - Navigation / full reload: hydration re-runs, `authReady` re-flips true → loads once. Correct.
  - `token` is still read inside the effect for the `Authorization` header; ESLint
    `react-hooks/exhaustive-deps` may flag it as a missing dep — silence it with an inline
    `// eslint-disable-next-line react-hooks/exhaustive-deps` (intentional: `token` is data the
    effect reads, not a trigger; `isAuthenticated` already gates every transition that changes it).

### 3. `frontend/src/plugins/loadPlugin.js` — init runtime once, register the current remote set every load

- Split the one-time latch (which currently freezes the remote set to the first call) into: a
  one-time bare `init()` of the runtime singleton, plus `registerRemotes(remotes, { force: true })`
  on **every** `loadPlugins` call, before `loadRemote`. This is what lets the transition reload in
  change 2 actually pick up the new remote set in place, with no page reload:
  ```js
  import { API } from '../datamodel/api'

  let mfInitialised = false

  async function ensureInit() {
    if (mfInitialised) return
    const { init } = await import('@module-federation/runtime')
    await init({
      name: 'ymerflow_host',
      remotes: [],
      shared: {
        react:                   { version: '18.2.0', lib: () => import('react'),    singleton: true },
        'react-dom':             { version: '18.2.0', lib: () => import('react-dom'), singleton: true },
        'gladly-plot':           { version: '0.0.19', lib: () => import('gladly-plot'), singleton: true },
        '@tanstack/react-query': { version: '5.90.19', lib: () => import('@tanstack/react-query'), singleton: true },
      },
    })
    mfInitialised = true
  }

  export async function loadPlugins(plugins) {
    // Always init the runtime (even for an empty set) so a later authenticated reload can register
    // remotes into an already-initialized runtime. Do NOT early-return on empty here.
    const resolveUrl = (base_url) =>
      base_url.startsWith('http') ? base_url : API + base_url

    const remotes = (plugins || []).map(p => ({
      name: p.name,
      entry: resolveUrl(p.base_url) + 'remoteEntry.js',
      type: 'module',
    }))

    try {
      await ensureInit()
      const { registerRemotes, loadRemote } = await import('@module-federation/runtime')
      // force: true so an in-session logout→login (or a changed content hash) re-registers the
      // remote under the same name instead of being ignored as a duplicate.
      if (remotes.length) registerRemotes(remotes, { force: true })
      await Promise.all(
        (plugins || []).map(p =>
          loadRemote(`${p.name}/index`)
            .catch(e => console.warn(`Failed to load plugin ${p.name}:`, e))
        )
      )
    } catch (e) {
      console.warn('Plugin loading failed, continuing without plugins:', e)
    }
  }
  ```
  - Notes:
    - The old `if (!plugins || plugins.length === 0) return` early-return is removed. It is no longer
      needed as a guard (the mapping handles an empty list) and keeping it would reintroduce a subtle
      variant of the bug on the empty→non-empty path. `registerRemotes` is only called when there is
      something to register.
    - `resetHooks()` in App.jsx already clears a logged-out user's private plugin hooks; on logout we
      simply don't `loadRemote` the private plugins, so their hooks don't re-register. The private
      plugin module code staying resident in memory after logout is harmless (accepted trade-off of
      in-place re-register vs. a full page reload).

## Verification

- Load the app already logged in (token in `localStorage`): the "Add cluster" dialog lists the
  plugin-contributed types (Minikube, and AKS/GKE where those plugins are installed) in addition to
  `Same cluster as backend` / `Kubeconfig`. Browser network panel shows `/plugins/me` returning the
  full set and the private plugin `remoteEntry.js` bundles being fetched (not only `cms`).
- Load the app logged out: only the host built-ins + any `public` bundles load; no errors; the
  public site works.
- In-session login (from the login page, no manual reload): after `login()`, the private plugins
  load and their contributions (cluster forms, widgets, etc.) appear.
- In-session logout: private-plugin contributions disappear (hooks reset); no console errors; a
  subsequent in-session login re-registers and reloads them (exercises `registerRemotes({force:true})`).
- Confirm there is no pre-hydration `/plugins/me` request in the network panel (the first request
  happens only after `authReady`).
- This is a frontend-only change: it requires a **frontend rebuild + redeploy** to reach prod; a
  running bundle will not pick it up via hot reload.

## Notes

- Backend and DB are correct and unchanged by this plan; do not modify plugin `public` flags or the
  `/plugins/me` endpoint.
- After implementation, move this file to `docs/plans/done/`.

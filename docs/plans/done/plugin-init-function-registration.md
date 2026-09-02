# Plugin hook registration via a re-callable `init()` export

## Goal

Make frontend-plugin hook registration **deterministic and host-controlled**, so that a plugin's
hooks are correctly (re-)registered on *every* plugin load — including the in-tab auth transitions
where the host tears the hook registry down and rebuilds it. Today registration is a **module-level
import side effect**, which the host cannot re-invoke: after `resetHooks()` drops a plugin's
registrations, the only thing that could restore them is the module re-executing, and whether that
happens is entirely at the browser's discretion. For `type: 'module'` remotes it does **not**
happen — the browser's ES-module registry caches `remoteEntry.js` by URL and never re-evaluates it
— so the plugin's hooks stay gone until a full page reload creates a fresh runtime.

The fix: a plugin exposes an **exported `init()` function** that performs all its `registerHook(...)`
calls, and the host **calls that function after every `loadRemote(...)`**. Because the host is
invoking a function on the (possibly cached) module namespace, it runs deterministically every
time, regardless of the browser's module cache.

**This is host-repo + SDK + in-repo-plugins work.** It changes the frontend-plugin contract.

## Why it breaks today

1. A plugin's `src/index.jsx` calls `window.__ymerflow_registerHook(...)` (or the SDK's
   `registerHook`) at **module top level**, as a side effect of being imported
   (`deps/Ymerflow-plugin-sdk/js/index.js:5-6` documents this explicitly:
   *"registers all its extensions as side effects of being imported"*).
2. On every auth transition, `AuthenticatedApp`'s plugin-load effect
   (`frontend/src/App.jsx:243-263`) calls `resetHooks()` — which drops all plugin-contributed hooks
   back to the host-only snapshot (`frontend/src/plugins/hooks.jsx:25-33`) — and then re-runs
   `loadPlugins()` (`frontend/src/plugins/loadPlugin.js:25-60`) to reload the auth-appropriate
   bundle set.
3. `loadPlugins` calls `loadRemote('<name>/index')` purely to *trigger the import side effect*; it
   ignores the returned module (`loadPlugin.js:51-56`). The remotes are `type: 'module'`
   (`loadPlugin.js:42`), loaded via dynamic `import()`. **The browser caches the ESM `remoteEntry.js`
   by URL and will not re-evaluate it on a second import.** `registerRemotes(..., { force: true })`
   deletes Module-Federation's *own* caches and the container global
   (`@module-federation/runtime-core` `removeRemote`), but it cannot evict the browser's module
   registry — so `index.jsx`'s top-level `registerHook(...)` calls **only ever run on the first
   import** and never again.

Net effect: the moment a user logs in / signs up **in the same tab**, `resetHooks()` removes a
plugin's hooks and nothing puts them back.

### Why this only became visible now

Before a bundle is `public`, it is loaded for the **first time** *after* login, so its single
top-level execution registers its hooks into the post-`resetHooks()` registry and everything works.
The bug is only reachable for a bundle that loads **while logged out and again after login** — i.e.
a `public` bundle (`backend/routers/plugins.py:124`). `ymerflow-cms` is `public` too, but the hooks
it registers that matter are `logged_out_routes` (used *before* login), so its post-login hook loss
is invisible. **Billing is the first `public` bundle whose hooks matter *after* login**
(`account_tabs`, `app_providers`/`ContractGuard`, `fullscreen_pages`, `user_menu_extra_items`), so
it is the first place the latent bug produces visible breakage:

- `account_tabs` empty → no Contract tab under Account.
- `app_providers` empty → `ContractGuard` never mounts → no contract nudge, no invite redirect.
- `fullscreen_pages` empty → the main app's own `pendingPath` fullscreen-restore (`App.jsx:335`)
  can't match → the user falls through to `/app`.
- `user_menu_extra_items` empty → billing's `BalanceDisplay` missing from the user menu.

A full page reload creates a fresh MF runtime (billing loads exactly once), so its hooks *are*
present — which is why reloading behaves differently from an in-tab login.

## Design decisions

1. **A named `init()` export, called by the host on every load.** The plugin moves all its
   `registerHook(...)` calls out of module top level into `export function init() { ... }`. The host
   calls `module.init()` after each `loadRemote(...)`. Named `init` (not default) so a module can
   still have other exports and so the intent is explicit at the call site.
2. **`init()` takes no arguments; registration still goes through the window bridge / SDK
   `registerHook`.** This keeps migration purely mechanical (wrap the existing body) and does not
   change the one-shared-registry model. The host guarantees the bridge
   (`window.__ymerflow_registerHook`, `window.__ymerflow_hooks`) is installed before any plugin
   loads, so it is present when `init()` runs.
3. **`init()` must be idempotent-by-reset, not idempotent-by-itself.** The host always calls
   `resetHooks()` immediately before the load pass, so the registry is empty of plugin hooks when
   `init()` runs; `init()` simply registers. It must **not** guard against "already registered" — a
   second call after a reset is the normal, intended path.
4. **Registration must live *only* inside `init()`, never also at top level.** Since the host calls
   `init()` on the first load too (not only re-loads), a plugin that both registered at top level
   *and* exported `init()` would double-register on first load. Migration therefore *moves* the
   calls; it does not add `init()` alongside them.
5. **Backward compatibility: `init()` is optional but recommended.** The host calls
   `module.init?.()` only when it is a function. A legacy plugin that still registers at top level
   keeps working exactly as before (including the pre-existing across-auth-transition limitation) —
   no hard crash. All in-repo plugins are migrated in this change; external plugins keep working
   until they opt in. The SDK docs mark top-level registration as deprecated.
6. **No build/preset change.** The MF preset already exposes `./index` → `src/index.js`
   (`deps/Ymerflow-plugin-sdk/js/vite-preset.js:60`), so `loadRemote('<name>/index')` returns that
   module's namespace and any `init` export is present in it. Nothing about `exposes`, `shared`, or
   `remoteEntry` needs to change.

## Current state (confirmed by reading the code)

- `frontend/src/plugins/loadPlugin.js:51-56` — `loadPlugins` does
  `loadRemote('<name>/index').catch(...)` and **discards** the resolved module; registration is
  assumed to have happened as an import side effect.
- `frontend/src/plugins/hooks.jsx:12-33` — `registerHook` is append-only; `resetHooks()` restores a
  host-only snapshot, dropping every plugin registration. Host built-ins registered at
  `frontend/src/App.jsx:61-99` are captured in that snapshot and are unaffected.
- `frontend/src/App.jsx:243-263` — the effect that runs `resetHooks()` + `loadPlugins()` on
  `[authReady, isAuthenticated]`, i.e. on every auth transition.
- Plugins registering hooks at module top level (all identical `if (window.__ymerflow_registerHook)
  { ...registerHook... }` shape):
  - `plugins/billing/frontend/src/index.jsx`
  - `plugins/ymerflow-cms/frontend/src/index.jsx`
  - `plugins/ymerflow-minikube/frontend/src/index.jsx`
  - `plugins/ymerflow-gcp/frontend/src/index.jsx`
  - `plugins/ymerflow-azure/frontend/src/index.jsx`
  - `plugins/ymerflow-plugin-tickets-github/frontend/src/index.jsx`
- SDK docs describing the side-effect contract: `deps/Ymerflow-plugin-sdk/js/index.js:1-9`,
  `deps/Ymerflow-plugin-sdk/docs/frontend-hooks.md:1-6`, `deps/Ymerflow-plugin-sdk/docs/authoring.md`.

## Implementation

### 1. Host — call `init()` after each `loadRemote` (`frontend/src/plugins/loadPlugin.js`)

Capture the resolved module and invoke its `init()` if present. Keep the per-plugin isolation (one
bad plugin must not abort the others) and keep the whole set parallel:

```js
await Promise.all(
  (plugins || []).map(p =>
    loadRemote(`${p.name}/index`)
      .then(mod => {
        // New contract: the plugin registers its hooks in an exported init() that the host
        // calls on EVERY load. This is what makes re-registration survive resetHooks() across
        // in-tab auth transitions — a cached ESM remoteEntry is never re-evaluated by the
        // browser, so relying on module-top-level side effects loses the hooks. Legacy plugins
        // that registered at import time (no init export) keep working via that side effect.
        if (mod && typeof mod.init === 'function') mod.init()
      })
      .catch(e => console.warn(`Failed to load plugin ${p.name}:`, e))
  )
)
```

(The `resetHooks()` that must precede this stays where it is, in the `App.jsx:243-263` effect — no
change there.)

### 2. In-repo plugins — move registration into `export function init()`

Mechanical for each of the six plugins: replace the top-level
`if (window.__ymerflow_registerHook) { <registrations> } else { <error> }` block with

```jsx
export function init() {
  if (typeof window === 'undefined' || !window.__ymerflow_registerHook) {
    console.error('[<plugin>] window.__ymerflow_registerHook not available')
    return
  }
  <the exact same registerHook(...) calls, unchanged>
}
```

`import` statements and any component definitions stay at module top level; only the `registerHook`
calls move into `init()`. Note for billing specifically: the module-scoped
`pendingRedirectDecision` promise in `ContractGuard.jsx` and the `checkPendingRedirect` export are
unaffected — only the `registerHook('pending_redirects', checkPendingRedirect)` *call* moves into
`init()`.

### 3. SDK — update the contract and docs

- `deps/Ymerflow-plugin-sdk/js/index.js` header comment: replace "registers … as side effects of
  being imported" with the `init()` contract, showing the new canonical shape:
  ```js
  import { registerHook } from 'ymerflow-plugin-sdk'
  export function init() {
    registerHook('widgets', () => [{ name: 'MyWidget', component: MyWidget }])
  }
  ```
- `deps/Ymerflow-plugin-sdk/docs/frontend-hooks.md` (intro) and
  `deps/Ymerflow-plugin-sdk/docs/authoring.md`: document that `src/index.js` must
  **export `init()`** and that the host calls it on every (re)load; mark bare top-level
  registration as deprecated (works, but its hooks vanish across in-tab auth transitions).

## Flow after the fix

1. Logged out → billing (public) loads once: `loadRemote` → host calls `billing.init()` → hooks
   registered.
2. In-tab login/signup → effect fires → `resetHooks()` drops plugin hooks → `loadPlugins()` →
   `loadRemote` returns the **cached** module (no re-eval, fine) → host calls `billing.init()`
   **again** → hooks re-registered. Account gets its Contract tab, `ContractGuard` mounts,
   `fullscreen_pages` is populated, the user menu shows the balance.
3. Full reload → fresh runtime, one load, `init()` called once → same end state.

## Files touched

- `frontend/src/plugins/loadPlugin.js` — call `mod.init?.()` after `loadRemote`.
- `plugins/billing/frontend/src/index.jsx`
- `plugins/ymerflow-cms/frontend/src/index.jsx`
- `plugins/ymerflow-minikube/frontend/src/index.jsx`
- `plugins/ymerflow-gcp/frontend/src/index.jsx`
- `plugins/ymerflow-azure/frontend/src/index.jsx`
- `plugins/ymerflow-plugin-tickets-github/frontend/src/index.jsx`
- `deps/Ymerflow-plugin-sdk/js/index.js` — contract comment.
- `deps/Ymerflow-plugin-sdk/docs/frontend-hooks.md`, `deps/Ymerflow-plugin-sdk/docs/authoring.md`.

## Verification

Plugin/host frontends auto-reload; no servers to start.

- **In-tab login (existing-plan user)** → Account shows the Contract tab; user menu shows the
  balance; `ContractGuard` runs (no reload needed). Previously all three were missing until a reload.
- **In-tab signup (new user)** → same: Contract tab present, `app_providers`/`ContractGuard`
  mounted.
- **Repeated in-tab logout→login cycles** → hooks present every time (no dependence on a reload),
  and no double-registration (e.g. exactly one Contract tab, one balance item).
- **Legacy plugin with no `init()` export** (temporarily revert one plugin) → still loads and
  registers on first load via the top-level side effect; confirms the `init?.()` fallback.
- **Non-public plugins** (minikube/gcp/azure forms, tickets-github menu item) → unchanged behaviour
  after login.

## Out of scope / relationship to other work

- **The stale invite-redirect keys are a separate bug** — `billingPendingInvitePath` and
  `pendingPath` are never cleared on consume or on logout, so once hooks work again a stale key can
  still redirect a later user to a previous invite. Tracked in
  `plugins/billing/docs/bugs/stale-invite-redirect-keys.md`. This plan does **not** touch it.
- **No change to `resetHooks()`/the registry model** beyond calling `init()` — the host-only
  snapshot behaviour stays as-is.
- **No MF `shared`/`exposes`/`remoteEntry`/preset change.**
- Once hooks re-register correctly, whether the billing `billingPendingInvitePath` + `ContractGuard`
  invite machinery is still needed at all (vs. the main app's existing `pendingPath` restore) is a
  billing-plugin follow-up, not part of this host-repo change.

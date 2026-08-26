# Host hooks: plugin-contributed menu entries, logged-out menu bar, and public plugin bundles

## Goal & scope

Add a small set of **generic, CMS-agnostic host extension points** to the frontend (plus one
backend semantics change) so that a plugin can:

1. contribute **top-level menu entries** into the logged-in app `MenuBar` at an arbitrary menu path
   (main menu / submenu / subsubmenu / …), built from a *dynamically fetched* list;
2. get a **menu bar on the logged-out `LandingPage`** — reusing the existing `MenuBar`/`MenuContext`
   machinery — that is hidden entirely when no plugin contributes entries;
3. register **top-level routes that render while logged out**; and
4. have its **frontend bundle loaded for anonymous visitors** when it opts in as public, with the
   plugin set correctly reloaded on every login/logout transition.

This work is motivated by the `ymerflow-cms` plugin (see
`plugins/ymerflow-cms/docs/plans/ymerflow-cms-plugin.md`), but every item here is a general host
capability with no CMS-specific logic. This plan is a **prerequisite** for the CMS plan.

## What already exists (host, unchanged)

- **Plugin hook bridge** — `frontend/src/plugins/hooks.jsx` exposes
  `window.__ymerflow_registerHook(name, fn)` and runs hooks via `hooks.run.*` / `hooks.run_jsx.*`.
  Plugins reach host React contexts through `window.__ymerflow_*` bridges
  (`__ymerflow_AuthContext`, `__ymerflow_api`, `__ymerflow_MessageContext`) — see `AuthContext.jsx`.
- **Nested menu system** — `flexout/MenuContext.jsx` (`useRegisterMenu(path, action, position)`,
  `MenuProvider`) + `flexout/MenuBar.jsx` render a menu tree of arbitrary depth. Currently only the
  host's own components (`App.jsx` → `MenuBarWithComponents`) register into it.
- **Landing page** — `LandingPage.jsx` renders when unauthenticated; it has no menu bar and no
  plugin hooks today.
- **Route hooks** — `App.jsx` already maps `hooks.run.pages()` → `/app/plugin/:path` and
  `hooks.run_jsx.app_routes()` → arbitrary routes, and checks `hooks.run.fullscreen_pages()` before
  the app shell. All of these are evaluated **inside `AuthenticatedApp`**, i.e. only after auth.
- **`GET /plugins/me`** — `backend/routers/plugins.py`, currently `Depends(get_current_user)`. Returns
  backend-bundled plugins (always-on, discovered via the `frontend_bundles` hook,
  `backend/plugin_assets.py`) plus the user's enabled remote plugins. Plugin *assets* are served
  from an unguessable content-hash URL that is already public.

## H1. Expose the menu-registration API to plugins

`flexout/MenuContext.jsx`: at module load, bridge the context and the registration hook to
`window`, mirroring `AuthContext.jsx`:

```js
if (typeof window !== 'undefined') {
  window.__ymerflow_MenuContext = MenuContext;
  window.__ymerflow_useRegisterMenu = useRegisterMenu;
}
```

Lets a plugin component call `useRegisterMenu([...menuPath], action, position)` using the shared
React singleton.

## H2. A hook for plugins to register into the menu tree

Add a `menu_registrars` (run_jsx) hook rendered as invisible components inside every `MenuProvider`.
Each registrar component may call `useRegisterMenu` (via H1) in an effect to inject entries — this
is how a plugin turns a *dynamically fetched* list into menu entries, since the menu tree is built
from imperative `registerMenu` calls, not a static array.

- `App.jsx` `MenuBarWithComponents` renders `{hooks.run_jsx.menu_registrars({ context: 'in' })}`
  alongside `<UserMenu/><MenuBar/>`.
- The landing menu bar (H3) renders `{hooks.run_jsx.menu_registrars({ context: 'out' })}`.
- The `context` arg (`'in'` | `'out'`) lets a registrar contribute only to the relevant menu bar.

## H3. A menu bar on the logged-out landing page (hidden when empty)

`LandingPage.jsx`: wrap the page in `MenuProvider` and render the `menu_registrars` context plus the
same `MenuBar`, above the existing hero/cards. `MenuBar`/`MenuContext` are self-contained (no
`AuthContext`/`ProcessContext` dependency), so they mount cleanly on the unauthenticated page.

**The bar is hidden entirely when there are no entries.** If no plugin contributes logged-out menu
items, the landing page must look exactly as it does today — no empty navbar strip. The registrar
components stay mounted unconditionally (so the tree *can* fill asynchronously), but the bar renders
only when the tree is non-empty:

```jsx
function LandingMenuBar() {
  const { menuTree } = useMenu();
  if (Object.keys(menuTree).length === 0) return null;  // no contributor → no bar
  return <MenuBar />;
}
// inside MenuProvider on LandingPage:
{hooks.run_jsx.menu_registrars({ context: 'out' })}  {/* always mounted: fills the tree */}
<LandingMenuBar />                                    {/* shown only once the tree has entries */}
```

Gating on the menu tree (not on plugin presence) correctly covers both "no such plugin" and "plugin
present but zero logged-out entries". The logged-in `MenuBar` in `App.jsx` is unaffected — it always
carries the host's own brand/project/workspace components, so it is never empty.

## H4. A route seam for logged-out plugin pages

The existing route hooks live inside `AuthenticatedApp`, which short-circuits to `LandingPage` when
unauthenticated. Add a pre-auth `logged_out_routes` (run_jsx) hook checked in `AuthenticatedApp`
*before* the `!isAuthenticated → LandingPage` return (same shape as the existing `fullscreen_pages`
check, but on the unauthenticated branch). A plugin registers logged-out top-level routes here;
logged-in routes continue to use the existing `app_routes` hook.

## H5. Load public plugin bundles for anonymous visitors

**No new endpoint — `GET /plugins/me` gains new semantics.**

- **Backend** (`backend/routers/plugins.py`): make the auth dependency optional (allow anonymous).
  - Authenticated → unchanged (all backend-bundled plugins + user-enabled remote plugins).
  - Anonymous → return **only the backend-bundled plugins flagged public**, and skip the
    user-enabled remote-plugin query entirely (there is no user).
  - "Public" is a new `public: true` flag on a bundle's `frontend_bundles()` dict, threaded through
    `_backend_plugins` / `plugin_assets.py` into the `/me` response. Bundles without the flag are
    private (default false) — so this change is **inert for every existing plugin** until one opts
    in. Asset serving is already public (content-hash capability URL), so no asset-auth change.
- **Frontend** (`App.jsx` `AuthenticatedApp`): today the plugin-loading effect early-returns for
  unauthenticated non-publication visitors (`Promise.resolve([])`). Change it to **always** fetch
  `GET /plugins/me` — with the `Authorization` header when a token exists, without it when anonymous
  — and load whatever bundles come back. Anonymous visitors load the public set; authenticated
  visitors load the full set.
- **Reload on login/logout (explicit requirement).** The effect already keys on
  `[isAuthenticated, token, …]`, so an auth transition re-runs it and re-fetches `/plugins/me`. But
  the frontend hook registry (`plugins/hooks.jsx`) is an append-only module `Map`, so a naive
  re-run would **double-register** every hook and leak private hooks after logout. Therefore, on
  each auth transition, **reset plugin-contributed state before reloading**: clear the hook registry
  back to the host's built-in registrations, then `loadPlugins(...)` the fresh set and rebuild the
  derived registries (`buildDatasetRegistry` / `buildLayerTypeRegistry` /
  `buildQuantityKindRegistry` / `buildWidgets`). Add a `resetHooks()` (or equivalent re-init) to
  `plugins/hooks.jsx`. Net effect: logging in adds private plugins and their menu entries; logging
  out drops them and reverts the landing page to only its public contributions (or none, per H3).

## Non-goals

- No CMS-specific behavior (data model, page rendering, admin UI) — that lives in the CMS plugin.
- No restyle of the reused `MenuBar` (the landing bar reuses the existing dark navbar look).
- No change to how authenticated plugin loading, `pages`/`app_routes`/`fullscreen_pages`, or
  publication-link anonymous viewing work beyond the additions above.

## Implementation order

1. **H1** menu-registration bridge (`MenuContext.jsx`).
2. **H2** `menu_registrars` hook wiring in `App.jsx`.
3. **H4** `logged_out_routes` hook in `AuthenticatedApp`.
4. **H5** backend `public` flag + anonymous `/plugins/me`; frontend always-fetch + `resetHooks()` +
   reload-on-auth-change.
5. **H3** landing `MenuProvider` + registrars + `LandingMenuBar` (empty-tree hiding).
6. Smoke-test with a throwaway registrar/route before the CMS plugin exists: a hardcoded
   `menu_registrars`/`logged_out_routes`/`public` bundle proves each seam independently.

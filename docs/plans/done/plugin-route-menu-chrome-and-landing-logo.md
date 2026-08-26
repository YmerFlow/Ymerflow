# Host: render plugin routes inside the menu chrome + add the landing-bar logo

## Goal & scope

Host-side (`frontend/`) changes that make plugin-registered routes inherit the top menu, and give the
logged-out menu bar the same logo the logged-in bar has. Motivated by the CMS plugin (see
`plugins/ymerflow-cms/docs/plans/cms-page-chrome-and-branding.md`), but the changes are **generic** —
they apply to every route contributed through the `app_routes` and `logged_out_routes` hooks, not to
CMS specifically. No new extension points, no new `window.__ymerflow_*` bridges; this is a change to
how the host renders existing hook results.

Frontend chrome only — no backend, API, or data-model changes.

### Decisions settled with the user (2026-08-26)

1. **Fix menu visibility in the host, generically** — wrap all plugin routes in the shared chrome
   rather than have each plugin re-create it.
2. **The logged-out bar appears only when it has real menu entries** — registering the logo as a
   menu component must not by itself force the bar visible (preserves the bar-less vanilla install and
   avoids a second logo beside the big landing-content logo).

## Root cause

Both hooks are mapped to bare `<Route>`s that render the element **as a sibling of** the
chrome-bearing route, so neither inherits the top menu:

- **Logged-out** (`AuthenticatedApp` in `App.jsx`): `logged_out_routes` render inside a `<Routes>`
  whose `*` fallback is `<LandingPage />`. `LandingPage` is the only place that mounts the logged-out
  menu chrome (`MenuProvider` + `menu_registrars({context:'out'})` + `LandingMenuBar`). A route match
  renders the plugin element **instead of** `LandingPage`, so there is no `MenuProvider` and no bar.
- **Logged-in** (`AppWithContext` in `App.jsx`): `app_routes` render as siblings of `/app/*`. Only
  the `/app/*` element mounts `MenuBarWithComponents` (logo + dropdowns + `MenuBar`). The plugin route
  renders bare — no bar.

Separately, `BrandLogo` (`BrandLogo.jsx`) is registered only in `MenuBarWithComponents`
(logged-in) via `useRegisterMenuComponent(["_brandLogo"], BrandLogo, 0)`; the logged-out chrome in
`LandingPage.jsx` never registers it.

## Changes

### H1 — Extract logged-out chrome, register the logo, route content inside it

**`frontend/src/LandingPage.jsx`** — turn the current inline chrome into a reusable `LandingChrome`
wrapper, export `LandingContent`, register `BrandLogo`, and change the emptiness test:

```jsx
import BrandLogo from './BrandLogo';
import { MenuProvider, useMenu, useRegisterMenuComponent } from './flexout/MenuContext';
import { hooks } from './plugins/hooks';

function LandingMenuBar() {
  const { menuTree } = useMenu();
  // Count only real entries. Component-only nodes use '_'-prefixed keys (e.g. _brandLogo) and must
  // not by themselves keep the bar visible (decision 2) — otherwise the logo would force a bar onto
  // a vanilla install and duplicate the big landing-content logo.
  const hasRealEntries = Object.keys(menuTree).some(k => !k.startsWith('_'));
  if (!hasRealEntries) return null;
  return <MenuBar />;
}

// Registers the shared logo into the logged-out menu tree — same markup/styling as the logged-in bar.
function LandingBrand() {
  useRegisterMenuComponent(['_brandLogo'], BrandLogo, 0);
  return null;
}

// Chrome shared by the landing page AND every logged-out plugin route.
export function LandingChrome({ children }) {
  return (
    <MenuProvider>
      <LandingBrand />
      {hooks.run_jsx.menu_registrars({ context: 'out' })}
      <LandingMenuBar />
      {children}
    </MenuProvider>
  );
}

export function LandingContent() { /* the existing landing body, unchanged */ }

export default function LandingPage() {
  return <LandingChrome><LandingContent /></LandingChrome>;
}
```

Notes:
- `LandingContent` already exists as a local component — promote it to a named export.
- `menu_registrars({context:'out'})` moves *into* `LandingChrome`, so it runs for plugin routes too
  and their entries populate the bar on those pages.
- The old test was `Object.keys(menuTree).length === 0`; with the logo now always registered that key
  would always be present, hence the "has a non-`_` entry" test.

**`frontend/src/App.jsx`** (`AuthenticatedApp`, logged-out branch) — mount one `LandingChrome` and
select content by route so the bar is shared across the landing page and every logged-out plugin
route:

```jsx
import LandingPage, { LandingChrome, LandingContent } from './LandingPage';

// ...in the `!anonymousViewingAllowed` branch, replacing the current <Routes>:
return (
  <LandingChrome>
    <Routes>
      {hooks.run_jsx.logged_out_routes().map(({ path, element }) => (
        <Route key={path} path={path} element={element} />
      ))}
      <Route path="*" element={<LandingContent />} />
    </Routes>
  </LandingChrome>
);
```

(The `pluginsReady` guard above this block is unchanged — public plugins must load before matching
the URL so their `logged_out_routes` are registered.)

### H2 — Wrap logged-in plugin routes in `PageChrome`

**`frontend/src/App.jsx`** (`AppWithContext`) — `PageChrome` already renders
`MenuBarWithComponents` (logo + dropdowns + `MenuBar`) above a scrolling content area
(`flex-grow-1 overflow-auto`). Wrap the generic `app_routes`:

```jsx
{hooks.run_jsx.app_routes().map(({ path, element }) => (
  <Route key={path} path={path} element={<PageChrome>{element}</PageChrome>} />
))}
```

Any plugin element that previously supplied its own scroll container should rely on `PageChrome`'s
instead (the CMS plugin's `CmsPageView` drops its `overflowY/height:100%` hack accordingly).

## Behavioral impact & compatibility

- **Vanilla install (no public plugin):** unchanged — no logged-out route matches, the landing page
  still renders with no top bar (only real entries would show it) and a single content logo.
- **`app_routes` consumers:** now render *with* the app menu bar and inside a scroll container. This
  is the intended behavior (plugin pages looked "chrome-less" before). A plugin that deliberately
  wanted a chrome-less full-screen page should use the existing `fullscreen_pages` hook instead —
  `app_routes` is for in-app pages.
- **Edge case (accepted):** a logged-out route whose context contributes no real menu entry keeps the
  bar hidden on that page (decision 2).

## Testing / verification

In the running dev app (with the CMS plugin installed as the exercising case):

1. Logged-out, no CMS pages → landing page shows no top bar. *(vanilla unchanged)*
2. Logged-out, a CMS page with a menu path exists → top bar with **logo** + entry appears on both the
   landing page and the plugin route; persists across navigation.
3. Logged-in plugin route (e.g. `/app/page/<slug>`) → full app menu bar above the content; content
   scrolls in the pane.
4. Logged-out bar logo uses `BrandLogo` — identical markup/styling to the logged-in bar.

## Files touched

- `frontend/src/LandingPage.jsx` — extract `LandingChrome`/`LandingContent`, register `BrandLogo`,
  change the emptiness test.
- `frontend/src/App.jsx` — logged-out branch renders `LandingChrome` around a content `<Routes>`;
  `app_routes` wrapped in `PageChrome`.

## Sequencing

Land together with the CMS plugin change (`plugins/ymerflow-cms/docs/plans/cms-page-chrome-and-branding.md`,
step P1), which assumes the host now provides the chrome.

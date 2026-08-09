# Auto-open "create project" dialog for new users with no projects

## Goal

When a user lands on the main app page (`/app/*`) and has zero projects, automatically open the
existing "create project" dialog instead of requiring them to find "Create New Project..." in the
project dropdown themselves.

This must coexist with the billing plugin's existing behavior of hard-redirecting brand-new /
lapsed-contract users to `/account/contract` right after login (see
`plugins/billing/frontend/src/ContractGuard.jsx`). The two can race: without coordination, the
create-project dialog could flash open for a moment before the billing redirect fires. The main
app must not gain any billing-specific knowledge to solve this — it may only coordinate through the
existing generic plugin hook system (`frontend/src/plugins/hooks.jsx`).

## Design decisions (confirmed with user)

1. **Reopen behavior: once per visit.** The dialog auto-opens at most once per arrival at `/app`.
   If the user dismisses it without creating a project, it does not reopen again until they
   navigate away from `/app` and back (which naturally happens if, e.g., they go set up a contract
   and return). This avoids a nagging re-open loop.
2. **No fail-open timeout on the billing check.** If the billing plugin's `/billing/my-contract`
   request stalls indefinitely, the auto-open dialog will also wait indefinitely rather than
   guessing after a timeout. This is a deliberate simplicity choice — a genuinely hung network
   request is treated as an edge case, not a normal path we defend against.
3. **New generic hook: `pending_redirects`** (`run_async`). Any plugin can register a handler of
   shape `async () => array` that:
   - Resolves once it has decided whether it is imminently navigating the user away from the
     current page (never intentionally left pending except in the "genuinely hung network call"
     edge case from decision 2).
   - Returns `[]` if it will not redirect.
   - Returns `[true]` if it will (or just did) redirect.
   The main app only ever calls `hooks.run_async.pending_redirects()` and checks whether any
   result is truthy — it has zero knowledge of billing/contracts. If no plugin registers this hook,
   the call resolves to `[]` immediately (dialog opens with no delay), so this degrades cleanly
   when the billing plugin isn't installed.

## Current state

- **Hook system** (`frontend/src/plugins/hooks.jsx`): `registerHook(name, fn)` /
  `hooks.run/run_async/run_jsx.<name>(...)`. `run_async` sequentially awaits every handler
  registered under a name and concatenates their (array) results — this would be its first
  consumer. Plugins only ever reach this via `window.__nagelfluh_registerHook` /
  `window.__nagelfluh_hooks` (module-federation bundles, no direct imports from the host).
- **Create-project dialog**: currently only manually triggered.
  `frontend/src/ProjectModal.jsx` is a dumb controlled `<Modal>` (`show`/`onHide`/`onSubmit(name)`).
  `frontend/src/ProjectDropdown.jsx` owns the only existing trigger today (a dropdown item), and
  the reference pattern for creating a project: `useCreateProject().mutateAsync(name)` (from
  `frontend/src/datamodel/useQueries.js`) → `setCurrentProject(newProject.id)` → close dialog.
- **Where `projects` lives**: `frontend/src/ProcessContext.jsx`'s `ProcessProvider` exposes
  `projects`, `projectsLoading`, `setCurrentProject` via `ProcessContext` (backed by
  `useProjects()`, a react-query hook).
- **Route structure** (`frontend/src/App.jsx`): `AuthenticatedApp` wraps the whole authenticated
  tree in plugin-contributed `app_providers` (`hooks.run_jsx.app_providers()`, `reduceRight`) once
  per full page load, **above** `<Routes>`. The `/app/*` route element itself
  (`MessageDisplay` + `MenuBarWithComponents` + `MainLayout`) is a *separate* subtree that
  unmounts/remounts whenever the user SPA-navigates away from `/app` and back (e.g. to
  `/account/contract` and back). This distinction matters: `app_providers`-mounted components
  (like billing's `ContractGuard`) see one mount per full page load; anything placed inside the
  `/app/*` route element sees one mount per visit to `/app`.
- **Billing plugin redirect** (`plugins/billing/frontend/src/ContractGuard.jsx`, registered via
  `app_providers` in `plugins/billing/frontend/src/index.jsx`): on first mount, once `user` is
  populated, fetches `GET /billing/my-contract` and — only if `needsContract` (no contract ever, or
  lapsed) **and** this is the one-shot "just authenticated" transition (`consumeJustAuthenticated()`
  on `AuthContext`, a signal that can only be consumed once) **and** not already on the contract
  page — does `window.location.href = '/account/contract'` (hard navigation). Otherwise it does
  nothing further (a separate `header_banners`-registered banner nudges non-redirect cases). Admins
  are exempt. This check runs at most once per full page load (`ranRef` guard).

## Implementation

### A. Main app (`frontend/`)

1. **New file `frontend/src/AutoCreateProjectDialog.jsx`**:
   - Reads `projects`, `projectsLoading`, `setCurrentProject` from `ProcessContext`, and uses
     `useCreateProject()` — the same building blocks `ProjectDropdown` already uses. No new
     project-creation logic; `ProjectModal` is reused as-is.
   - On mount, once `projectsLoading` is false: if `projects.length !== 0`, do nothing. Otherwise,
     await `hooks.run_async.pending_redirects()`; if none of the results are truthy (and the
     project list is still empty), open the dialog.
   - Guards the check with a ref so it runs at most once per mount (decision 1). Submitting the
     dialog follows `ProjectDropdown.handleCreateProject`'s exact pattern
     (`mutateAsync(name)` → `setCurrentProject(newProject.id)` → close).
2. **`frontend/src/App.jsx`**: mount `<AutoCreateProjectDialog />` as a sibling inside the `/app/*`
   route element (alongside `MessageDisplay`/`MenuBarWithComponents`/`MainLayout`) — this is the
   only edit to this file, and is what gives us "re-checks every time the user returns to `/app`"
   for free via React's normal mount/unmount.

No changes needed to `ProcessContext.jsx`, `ProjectModal.jsx`, `ProjectDropdown.jsx`,
`useQueries.js`, or `plugins/hooks.jsx`.

### B. Billing plugin (`plugins/billing/frontend/`)

3. **`plugins/billing/frontend/src/ContractGuard.jsx`**: expose the redirect decision it already
   computes, without a second fetch or a second `consumeJustAuthenticated()` call (that signal is
   one-shot):
   - Add a module-scoped promise (`pendingRedirectDecision`) plus its `resolve` function.
   - Every exit path of the existing effect (admin-exempt, fetch error, contract fine, already on
     contract page, or "about to redirect") calls `resolve(...)` exactly once with a boolean — the
     one case that does **not** resolve is a fetch that never settles at all (matches decision 2).
   - Export `export async function checkPendingRedirect() { return (await pendingRedirectDecision) ? [true] : [] }`.
4. **`plugins/billing/frontend/src/index.jsx`**: `import { checkPendingRedirect } from './ContractGuard'`
   and add `window.__nagelfluh_registerHook('pending_redirects', checkPendingRedirect)` alongside
   the existing registrations.

This mirrors the precedent in `plugins/billing/docs/plans/done/new-user-contract-nudge.md`, which
documented a small cross-repo dependency (a new hook call in the host) inside the billing plugin's
own plan rather than splitting it into a second plan file. Following the same convention here: the
root-repo change (section A) is primary and lives in this plan; the billing-plugin change (section
B) is a small, self-contained addition to an existing file, described here in full. **Flag during
review if you'd rather this repo's `CLAUDE.md` process apply strictly and have a mirrored plan
file committed in `plugins/billing/docs/plans/` before that repo's two-file change lands** — happy
to add one if you'd rather keep the repos' plan trails fully separate.

## Verification

- `cd frontend && npx vite build` (and, if there's a way to build/typecheck the billing plugin
  bundle standalone, run that too — will confirm the actual dev/build loop for the billing plugin
  before relying on any specific command).
- Manual, using already-running dev servers:
  1. Fresh signup, no contract set up → redirected to `/account/contract`; dialog never visibly
     flashes open first.
  2. Fresh signup with a contract already active (or an admin account), zero projects → no
     redirect; dialog opens automatically on `/app`.
  3. Existing user (not just-authenticated) with a lapsed contract and zero projects, loading
     `/app` directly → banner shows, no redirect, dialog still opens (redirect isn't pending for a
     non-just-authenticated session).
  4. From scenario 3: navigate to `/account` and back to `/app` → dialog opens again on remount.
  5. Create a project via the auto-opened dialog → dialog closes, project list refetches, dialog
     does not reopen for the remainder of that `/app` visit.
  6. No billing plugin installed at all → dialog opens immediately, no delay.

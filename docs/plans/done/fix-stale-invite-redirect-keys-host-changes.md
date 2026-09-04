# Host changes for `fix-stale-invite-redirect-keys`

## Context

This is the host-repo (main Nagelfluh) companion to the billing-plugin plan
`plugins/billing/docs/plans/done/fix-stale-invite-redirect-keys.md`. That plan fixes a
cross-user leak where a stashed pre-login destination survived into the next user's
session in the same tab and redirected them to the previous user's invite. It does so by
making the host's general `pendingPath` mechanism correct and self-clearing, then deleting
the billing plugin's redundant private `billingPendingInvitePath` key. The billing-side
edits live with that plan; the two host edits are recorded here.

## Changes made

### 1. `frontend/src/App.jsx` — URL-driven, self-clearing, general restore

Replaced the fullscreen-only `pendingPath` restore (which rendered the fullscreen
component while the browser URL still read `/`, and only cleared the key on the *non*-match
branch — so a matched key lingered, and ordinary project URLs were never restored) with a
consume-and-navigate:

```jsx
const pendingPath = sessionStorage.getItem('pendingPath');
if (pendingPath) {
  sessionStorage.removeItem('pendingPath');
  const here = location.pathname + location.search + location.hash;
  if (pendingPath !== here) return <Navigate to={pendingPath} replace />;
}
```

The key is now **always removed** the first time an authenticated render reaches this
point, so it can never cross into a later session. The target URL resolves through the
normal fullscreen / route checks on the next render, so this works for both fullscreen
plugin pages (e.g. the billing invite) and ordinary `/app/...` project URLs. The
`pendingPath !== here` guard avoids a redundant navigation/loop when the URL was already
preserved through login. `Navigate` and `location` were already in scope.

Knock-on effect (intended): after restore navigates to `/billing/invite/{token}`, the
`currentFullscreen` check just above short-circuits to the plugin's `InviteLandingPage`
**before** `AppWithContext`/`ContractGuard` mount — so the invite is shown to every user
type purely by render order, which is why the billing plugin can drop its special-case
invite branch.

### 2. `frontend/src/AuthContext.jsx` — clear stashes on logout (hardening)

In `logout()`, before `queryClient.clear()`:

```jsx
sessionStorage.removeItem('pendingPath');
sessionStorage.removeItem('pendingInviteToken');
```

Belt-and-suspenders: the restore in (1) already consumes `pendingPath` on the first
authenticated render, but clearing on logout also covers the project-invite token and
guarantees nothing survives the user boundary in a tab.

## Not changed

- No new hook and no `frontend/src/plugins/hooks.jsx` change — the fix needs no
  plugin-owned stash key, so there is nothing for a logout-cleanup hook to do.

## Verification

See the "Verification" section of the billing plan for the full single-tab test matrix
(cross-user leak, contract-less new user, admin/has-contract user, already-logged-in,
general project-URL restore, and the no-stash regression case).

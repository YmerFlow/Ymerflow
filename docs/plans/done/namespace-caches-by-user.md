# Namespace Client-Side Caches by User

## Overview

Several client-side caches survive a logout → login-as-different-user switch and
can display the previous user's data. Logout uses `navigate()` (no full page
reload — `UserMenu.jsx:35`), so nothing that lives in memory or IndexedDB is
torn down when the user changes.

This plan namespaces every persistent cache by a **stable user identifier**
(the immutable integer `user.id`) and resets the in-memory query cache when the
user changes, so no stale cross-user data is ever shown.

## Affected caches (inventory)

| Cache | Location | Current key | Persists across logout? |
|---|---|---|---|
| IndexedDB `YmerFlowCache` — stores `datasets`, `data`, `geography` | `datamodel/dataset.js:38` | `<id>` and `<id>-<partPath>` | Yes |
| IndexedDB `webxtile-<datasetId>` — per-dataset tile cache (store `tiles`) | `datamodel/webxtile.js:237` | DB name = `webxtile-<datasetId>` | Yes |
| TanStack Query in-memory cache | `App.jsx:104` | `queryKeys.*` (no user in key) | Yes (no reload on logout) |
| `localStorage` `auth_token` / `auth_user` | `AuthContext.jsx` | — | Already cleared on logout ✓ |
| `sessionStorage` `pendingInviteToken` / `pendingPath` | `App.jsx` | — | Transient, no user data ✓ |

Only the first three need work. localStorage/sessionStorage are already handled
or carry no user-specific cached data.

## Design Decisions

- **Namespace value: stable integer `user.id`, not `username`.** Immune to a
  future username rename/reuse. When logged out (anonymous publication viewing),
  the namespace is the literal string `anon`.
- **IndexedDB `YmerFlowCache`: prefix every key**, not per-user database and not
  clear-on-logout. Keeps each user's cache warm across sessions (the point of
  prefixing) and needs no teardown. Old users' entries linger but are reclaimed
  by the existing LRU quota eviction.
- **IndexedDB `webxtile-*`: prefix the database name** (`webxtile-<ns>-<datasetId>`)
  rather than a key, because webxtile owns its own single-store DB per dataset —
  the namespace has to move into the DB name.
- **TanStack Query: reset, don't prefix.** Prefixing every query key with the
  user id would touch the entire `queryKeys` registry and every inline key. The
  cache is in-memory only (no persister), so calling `queryClient.clear()` when
  the user changes is simpler and fully sufficient — active observers refetch
  under the new token automatically.
- **Single source of truth for the namespace: `localStorage.auth_user`.** The
  cache modules are plain (non-React) modules. Reading the current user id from
  `auth_user` at key-build time (the same source `AuthContext` hydrates from,
  and the same pattern `api.js:38` uses for the token) guarantees the value is
  always current — even immediately after a user switch — with no module-level
  staleness.

## Architecture

### 1. Shared namespace helper

New tiny module `frontend/src/datamodel/cacheNamespace.js`:

```javascript
// Current cache namespace = the logged-in user's stable id, or "anon".
// Read from localStorage (the same source AuthContext hydrates from) so the
// value is always current, even right after a user switch with no page reload.
export function cacheNamespace() {
  try {
    const raw = localStorage.getItem('auth_user');
    if (!raw) return 'anon';
    const { id } = JSON.parse(raw);
    return id != null ? String(id) : 'anon';
  } catch {
    // Malformed auth_user must not silently poison the cache namespace —
    // fall back to anon rather than throwing inside a cache read/write.
    return 'anon';
  }
}
```

> **Prerequisite (verified 2026-08-28): `user.id` is currently NOT in the payload.**
> `User.to_dict()` (`backend/models/user.py:24-35`) returns `username`, `email`,
> `is_admin`, `preferences` (plus billing-plugin `balance`/`usage`) — **no `id`**.
> So `auth_user` never carries it today. Fix: add `"id": self.id` to
> `User.to_dict()`. This is safe — all five `User.to_dict()` call sites are in
> `backend/routers/auth.py` (signup, login, account get/update, tos-accept) and
> every one serializes the *authenticated user's own* record; other users are
> serialized via a separate `ProjectMember.to_dict()`, so no cross-user id is
> ever exposed. The frontend already stores `result.user` verbatim into
> `auth_user`, so no frontend change is needed once `to_dict()` includes `id`.

### 2. `YmerFlowCache` IndexedDB — prefix keys

In `datamodel/dataset.js`, thread the namespace into the two central helpers so
**all** call sites are covered automatically (there are 5 `cacheKey =` sites:
lines 366, 499, 697, 804, 980):

```javascript
import { cacheNamespace } from './cacheNamespace';

// getFromCache / putInCache build the real stored key from the caller's key:
const nsKey = `${cacheNamespace()}:${key}`;
```

Apply in `getFromCache` (line 168), `putInCache` (line 197), and the
`store.put(result, key)` lastAccessed-bump inside `getFromCache` (line 182) so
the bumped write targets the same namespaced key.

`evictOldest()` (line 232) cursors raw stored keys across all stores and evicts
the globally-oldest entry regardless of namespace — this is a global quota
manager and is left unchanged (one user hitting quota may evict another user's
cold entries; acceptable). Add a one-line comment noting keys are now
namespaced.

### 3. `webxtile-*` IndexedDB — prefix DB name

In `datamodel/webxtile.js:235-239`, change the loader DB name:

```javascript
import { cacheNamespace } from './cacheNamespace';
// ...
new WebxtileLoader(url, { dbName: `webxtile-${cacheNamespace()}-${this.id}`, ... })
```

No change needed inside the `webxtile` package — it just opens whatever DB name
it's given.

### 4. TanStack Query — reset on user change

Extract the module-level `queryClient` out of `App.jsx:104-111` into its own
module `frontend/src/datamodel/queryClient.js` and export it, so both `App.jsx`
and `AuthContext.jsx` can import the same singleton:

```javascript
// datamodel/queryClient.js
import { QueryClient } from '@tanstack/react-query';
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});
```

`App.jsx` imports it instead of constructing it inline.

In `AuthContext.jsx`, clear the query cache on both `login()` and `logout()`
(the two explicit user-change transitions). The mount-time session *restore*
(lines 31-42) is the **same** user and starts from an empty cache anyway, so it
is intentionally left alone.

```javascript
import { queryClient } from './datamodel/queryClient';

const login = useCallback((userData, authToken) => {
  // ...existing...
  queryClient.clear();   // drop any prior user's cached queries; observers refetch
}, []);

const logout = useCallback(() => {
  // ...existing...
  queryClient.clear();
}, []);
```

`queryClient.clear()` removes all cached queries; mounted `useQuery` observers
immediately refetch under the new (or absent) auth token, so the new user sees
their own data and a logged-out user sees empty/anonymous results.

## Implementation Steps

1. **Prerequisite** — add `"id": self.id` to `User.to_dict()`
   (`backend/models/user.py:24`). Verified NOT present today (2026-08-28); safe to
   add (all `User.to_dict()` call sites serialize the caller's own record). No
   frontend change needed — `auth_user` already stores the full `result.user`.
2. Add `frontend/src/datamodel/cacheNamespace.js` with `cacheNamespace()`.
3. `dataset.js`: namespace keys in `getFromCache`, `putInCache`, and the
   lastAccessed-bump write. Comment `evictOldest` as namespace-agnostic.
4. `webxtile.js`: namespace the `dbName` passed to `WebxtileLoader`.
5. Extract `queryClient` into `datamodel/queryClient.js`; import it in `App.jsx`.
6. `AuthContext.jsx`: `import { queryClient }` and call `queryClient.clear()` in
   `login()` and `logout()`.

## Verification

- Log in as user A, open a dataset (populates `YmerFlowCache` + a `webxtile-*`
  DB + query cache). In DevTools → Application → IndexedDB, confirm keys are
  prefixed `A_id:...` and the tile DB is `webxtile-A_id-<datasetId>`.
- Log out, log in as user B **without reloading**. Confirm: the project/workspace
  list shows B's data immediately (query cache cleared), and B's dataset reads
  create new `B_id:...` / `webxtile-B_id-*` entries rather than reading A's.
- Log back in as A; confirm A's cache entries are still present (warm cache — the
  benefit of prefixing over clearing).
- Anonymous publication link (logged out): confirm entries are namespaced `anon:`
  and don't collide with any logged-in user's cache.

## Non-goals

- **Evicting a departed user's cached data.** Prefixing intentionally keeps it
  for when they return; the existing LRU quota eviction reclaims space as needed.
  A future "clear my cached data" account action could delete all entries whose
  key/DB-name matches the current namespace, but is out of scope here.
- **Per-instance in-memory dataset caches** (`this._dataCache`,
  `this._geographyCache`) — these live on freshly-created `Dataset` instances and
  are rebuilt when queries refetch after the query-cache reset; no namespacing
  needed.
- Namespacing `localStorage`/`sessionStorage` — they hold no cross-user cached
  data (auth keys are already cleared on logout; pending-nav keys are transient).

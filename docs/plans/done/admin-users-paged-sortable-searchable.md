# Admin Users List — Paged, Sortable & Searchable

## Goal

Turn the admin **Users** list (`/admin/users` tab) from a fetch-everything-and-render table into a
server-paged, server-sorted, server-searched table:

1. **Paged** — numbered page controls (Prev / 1 2 3 … / Next) with a total count
   ("Showing 51–75 of 431 users"). Default page size **25**.
2. **Sortable** — click a column header to sort by that column; click again to flip direction.
   Sortable columns: **Username**, **Email**, **Admin?**.
3. **Searchable** — a single search box that matches a **substring** of **either** username **or**
   email (case-insensitive). One box, both fields.
4. **URL-persisted state** — search term, sort column, sort direction, and page live in the URL
   query string, so a filtered/sorted view is reload-safe and shareable
   (`/admin/users?q=acme&sort=email&dir=asc&page=3`).

All paging/sorting/searching happens **server-side** — that is the whole point (the current
endpoint returns every user, which won't scale). No expensive work moves into the backend beyond a
bounded `SELECT` with `LIMIT`/`OFFSET`, which the DB indexes handle.

---

## Background & Current State

### Backend — no pagination

`backend/routers/auth.py` (mounted under the `/auth` prefix):

```python
@router.get("/admin/users")
async def admin_list_users(auth: AuthContext = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """List all users (admin only)."""
    stmt = select(User).order_by(User.username)
    result = await db.execute(stmt)
    users = result.scalars().all()
    return [{"username": u.username, "email": u.email, "is_admin": u.is_admin} for u in users]
```

Returns a bare JSON **array** of every user. No `limit`/`offset`/`sort`/`search` params, no total.

### User model — `backend/models/user.py`

```python
username = Column(String(255), unique=True, nullable=False, index=True)
email    = Column(String(255), unique=True, nullable=True,  index=True)   # nullable!
is_admin = Column(Boolean, default=False, nullable=False, server_default="0")
```

Both `username` and `email` are indexed. `email` is **nullable** — search and sort must tolerate
NULL emails. `username` is stored lowercased (see `admin_set_user_admin` which lowercases input).

### Frontend

- **API layer** `frontend/src/datamodel/api.js`:
  ```js
  export async function listAdminUsers() {
    const response = await apiClient.get('/auth/admin/users');
    return response.data;   // array
  }
  ```
- **Query hook** `frontend/src/datamodel/useAuthQueries.js`:
  ```js
  export function useAdminUsers() {
    return useQuery({ queryKey: ['adminUsers'], queryFn: listAdminUsers });
  }
  export function useSetUserAdmin() {
    return useMutation({ mutationFn: ..., onSuccess: () => queryClient.invalidateQueries(['adminUsers']) });
  }
  ```
- **Component** `frontend/src/AdminPage.jsx` → `UsersAdminPanel`: `const { data: users = [] } = useAdminUsers();`
  then `users.map(...)` into a react-bootstrap `<Table>`. No page/sort/search UI.
- The `/admin/:tab?` route already exists (see `docs/plans/done/admin-page-and-url-routed-tabs.md`).
  We add **query-string** state on top of the existing path-segment tab routing — the two don't
  collide (path segment = which tab; query string = this tab's paging state).

---

## Design Decisions

### Decision 1: Paging mechanism — **offset/limit, numbered pages** (chosen)

Server accepts `limit` + `offset`; response includes `total`. Frontend renders numbered page
controls and "Showing X–Y of N". Rejected: cursor pagination / infinite scroll — awkward to combine
with arbitrary column sorting and page-jumping, and a users table is small enough that deep-offset
cost is a non-issue.

### Decision 2: State in the **URL query string** (chosen)

`?q=&sort=&dir=&page=` on top of the `/admin/users` path. Deep-linkable, reload-safe, consistent
with the admin area already being URL-routed. Read/written via react-router's `useSearchParams`.

### Decision 3: Search semantics — **case-insensitive substring, username OR email** (chosen)

A single `q` param. Server filters `lower(username) LIKE %q%` **OR** `lower(email) LIKE %q%`.
Case-insensitive via `ILIKE` (Postgres) or `lower()`-wrapping (portable — used here to stay
DB-agnostic since dev may be SQLite). Empty/missing `q` = no filter. `q` is matched literally as a
substring; `%` and `_` in user input are escaped so they aren't treated as LIKE wildcards.

### Decision 4: Sort — **whitelist of columns, both directions** (chosen)

`sort ∈ {username, email, is_admin}` (default `username`), `dir ∈ {asc, desc}` (default `asc`).
The column name is validated against a server-side whitelist (never interpolated raw) to avoid
injection and invalid-column errors. NULL emails sort consistently (they group at one end; exact
end is DB-dependent and acceptable). A secondary `username asc` tiebreak keeps ordering stable
across pages (critical for `is_admin`, which has only two values).

### Decision 5: Response shape — **`{ items, total }`** (chosen)

```json
{ "items": [ { "username": "...", "email": "...", "is_admin": false }, ... ], "total": 431 }
```

`total` is the count **after** the search filter (so the page control reflects the filtered set).
This is a **breaking change** to the endpoint's response shape (array → object); the only caller is
our own frontend, updated in the same change. No external API consumers.

### Decision 6: Default page size — **25** (chosen)

`limit` defaults to 25. Server clamps `limit` to a sane max (e.g. 200) to prevent a client asking
for everything. Page size is fixed in the UI for v1 (no page-size selector) to keep scope tight; a
selector can be added later.

---

## Backend Design

### `GET /auth/admin/users` (rewritten) — `backend/routers/auth.py`

Query params (all optional):

| Param    | Type | Default    | Notes |
|----------|------|------------|-------|
| `q`      | str  | `None`     | substring match on username OR email, case-insensitive |
| `sort`   | str  | `username` | one of `username`, `email`, `is_admin` (whitelist) |
| `dir`    | str  | `asc`      | `asc` or `desc` |
| `limit`  | int  | `25`       | clamped to `[1, 200]` |
| `offset` | int  | `0`        | clamped to `>= 0` |

Sketch:

```python
from sqlalchemy import select, func, or_

SORTABLE = {"username": User.username, "email": User.email, "is_admin": User.is_admin}

@router.get("/admin/users")
async def admin_list_users(
    q: str | None = None,
    sort: str = "username",
    dir: str = "asc",
    limit: int = 25,
    offset: int = 0,
    auth: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    sort_col = SORTABLE.get(sort, User.username)
    order = sort_col.desc() if dir == "desc" else sort_col.asc()

    base = select(User)
    if q:
        # escape LIKE wildcards in user input, match as a literal substring
        needle = "%" + q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        base = base.where(or_(
            func.lower(User.username).like(needle, escape="\\"),
            func.lower(User.email).like(needle, escape="\\"),
        ))

    total = await db.scalar(select(func.count()).select_from(base.subquery()))

    stmt = base.order_by(order, User.username.asc()).limit(limit).offset(offset)
    users = (await db.execute(stmt)).scalars().all()

    return {
        "items": [{"username": u.username, "email": u.email, "is_admin": u.is_admin} for u in users],
        "total": total,
    }
```

Notes:
- `require_admin` dependency and route path are unchanged.
- No DB migration — existing indexes on `username`/`email` cover the sort/filter.
- `func.lower(...).like(...)` is portable across Postgres (prod) and SQLite (dev). `ILIKE` would be
  Postgres-only; `lower()` keeps it DB-agnostic.
- Secondary `User.username.asc()` tiebreak guarantees stable paging under low-cardinality sorts.

---

## Frontend Design

### `frontend/src/datamodel/api.js`

```js
export async function listAdminUsers({ q, sort, dir, limit, offset } = {}) {
  const response = await apiClient.get('/auth/admin/users', {
    params: { q: q || undefined, sort, dir, limit, offset },
  });
  return response.data;   // { items, total }
}
```

### `frontend/src/datamodel/useAuthQueries.js`

```js
export function useAdminUsers(params) {
  return useQuery({
    queryKey: ['adminUsers', params],           // params in the key → refetch on any change
    queryFn: () => listAdminUsers(params),
    keepPreviousData: true,                      // avoid table flicker on page/sort change
  });
}
```

`useSetUserAdmin` is unchanged **except** its `onSuccess` invalidates the `['adminUsers']` prefix so
every param-keyed page refetches: `queryClient.invalidateQueries({ queryKey: ['adminUsers'] })`.

### `frontend/src/AdminPage.jsx` — `UsersAdminPanel` rewrite

State from the URL via `useSearchParams`:

```js
const [searchParams, setSearchParams] = useSearchParams();
const q     = searchParams.get('q')    || '';
const sort  = searchParams.get('sort') || 'username';
const dir   = searchParams.get('dir')  || 'asc';
const page  = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
const PAGE_SIZE = 25;
const offset = (page - 1) * PAGE_SIZE;

const { data, isLoading, isFetching } = useAdminUsers({ q, sort, dir, limit: PAGE_SIZE, offset });
const users = data?.items ?? [];
const total = data?.total ?? 0;
const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
```

Helpers that write back to the URL (merging, not clobbering, so the `:tab` path is untouched):

```js
const update = (patch) => setSearchParams(prev => {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v == null) next.delete(k); else next.set(k, v);
  }
  return next;
}, { replace: true });

const onSearch = (value) => update({ q: value, page: 1 });   // reset to page 1 on new search
const onSort = (col) => update({
  sort: col,
  dir: sort === col && dir === 'asc' ? 'desc' : 'asc',
  page: 1,
});
const goToPage = (p) => update({ page: p });
```

UI additions inside the existing `<Card.Body>`:

- **Search box** above the table: a `<Form.Control>` bound to `q`. Debounce (~300 ms) so typing
  doesn't fire a request per keystroke; on debounce fire `onSearch(value)`.
- **Sortable headers**: each `<th>` becomes clickable (`onClick={() => onSort('username')}`) with a
  ▲/▼ indicator on the active column. `is_admin` header sorts too.
- **Table body**: unchanged row rendering (`users.map(...)`), including the existing
  make-admin/revoke button and the `disabled` self-guard.
- **Footer / pager**: "Showing {offset+1}–{offset+users.length} of {total}" plus numbered page
  controls (react-bootstrap `<Pagination>`). Disable Prev on page 1, Next on last page. Optionally
  dim the table (`isFetching`) while a new page loads (`keepPreviousData` keeps the old rows visible).
- **Empty state**: when `total === 0`, show "No users match '{q}'." instead of an empty table.

No other admin panels or the shared `TabbedPage` change — the query string is scoped to this tab's
component and ignored by the tab router.

---

## Migration / Compatibility

- **No DB migration** — read-only query changes; existing indexes suffice.
- **Breaking response-shape change** (array → `{items, total}`) on `GET /auth/admin/users`. Only
  consumer is our frontend, updated atomically in the same change. Searched the repo: no other
  caller. (If a plugin or MCP tool turns out to call it, it must be updated too — verify during
  implementation with a repo-wide grep for `admin/users`.)
- **Old links**: `/admin/users` with no query params behaves as before (page 1, sorted by username,
  no filter) — the defaults reproduce the prior view (minus showing only the first 25).

---

## Implementation Steps

1. **Backend** — rewrite `admin_list_users` in `backend/routers/auth.py`: add `q/sort/dir/limit/offset`
   params, whitelist sort columns, escaped case-insensitive OR-substring filter, `total` count,
   `{items, total}` response, clamps, stable secondary sort. Add `func`, `or_` imports if missing.
2. **API layer** — update `listAdminUsers` in `frontend/src/datamodel/api.js` to pass params and
   return `{items, total}`.
3. **Query hook** — update `useAdminUsers` in `frontend/src/datamodel/useAuthQueries.js` to take
   `params`, include them in `queryKey`, set `keepPreviousData`. Keep `useSetUserAdmin` invalidating
   the `['adminUsers']` prefix.
4. **Component** — rewrite `UsersAdminPanel` in `frontend/src/AdminPage.jsx`: `useSearchParams`
   state, debounced search box, sortable headers with direction indicators, numbered `<Pagination>`,
   count line, empty state. Preserve the existing make/revoke-admin button and self-guard.
5. **Manual verification** (below).

---

## Verification

- **Paging**: with > 25 users, first load shows 25 rows + "Showing 1–25 of N" + numbered pager.
  Clicking page 2 loads the next 25 and updates the URL to `?page=2`; reload stays on page 2.
- **Search**: typing a substring present in some usernames and a different substring present only in
  emails each filter correctly; matching neither yields the empty state. Search resets to page 1 and
  writes `?q=`. Case-insensitive (upper/lowercase query find the same rows). A user with NULL email
  still matches on username and doesn't error.
- **Sort**: clicking Username / Email / Admin? headers sorts server-side; a second click flips
  direction; the active header shows ▲/▼; URL reflects `?sort=&dir=`. Paging stays stable when
  sorted by Admin? (secondary username tiebreak — no rows repeat/skip across pages).
- **URL round-trip**: `/admin/users?q=acme&sort=email&dir=desc&page=2` loads that exact view on a
  cold reload/share.
- **Combination**: search + sort + page compose (e.g. filtered set re-paginates; `total` reflects
  the filtered count, pager shrinks accordingly).
- **Admin action still works**: make-admin / revoke-admin from a row refetches the current page;
  the self-row button stays disabled.
- **Regression**: bare `/admin/users` (no query) shows page 1 sorted by username; other admin tabs
  unaffected.

---

## Open Questions

- [ ] LIKE-wildcard escaping form — the `escape="\\"` + manual `%`/`_` escaping above is portable;
      confirm it behaves identically on the prod Postgres and dev SQLite during implementation.
- [ ] Whether to add a page-size selector (25/50/100) now or defer — plan defers to keep scope tight;
      easy to add later since `limit` is already a param.

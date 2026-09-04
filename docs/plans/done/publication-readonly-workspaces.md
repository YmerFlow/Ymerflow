# Read-Only Publications Must Carry Workspaces

## Goal

Make workspaces visible through the read-only publication scheme, to the same audience that is
already allowed to view the read-only project — including anonymous (not-logged-in) visitors when
the publication permits anonymous access. Also make globally-public workspaces
(searchable + superpublic-in-toolbar) readable without logging in, exactly as they are for a
logged-in user.

This builds directly on `docs/plans/done/publication-readonly-projects.md` (the read-only
publication feature). That plan explicitly left workspaces out of scope
("`Workspace` has no `project_id` FK … out of scope, unchanged" — which was wrong: `Workspace`
*does* have a `project_id`, and the read scheme should have covered it). This plan closes that gap.

**No database schema change. No migration.** The `workspaces` table already has everything needed
(`project_id`, `is_public`, `superpublic`). This is purely an access-control change on three read
endpoints plus threading the viewing-project id through a few frontend calls.

---

## Symptoms (the bugs being fixed)

1. **Anonymous + publication link → no workspaces at all, not even superpublic ones.**
2. **Logged-in + publication link → the publication project's own workspaces are invisible.**
3. **Superpublic / public workspaces are not readable when logged out.**

The frontend is already written for this flow — it just never receives the data:

- `WorkspaceMenu.jsx`'s `WorkspaceList` already merges `useWorkspaces(currentProject)` +
  `usePublicWorkspaces().filter(w => w.superpublic)` + a pinned cross-project workspace, and
  `SaveCurrentWorkspaceItem` already disables editing via the `!p.read_only` guard against the
  `projects` list (publication entries are pinned with `read_only: true` by `GET /projects`).
- `PublicWorkspaceSearch` already searches `usePublicWorkspaces()` by title, and "using" a result
  is just navigation; forking only happens on save.

So the fix is almost entirely backend: three read endpoints never joined the publication /
optional-auth scheme.

---

## Root Cause (backend, `backend/routers/workspaces.py`)

| Endpoint | Line | Current dependency | Failure |
|---|---|---|---|
| `GET /workspaces?project_id=` (`list_workspaces`) | 207 | `require_project_member` | Publication id (or anonymous) → **403**. Bugs 1 & 2. |
| `GET /workspaces/public` (`list_public_workspaces`) | 230 | `get_current_user` | Anonymous → **401**. Bug 1 (superpublic) & Bug 3. |
| `GET /workspace/{id}` (`get_workspace`) | 786 | `get_current_user` + member-or-`is_public` check | Anonymous → **401**; no publication read path for a project's non-public workspaces. Bugs 1, 2, 3. |

Write endpoints (`create_workspace`, `create_workspace_version`, `update_workspace`,
`fork_workspace`, `delete_workspace`) all go through `require_project_member` /
`_require_workspace_member`, which require **real membership** and already 403 a publication id or
anonymous caller. Read-only is therefore enforced by construction — **these are not changed**, only
verified.

The read primitives to reuse already exist in `backend/services/auth_service.py`:
`get_current_user_optional` (returns `None` instead of 401) and
`resolve_project_for_read(project_id, ...) -> ProjectReadAccess{project, read_only, publication}`
(resolves a value as a real membership *or* a publication id, honoring `allow_anonymous`).

---

## Design Decisions (confirmed with operator)

### 1. A readonly publication link carries **all** of the project's workspaces (chosen)

When viewing project P through a publication, the link exposes **every** workspace whose
`project_id == P` (public or not), read-only, to whatever audience may view the publication
(anonymous iff `allow_anonymous`, otherwise any logged-in user). The publication is a full
read-only view of the project, and its workspaces are part of that view.

*Rejected:* exposing only the project's own `is_public`/`superpublic` workspaces — that would hide
a project's real layouts from the very people the owner shared the project with.

### 2. Globally-public workspaces are readable by everyone, including anonymous (chosen)

There is no login-gated "fork gallery." `GET /workspaces/public` backs a **search** (search public
workspaces → open one → forking happens only on *save*, which still requires membership). Anonymous
visitors get the **same** full `is_public` list as logged-in users. `superpublic` remains the
subset the toolbar auto-lists (client-side `filter(w => w.superpublic)`), and superpublic workspaces
are — by being `is_public` — anonymously readable too, satisfying "superpublic must be readable when
not logged in."

*Rejected:* restricting anonymous callers to `superpublic` only — the operator confirmed the public
search must work identically for anonymous users.

### 3. `get_workspace` stays keyed on `workspace_id` with an optional viewing `project_id` (chosen)

`get_workspace` serves two roles at once: fetching a globally-public workspace (which belongs to
some *other* project — e.g. the pinned/`default` superpublic one) and fetching a workspace of the
project currently being viewed. The frontend already calls it with just an id. Rather than move it
under `/projects/{project_id}/...` (which would break the global-public case, where the viewer isn't
scoped to that workspace's project), add an **optional** `project_id` query param that carries the
current viewing context (the publication id, when viewing a publication). Access is then the union
of a global-public path and a publication-scoped path — see below.

*Rejected:* a looser "does the workspace's project have *any* publication?" check — that would let
any logged-in non-member read any workspace of any project that has any publication, which is looser
than the rest of the publication system (where you must present a specific publication id).

---

## Backend Changes (`backend/routers/workspaces.py`)

### `list_workspaces` (line 207)

Swap `Depends(require_project_member)` for `Depends(resolve_project_for_read)`; filter on the
resolved project id:

```python
@router.get("s", operation_id="list_workspaces")
async def list_workspaces(
    project_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Workspace)
        .options(*_WORKSPACE_LOAD_OPTIONS)
        .where(Workspace.project_id == access.project.id)
    )
    ...
    return [w.to_dict() for w in workspaces]
```

`resolve_project_for_read` handles all three audiences at once: logged-in member (`read_only=False`),
logged-in publication viewer, and anonymous publication viewer (when `allow_anonymous`). It already
404s an unknown id and 401s an anonymous caller against a non-anonymous publication. Import
`resolve_project_for_read` and `ProjectReadAccess` from `services.auth_service`.

### `list_public_workspaces` (line 230)

Swap `get_current_user` for `get_current_user_optional`. Behavior is otherwise unchanged — it still
returns every `is_public` workspace; the only difference is that an anonymous caller now gets the
list instead of a 401. `auth` becomes unused (drop it, or keep as `_auth` for symmetry).

```python
@router.get("s/public", operation_id="list_public_workspaces")
async def list_public_workspaces(
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.is_public == True)  # noqa: E712
    ...
```

### `get_workspace` (line 786)

Switch to `get_current_user_optional`, add an optional `project_id` viewing-context query param, and
replace the member-or-`is_public` check with a helper that allows a read if **any** of:

- **A. Globally public** — `workspace.is_public` (covers superpublic, which implies `is_public`):
  anyone, including anonymous.
- **B. Member** — caller is authenticated and is a `ProjectMember` of `workspace.project_id`.
- **C. Publication-scoped** — a `project_id` viewing context was supplied, it resolves (via the same
  logic as `resolve_project_for_read`) to a project/publication this caller may read, **and**
  `workspace.project_id == resolved.project.id`. This is what carries the publication's read access
  down to the project's private workspaces (Decision 1), for both anonymous and logged-in viewers.

Otherwise 404 (same opaque "Workspace not found" as today — don't distinguish 401/403/404 for a
read miss on an unguessable UUID).

Sketch:

```python
@router.get("/{workspace_id}", operation_id="get_workspace")
async def get_workspace(
    workspace_id: str,
    project_id: Optional[str] = None,   # viewing context: real project id OR publication id
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    workspace = (await db.execute(
        select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.id == workspace_id)
    )).scalar_one_or_none()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    if not await _can_read_workspace(workspace, project_id, auth, db):
        raise HTTPException(status_code=404, detail="Workspace not found")

    return workspace.to_dict(project_name=workspace.project.name if workspace.project else None)
```

`_can_read_workspace(workspace, project_id, auth, db) -> bool` implements A/B/C. For path C, reuse
`resolve_project_for_read`'s resolution rather than duplicating it — factor the pure resolution
(no `Depends`) into a helper in `auth_service.py` (e.g. `try_resolve_project_for_read(project_id,
auth, db) -> ProjectReadAccess | None`) that both the dependency and this helper call, so the
"real-membership-or-publication, honor `allow_anonymous`" logic lives in exactly one place. Path C
returns True iff that helper yields a `ProjectReadAccess` whose `project.id == workspace.project_id`.

---

## Frontend Changes

### Thread the viewing project into `getWorkspace` / `useWorkspace`

`get_workspace` path C needs the current viewing `project_id`. Today the frontend calls
`getWorkspace(workspaceId)` with no context, so a publication viewer fetching one of the project's
non-public workspaces by id would 404.

- `frontend/src/datamodel/api.js` (`getWorkspace`, line 602): accept an optional `projectId` and
  send it as a query param —
  `apiClient.get(\`/workspace/${workspaceId}\`, { params: projectId ? { project_id: projectId } : {} })`.
- `frontend/src/datamodel/useQueries.js` (`useWorkspace`, line 512): accept `projectId`, include it
  in the query key (`queryKeys.workspace(id, projectId)` — extend the key factory at line 79 to
  `(id, projectId) => ['workspace', id, projectId ?? null]` so a global fetch and a
  publication-scoped fetch don't collide in cache), and pass it to `getWorkspace`.
- Update `useWorkspace` call sites to pass `currentProject` as the viewing context:
  - `WorkspaceMenu.jsx:71` (pinned), `:102` and `:210` (SaveCurrent / current) — pass
    `currentProject`.
  - `WorkspaceLayoutSync.jsx:20`, `ProcessContext.jsx:215` — pass `currentProject`.
  - `AppBootstrap.jsx:26` (`useWorkspace('default')`) — **no** project needed; `default` is
    superpublic → path A. Leave as-is.

### No change needed to `useWorkspaces` / `usePublicWorkspaces`

- `useWorkspaces(currentProject)` — signature unchanged; the backend now accepts a publication id
  there. It's already `enabled: !!projectId`, and `currentProject` holds the publication id when
  viewing a publication.
- `usePublicWorkspaces()` — already ungated (no `enabled: isAuthenticated`), so it runs for
  anonymous visitors and now succeeds. No change.

### Anonymous app-shell gating

The read-only publication plan already relaxed the `/app/*` shell to render for an anonymous viewer
when a `p` (project/publication) URL segment is present. Confirm during implementation that, in that
anonymous state, `usePublicWorkspaces()` and `useWorkspaces(currentProject)` actually fire (they
should, per above) — this is the one integration point to eyeball rather than assume.

---

## Implementation Steps

1. **`auth_service.py`**: extract `try_resolve_project_for_read(project_id, auth, db)` (the
   dependency-free resolver returning `ProjectReadAccess | None`); have the existing
   `resolve_project_for_read` dependency call it (and raise 404/401 as it does today).
2. **`workspaces.py` `list_workspaces`**: `require_project_member` → `resolve_project_for_read`;
   filter on `access.project.id`.
3. **`workspaces.py` `list_public_workspaces`**: `get_current_user` → `get_current_user_optional`.
4. **`workspaces.py` `get_workspace`**: `get_current_user_optional`, optional `project_id` param,
   `_can_read_workspace` helper (paths A/B/C).
5. **Frontend**: optional `projectId` through `getWorkspace` → `useWorkspace` (+ query-key), pass
   `currentProject` at the five call sites above (not `AppBootstrap`'s `'default'`).
6. Manual verification (below).

---

## Verification

Set up: a project P with (a) a private workspace, (b) an `is_public` non-superpublic workspace,
plus the global superpublic `default`. Create a publication for P with `allow_anonymous = true`, and
a second with `allow_anonymous = false`.

- **Anonymous + anonymous-allowed publication link**: toolbar workspace dropdown shows P's
  workspaces (all of them) **and** `default` (superpublic); the public-workspace search finds P's
  `is_public` workspace and any other project's public ones; opening any of them renders read-only;
  **Save** is disabled; a direct `POST/PATCH/DELETE` to a workspace endpoint → 403.
- **Anonymous + non-anonymous publication link**: workspace endpoints for P → 401 (login required),
  matching how the rest of that publication behaves.
- **Anonymous, no publication at all**: `GET /workspaces/public` succeeds and the search works;
  `GET /workspaces?project_id=<real P>` → 404/401 (no read access to P without a publication);
  `GET /workspace/<P's private ws>` (no `project_id`) → 404; `GET /workspace/<default>` → 200.
- **Logged-in non-member + publication link**: P's workspaces appear read-only in the dropdown;
  Save disabled; writes 403. Their own projects' workspaces remain editable.
- **Logged-in member of P (no publication)**: unchanged — all of P's workspaces editable, Save works,
  public search + fork-on-save unchanged.
- **`get_workspace` isolation**: `GET /workspace/<P's private ws>?project_id=<publication for P>` →
  200; the same with `?project_id=<publication for a *different* project>` → 404 (path C requires the
  workspace to belong to the resolved project).

---

## Out of Scope

- No schema/migration changes.
- No change to write endpoints or to the fork-on-save flow.
- No new discovery UI; the existing toolbar dropdown and public-workspace search are reused verbatim.

# Unify Project/Workspace Toolbar Widgets & Two-Tier Publishing

## Goal

Two related asymmetries between projects and workspaces, fixed together:

1. **Toolbar widget**: the current project shows as a live "Project: `<name>`" button in the
   toolbar; the current workspace doesn't — "Workspaces" is a static label with no binding to
   what's actually loaded. Give workspaces the same kind of widget projects already have.
2. **Public visibility**: projects and workspaces each have a single "public" flag today, with
   different discovery UX (findable projects are merged straight into everyone's project list;
   public workspaces require opening a dialog and searching). Both gain a second, admin-only tier:

   - **public** (any project/workspace member can set): discoverable via a search combobox.
   - **superpublic** (site admins only): listed directly in the menu, no search needed.

   Superpublic implies public. Both projects and workspaces get this same two-tier model, each
   built on top of their own existing storage shape (`Publication` rows for projects,
   a flat column for workspaces) rather than merging the two into one schema.

The "Public Workspaces" dialog (`WorkspaceSharingModal.jsx`) loses its discovery tab — that job
moves into the new toolbar widget's combobox — and becomes a single-purpose "Publish Workspaces"
dialog.

---

## Background & Current State

### Toolbar: two different widget patterns

`MenuBarWithComponents` (`frontend/src/App.jsx:138-143`) renders `<UserMenu/><WorkspaceMenu/><MenuBar/>`
and registers two more components directly into the flexout menu tree:

```js
function MenuBarWithComponents() {
  useRegisterMenuComponent(["_projectDropdown"], ProjectDropdown, -2);
  useRegisterMenuComponent(["_processSelector"], ProcessSelector, -1);
  return <><UserMenu /><WorkspaceMenu /><MenuBar /></>;
}
```

- **`ProjectDropdown`** (`frontend/src/ProjectDropdown.jsx`) is a self-contained react-bootstrap
  `<Dropdown>`. Its toggle label is dynamic: `Project: {currentProjectObj ? currentProjectObj.name : 'None'}`
  (line 48). It's registered as a top-level component (position `-2`), so `MenuBar`
  (`frontend/src/flexout/MenuBar.jsx:76-84`) renders it verbatim instead of building a generic
  dropdown around it.
- **`WorkspaceMenu`** (`frontend/src/WorkspaceMenu.jsx`) instead registers a tree of items under
  the literal path segment `'Workspaces'` via `useRegisterMenu`/`useRegisterMenuComponent`
  (lines 130, 132-153, 177). Since `'Workspaces'` itself has no `component`, `MenuBar`'s generic
  dropdown path (`MenuBar.jsx:86-98`) renders it as a plain `nav-link dropdown-toggle` whose label
  is the hardcoded string `"Workspaces"` — never the current workspace's title.
- **`UserMenu`** (`frontend/src/UserMenu.jsx`) shows a dynamic label *is* achievable within the
  flexout-menu path too — its root path segment is built as
  `var menuName = "Nagelfluh Geophysics: " + user?.username;` (line 44) — but `WorkspaceMenu` never
  did this, hardcoding `'Workspaces'` instead.
- `UserMenu.jsx`'s `AdminMenuItem` (lines 16-27) is the existing precedent for admin-gating a menu
  item: it's registered *unconditionally* (`useRegisterMenuComponent([menuName, 'Admin'], AdminMenuItem, 2)`,
  satisfying Rules of Hooks), and the leaf component itself returns `null` when `!user?.is_admin`.
  The same pattern — register unconditionally, gate the render — applies below to the superpublic
  checkboxes.

### Visibility: two different models

**Projects** — no visibility flag on `Project` itself. A project can have zero or more
`Publication` rows (`backend/models/project.py:89-111`), each an independent, separately-revocable
share link:

```python
class Publication(Base):
    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    findable = Column(Boolean, nullable=False, default=False)
    allow_anonymous = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
```

`GET /projects` (`backend/routers/projects.py:43-123`) merges every `findable=True` publication
directly into *every authenticated user's* project list (lines 79-98), each showing as
`"<Project Name> (ro)"`. **Any project member can set `findable=True`** today — there's no
admin gate — via `POST /projects/{project_id}/publications`
(`backend/routers/publications.py:19-44`), surfaced in `ProjectMembersModal.jsx`'s
`PublicationsTab` (lines 209-323). **There is no update endpoint for a `Publication` today** — the
only way to change `findable` after creation is delete-and-recreate. There is no search UI for
public projects anywhere; `GET /publications/findable` (`publications.py:83-103`) exists for a
*future, currently-unbuilt* anonymous/logged-out discovery page and is explicitly unconsumed.

**Workspaces** — a single boolean directly on the row (`backend/models/workspace.py:16`):
`is_public = Column(Boolean, nullable=False, default=False, server_default="0")`. Any member of a
workspace's home project can toggle it via `PATCH /workspace/{id}`
(`backend/routers/workspaces.py:318-341`), surfaced as an inline checkbox in
`WorkspaceSharingModal.jsx`'s `PublishWorkspacesTab` (lines 127-169). Discovery is
`GET /workspaces/public` (`workspaces.py:81-98`, route `s/public` under the `/workspace` prefix) —
**every** public workspace, unfiltered, consumed only by `AddPublicWorkspacesTab`
(`WorkspaceSharingModal.jsx:30-125`), which does client-side substring filtering against
`w.title` and, on selection, calls `setSelectedEnvironment(selected.id, selectedVersion)` to just
*view* it (no fork, no copy — a working-tree diff currently on disk already removed the old
"Add to Project"/fork button from this tab, leaving View as the only action). Nothing merges
public workspaces into the visible menu list directly — that's the entire reason today's UX
requires opening a dialog and searching.

### Admin model

Global, not per-project: `User.is_admin` (`backend/models/user.py:16`), gated server-side by
`require_admin` (`backend/auth_deps.py:6-9`, used throughout `backend/routers/admin.py`) and
client-side by `user?.is_admin` (`RequireAdmin` in `App.jsx:157-163`, `AdminMenuItem` in
`UserMenu.jsx:16-27`). There is **no per-project role** — `ProjectMember` is a plain membership
join table with no `role` column, and every existing project/workspace write is gated purely on
membership (`require_project_member`, `backend/services/auth_service.py:178-210`, returns the
`Project`; `_require_workspace_member`, `workspaces.py:35-55`, returns the `Workspace`). Setting
superpublic will be the first capability in the codebase gated on *both* admin status *and*
project membership — composed as two separate checks, since `require_project_member` only injects
the `Project`/`Workspace`, not the `AuthContext`/`User` needed for the admin check.

### Prior art

`docs/plans/done/publication-readonly-projects.md` explicitly chose "fold publication management
into the existing Members modal" over a standalone dialog (Decision 10) — the opposite of how
`WorkspaceSharingModal` turned out, and the reason this plan collapses it down to one purpose
rather than leaving it as a home for two.

`docs/plans/done/public-workspace-viewing.md` already rejected merging a single pinned workspace
into `GET /workspaces` because that endpoint is strictly project-scoped by design (its Decision 1,
rejected alternative). The same reasoning applies here at slightly larger scope — see Design
Decision 6 below for why superpublic workspaces merge into the toolbar list client-side rather
than via a backend change to `GET /workspaces`.

---

## Design Decisions

### 1. Toolbar: duplicate `ProjectDropdown`'s pattern for workspaces (chosen)

`WorkspaceMenu.jsx` is rewritten from a flexout-menu-tree registration into a self-contained
react-bootstrap `<Dropdown>` component, structurally mirroring `ProjectDropdown.jsx` — same file,
same default export name, still mounted the same way in `MenuBarWithComponents`
(`App.jsx:141`, unchanged call site). Toggle label: `Workspace: {current ? current.title : 'None'}`.

**Rejected: extract a shared generic `<EntityMenu>` component** used by both `ProjectDropdown` and
the new workspace widget. This pattern is already duplicated once (`ProcessSelector` follows the
same bespoke-top-level-`Dropdown` shape as `ProjectDropdown`), so a third instance isn't a new kind
of duplication in this codebase, and the two widgets differ enough in content — workspace rows
embed a per-row version `<select>`, project rows don't; the workspace widget needs a "Save"/"Save
As New" action, the project widget needs "Manage Members"/"Export" — that a shared abstraction
would need several render-prop escape hatches to stay flexible, for a net loss of readability.
Revisit only if a third or fourth entity type needs the same shape later.

Workspace rows keep their existing custom markup (title button + version `<select>`,
`WorkspaceMenu.jsx:33-56`) rendered directly inside `Dropdown.Menu` rather than as `Dropdown.Item`
— react-bootstrap's `Dropdown.Menu` accepts arbitrary children, and the row's click handlers
already call `setSelectedEnvironment` directly rather than relying on `Dropdown`'s `onSelect`/
`eventKey` machinery, so this carries over unchanged.

### 2. Projects: repurpose `findable` as "public"; add `superpublic` (chosen)

`Publication.findable` stops being the menu-merge criterion and becomes purely the "public,
search-only" tier — its existing member-settable, no-admin-gate semantics are otherwise unchanged.
A new column, `Publication.superpublic` (member+admin-gated), takes over `findable`'s old job of
being merged directly into everyone's `GET /projects` list.

**Rejected: leave `findable` as the menu-merge flag and add a separate, stricter flag on top.**
Would leave two independent mechanisms that both cause direct menu-listing (member-settable
`findable` and admin-settable `superpublic`), which contradicts the goal of admins being the only
ones who can make something menu-listed. Repurposing `findable` is a real, if narrow, permission
tightening for any existing findable publication — see Migration/Compatibility.

### 3. Workspaces: keep `is_public` as "public"; add `superpublic` (chosen)

Symmetric with Decision 2: `Workspace.is_public` keeps its exact current meaning and behavior
(member-settable, surfaced via search) — nothing about it changes. A new
`Workspace.superpublic` column (member+admin-gated) is the new "listed directly in the menu" tier,
which doesn't exist for workspaces at all today.

### 4. Superpublic implies public — enforced server-side at write time (chosen)

Setting `superpublic = True` force-sets `findable`/`is_public = True` in the same write,
regardless of what else is in the request body. One flag to unset (`superpublic`) to drop out of
the menu while staying searchable; unsetting `findable`/`is_public` while `superpublic` is still
true is rejected as a no-op-but-confusing state, so the handler simply doesn't allow it to occur —
it always writes `is_public/findable = True` alongside `superpublic = True`, never taking the
body's value for the public flag when superpublic is being set true in the same call.

### 5. Superpublic requires admin **and** project membership (chosen)

Setting `superpublic` goes through the *same* membership gate every other project/workspace write
uses (`require_project_member` / `_require_workspace_member`), plus an additional
`auth.user.is_admin` check inside the handler, only when the request body actually includes
`superpublic`. An admin who wants to superpublic a project they haven't joined must join it first,
like any other write — no special-cased cross-membership admin bypass. `findable`/`is_public`
writes are unaffected: no admin check, same as today.

### 6. Combobox: full public set, no dedup against already-superpublic items (chosen)

Both toolbar widgets grow a search box at the bottom of their dropdown menu, listing **every**
public entity (superpublic or not) filtered client-side by substring match against name/title —
mirroring `AddPublicWorkspacesTab`'s existing UX (`WorkspaceSharingModal.jsx:74-104`) almost
exactly. Superpublic items appear in both places (main list and combobox) rather than being
hidden from the combobox — simpler query, no special-casing, accepted as a minor redundancy rather
than a bug.

Selecting a result just **navigates to it** — `setCurrentProject(publicationId)` for projects
(reusing the existing "pinned currently-viewed publication" merge in `GET /projects`,
`projects.py:104-121`, which already makes a viewed-but-unowned publication show up in the
requester's own list for the rest of the session) or `setSelectedEnvironment(id, version)` for
workspaces (exactly what `AddPublicWorkspacesTab`'s "View" button already does,
`WorkspaceSharingModal.jsx:65-69`). No forking, no "add to my list" mutation — consistent with how
workspace viewing already works today.

**Projects need this combobox built from scratch** — no search UI for public projects exists
today (`GET /publications/findable` is unauthenticated-only and unconsumed). A new authenticated
endpoint, `GET /publications/public`, is added specifically for it, deliberately separate from the
existing anonymous `/publications/findable` endpoint (see Decision 8).

### 7. Workspace menu-merging happens client-side, not via a backend `GET /workspaces` change (chosen)

The main (non-search) row list in the new workspace dropdown is the union of: workspaces owned by
`currentProject` (`useWorkspaces(currentProject)`, unchanged), the existing "pinned" URL-selected
workspace (`WorkspaceMenu.jsx:159-175`'s existing mechanism, unchanged), and every workspace from
`usePublicWorkspaces()` where `superpublic === true`. This merge happens in the frontend, the same
place the pinned-workspace merge already happens.

**Rejected: add superpublic-merging to `GET /workspaces` itself, mirroring how `GET /projects`
merges findable/superpublic publications server-side.** `public-workspace-viewing.md` already
rejected a structurally identical change (merging a single pinned workspace server-side) on the
grounds that `GET /workspaces` is strictly project-scoped by design and conflating "workspaces
this project owns" with "workspaces to show regardless of project" is two different questions.
The same reasoning holds at the "all superpublic workspaces" scale, and `usePublicWorkspaces()`
already exists as exactly the right data source to compose client-side.

This is an intentional asymmetry with projects, where the equivalent merge already happens
server-side (`GET /projects`) and is left as-is (Decision 2) — not a new server-side change,
just a redirected filter condition. Projects and workspaces don't need identical plumbing to
produce the same user-facing behavior.

### 8. New `GET /publications/public` (authenticated), separate from `/publications/findable` (chosen)

Mirrors `GET /workspaces/public` (`workspaces.py:81-98`) in shape: authenticated, lists every
`Publication` with `findable = True`, returns `{id, project_name, superpublic}` per entry. Must be
registered before `/publications/{publication_id}` in `publications.py` for the same
literal-path-before-param-path reason already documented at `publications.py:90-93` for
`/publications/findable`.

**Rejected: reuse/extend `/publications/findable` for this.** That endpoint is explicitly
unauthenticated and scoped to a not-yet-built logged-out discovery page (per its own docstring).
Per the earlier scope decision (logged-in discoverability only, anonymous access untouched), this
plan doesn't touch it — adding auth to it or repurposing it would conflate two different
audiences behind one endpoint.

### 9. `Publication` gains an update endpoint (chosen)

There's no way to change `findable` on an existing publication today short of delete+recreate.
`PATCH /projects/{project_id}/publications/{publication_id}` is added, accepting
`{findable?: bool, superpublic?: bool}` — mirrors `PATCH /workspace/{id}`'s existing `is_public`
toggle exactly, and lets `ProjectMembersModal`'s Publications tab grow the same "inline editable
checkbox" table `PublishWorkspacesTab` already has, instead of requiring delete+recreate just to
flip a flag.

### 10. `WorkspaceSharingModal` loses its discovery tab, becomes "Publish Workspaces" (chosen)

Directly requested. With discovery now living in the toolbar combobox (Decision 6), the modal's
`Tabs`/`AddPublicWorkspacesTab` (`WorkspaceSharingModal.jsx:1-125`) are deleted; only
`PublishWorkspacesTab`'s content remains, unwrapped from `Tabs`, with the modal title changed from
"Workspaces" to "Publish Workspaces". It gains a second, admin-only-visible checkbox column for
`superpublic`, following the `AdminMenuItem` precedent (Background, above): always rendered in the
component tree, gated with `user?.is_admin && ...` inside the render rather than conditionally
mounted.

### 11. The bootstrap "Default" workspace is seeded superpublic (chosen)

The `'default'` workspace seeded by `backend/alembic/versions/5g9h7d8f6c4b_add_bootstrap_workspace.py`
is the one every fresh install/project effectively relies on as a starting point, and was already
force-set `is_public=1` for exactly this reason when project-scoping was added
(`af672e56b096_workspace_versioning_and_sharing.py:52-54`, backfilling every then-existing
workspace — at that point just this one — to public). The new migration that adds
`Workspace.superpublic` (see Migration section) sets `superpublic = 1` for `id = 'default'`
specifically, so it keeps showing up directly in every user's workspace dropdown with no search
needed, matching its current effectively-universal visibility.

**Not** a blanket "set superpublic for every currently-public workspace" backfill — by the time
this migration runs there will be many real, project-owned public workspaces created by ordinary
users, and superpublic is admin-only precisely so it isn't granted automatically. Only the
bootstrap row is special-cased, by id, exactly as the earlier migration did for `is_public`.

### 12. Anonymous/logged-out access untouched (confirmed out of scope)

`Publication.allow_anonymous`, `GET /publications/{id}`'s anonymous-resolve path, and
`GET /publications/findable` are not modified. This plan is entirely about which projects/
workspaces show up in menus and search **for logged-in users** — orthogonal to whether a given
share link itself requires login.

---

## Backend Changes

### `backend/models/project.py`

Add to `Publication`:

```python
superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
```

Include in `to_dict()` (line 103-111).

### `backend/models/workspace.py`

Add to `Workspace`:

```python
superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
```

Include in `to_dict()` (line 28-41).

### Migration

New Alembic migration(s) under `backend/alembic/versions/` adding both columns. Generate the
revision id via `alembic revision -m "..."` or `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`
per CLAUDE.md rule 9 — never hand-write one — and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` before committing, since revision ids are a single
flat namespace across main and every plugin's migration directory.

The workspace-side migration also seeds the bootstrap row per Decision 11:

```python
op.add_column('workspaces', sa.Column('superpublic', sa.Boolean(), nullable=False, server_default=sa.false()))
op.add_column('publications', sa.Column('superpublic', sa.Boolean(), nullable=False, server_default=sa.false()))

op.execute(sa.text("UPDATE workspaces SET superpublic = 1, is_public = 1 WHERE id = 'default'"))
```

(`is_public = 1` is already true for `'default'` today via `af672e56b096`, but setting it again
here is cheap insurance and keeps this migration self-consistent with Decision 4 even if that's
ever not the case in some install.)

### `backend/routers/projects.py` — `list_projects` (lines 43-123)

- Line 82: `.where(Publication.findable == True)` → `.where(Publication.superpublic == True)`.
- Lines 90-97 (`findable_entries` construction) and 113-120 (pinned entry): include both flags in
  the returned dict, e.g. `"findable": pub.findable, "superpublic": pub.superpublic`, instead of
  the current hardcoded `"findable": True` — the frontend combobox/badge logic wants both.

### `backend/routers/publications.py`

- `create_publication` (lines 19-44): unchanged — still member-only, still only sets `findable`/
  `allow_anonymous`. `superpublic` always defaults `False` on creation; set it via the new PATCH.
- New endpoint, registered **before** `/publications/{publication_id}` (same ordering constraint
  as the existing `/publications/findable`):

  ```python
  @router.get("/publications/public", summary="List all public (findable) publications")
  async def list_public_publications(
      auth: AuthContext = Depends(get_current_user),
      db: AsyncSession = Depends(get_db),
  ):
      """Every publication marked public (findable), for the logged-in discovery combobox.

      Distinct from /publications/findable: that one is unauthenticated, for a not-yet-built
      logged-out discovery page. This one requires login and backs the search box at the
      bottom of the project toolbar dropdown.
      """
      stmt = (
          select(Publication)
          .options(selectinload(Publication.project))
          .where(Publication.findable == True)  # noqa: E712
      )
      result = await db.execute(stmt)
      return [
          {"id": p.id, "project_name": p.project.name, "superpublic": p.superpublic}
          for p in result.scalars().all()
      ]
  ```

- New endpoint:

  ```python
  @router.patch("/projects/{project_id}/publications/{publication_id}", summary="Update a publication")
  async def update_publication(
      publication_id: str,
      body: Dict,
      project: Project = Depends(require_project_member),
      auth: AuthContext = Depends(get_current_user),
      db: AsyncSession = Depends(get_db),
  ):
      """Toggle a publication's public/superpublic flags.

      `findable` (public/searchable): any project member.
      `superpublic` (listed directly in everyone's menu): site admins only.
      Setting superpublic=true always also sets findable=true, regardless of what's in the body.
      """
      stmt = select(Publication).where(
          Publication.id == publication_id, Publication.project_id == project.id,
      )
      result = await db.execute(stmt)
      publication = result.scalar_one_or_none()
      if not publication:
          raise HTTPException(status_code=404, detail="Publication not found")

      if "superpublic" in body:
          if not auth.user.is_admin:
              raise HTTPException(status_code=403, detail="Admin access required")
          publication.superpublic = bool(body["superpublic"])
          if publication.superpublic:
              publication.findable = True
      if "findable" in body and not publication.superpublic:
          publication.findable = bool(body["findable"])

      await db.commit()
      await db.refresh(publication)
      return publication.to_dict()
  ```

  (The `and not publication.superpublic` guard on the plain `findable` write is what makes
  Decision 4 hold even if a client sends both keys in one call with `findable: false`.)

### `backend/routers/workspaces.py` — `update_workspace` (lines 318-341)

```python
@router.patch("/{workspace_id}")
async def update_workspace(
    workspace_id: str,
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rename a workspace and/or toggle its public/superpublic status.

    Any member of the workspace's home project may publish/unpublish it (public tier).
    Only site admins may set it superpublic (listed directly in the toolbar dropdown).
    Setting superpublic=true always also sets is_public=true.
    """
    workspace = await _require_workspace_member(workspace_id, auth, db)

    if "title" in body:
        workspace.title = body["title"]
    if "superpublic" in body:
        if not auth.user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
        workspace.superpublic = bool(body["superpublic"])
        if workspace.superpublic:
            workspace.is_public = True
    if "is_public" in body and not workspace.superpublic:
        workspace.is_public = bool(body["is_public"])

    await db.commit()
    return await _reload_workspace_dict(workspace.id, db)
```

Also update the now partly-inaccurate docstring at lines 328-330 ("no creator-only or admin-only
restriction") to reflect that `superpublic` is the one exception.

`list_public_workspaces` (`workspaces.py:81-98`) needs no change — `is_public` remains its filter
column, and Decision 4 guarantees every superpublic workspace already has `is_public = True`.

---

## Frontend Changes

### `frontend/src/datamodel/api.js`

```js
export async function getPublicPublications() {
  const response = await apiClient.get('/publications/public');
  return response.data;
}

export async function updatePublication(projectId, publicationId, { findable, superpublic } = {}) {
  const body = {};
  if (findable !== undefined) body.findable = findable;
  if (superpublic !== undefined) body.superpublic = superpublic;
  const response = await apiClient.patch(`/projects/${projectId}/publications/${publicationId}`, body);
  return response.data;
}
```

`updateWorkspace` (line 512-518) gains a `superpublic` passthrough, same shape as `is_public`.

### `frontend/src/datamodel/useQueries.js`

- `queryKeys`: add `publicPublications: ['publicPublications']`.
- `usePublicPublications()` — mirrors `usePublicWorkspaces` (lines 464-470) exactly.
- `useUpdatePublication(projectId)` — mirrors `useUpdateWorkspace` (lines 502-511), but invalidates
  **both** `queryKeys.publications(projectId)` and `queryKeys.projects` (a superpublic change
  affects the merged `GET /projects` list everyone sees) and `queryKeys.publicPublications`.
- `useUpdateWorkspace`'s `mutationFn` (line 503) extends its destructured args to
  `{ workspaceId, title, is_public, superpublic }`; its `onSuccess` already invalidates
  `queryKeys.workspaces(projectId)` and `queryKeys.publicWorkspaces` (lines 505-508) — unchanged,
  both are the right invalidations for a superpublic change too.

### `frontend/src/WorkspaceMenu.jsx` — rewritten per Decision 1

- Default export becomes a `<Dropdown>` component (structure mirrors `ProjectDropdown.jsx`), not a
  hook-registration component.
- Toggle label: `Workspace: {current?.title ?? 'None'}`, where `current` resolves the same way
  `SaveCurrentWorkspaceComponent` already does today (`useWorkspace(selectedEnvironment)`).
- Menu body: existing `WorkspaceRow` markup for the merged row list (owned ∪ pinned ∪
  superpublic-public, per Decision 7), then a divider, then "Save"/"Save As New Workspace..."
  (existing logic, ported as click handlers instead of registered menu actions), then "Publish
  Workspaces..." (opens the trimmed `WorkspaceSharingModal`), then the search combobox from
  Decision 6 at the very bottom (adapted from `AddPublicWorkspacesTab`'s existing search+select
  UI, `WorkspaceSharingModal.jsx:74-104`, using `usePublicPublications`-equivalent —
  i.e. `usePublicWorkspaces()`, already fetching the full public set needed here).
- Since this is now a real react-bootstrap `<Dropdown>`, use `autoClose="outside"` so typing in the
  search box or picking a version from a row's `<select>` doesn't immediately close the menu —
  matching how `WorkspaceRow`'s version `<select>` already calls `e.stopPropagation()` on click
  (line 48) to avoid triggering the row's own click handler; the combobox's inputs need the same
  treatment for clicks that shouldn't close the dropdown or select a row.
- The layout-clear effect (lines 73-77) and the `useEffect` syncing `layoutRef` (lines 66-68) carry
  over unchanged — they're not tied to the menu-tree registration, just co-located in this file.

### `frontend/src/ProjectDropdown.jsx`

- Add the same combobox at the bottom of the existing `<Dropdown.Menu>` (after the current
  "Create New Project..." item), backed by `usePublicPublications()`, filtering by
  `project_name`. Selecting an entry calls `setCurrentProject(entry.id)` directly (not through
  `handleProjectSelect`'s `eventKey` dispatch, since search results aren't part of the `projects`
  array) — same "just navigate" behavior as Decision 6 describes for workspaces.
- `autoClose="outside"` on the `<Dropdown>` here too, for the same reason.

### `frontend/src/WorkspaceSharingModal.jsx` — trimmed per Decision 10

- Delete `AddPublicWorkspacesTab` and the `Tabs`/`Tab` wrapper entirely.
- Rename the modal title to "Publish Workspaces".
- `PublishWorkspacesTab`'s table (lines 142-168) gains a second `<th>Superpublic</th>` column with
  a checkbox, rendered only when `user?.is_admin` (from `AuthContext`) — following the
  `AdminMenuItem` precedent: the column/cells are always in the JSX, gated by a render condition,
  not by conditionally skipping a hook.
- `handleToggle` extends to accept which flag is being toggled, calling the new
  `useUpdatePublication`-equivalent for workspaces (`useUpdateWorkspace`, already extended above)
  with `{ workspaceId, superpublic: !ws.superpublic }`.

### `frontend/src/ProjectMembersModal.jsx` — `PublicationsTab` (lines 209-323)

- Rename the "Findable" checkbox/column to "Public" (label text only — the underlying field stays
  `findable`, per Decision 2's "repurpose in place" choice, not a rename, to avoid an unnecessary
  DB/API rename alongside the semantic one).
- Table (lines 260-298) gains inline-editable checkboxes for both `findable`("Public") and,
  admin-gated, `superpublic`, using the new `useUpdatePublication` mutation — replacing the current
  create-only flow where changing `findable` requires delete+recreate.
- The creation form (lines 300-320) keeps its "Findable" checkbox (renamed "Public" in the label)
  for setting the initial value at creation time; no creation-time `superpublic` option — that's
  only settable after creation, via the table's admin-gated checkbox, consistent with workspaces
  (creation always starts non-superpublic; Decision 4/9 keep the admin gate on one single code
  path rather than two).

---

## Migration / Compatibility

- **Two new nullable-false, default-`False` columns** (`Publication.superpublic`,
  `Workspace.superpublic`) — additive, no backfill needed, no existing row's meaning changes.
- **Real behavior change**: any existing `Publication` with `findable=True`, created by a non-admin
  member under today's rules, stops being merged into everyone's `GET /projects` list the moment
  this ships (since the merge criterion moves to `superpublic`, which starts `False` for every
  existing row). If any such publications already exist in production, an admin will need to
  explicitly flip them to `superpublic=True` via the new PATCH/UI for them to keep showing up
  directly in menus — they remain fully accessible via the link itself and via the new search
  combobox (still `findable=True`) in the meantime. Worth a quick query before deploying
  (`SELECT * FROM publications WHERE findable = true`) to know if anyone's affected and give them a
  heads-up.
- No change to any existing URL, `allow_anonymous` behavior, or the publication-substitutes-for-
  project-id mechanism.

---

## Implementation Steps

1. **Backend**: add both `superpublic` columns + migration; update `list_projects`'s merge filter;
   add `GET /publications/public`; add the two `PATCH` endpoints (publications, workspaces);
   update `update_workspace`'s docstring.
2. **Frontend data layer**: `api.js` + `useQueries.js` additions (Decision 6/9 support).
3. **`WorkspaceMenu.jsx` rewrite** (Decision 1/6/7) — the toolbar widget itself.
4. **`ProjectDropdown.jsx`**: add the combobox (Decision 6).
5. **`WorkspaceSharingModal.jsx`** trim to "Publish Workspaces" + superpublic column (Decision 10).
6. **`ProjectMembersModal.jsx`**'s `PublicationsTab`: relabel, add inline-editable checkboxes
   (Decision 9).
7. Manual verification (below).

---

## Verification

- As a non-admin member of a project: mark a publication "public" (findable) → it appears in the
  project combobox for other users, but *not* directly in their project list. Attempt to mark it
  superpublic → 403 / no admin checkbox visible.
- As an admin who is also a member: mark that same publication superpublic → it now appears
  directly in every user's project list (`GET /projects`); its `findable` flag reads `true` even
  though it was never explicitly re-set.
- As an admin who is **not** a member of some other project: confirm you cannot mark its
  publications/workspaces superpublic until you join (403, matching every other project write).
- Repeat both above for a workspace: public → shows in the toolbar's search combobox only;
  superpublic (admin) → shows directly in the workspace dropdown's row list for every user, tagged
  distinguishably from owned rows.
- Open the workspace toolbar dropdown as any user: current workspace's title shows in the toggle
  label, matching `ProjectDropdown`'s existing behavior for the current project.
- `WorkspaceSharingModal` (via "Publish Workspaces...") no longer shows a "View public workspaces"
  tab; only the publish table remains, with the superpublic column visible only to admins.
- Selecting an entry from either combobox navigates to it (URL updates, content loads) without
  creating any new project/workspace row and without requiring membership.
- Un-setting superpublic on a project/workspace it was set on: it drops out of the direct menu
  listing but remains in the combobox (still public/findable/is_public).
- On a freshly migrated/bootstrapped install (or an existing one, post-migration): the "Default"
  workspace (`id = 'default'`) appears directly in every user's workspace dropdown with no search
  needed, matching its pre-existing effectively-universal visibility.

---

## Open Questions

- [ ] **Existing findable publications in production**: confirmed via the migration-time query
      above (Migration/Compatibility) — resolve before deploying, not during code review.
- [ ] **Combobox result caps/pagination**: neither `GET /workspaces/public` nor the new
      `GET /publications/public` paginate or limit results — matches existing precedent
      (`usePublicWorkspaces` today has the same lack of a cap) but could become a real scaling
      concern later. Not addressed in this pass.

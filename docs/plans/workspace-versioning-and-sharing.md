# Workspace Versioning, Project Scoping, and Public Sharing

## Goal

Today a `Workspace` (a saved flexout layout) is a single unscoped, unversioned row: no
`project_id`, no owner, no auth check on create/edit/delete, and saving never keeps history. Bring
workspaces in line with how the rest of the app treats shared resources:

- Workspaces belong to a project and are edited only by that project's members (mirrors `Process`).
- Workspaces keep version history the same way `Process`/`ProcessVersion` do — no destructive
  overwrite, "current" = latest version.
- A project can mark one of its workspaces **public**; any other project can browse the public
  list and **fork** (copy) a specific version of a public workspace into its own project as a new,
  independent workspace.

## Background & Current State

### Data model (`backend/models/workspace.py`)

```python
class Workspace(Base):
    __tablename__ = "workspaces"
    id = Column(String(255), primary_key=True)
    title = Column(String(255), nullable=False)
    layout = Column(JSON, nullable=False)
    created_at = Column(DateTime, ...)
    updated_at = Column(DateTime, ...)
```

No `project_id`, no `user_id`, no version field. `POST /workspace` (`backend/routers/workspaces.py`)
upserts by client-supplied id with no auth dependency at all — confirmed unscoped in
`docs/mcp-tools.md:400` and explicitly called out as deferred/out-of-scope in
`docs/plans/publication-readonly-projects.md:73`. A single `"default"` workspace is seeded by
`backend/alembic/versions/1bb9f6022bec_seed_default_data.py`, alongside a seeded
`default-project-00000000-0000-0000-0000-000000000000` project — that seed migration already
gives us a real project to backfill onto (see Migration below).

### Versioning precedent (`backend/models/process.py`)

`Process` (parent row: id, name, project_id, ...) + `ProcessVersion` (child: id, process_id FK,
`version` Integer, `UniqueConstraint(process_id, version)`, own timestamps/state). Version numbers
are assigned as `len(process.versions) + 1` at creation — monotonic, no gaps, no rollback. There is
no separate "current version" pointer column; `Process.to_dict()` just embeds
`"versions": [v.to_dict() for v in sorted(...)]` and callers treat `max(version)` as current.

### Menu system (`frontend/src/flexout/MenuContext.jsx`, `frontend/src/WorkspaceMenu.jsx`)

`useRegisterMenu(path, action, position, active)` registers a leaf action at a path;
`useRegisterMenuComponent(path, component, position)` renders an arbitrary component at a path
instead. **A menu node cannot have both a click action and child items** — `MenuBar.jsx` renders
any node with children as a plain unclickable dropdown toggle, ignoring `node.action`
(confirmed by reading `mergeMenu`/`MenuBar.jsx` — no code path combines them). The existing
precedent for "name + inline version picker" is `ProcessSelector.jsx:154-165`: a
`useRegisterMenuComponent`-rendered component with a native `<select>` bound to
`activeProcess.version`, populated from `currentProcess.versions`. This is the pattern to reuse for
workspaces rather than trying to nest versions as menu-path children.

---

## Design Decisions

### 1. Version history: `Workspace` + `WorkspaceVersion`, mirroring `Process`/`ProcessVersion` (chosen)

Same shape: `Workspace` becomes the parent/identity row, `WorkspaceVersion` holds `layout` per
version. Saving over an existing workspace always **adds** a new version; nothing is ever
overwritten in place. "Current" = highest `version`, no pointer column, same as `Process`.

**Rejected:** bumping a `version` integer column on the existing single-row table and keeping only
the latest `layout` — no history, can't browse or fork an older version, and diverges from the
established pattern for no benefit.

### 2. Scope: `project_id` NOT NULL + `is_public` flag, not nullable-`project_id`-as-scope-signal (chosen)

Elsewhere in this codebase, scope is signaled purely by presence/absence of `project_id`
(`Environment`/`StorageBackend` have none → global; `Process`/`Dataset` have one → project-scoped).
That idiom doesn't fit here: per your answer that a public workspace should still be editable by
"any project member of the original's home project," a public workspace still needs a real home
project — it isn't ownerless. So `project_id` is **always** set (every workspace belongs to exactly
one project), and a separate `is_public` boolean controls whether it's listed in the public gallery.

**Rejected:** nullable `project_id` meaning "public" — would leave no project to check membership
against when gating who can add new versions to a public workspace, contradicting the answer above.

### 3. Create / publish rights: any authenticated project member; no role system needed (chosen, per your answers)

- Create a workspace in project P: `require_project_member(P)` — same dependency `Process` creation
  already uses.
- Toggle `is_public` on a workspace: any member of its home project (not creator-only, not
  admin-only) — matches "any authenticated user [can publish]" plus the fact that today's codebase
  has no per-project roles, only binary membership (`ProjectMember` has no `role` column) plus a
  global `is_admin` flag unrelated to any one project.
- Add a new version to an existing workspace (public or not): same `require_project_member` check
  against the workspace's `project_id` — matches "any project member of the original's home
  project" from your answer, no separate ownership/`created_by`-gated check needed.

### 4. Add-from-public = copy, not live reference (chosen)

Forking copies the chosen version's `layout` into a brand-new `Workspace` in the requester's
project, starting its own version-1 history. `forked_from_workspace_id` / `forked_from_version`
are stored purely for provenance/attribution — never re-read to sync anything. This matches the
"pin a version" model `Process` outputs already imply: the public original can keep evolving
without silently changing what a project that forked it sees, and the fork's own edits never leak
back upstream.

**Rejected:** live reference (fork always resolves to the public workspace's latest version) —
would mean a project's saved layout can change out from under it whenever the public original is
updated, and forking an older version specifically wouldn't be expressible.

### 5. Fork picks a specific version, defaulting to latest (chosen)

The gallery/fork UI lets you pick which version of the public workspace to copy, pre-selected to
the highest version number at the time you open it — matches your requested version-dropdown
default, applied consistently in both the per-workspace selector and the fork picker.

### 6. Frontend: per-workspace menu component (title + version `<select>`), not nested menu paths (chosen)

Given the menu system's action-vs-children limitation (see Background), each workspace stops being
a plain `useRegisterMenu` leaf and becomes a `useRegisterMenuComponent` row: clickable title text
(loads the currently-selected version; default = latest) plus an inline version `<select>`,
structurally identical to `ProcessSelector.jsx`'s version selector. A new top-level
`['Workspaces', 'Public Workspaces...']` entry opens a single tabbed modal (new component,
`WorkspaceSharingModal.jsx`, see Design Decision 8) rather than trying to represent hundreds of
other-project public workspaces as menu items.

### 7. Public gallery search: reuse `ProcessSelector.jsx`'s search-combo-box pattern, no pagination (chosen, per your answer)

`ProcessSelector.jsx:112-148` already implements exactly this shape: a text input that filters an
in-memory list by substring match on name (`processes.filter(p => p.name.toLowerCase().includes(...))`),
showing matches in an absolute-positioned `dropdown-menu` with click-outside-to-close
(`dropdownRef`/`handleClickOutside`). The "Add public workspaces" tab reuses this exact pattern —
fetch the full public list once (`GET /workspaces/public`, no `?search=` param needed), filter
client-side by title as the user types. No server-side pagination/search endpoint needed for this
pass; revisit only if the public list grows large enough that fetching it whole becomes a problem.

### 8. Publish toggle lives in the same modal as "add public", as a second tab (chosen, per your answer)

`WorkspaceSharingModal.jsx` has two tabs:
- **"Add public workspaces"** — the search-combo-box + version-`<select>` + "Add to Project" fork
  flow from Design Decisions 6/7.
- **"Publish workspaces"** — lists the current project's own workspaces (title, version count) each
  with an `is_public` checkbox/toggle, calling `PATCH /workspace/{id}` on change.

No separate inline toggle on each `WorkspaceMenu` row, and no separate modal — one component, one
menu entry (`['Workspaces', 'Public Workspaces...']`), two tabs. This mirrors
`ProjectMembersModal`'s existing pattern of folding a related management concern into a second
tab/section of one modal rather than spawning a new modal per concern (see
`docs/plans/publication-readonly-projects.md` Design Decision 10, same idea applied there to
publications inside the Members modal).

### 9. Migration backfill: existing rows attach to the existing seeded default project (chosen)

Every existing `Workspace` row (today just `"default"`, plus whatever real users have created since
— all currently ownerless) gets `project_id = 'default-project-00000000-0000-0000-0000-000000000000'`
(the project already seeded by `1bb9f6022bec_seed_default_data.py`) and `is_public = true`. This
preserves today's de-facto behavior — every workspace is visible/usable by everyone — as the public
gallery, rather than silently making pre-existing workspaces inaccessible. Each gets a single
`WorkspaceVersion` (version 1) built from its current `layout` column, which is then dropped from
`Workspace`.

---

## Data Model

```python
# backend/models/workspace.py
class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String(255), nullable=False)
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    is_public = Column(Boolean, nullable=False, server_default=sa.false())
    forked_from_workspace_id = Column(String(255), ForeignKey("workspaces.id", ondelete="SET NULL"),
                                       nullable=True)
    forked_from_version = Column(Integer, nullable=True)
    created_by = Column(String(255), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", back_populates="workspaces")
    versions = relationship("WorkspaceVersion", back_populates="workspace",
                             cascade="all, delete-orphan", order_by="WorkspaceVersion.version")

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "project_id": self.project_id,
            "is_public": self.is_public,
            "forked_from_workspace_id": self.forked_from_workspace_id,
            "forked_from_version": self.forked_from_version,
            "versions": [v.to_dict() for v in sorted(self.versions, key=lambda v: v.version)],
        }


class WorkspaceVersion(Base):
    __tablename__ = "workspace_versions"
    __table_args__ = (UniqueConstraint("workspace_id", "version"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    workspace_id = Column(String(255), ForeignKey("workspaces.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    version = Column(Integer, nullable=False)
    layout = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(String(255), ForeignKey("users.id"), nullable=True)

    workspace = relationship("Workspace", back_populates="versions")

    def to_dict(self):
        return {"version": self.version, "layout": self.layout, "created_at": self.created_at.isoformat()}
```

Add `workspaces = relationship("Workspace", back_populates="project", cascade="all, delete-orphan")`
to `Project`.

Migration: new revision, `down_revision` = current head. Steps: create `workspace_versions`;
add `project_id` (nullable first), `is_public`, `forked_from_workspace_id`, `forked_from_version`,
`created_by` to `workspaces`; backfill per Design Decision 7 (`project_id` +
`is_public=true` for every existing row, one `WorkspaceVersion(version=1)` copied from each row's
`layout`); then alter `project_id` to NOT NULL and drop `layout`. **Generate the revision id with
`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"` and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` before committing** — per repo rule 9.

---

## Backend Changes (`backend/routers/workspaces.py`)

Follows the current query-param convention other project-scoped resources use today
(`?project_id=...`) rather than pre-adopting the `/projects/{project_id}/...` path nesting from
`docs/plans/publication-readonly-projects.md`, since that plan hasn't landed yet — see Open
Questions for the coordination note.

- `GET /workspaces?project_id=` — `Depends(require_project_member)`. Lists the calling project's
  own workspaces (replaces today's unscoped list).
- `GET /workspaces/public` — `Depends(get_current_user)`, no project-membership check (any
  authenticated user can browse). Lists every `Workspace` with `is_public = true`, including each
  one's home project name and full version list (for the fork picker's version `<select>`).
- `GET /workspace/{workspace_id}` — `Depends(get_current_user)`; 404 unless the workspace is public
  or the caller is a member of its `project_id`.
- `POST /workspace?project_id=` — `Depends(require_project_member)`. Body `{title, layout}`.
  Creates a new `Workspace` + its `version=1` `WorkspaceVersion`.
- `POST /workspace/{workspace_id}/versions` — `Depends(require_project_member)` on the workspace's
  own `project_id`. Body `{layout}`. Appends `version = len(workspace.versions) + 1`. This is new —
  today there is no "add a version to an existing workspace" action at all (the current frontend
  always creates a brand-new row via `POST /workspace`).
- `PATCH /workspace/{workspace_id}` — `Depends(require_project_member)`. Body
  `{title?, is_public?}` — rename and/or publish/unpublish.
- `POST /workspace/{workspace_id}/fork?project_id=` — `Depends(require_project_member)` on the
  *destination* `project_id`. Body `{version?}` (defaults to source's latest). 404 unless the
  source workspace is public. Copies the chosen `WorkspaceVersion.layout` into a new `Workspace`
  (`project_id` = destination, `is_public=false`, `forked_from_workspace_id`/`forked_from_version`
  set) with its own `version=1`.
- `DELETE /workspace/{workspace_id}` — `Depends(require_project_member)`; keeps today's guard
  against deleting the seeded `"default"` id.

---

## Frontend Changes

### `frontend/src/datamodel/api.js` / `useQueries.js`

- `getWorkspaces(projectId)`, `getPublicWorkspaces()`, `getWorkspace(id)` (now returns
  `{..., versions: [...]}`), `saveWorkspace({projectId, title, layout})`,
  `saveWorkspaceVersion(workspaceId, layout)`, `updateWorkspace(id, {title?, is_public?})`,
  `forkWorkspace(workspaceId, {projectId, version?})` — added following the existing
  hook/invalidation pattern (no manual `fetch()`, no direct `queryClient.invalidateQueries()`, per
  the repo's data-access rules).

### `frontend/src/WorkspaceMenu.jsx`

- `WorkspaceMenuItem` (plain `useRegisterMenu` leaf) is replaced by a `useRegisterMenuComponent`
  row per workspace: title text (click → load the row's currently-selected version, default
  latest) + a version `<select>` populated from `workspace.versions`, structurally mirroring
  `ProcessSelector.jsx:150-165`.
- `['Workspaces', 'Save Current Layout As New Workspace...']` (renamed from today's
  `'Save Current Layout As...'`) — unchanged prompt-for-title flow, now scoped to
  `currentProject`.
- New action on the active workspace's row: "Save as New Version" — calls
  `saveWorkspaceVersion(workspaceId, layoutRef.current)`, no title prompt.
- New top-level `['Workspaces', 'Public Workspaces...']` entry opens `WorkspaceSharingModal.jsx`
  (see below).

### `frontend/src/WorkspaceSharingModal.jsx` (new)

Two tabs (per Design Decision 8):

- **"Add public workspaces"** — a search combo box structurally identical to
  `ProcessSelector.jsx:112-148` (text input, client-side substring filter over
  `getPublicWorkspaces()` results, absolute-positioned dropdown, click-outside-to-close), each
  match showing its home project name; selecting one reveals a version `<select>` (default =
  latest) and an "Add to Project" button calling `forkWorkspace(workspaceId, {projectId:
  currentProject, version})`. On success, closes and refreshes the project's own workspace list.
- **"Publish workspaces"** — lists the current project's own workspaces (title, version count),
  each with an `is_public` checkbox calling `updateWorkspace(id, {is_public})` on change.

---

## Migration / Compatibility

- Existing rows are backfilled per Design Decision 9 — no data loss, but every pre-existing
  workspace becomes visible in every project's public gallery immediately after migration (matches
  today's actual unscoped visibility, so not a behavior regression, but worth calling out
  explicitly since it's a lot of workspaces suddenly appearing in a new "Public" UI section if
  users have created many).
- `POST /workspace` without a `project_id` breaks — anything calling the old endpoint shape
  (frontend, MCP tool wrappers) must be updated in the same change. Grep for
  `mcp__nagelfluh__*` workspace tool definitions and `frontend/src/datamodel/api.js` call sites.

---

## Implementation Steps

1. **Migration**: add `WorkspaceVersion` model, extend `Workspace`; generate migration (real
   entropy revision id, verify uniqueness); backfill existing rows onto the seeded default
   project as public, version 1.
2. **Backend endpoints**: `GET /workspaces?project_id=`, `GET /workspaces/public`,
   `GET /workspace/{id}` (scoped), `POST /workspace?project_id=`,
   `POST /workspace/{id}/versions`, `PATCH /workspace/{id}`, `POST /workspace/{id}/fork`; update
   `DELETE` for the new auth dependency.
3. **Frontend hooks**: add the new API functions + TanStack Query hooks and invalidation, per
   `docs/frontend/queries.md` conventions.
4. **`WorkspaceMenu.jsx` rework**: per-workspace component (title + version select), renamed
   "save as new workspace" action, new "save as new version" action.
5. **`WorkspaceSharingModal.jsx`**: new tabbed component ("Add public workspaces" /
   "Publish workspaces"), `['Workspaces', 'Public Workspaces...']` menu entry.
6. **MCP tool wrappers**: update any `mcp__nagelfluh__*` workspace tool definitions for the new
   request/response shapes.
7. Manual verification (below).

---

## Verification

- As a project member: "Save Current Layout As New Workspace..." → appears only in that project's
  own `WorkspaceMenu` list, not any other project's.
- "Save as New Version" on that workspace twice → version `<select>` shows v1/v2/v3, defaults to
  latest, loading each version renders the layout it was saved with.
- Toggle the workspace public via the "Publish workspaces" tab → switch to a different project →
  the "Add public workspaces" tab shows it with the correct home-project name and version list, and
  typing part of its title in the search box filters it in.
- Fork an older version specifically (not latest) → the new project-local workspace's layout
  matches that older version, not the current latest.
- Edit the fork afterward (save as new version) → the original public workspace's versions are
  unchanged.
- As a non-member of the source project: fork still succeeds (public workspaces are forkable by
  anyone authenticated); attempting to add a version directly to the *original* (not the fork)
  without membership → 403.
- Existing `"default"` workspace still loads for every project after migration, now listed under
  "Public" rather than unconditionally.

---

## Open Questions

None outstanding — the four raised in review are resolved and folded into the design above:
query-param URL scheme now, reconcile with `publication-readonly-projects.md` if/when it lands
(§Backend Changes intro); public gallery uses client-side search reusing `ProcessSelector.jsx`'s
combo-box, no pagination (Design Decision 7); publish toggle lives in `WorkspaceSharingModal.jsx`'s
"Publish workspaces" tab (Design Decision 8); `created_by` stays informational-only, never gates
authorization (Design Decision 3).

One coordination note carried forward, not a blocker: if `docs/plans/publication-readonly-
projects.md` lands *after* this plan, that plan's endpoint-migration table should gain a
`workspaces.py` row so it converts these routes to `/projects/{project_id}/...` nesting alongside
everything else it moves.

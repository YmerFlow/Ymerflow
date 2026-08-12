# Read-Only Publications (Public / Public+Findable Projects)

## Goal

Allow any member of a project to create shareable **publication** links that grant read-only
access to that project (and its resources) without requiring the recipient to be a project
member. Two flavors, controlled by flags on the same table:

- **Public (unlisted)**: anyone with the publication link can view the project read-only.
  Doesn't show up in anyone else's Projects list except the person who currently has the link
  open.
- **Public + findable**: same, plus it shows up in *every* user's Projects list (after their own
  projects), so it can be discovered without having the link.

A project can have any number of publication rows simultaneously (e.g. one unlisted link handed
to a specific collaborator, one findable link for general discovery).

No writes are ever permitted through a publication id — every write-capable endpoint continues to
require real project membership.

---

## Background & Current State

### Data model (`backend/models/project.py`)

```python
class Project(Base):
    __tablename__ = "projects"
    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    ...
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    invites = relationship("ProjectInvite", back_populates="project", cascade="all, delete-orphan")
```

`ProjectMember` is a composite-PK `(project_id, user_id)` join table; `require_project_member`
(`backend/services/auth_service.py:164-189`) is the canonical FastAPI dependency that resolves a
path `project_id` into a `Project`, gated on real membership (plus API-key project scoping). It's
only used as a `Depends()` on routes with `{project_id}` in the path
(`backend/routers/projects.py`). Three other places re-implement the same check by hand:
`routers/tags.py`'s local `_require_project_member`, and inline SQL in `routers/processes.py` /
`routers/datasets.py`.

### Current API URL scheme (the problem this plan must fix first)

Today `project_id` is **not consistently part of the URL path**. Some routes key on it directly
(`/projects/{project_id}/...`), but most project-resource routes key on the *resource's own id*
and derive `project_id` internally, with the parent project never appearing in the URL:

| Router | Current path | project_id location |
|---|---|---|
| `processes.py` | `POST /process?project_id=...` | query param |
| `processes.py` | `GET /processes?project_id=...` | query param |
| `processes.py` | `GET /process/{process_id}` | **not present** — derived from `process.project_id` |
| `processes.py` | `GET /process/{process_id}/logs` | derived |
| `processes.py` | `POST /process/{id}/versions/{v}/clone`, `/cancel`, `PATCH .../position` | derived |
| `datasets.py` | `GET /datasets?project_id=...` | query param |
| `datasets.py` | `GET /dataset/{dataset_id}`, `/data`, `/geography`, `/{part_path}` | **not present** — derived |
| `tags.py` | `POST /process/{id}/versions/{v}/tags/{tag_id}` | derived |
| `uploads.py` | `POST /upload?project_id=...` | query param |
| `utilities.py` | `GET /utilities/available-clusters?project_id=...` | query param |

Because a publication id has to work as a drop-in substitute for `project_id`, every one of these
needs to resolve *some* `project_id`-shaped value per request. Query-param and derived-from-
resource-id styles are both awkward to extend uniformly (query params are easy to drop
accidentally; derived-from-resource-id means there's nothing in the URL to substitute at all).

**Decision: normalize every project-resource endpoint to live under `/projects/{project_id}/...`**,
so `project_id` (real id or publication id) is always a path segment, resolved once by a shared
dependency. This is a prerequisite refactor, done before the publication feature is layered on.

`Workspace` has no `project_id` FK and is not project-scoped in the DB — out of scope, unchanged.

### Frontend URL scheme

Frontend page URLs already nest project inside the path:
`/app/w/:workspace/p/:project/pr/:process/v/:version/part/:part/s/:sounding`, hand-parsed by
`parseUrlParams`/`buildUrlPath` in `frontend/src/ProcessContext.jsx:92-159`. `currentProject` is
whatever the `p` segment currently holds — there is no separate frontend concept of "is this a
real project id or something else," which is exactly what lets a publication id slot in
transparently: the frontend keeps using `currentProject` as today, and it happens to sometimes
hold a publication id instead of a real project id.

### Projects list/menu

`frontend/src/ProjectDropdown.jsx`, fed by `useProjects()` (`frontend/src/datamodel/useQueries.js:52-61`,
query key `['projects']`, `enabled: isAuthenticated`), backed by `GET /projects` which orders by
`created_at` ascending. The dropdown just renders array order; `active={project.id === currentProject}`
highlights the current one.

---

## Design Decisions

### 1. Backend URL scheme: `project_id`-or-publication-id always in the path (chosen)

Every project-resource endpoint moves under `/projects/{project_id}/...`, e.g.:

- `POST /process?project_id=` → `POST /projects/{project_id}/process`
- `GET /process/{process_id}` → `GET /projects/{project_id}/process/{process_id}`
- `GET /process/{process_id}/logs` → `GET /projects/{project_id}/process/{process_id}/logs`
- `POST/PATCH .../clone`, `/cancel`, `/position` → same nesting
- `GET /datasets?project_id=` → `GET /projects/{project_id}/datasets`
- `GET /dataset/{dataset_id}(...)` → `GET /projects/{project_id}/dataset/{dataset_id}(...)`
- `POST /process/{id}/versions/{v}/tags/{tag_id}` → `.../projects/{project_id}/process/{id}/versions/{v}/tags/{tag_id}`
- `POST /upload?project_id=` → `POST /projects/{project_id}/upload`
- `GET /utilities/available-clusters?project_id=` → `GET /projects/{project_id}/utilities/available-clusters`

Handlers additionally verify the resource actually belongs to the resolved project (e.g.
`process.project_id == project.id`), returning 404 on mismatch — defense in depth, not just
routing sugar.

**Rejected:** keeping query-param/derived styles and threading an extra `publication_id` param
through every call site individually — more call sites to touch, easier to miss one, and no
single choke point for the read/write split below.

### 2. One shared resolver dependency, two flavors (chosen)

- `require_project_member(project_id, ...)` (existing, in `auth_service.py`) stays **strict**:
  real project id + real `ProjectMember` row only. A publication id passed here resolves to "valid
  publication, but not a membership" → **403** ("read-only publication link, cannot write"), not a
  generic not-found. Used by every write-capable endpoint and by membership/invite management
  reads (member lists/invites are never exposed to publication viewers).
- New `resolve_project_for_read(project_id, auth=Depends(get_current_user_optional), db=...)` in
  `auth_service.py`: tries real membership first; if that fails, looks up `project_id` as a
  `Publication.id`. If found, checks `publication.allow_anonymous or auth.user is not None`
  (401 if neither), and returns the project in read-only mode. Used by every pure-read endpoint.

This also finally consolidates the four duplicated membership-check implementations
(`auth_service.require_project_member`, `tags.py::_require_project_member`, inline checks in
`processes.py`/`datasets.py`) into these two call sites.

**Why not thread the publication id through every resource-id-keyed call individually?**
Considered and rejected in favor of (1) above — once `project_id` is always in the path and
resolved once per request, every downstream read check is just "is this project accessible for
reading," independent of resource id. Process/dataset ids are unguessable UUIDs, so this carries
no practical security gap versus re-validating a specific publication id on every call — the
capability boundary is "you had a working link into the project," which holds either way.

### 3. Write endpoints never accept a publication id (chosen)

Confirmed by construction of (2): every write route depends on `require_project_member`, which
raises 403 for a publication id. No mixed read+write single endpoints exist today (write routes
are always distinct from read routes), so no route needs special-casing beyond using the right
dependency.

### 4. Anonymous access is opt-in per publication (chosen)

`Publication.allow_anonymous` (bool, **default `true`** — i.e. new publications are anonymous-
viewable unless the creating member turns it off) gates whether an unauthenticated request may use
that publication id at all. This is independent of `findable`.

### 5. Multiple publications per project (chosen)

No uniqueness constraint beyond the primary key — a project can have any number of `Publication`
rows. Members manage them as a list (create/delete), never edit-in-place beyond the two flags.

### 6. Display name (chosen)

No separate publication display name. Listings show the underlying project's real `name` with
`" (ro)"` appended **by the API**, not stored — so renaming the project automatically updates what
publication viewers see.

### 7. Publication id shape (chosen)

Same UUID shape as `Project.id` (`String(255)`, `default=lambda: str(uuid.uuid4())`) — a project id
and a publication id are visually indistinguishable, which is what makes "accept a publication id
anywhere a project id is accepted" a clean substitution rather than requiring per-endpoint format
detection.

### 8. No audit/access log (chosen)

`Publication` carries just `id`, `project_id`, `findable`, `allow_anonymous`, `created_by`,
`created_at`. No separate access-log table for this pass.

### 9. Findable discovery: merged into `GET /projects` for logged-in users, separate public endpoint for logged-out (chosen)

- Logged-in `GET /projects` (see §`GET /projects` below) already returns own projects; it's
  extended to append findable publications from *other* projects (§Backend Changes).
- A separate, fully public `GET /publications/findable` endpoint is added for logged-out
  discovery, but this plan does not build a logged-out discovery *page* in this repo — that's
  explicitly **out of scope for this plan** (see Open Questions); only the backend capability is
  built now.

### 10. Publication management UI: folded into the existing Members modal (chosen)

`ProjectMembersModal` gains a second section/tab listing existing publications (id, findable /
anonymous flags, a copy-link button, a delete button) plus a small "Create publication" form
(two checkboxes: Findable, Allow anonymous — anonymous defaulted checked). No new modal component.

---

## Data Model

New table, migration follows the `c1d2e3f4a5b6_project_membership.py` precedent (new table, no
FK-heavy backfill needed since it's additive-only — no existing rows to grandfather):

```python
# backend/models/project.py
class Publication(Base):
    __tablename__ = "publications"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    findable = Column(Boolean, nullable=False, server_default=sa.false())
    allow_anonymous = Column(Boolean, nullable=False, server_default=sa.true())
    created_by = Column(String(255), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", back_populates="publications")
```

Add to `Project`: `publications = relationship("Publication", back_populates="project", cascade="all, delete-orphan")`.

Migration file: new revision, `down_revision` = current head `d1266f2f6e68`. **Generate the
revision id with `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"` (or `alembic revision`)
and verify uniqueness with `grep -rn "revision = '<id>'" --include=*.py .` before committing** —
per repo rule 9, never hand-invent one.

---

## Backend Changes

### `backend/services/auth_service.py`

- Add `get_current_user_optional` (like `get_current_user` but returns `None` instead of raising
  on missing/invalid credentials) — needed so `resolve_project_for_read` can distinguish
  "anonymous but publication allows it" from "not authenticated at all."
- Add `resolve_project_for_read(project_id, auth=Depends(get_current_user_optional), db=Depends(get_db)) -> ProjectReadAccess`
  where `ProjectReadAccess` is a small dataclass `{project: Project, read_only: bool, publication: Publication | None}`.
  Logic:
  1. Try real membership (same query as `require_project_member`, but don't raise — fall through
     on miss).
  2. If no membership match, look up `Publication.id == project_id`; on miss, 404.
  3. If found: require `publication.allow_anonymous or auth is not None`, else 401. Return
     `ProjectReadAccess(project=publication.project, read_only=True, publication=publication)`.
- `require_project_member` gains a first check: if `project_id` matches a `Publication.id` (and not
  a real project the caller is a member of), raise 403 with a message distinguishing "read-only
  publication link" from plain "not a member" — small UX improvement, not required for
  correctness.

### Router restructuring (§Design Decision 1)

Move the endpoints listed in the table above under `backend/routers/projects.py`'s
`/projects/{project_id}` prefix (or a shared `APIRouter(prefix="/projects/{project_id}")` mounted
from each existing router file — implementation detail, keep routers split by resource type as
today, just change their `prefix`/path strings). Every GET route swaps its ad-hoc membership check
for `Depends(resolve_project_for_read)`; every write route swaps for `Depends(require_project_member)`.

`routers/tags.py`'s local `_require_project_member` is deleted; both its project-tag and
process-version-tag routes move to the shared dependencies (project-tag reads use
`resolve_project_for_read`, all tag writes use `require_project_member`).

### New publication endpoints (`backend/routers/projects.py`, or new `backend/routers/publications.py`)

- `POST /projects/{project_id}/publications` — `Depends(require_project_member)`. Body:
  `{findable: bool = false, allow_anonymous: bool = true}`. Creates and returns the row.
- `GET /projects/{project_id}/publications` — `Depends(require_project_member)`. Lists this
  project's publications (for the Members modal).
- `DELETE /projects/{project_id}/publications/{publication_id}` — `Depends(require_project_member)`.
- `GET /publications/{publication_id}` — no required auth; `Depends(get_current_user_optional)`.
  Returns `{id, project_id, project_name, findable, allow_anonymous}` if
  `allow_anonymous or auth is not None`, else 401. Used by the frontend to resolve/display the
  pinned entry's name before/independently of the member-projects list.
- `GET /publications/findable` — fully public, no auth dependency at all. Returns
  `[{id, project_name}, ...]` for every `Publication` with `findable = true`. Capability only for
  this pass — no UI consumes it yet (see Open Questions).

### `GET /projects` (existing, `backend/routers/projects.py`)

Extend to optionally accept `?viewing_id=<id>` and to append findable publications:

1. If caller is authenticated: fetch own member projects (unchanged query/order), then fetch all
   `findable` publications whose `project_id` is **not** already in that set, append as
   `{id: publication.id, name: f"{project.name} (ro)", read_only: true, findable: true}`.
2. If `viewing_id` is supplied and refers to a `Publication` not already present in the combined
   list (i.e. an unlisted one, or a findable one that happens to already be shown): prepend it
   (after the anonymous/auth check) to the very front, `{..., read_only: true}`.
3. If caller is **not** authenticated: skip steps 1's own-projects and findable merge entirely;
   only resolve and return `viewing_id` (if it's a valid, anonymous-allowed publication) — a
   single-entry list, or empty if `viewing_id` is absent/invalid/not anonymous-allowed.

This keeps `ProjectDropdown`/`useProjects()` as the single source for the ordering the spec
describes: **[pinned currently-viewed publication] → [own projects] → [other findable
publications]**, with no separate frontend merge logic needed.

---

## Frontend Changes

### `frontend/src/datamodel/useQueries.js`

- `useProjects()`: pass `viewing_id: currentProject` (from context) as a query param; relax
  `enabled: isAuthenticated` to `enabled: isAuthenticated || !!currentProject` so an anonymous
  viewer with a publication link in the URL still gets the single pinned entry.
- Every other project-scoped query/mutation hook (processes, datasets, uploads, tags, utilities)
  updates its URL template to the new `/projects/{project_id}/...` nesting from §Backend Changes.
  No hook's *call signature* changes — `projectId` is already threaded through today, it's only
  the literal URL string that moves.

### Auth gating for anonymous viewers

The app shell currently assumes a logged-in user before rendering `/app/*` (needs confirmation of
the exact mechanism — likely an `AuthContext`/route-guard check in `App.jsx`). This must be relaxed
to: "allow rendering `/app/*` without a session if the `p` URL segment is present and resolves to
an anonymous-allowed publication." Concretely, on encountering an unauthenticated session with a
`p` segment set, call `GET /publications/{id}` before deciding whether to redirect to the login
page. **Exact integration point is an implementation-time investigation** (see Open Questions) —
this is the one piece of this plan that touches an area not fully mapped by the initial survey.

### `frontend/src/ProjectMembersModal.jsx` (or wherever it lives)

Add a "Publications" section: list existing rows (via a new `usePublications(projectId)` /
`useCreatePublication()` / `useDeletePublication()` set of hooks following the existing
mutation/invalidation pattern — invalidate via a new `invalidatePublications` style helper or fold
into `invalidateProject`), each row showing findable/anonymous flags, a delete button, and a "Copy
link" button. The copy-link button:

```js
const currentPath = buildUrlPath({ ...urlParams, project: publication.id });
navigator.clipboard.writeText(`${window.location.origin}${currentPath}`);
```

i.e. take the *current* workspace/project/process/version/part/sounding URL (whatever the member
was looking at when they opened the modal) and substitute the publication id for the project id —
exactly the "copy the current URL with the project id replaced" behavior from the spec. The create
form: two checkboxes (Findable — default unchecked, Allow anonymous — default checked per
Design Decision 4), a Create button that calls the mutation and then immediately offers the
copy-link action for the new row.

### `frontend/src/ProjectDropdown.jsx`

No changes needed beyond what `GET /projects`'s new ordering already provides — the dropdown just
renders array order and highlights `active={project.id === currentProject}`, which continues to
work verbatim since a pinned publication entry's `id` equals `currentProject` when active.

---

## Migration / Compatibility

- New `publications` table, additive only — no existing data affected, no backfill needed.
- **Backend URL scheme change is breaking for anything calling the old paths directly** (e.g. the
  MCP server tools listed in the system's available-tools, external scripts, saved bookmarks to
  raw API URLs). Since this is an internal API (frontend + MCP tool wrappers, not a public stable
  API), old routes are removed outright rather than kept as deprecated aliases — grep for every
  literal old path string in `frontend/src/` and any `mcp__nagelfluh__*` tool definitions and
  update them as part of the same change (no version skew window, since frontend and backend
  deploy together).
- No change to `Workspace` — remains project-agnostic.

---

## Implementation Steps

1. **Migration**: add `Publication` model + relationship on `Project`; generate migration (real
   entropy revision id, verify uniqueness).
2. **Auth service**: add `get_current_user_optional`, `resolve_project_for_read`,
   `ProjectReadAccess`; harden `require_project_member`'s publication-id rejection message.
3. **URL scheme refactor**: move every endpoint in the §Design Decision 1 table under
   `/projects/{project_id}/...`; swap ad-hoc/inline membership checks for the two shared
   dependencies; delete `tags.py`'s local `_require_project_member`. Update every frontend fetch
   URL template in `useQueries.js` and any MCP tool wrapper referencing the old paths in the same
   commit (no deprecation window — see Compatibility).
4. **Publication CRUD endpoints**: `POST/GET/DELETE /projects/{project_id}/publications`,
   `GET /publications/{id}`, `GET /publications/findable`.
5. **`GET /projects` extension**: `viewing_id` param, findable-publication merge, anonymous-caller
   single-entry behavior.
6. **Frontend hooks**: `usePublications`, `useCreatePublication`, `useDeletePublication`;
   `useProjects()` passes `viewing_id`, relaxed `enabled`.
7. **Frontend anonymous-entry investigation**: locate and adjust the auth gate that currently
   forces login before `/app/*` renders (see Open Questions) so an anonymous-allowed publication
   link works end to end.
8. **`ProjectMembersModal` Publications section**: list/create/delete UI + copy-link button using
   `buildUrlPath`.
9. Manual verification (below).

---

## Verification

- As a project member: open Members modal → Publications section → create one unlisted
  (anonymous-allowed) publication → copy link.
- Open the copied link in a private/incognito window (no session): project loads read-only;
  Projects dropdown shows only the one pinned `"<name> (ro)"` entry, selected.
- Attempt a write while viewing via the publication (e.g. try to create a process, or hit a
  mutation directly) → 403.
- Log in as a *different*, non-member user in that same incognito session while still on the
  publication URL: their own real projects now also appear in the dropdown, below the pinned
  entry.
- Create a second publication with **findable** checked, **allow-anonymous unchecked**: log in as
  any third user (not a member) with no publication link at all → their Projects dropdown shows
  their own projects, then the findable project as `"<name> (ro)"` after them. Opening it while
  logged out → login required (401), since anonymous is off for that row.
- Delete a publication → its link stops resolving (404) and it disappears from any list it
  appeared in.
- Rename the underlying project → all publication listings immediately reflect the new name
  (still with `" (ro)"` appended).

---

## Open Questions

- [ ] **Frontend auth gate for anonymous viewers** — the exact current mechanism that forces login
      before `/app/*` renders needs to be located (likely `App.jsx` / an `AuthContext` guard) and
      adjusted to check `GET /publications/{id}` before redirecting to login when a `p` segment is
      present but no session exists. Flagged because the initial codebase survey for this plan
      didn't trace that specific guard.
- [ ] **Logged-out discovery page** — `GET /publications/findable` is built per Design Decision 9,
      but no UI consumes it in this pass. A follow-up plan can add an unauthenticated route/page
      once there's a concrete need.
- [ ] **MCP tool wrappers** — confirm which `mcp__nagelfluh__*` tools embed the old (pre-refactor)
      REST paths and need their definitions regenerated/updated alongside the router move.

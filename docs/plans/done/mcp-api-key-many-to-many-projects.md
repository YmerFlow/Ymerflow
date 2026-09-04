# MCP API Keys: Many-to-Many with Projects

**Context:** Today an MCP API key is bound to exactly one project via a hard FK
(`api_keys.project_id → projects.id`). We want a key to grant access to a
*subset* of the projects its owner is a member of. A user may only put projects
they already have access to on a key (including **zero** projects). We also
expose `create_project` to MCP, and any project a key creates is **auto-added**
to that key's project set — so a zero-project key is a valid bootstrap state: the
MCP client must create a project before it can do anything else.

---

## Current state (confirmed)

| Concern | Where | Today |
|---|---|---|
| Key model | `backend/models/api_key.py:9-33` | 1:1 FK `project_id`, non-null, CASCADE; `project` relationship; `to_dict` emits `project_id`/`project_name` |
| Key creation | `backend/routers/auth.py:341-397` | Body `{label, project_id, expires_at}`; membership-checked (`357-364`); returns raw key once |
| Auth / lookup | `backend/services/auth_service.py:114-140` | Hash bearer `apk_…`, load key, set `AuthContext.api_key_project_id = api_key.project_id` |
| AuthContext | `backend/services/auth_service.py:26-30` | `api_key_project_id: str \| None` (`None` = JWT / full access) |
| Write gate | `auth_service.py:178-210` | Gate 1: `api_key_project_id != project_id → 403`; Gate 2: membership |
| Read gate | `auth_service.py:220-254` | `api_key_project_id is None or == project_id` |
| Discovery | `backend/routers/projects.py:43-126` | `list_projects`; API-key path filters `Project.id == auth.api_key_project_id` (`74-75`) |
| Upload token | `backend/routers/uploads.py:154-186` | Derives single project from `auth.api_key_project_id` (`173`); errors if absent |
| create_project | `backend/routers/projects.py:129-173` | `POST /projects`, tag `["Projects"]` (not MCP-exposed); requires `storage_backend_id`; adds creator as `ProjectMember` |
| Storage backends | `backend/routers/utilities.py:236-247` | `GET /utilities/available-storage-backends`, not MCP-tagged |
| MCP mount | `backend/main.py:120-169` | `include_tags=["ProjectDiscovery","Processes","Datasets","Environments","Uploads","Workspaces"]`; description says "key is already scoped to a project" |
| Frontend UI | `frontend/src/AccountPage.jsx:278-388` | Single-project `<Form.Select>` at key creation; `useCreateApiKey` sends `projectId` |

**Membership model:** `ProjectMember` (`backend/models/project.py:44-61`) — flat
composite-PK join table, no roles. This is the source of truth for "projects the
user has access to."

---

## Design decisions (agreed)

1. **Many-to-many via a join table** `api_key_projects(api_key_id, project_id)`.
   Drop `api_keys.project_id`. `ApiKey.projects` becomes a list; `Project.api_keys`
   becomes the many-to-many reverse side.

2. **`AuthContext` carries a set, not a scalar.** `api_key_project_ids: frozenset[str] | None`.
   - `None` → JWT / not API-key-scoped → full access to the user's memberships (unchanged semantics).
   - a `frozenset` (possibly **empty**) → API-key-scoped to exactly those projects.
   - Also add `api_key_id: str | None` so `create_project` knows which key to auto-add into.
   - The old scalar `api_key_project_id` is removed; all readers migrate to set membership.

3. **Scope is create-only + auto-add.** A key's project set is fixed at creation
   **except** it grows automatically when `create_project` is called with that key.
   No manual add/remove endpoint or UI. To change scope otherwise: revoke + re-issue.

4. **Key creation takes a list.** Body `{label, project_ids: [...], expires_at}`.
   Each id must be one of the caller's memberships (else 403). Empty list is allowed
   and is the intended bootstrap-a-fresh-MCP-client state.

5. **`create_project` is exposed to MCP** (add MCP tag + `operation_id`). When called
   with an API key, the new project is inserted into that key's `api_key_projects`
   rows (auto-add). The creator is still added as a `ProjectMember` (unchanged).

6. **Storage backend for MCP `create_project`:**
   - Expose `available-storage-backends` as an MCP tool (add tag + `operation_id`).
   - Make `storage_backend_id` **optional** on `create_project`: if omitted, default to
     the sole allowed backend when there is exactly one; if there are several and none
     was given, return **400 whose `detail` lists the allowed backends** (`[{id, name}]`).
   - Net effect: the LLM gets the allowed set inline (in the default case it needs
     nothing; in the ambiguous case the error hands it the list), so a separate query
     round-trip is usually unnecessary — the tool remains for explicit discovery.

7. **`list_projects` is the MCP entry point.** Rewrite the MCP server description so
   the workflow starts at `list_projects()` to discover the key's accessible
   project(s), and `create_project()` when it has none. `project_id` stays an explicit
   per-call path parameter that must be in the key's scope.

8. **Rename the MCP discovery tag `ProjectDiscovery` → `Projects`** and put
   `create_project` (and `list_storage_backends`) in it. **Caveat:** `"Projects"` is
   already the *router-level default tag* on the entire projects router
   (`projects.py:24`), inert for MCP only because it isn't in `include_tags` today.
   Renaming naively would expose all 12 endpoints in that router (export, import,
   members, invites, setup-storage, …). To avoid that, **change the projects router's
   default tag to a non-exposed name** (`ProjectManagement`) and explicitly tag only the
   endpoints we want with `Projects`. Final MCP `Projects` tool set: `list_projects`,
   `list_public_publications`, `create_project`, `list_storage_backends`.

---

## Data model changes

### New association table (`backend/models/api_key.py`)

```python
from sqlalchemy import Table
api_key_projects = Table(
    "api_key_projects", Base.metadata,
    Column("api_key_id", String(255), ForeignKey("api_keys.id", ondelete="CASCADE"), primary_key=True),
    Column("project_id", String(255), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
)
```

### `ApiKey` model

- Remove the `project_id` column and the singular `project` relationship.
- Add `projects = relationship("Project", secondary=api_key_projects, back_populates="api_keys")`.
- `to_dict()` emits `projects: [{id, name}]` instead of `project_id`/`project_name`.
  (Keep it terse — it's returned in `list_api_keys` and the create response.)

### `Project` model (`backend/models/project.py`)

- `api_keys = relationship("ApiKey", secondary=api_key_projects, back_populates="projects")`
  (replacing the current one-to-many `back_populates="project"`).

---

## Migration

New Alembic revision in `backend/alembic/versions/` (generate the id with real
entropy per repo rule 9 — `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`,
then `grep -rn "revision = '<id>'" --include=*.py .` to confirm uniqueness).
`down_revision` = current head of the main chain.

**Upgrade:**
1. `create_table("api_key_projects", …)` with the two FK columns + composite PK.
2. **Backfill**: `INSERT INTO api_key_projects (api_key_id, project_id) SELECT id, project_id FROM api_keys` — every existing 1:1 key becomes a 1-project many-to-many key (no access change for existing keys).
3. `drop_column("api_keys", "project_id")` (drop its FK/index first if the dialect requires).

**Downgrade:** add `project_id` back (nullable), backfill the *first* project per key
from `api_key_projects` (best-effort — many-to-many → 1:1 is lossy; document that),
drop `api_key_projects`.

---

## Backend changes

### `backend/services/auth_service.py`
- `AuthContext`: replace `api_key_project_id: str | None` with
  `api_key_project_ids: frozenset[str] | None = None` and add `api_key_id: str | None = None`.
- API-key branch (`114-140`): `selectinload(ApiKey.projects)`; build
  `frozenset(p.id for p in api_key.projects)`; return
  `AuthContext(user=…, api_key_project_ids=…, api_key_id=api_key.id)`.
- Upload-token branch (`93-112`): the token already carries a single `project_id`;
  set `api_key_project_ids=frozenset({project_id})`, `api_key_id=None`.
- JWT branch (`142-161`): `api_key_project_ids=None`.
- `require_project_member` (`189`): gate becomes
  `if auth.api_key_project_ids is not None and project_id not in auth.api_key_project_ids: 403`.
- `resolve_project_for_read` (`230`): condition becomes
  `auth.api_key_project_ids is None or project_id in auth.api_key_project_ids`.

### `backend/routers/projects.py`
- `list_projects` (`74-75`): `if auth.api_key_project_ids is not None: stmt = stmt.where(Project.id.in_(auth.api_key_project_ids))`.
  (An empty set yields `IN ()` → no rows, which is exactly the desired
  "zero-project key sees nothing until it creates one".)
- `create_project`:
  - Add MCP tag + `operation_id="create_project"` (see MCP section).
  - Make `storage_backend_id` optional: if absent, `allowed = get_allowed_storage_backends(...)`; if `len(allowed)==1` use it; if `>1` raise `400` with `detail={"message": …, "available_backends": [{"id","name"}, …]}`; if `0` raise a clear 400.
  - **Auto-add**: after creating the project + `ProjectMember`, if `auth.api_key_id` is not None, insert an `api_key_projects` row `(auth.api_key_id, project_id)` in the same transaction.
  - Note: because every MCP call is a fresh HTTP request with fresh auth, no in-memory `AuthContext` mutation is needed — the *next* tool call re-reads the key's projects and sees the new one.

### `backend/routers/uploads.py`
- `request_upload_token` (`154-186`): it can no longer derive a single project from
  the key. Add a required `project_id` argument (query param), validate it is in
  `auth.api_key_project_ids` (or that the session is JWT / membership holds — reuse
  the same gate logic). Update the docstring/curl example accordingly.

### `backend/routers/workspaces.py`
- Line `192`: `auth.api_key_project_id != workspace.project_id` →
  `auth.api_key_project_ids is not None and workspace.project_id not in auth.api_key_project_ids`.

### `backend/routers/auth.py` — `create_api_key`
- Accept `project_ids: list[str]` only. **Hard cut** — the legacy singular `project_id`
  body field is removed; the only caller is the AccountPage UI, updated in lockstep.
- Validate **every** id in `project_ids` is a `ProjectMember` of `auth.user` (one
  query: `WHERE project_id IN (...) AND user_id = …`, assert count matches). Empty
  list is valid — skip the check.
- Create the `ApiKey`, then insert `api_key_projects` rows for each id.
- Response: `{**api_key.to_dict(), "key": raw_key}` where `to_dict` now includes
  `projects: [...]`.
- `list_api_keys` (`400-414`): `selectinload(ApiKey.projects)` instead of `.project`.

### MCP tag rename + exposure
- **`backend/routers/projects.py:24`**: change the router default tag from
  `tags=["Projects"]` to `tags=["ProjectManagement"]` (a name *not* in `include_tags`),
  so the router's other 11 endpoints stay off the MCP surface.
- **`list_projects` (`projects.py:43`)**: change its override `tags=["ProjectDiscovery"]`
  → `tags=["Projects"]`.
- **`create_project` (`projects.py:129`)**: add `tags=["Projects"]` and
  `operation_id="create_project"`.
- **`list_public_publications` (`publications.py:83`)**: change `tags=["ProjectDiscovery"]`
  → `tags=["Projects"]`.
- **`available-storage-backends` (`utilities.py:236`)**: add `tags=["Projects"]` and
  `operation_id="list_storage_backends"` (router default `Utilities` is not exposed, so
  no side effects).
- **`backend/main.py:167`**: in `include_tags`, replace `"ProjectDiscovery"` with
  `"Projects"`. Net exposed `Projects` tools: `list_projects`, `list_public_publications`,
  `create_project`, `list_storage_backends`.
- Rewrite the MCP description (`132-166`): a key now grants access to **a set of**
  projects (possibly empty). Workflow: `list_projects()` → if empty, `create_project()`
  (optionally `list_storage_backends()` first) → then the normal per-project tools with
  `project_id` from the discovered/created set.

---

## Frontend changes (`frontend/src/AccountPage.jsx`, `datamodel/useAuthQueries.js`)

- Key-creation form: replace the single-project `<Form.Select>` (`304-316`) with a
  **multi-select** (checkbox list or multi-select) over `projects`; allow **none**
  selected. Add a hint that an empty selection is valid (the key can then only call
  `list_projects`/`create_project` until it creates a project).
- `handleCreateKey` (`178-197`): send `projectIds: [...]` instead of `projectId`.
- `useCreateApiKey` mutation: send `project_ids` in the body.
- Key list table (`339-388`): the "Project" column (`356`) renders `k.projects`
  (join with `, `; show "—" / "none yet" when empty).
- Copy text ("scoped to a single project", `286`) updated to "scoped to a set of projects".

---

## Edge cases & notes

- **Empty-scope key** is a first-class state: `list_projects` returns `[]` (plus any
  public/superpublic publications, unchanged), and `create_project` is the only write
  it can perform. After the first `create_project`, the project auto-adds and
  subsequent calls see it.
- **Publications** are unaffected — read gate's publication fallback is unchanged; the
  set check only tightens which *own* projects a key may touch.
- **Existing keys** keep working: backfill gives each exactly its old single project.
- **`request_upload_token`** is now the one behavior that *required* a single implicit
  project; making `project_id` explicit is a forced consequence of multi-project keys.
- **No roles**: any member can mint a key for any project they belong to; the key can
  never exceed the union of the owner's memberships at creation time. (If the owner
  later loses membership to a project, Gate 2 still blocks — the key's scope is
  necessary but not sufficient.)

---

## Implementation order

| # | Item | File(s) |
|---|---|---|
| 1 | Association table + model relationships + `to_dict` | `backend/models/api_key.py`, `backend/models/project.py` |
| 2 | Alembic migration (create + backfill + drop column) | `backend/alembic/versions/<new>.py` |
| 3 | `AuthContext` set + `api_key_id`; both gates; auth branches | `backend/services/auth_service.py` |
| 4 | `list_projects` `.in_()`; `create_project` optional backend + auto-add + tag/op_id | `backend/routers/projects.py` |
| 5 | `create_api_key` list + validation; `list_api_keys` selectinload | `backend/routers/auth.py` |
| 6 | `request_upload_token` explicit `project_id` | `backend/routers/uploads.py` |
| 7 | `workspaces.py` gate update | `backend/routers/workspaces.py` |
| 8 | Rename tag `ProjectDiscovery`→`Projects` (router default→`ProjectManagement`, re-tag `list_projects`/`create_project`/`list_public_publications`/`list_storage_backends`); `include_tags` swap; MCP description rewrite | `backend/routers/projects.py`, `backend/routers/publications.py`, `backend/routers/utilities.py`, `backend/main.py` |
| 9 | Frontend multi-select + list rendering + mutation body | `frontend/src/AccountPage.jsx`, `frontend/src/datamodel/useAuthQueries.js` |

---

## Open questions for review

- None outstanding.

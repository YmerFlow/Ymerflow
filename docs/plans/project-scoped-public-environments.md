# Project-Scoped & Public/Super-Public Compute Environments

## Goal

Compute **environments** (a built Docker image + its extracted `process_types` JSON schemas) are
currently a single flat, globally-visible, **unscoped and unauthenticated** table. Every environment
built by any `create_environment` in any project — plus every bootstrap image from `docker/build.sh`
— is listed to every user in every project by a bare `GET /environments` (`select(Environment)` with
no filter, no auth). Its per-project `docker_image` registry path leaks across tenants too.

This plan gives environments the **same visibility model as `Workspace`**:

1. Environments become optionally **project-owned** (`project_id`, nullable — a bootstrap/system
   environment has no home project) and carry two orthogonal visibility flags, `is_public` and
   `superpublic` (super-public implies public), mirroring `backend/models/workspace.py:14-17`.
2. `docker/build.sh` bootstrap environments default to **superpublic** (the shared, always-available
   base runners everyone should see).
3. The `create_environment` process can produce a **public or private** environment, but **never
   super-public** (that tier is reserved for operator-built bootstrap images).
4. The Process Editor's **"Software version" dropdown** becomes a workspace-menu-style dropdown that
   shows **super-public + project-local + the currently-selected environment (even if it is only
   public)**, plus a **client-side search box** over the public environment gallery — mirroring
   `frontend/src/WorkspaceMenu.jsx`.

This is the environment analogue of the already-shipped
[`project-scoped-survey-systems.md`](done/project-scoped-survey-systems.md) and
[`workspace-versioning-and-sharing.md`](done/workspace-versioning-and-sharing.md) work; it reuses
their exact patterns.

---

## Background & Current State

### The `Environment` table has no visibility concept at all

`backend/models/environment.py` — columns: `id`, `name`, `docker_image`, `process_id`
(FK→processes, nullable), `process_types` (JSON schemas), `created_at`, `created_by` (FK→users,
nullable). **No `project_id`, no `is_public`, no `superpublic`.** `to_dict()` exposes none.

Today the only thing distinguishing a bootstrap environment from a user one is `process_id`:
bootstrap/build.sh rows have `process_id = NULL`; `create_environment` rows carry a real
`process_id`.

### The three insert paths (all must learn the new columns)

1. **Bootstrap (raw SQL upsert)** — `docker/update_bootstrap_environment.py`
   `update_bootstrap_environment()`. Called by `docker/build.sh` (dev: run directly; prod: a
   `db-update-<tag>` k8s Job). `INSERT INTO environments (id, name, docker_image, process_types,
   process_id, created_at) VALUES (...)`, `process_id = NULL`. Because it is **raw `text()` SQL**,
   any new column must be added to **both** the INSERT and the UPDATE branches or it silently falls
   to the DB default.
2. **`create_environment` process → `environment.json` → ORM insert** —
   `backend/models/process.py:1245-1252` (`_create_outputs`). Reads
   `{storage_base}/processes/{process.id}/environment.json` and builds
   `Environment(name=, docker_image=, process_id=, process_types=, created_by=process.created_by)`.
   `process.project_id` is available (`nullable=False`) but **not propagated** today. The
   `environment.json` payload is written by
   `deps/Ymerflow-process-sdk/ymerflow_runner/create_environment.py:248-262` and currently contains
   `{name, docker_image, process_id, process_types}` — no project, no visibility.
3. **REST `POST /environments`** — `backend/routers/environments.py:90-125`, from
   `CreateEnvironmentRequest {name, docker_image, process_id}`. (Kept for API parity; no project or
   visibility today.)

### The read path leaks everything

`GET /environments` (`environments.py:19-34`) — `select(Environment)`, **no filter, no auth
dependency**. Frontend `useEnvironments()` (`frontend/src/datamodel/useQueries.js:174-182`) hits it
with `include_schemas=true` and the full list (with ~44 KB schemas each) flows through
`ProcessContext` (`frontend/src/ProcessContext.jsx:212`) → `ProcessEditor` → `EnvironmentSelect`.

### The current dropdown

`frontend/src/widgets/EnvironmentSelect.jsx` is already a hand-rolled dropdown (trigger `span` +
absolutely-positioned `.card` list), fed `environments` as a prop, `onChange(id)` contract,
defaulting to the newest environment (`ProcessEditor.jsx:42-48,64`). No visibility, no search.

### Precedent to mirror

- **Ownership + optional public**, nullable `project_id`: `System`
  (`backend/models/system.py:18-20`) and its `list_systems` query
  `select(System).where(or_(System.is_public == True, System.project_id == project.id))`
  (`backend/routers/systems.py:48`).
- **`superpublic` tier + admin-gated promotion + two-endpoint gallery + client-side merge & search**:
  `Workspace` (`backend/models/workspace.py`, `backend/routers/workspaces.py`,
  `frontend/src/WorkspaceMenu.jsx`). The workspace `update_workspace` rule is the exact policy to
  copy: any project member may set `is_public`; only `auth.user.is_admin` may set `superpublic`;
  `superpublic=true` forces `is_public=true`; you cannot clear `is_public` while `superpublic`
  (`workspaces.py:956-965`).

---

## Design Decisions

Most of this is mechanical mirroring. The genuinely open choices — please confirm before
implementation:

### D1. `project_id` nullability — **recommend nullable** (like `System`, not `Workspace`)

Bootstrap/super-public environments have **no natural home project** (`process_id = NULL`, built by
the operator). `Workspace` made `project_id` NOT NULL by backfilling every row to a "default"
project; that's awkward here. `System` faced the identical situation and made `project_id`
**nullable**, with the global seed row as `project_id = NULL, is_public = True`. Recommend the same:
`Environment.project_id` nullable; bootstrap rows = `NULL / superpublic`; `create_environment` rows =
`process.project_id / private`.

### D2. Split schemas out of the lists — **DECIDED**

**All list endpoints return `id`, `name`, `created_at`, and the visibility fields only. A single
endpoint serves the `process_types` schemas for one environment, gated by read access (readable if
project-local, public, or super-public).**

This is nearly free because the editor **already** fetches per-environment schemas separately:
`ProcessEditor.jsx:74` calls `useEnvironmentProcessTypes(localEnvironment)` →
`GET /environments/{id}/process-types` to build the process-type param form. Nothing in the form
logic reads `environments[].process_types`; the `include_schemas=true` on the list call
(`api.js:334`) currently ships ~44 KB×N of schemas the editor never uses for form-building. So we:

- Drop `include_schemas` from the list endpoints entirely — lists are lightweight.
- Keep the existing single-environment schema endpoint `GET /environments/{env_id}/process-types`
  (and `/{type_name}`) as *the* way to get one environment's schemas, now **access-gated** so it
  serves any environment the caller may read (project-local / public / super-public).

Consequence for the dropdown: every environment the user can legitimately select is already present
in **project-scoped-list ∪ public-gallery** (a private env either lives in your own project's list or
is not readable at all), so — unlike `WorkspaceMenu` — **no separate "pinned selected" fetch is
needed**. A lightweight single-get is optional and only warranted if a readable selected env could
ever fall outside that union; it cannot under this model.

### D3. Admin promotion PATCH — **DECIDED: omit for now**

Visibility is set only at creation (build.sh → super-public; `create_environment` → public/private).
No `PATCH /environments/{id}` to reclassify an existing row. This meets the requirements (the only
super-public producer is `docker/build.sh`) and matches `project-scoped-survey-systems.md`'s
"no admin toggle — only build/migrations set it." If reclassification is ever needed, the endpoint
should be added **together with a GUI to drive it**, not as an orphan API-only toggle — addable later
with no migration and no change to any existing contract.

### D4. MCP + API surface — **DECIDED: mirror workspaces, expose the public gallery to MCP too**

`list_environments` today is global. It becomes project-scoped (`GET /projects/{project_id}/
environments`, requiring `project_id`) — a breaking but intended signature change to the MCP tool
`mcp__ymerflow__list_environments`. `get_environment_process_types`/`get_environment_process_type`
keep their signatures but now enforce read-access.

Crucially, the **search-box API must also be an MCP tool**, giving agents the same public-gallery
reach a human has in the dropdown. We **mirror workspaces**, which expose two separate list tools —
`list_workspaces` (project-scoped) and `list_public_workspaces` (gallery). So environments get the
matching pair:

- `GET /projects/{project_id}/environments` → `operation_id="list_environments"` (project-scoped:
  super-public + project-local).
- `GET /environments/public` → `operation_id="list_public_environments"` → an MCP tool mirroring
  `list_public_workspaces` (all `is_public`, for gallery search).

(Two tools, not one tool with a `scope` param, precisely *because* that's what workspaces do — the
one-unified-tool alternative would diverge from the pattern we're mirroring.)

---

## Implementation

### Phase 1 — Data model + migration

**1.1** `backend/models/environment.py`: add three columns (mirror `system.py` + `workspace.py`):
```python
project_id  = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
is_public   = Column(Boolean, nullable=False, default=False, server_default="0")
superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
```
Add the `project` relationship. Extend `to_dict()` to emit `project_id`, `is_public`, `superpublic`,
and accept an optional `project_name=` kwarg (as `Workspace.to_dict` does) for the public gallery.

**1.2** New Alembic migration (generate the revision id with real entropy —
`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`, then `grep -rn "revision = '<id>'"
--include=*.py .` to confirm uniqueness, per CLAUDE.md rule 9):
- `add_column` the three columns (nullable/`server_default="0"` as above).
- **Backfill**:
  - Bootstrap rows (`process_id IS NULL`) → `superpublic = TRUE, is_public = TRUE`,
    `project_id = NULL`.
  - User rows (`process_id IS NOT NULL`) → `is_public = FALSE, superpublic = FALSE`, and
    `project_id` = the creating process's `project_id`
    (`UPDATE environments e SET project_id = (SELECT p.project_id FROM processes p WHERE p.id =
    e.process_id)`).
- Add FK + index `ix_environments_project_id`. Downgrade drops them.

### Phase 2 — Backend read endpoints (mirror workspaces' two-endpoint split)

Rework `backend/routers/environments.py` (currently prefix `/environments`, unauthenticated):

**2.1** Project-scoped list — the dropdown's main contents (lightweight, D2):
`GET /projects/{project_id}/environments`, `Depends(resolve_project_for_read)`:
```python
select(Environment).where(or_(Environment.superpublic == True,
                              Environment.project_id == access.project.id))
```
(super-public + project-local). Returns `id, name, created_at, is_public, superpublic, project_id`
only — **no `process_types`**. Drop the `include_schemas` param.

**2.2** Public gallery — the search box + super-public source (lightweight, D2), and **its own MCP
tool** (D4): `GET /environments/public`, `operation_id="list_public_environments"`,
`Depends(get_current_user_optional)` (anonymous OK):
`select(Environment).where(Environment.is_public == True)`, returned with `project_name`, no
schemas. Mirrors `list_public_workspaces` (`workspaces.py:281-299`) in both HTTP shape and MCP
exposure.

**2.3** Single-environment schema endpoint — *the* way to get schemas (D2). Keep the existing
`GET /environments/{env_id}/process-types[/{type_name}]` routes, now **access-gated** via an
`_can_read_environment(env, auth, viewing_project)` helper mirroring `_can_read_workspace`
(`workspaces.py:215-251`): readable if `superpublic`/`is_public` OR caller is a member of the env's
home project OR a publication viewing-context resolves to that home project; 404 on denial.

No "pinned selected" single-get is needed (see D2) — a lightweight `GET .../environments/{env_id}`
is optional and left out unless implementation surfaces a need.

**2.4** `POST /environments`: extend `CreateEnvironmentRequest` with `project_id`, `is_public`
(default False). Never accept `superpublic` here.

### Phase 3 — Insert paths set the new fields

**3.1 Bootstrap** — `docker/update_bootstrap_environment.py`: add `superpublic`, `is_public`,
`project_id` to **both** the INSERT (`= TRUE, TRUE, NULL`) and the UPDATE branch (ensure an existing
bootstrap row gets re-marked superpublic on rebuild). Raw SQL — edit both statements.

**3.2 `create_environment`** — two edits:
- `deps/Ymerflow-process-sdk/ymerflow_runner/create_environment.py:248-262`: add
  `"project_id": storage_context['project_id']` and `"is_public": <param>` to the
  `environment.json` payload. Add an `is_public` (public vs private) boolean param to `schema()`
  (default False). **No superpublic param.**
- `backend/models/process.py:1245-1252` (`_create_outputs`): set
  `project_id = env_info.get('project_id') or process.project_id`,
  `is_public = env_info.get('is_public', False)`, `superpublic = False`.

### Phase 4 — Frontend: `EnvironmentMenu` mirroring `WorkspaceMenu`

**4.1** Query hooks in `frontend/src/datamodel/useQueries.js` + `api.js`:
- Change `useEnvironments()` → project-scoped `GET /projects/{projectId}/environments`
  (query key `['environments', projectId]`, `enabled: !!projectId`); drop `include_schemas` from the
  `api.js` call (lists are schema-free now, D2).
- Add `usePublicEnvironments()` → `GET /environments/public` (key `['publicEnvironments']`).
- `useEnvironmentProcessTypes(envId)` is unchanged in shape but its endpoint is now access-gated
  (2.3); it remains the sole source of the selected environment's schemas.
- `useCreateEnvironment` invalidates the project-scoped key (+ public).

**4.2** Replace/extend `EnvironmentSelect.jsx` (or add `EnvironmentMenu.jsx`) to mirror
`WorkspaceMenu.jsx`:
- Merge & dedup (client-side, via a `seen` Set), in order: **pinned selected env if not
  local** → **project-local** → **super-public** (`.filter(e => e.superpublic)` from the public
  list). Mirrors `WorkspaceMenu.jsx:82-84`.
- Rows show `name` + badges (`superpublic` blue / `public` grey) + optional `— project_name` suffix,
  active-row highlight when `id === value`.
- **Search box** = `PublicEnvironmentSearch`, client-side substring filter over
  `usePublicEnvironments()` by `name` (mirror `WorkspaceMenu.jsx:153-208`, incl. the
  `e.stopPropagation()` keydown guard and `autoClose="outside"` shell). No debounce, no server search
  param — same as workspaces.
- Preserve the existing `onChange(id)` contract so `ProcessEditor.jsx:319-328` only swaps the
  component. No per-selection schema fetch is added here — `ProcessEditor.jsx:74`'s
  `useEnvironmentProcessTypes(localEnvironment)` already fetches the selected env's schemas from the
  (now access-gated) single-environment endpoint (D2). `ProcessContext.jsx:212` switches to the
  project-scoped `useEnvironments(projectId)` hook.

### Phase 5 — Process creation access check + MCP

**5.1** When a process is created/updated with an `environment.id`, validate that environment is
readable from the process's project (super/public or project-local) — reuse the
`_can_read_environment` helper. Prevents running another tenant's private image.

**5.2** MCP + docs (D4):
- `list_environments` gains a required `project_id` (now project-scoped).
- New `list_public_environments` MCP tool (from the `operation_id` in 2.2), mirroring
  `list_public_workspaces` — the search-box API available to agents.
- `get_environment_process_types` / `get_environment_process_type` keep signatures but now enforce
  read-access; update descriptions accordingly.
- Update `docs/architecture/environment.md` and any API-endpoint docs listing `GET /environments`.
- Mirror the same changes for the older `nagelfluh` agent's environment tools if still wired.

---

## Testing / Verification

- Migration up+down on a copy of prod-shaped data; confirm bootstrap rows → superpublic, user rows →
  private + correct `project_id` backfill.
- `docker/build.sh` (dev path) rebuild → the bootstrap env appears superpublic and is visible from a
  brand-new project's dropdown.
- `create_environment` in project A with `is_public=false` → **not** visible in project B's dropdown
  or its public search; with `is_public=true` → not in project B's main list but **found via search**,
  and selectable.
- A process in project B pinned to a project-A **public** env still shows that env in the dropdown
  (pinned-fetch path) but a **private** project-A env is rejected by the access check.
- Anonymous `GET /environments/public` returns only `is_public` rows, no schemas.

## Out of Scope

- Admin PATCH to reclassify visibility (D3) — build.sh is the only super-public source for now.
- Any environment rename/delete/management UI.
- Environment "versions" (environments remain single-image; the "Software version" label is cosmetic).

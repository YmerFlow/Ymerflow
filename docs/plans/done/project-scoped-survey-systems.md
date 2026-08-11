# Project-Scoped & Public Survey Systems

## Goal

Survey "systems" (AEM instrument calibration/geometry, parsed from a `.gex` file) are currently a
single flat, admin-only, globally-visible table — the only row that has ever existed was
hand-inserted by a migration. This plan:

1. Makes `System` rows optionally **project-owned** (mirroring the ownership half of the
   `Workspace`/`Publication` pattern) and optionally **public** (a single `is_public` flag — no
   `superpublic` tier for now, since nothing sets it but migrations).
2. Adds a `+` button next to the Survey System dropdown in the AEM Model Simulator's "New Model"
   dialog, letting a project member upload a `.gex` file to add a new system scoped to the current
   project.
3. Keeps the existing SkyTEM 304 seed row visible to everyone by migrating it to
   `project_id = NULL, is_public = True`.

No admin UI for toggling `is_public` is in scope — only migrations set it, same as today's only
row. No rename/delete/management UI for project-owned systems is in scope either — this is
add-only, matching what's being asked for.

---

## Background & Current State

- `System` (`backend/models/system.py`) is a global, unscoped table: `id`, `name`, `gex`
  (msgpack-packed parsed GEX dict), `created_at`. No `project_id`, no visibility flag.
- The only row ever created is the "SkyTEM 304" seed in
  `backend/alembic/versions/cd8330115470_add_system_model.py`, inserted with a hardcoded
  pre-parsed `gex` blob. There is no other seeding path and **no create/update/delete endpoint at
  all** — `backend/routers/systems.py` only exposes `GET /systems`, which lists every row and
  returns them msgpack-packed (to preserve numpy arrays inside `gex`).
- Frontend: `frontend/src/widgets/AEMModelSimulator/CreateModelDialog.jsx` fetches `GET /systems`
  directly with a raw `fetch()` (not a TanStack Query hook — pre-existing tech debt) and renders
  the result as a `oneOf` dropdown (`system` field) inside an RJSF form. There is currently no way
  to add a system from this dialog.
- Parsing raw `.gex` text is done today only inside AEM process containers
  (`docker/base-runner/aem_processes/aem_processes/import_process.py`, via
  `libaarhusxyz.GEX(path)`). The backend itself already depends on `libaarhusxyz>=0.0.41`
  (`setup.py`), so it can parse a `.gex` file directly — this is a small text-config parse, not the
  kind of "expensive backend operation" the project rules warn against.
- Generic file upload already exists: `uploadFile()` (`frontend/src/datamodel/api.js`) POSTs
  multipart to `POST /projects/{project_id}/upload` (`backend/routers/uploads.py`), which stores
  the raw bytes via fsspec, creates an `Upload` row, and returns `{id, filename, url}`. The `url`
  is an auth-free HTTP link (`GET /uploads/{file_id}`); the backend can also just look up the
  `Upload` row by `id` and read it directly via the same fsspec/storage_options path
  `download_file()` uses, without a network round-trip through its own HTTP endpoint.

### Precedent for ownership + visibility: `Workspace`

`backend/models/workspace.py` already has almost exactly this shape:
```python
project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
is_public = Column(Boolean, nullable=False, default=False, server_default="0")
superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
```
One difference: `Workspace.project_id` is required (every workspace has a home project) — flat
`is_public` is the only optional/orthogonal bit. `System` needs `project_id` itself to be
*optional*, since a system can be global (no owning project at all, e.g. the seeded SkyTEM 304)
as well as project-owned. So the new `System.project_id` is **nullable**, unlike `Workspace`'s.

Visibility rule for a system, given a viewing project `P`:
- `is_public = True` → visible regardless of `project_id` (including `project_id IS NULL`).
- `is_public = False` and `project_id = P` → visible (project-owned, private to that project).
- `is_public = False` and `project_id != P` (or `NULL`) → not visible.

There is no "read-only publication can see private project systems" concern beyond the normal
`resolve_project_for_read` pattern already used elsewhere (a publication behaves like its home
project for reads).

---

## Design Decisions (settled)

- **Single `is_public` boolean**, not the two-tier `is_public`/`superpublic` model `Workspace` and
  `Publication` use. Nothing will set `superpublic`-equivalent behavior yet (no admin UI planned),
  so the extra column would be dead weight. If an admin publish-UI for systems is ever built, add
  `superpublic` then as its own migration.
- **Upload flow reuses the generic upload endpoint**, not a bespoke multipart-with-parse endpoint.
  Frontend calls `uploadFile()` (existing `POST /projects/{project_id}/upload`) to stash the raw
  `.gex` bytes, then calls a new `POST /projects/{project_id}/systems` with the resulting
  `upload_id` (and a name). The backend looks up the `Upload` row, reads the bytes via fsspec
  (same pattern as `download_file()` in `uploads.py`), parses with `libaarhusxyz.GEX(...)`, and
  creates the `System` row. This reuses `FileUploadField`/`uploadFile()`'s existing progress-bar
  UX instead of building a second upload code path.
- **Add-only**: no rename/delete/publish-toggle UI for project-owned systems in this plan.

---

## Backend Changes

### 1. Migration: add `project_id` + `is_public` to `systems`, re-home the seed row

New Alembic migration (generate id via `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`,
verify uniqueness per CLAUDE.md rule 9):

```python
def upgrade():
    op.add_column('systems', sa.Column('project_id', sa.String(length=255),
                   sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=True))
    op.create_index('ix_systems_project_id', 'systems', ['project_id'])
    op.add_column('systems', sa.Column('is_public', sa.Boolean(), nullable=False,
                   server_default='0'))
    # Re-home the existing seed row: keep it globally visible.
    op.execute("UPDATE systems SET is_public = true WHERE project_id IS NULL")
```
(The seed row already has `project_id IS NULL` since the column is new — the `UPDATE` just flips
`is_public` for every pre-existing row, which today is only that one.)

`downgrade()` drops the index and both columns.

### 2. `backend/models/system.py`

Add `project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)`
and `is_public = Column(Boolean, nullable=False, default=False, server_default="0")`. Update (or
remove, since it's already dead per its own docstring) `to_dict()` — no need to keep dead code
accurate; delete it rather than patch it, since the `/systems` endpoint builds its own dict
in-router and always has.

### 3. `backend/routers/systems.py` — move under `/projects/{project_id}/systems`, add POST

Every project-resource endpoint lives under `/projects/{project_id}/...` per the API convention in
CLAUDE.md, so:

- `GET /projects/{project_id}/systems` — replaces `GET /systems`. Uses
  `resolve_project_for_read` (read endpoint, so publication viewers work too, consistent with
  every other project-scoped GET). Query:
  ```python
  select(System).where(or_(System.is_public == True, System.project_id == project.id))
  ```
  Response shape/encoding (msgpack, to preserve numpy arrays in `gex`) stays exactly as today, plus
  `project_id` and `is_public` fields per row so the frontend can badge project-owned vs. public
  systems if useful later.

- `POST /projects/{project_id}/systems` — new. Uses `require_project_member` (write). Body:
  `{"name": str, "upload_id": str}`. Steps:
  1. Look up the `Upload` row by `upload_id`; 404 if missing.
  2. Read its bytes via fsspec using the same `resolve_bucket` + `get_fsspec_storage_options`
     pattern `download_file()` in `uploads.py` uses (`asyncio.to_thread` for the blocking read).
  3. Write the bytes to a temp file (`libaarhusxyz.GEX` takes a path) and parse:
     `gex = libaarhusxyz.GEX(tmp_path)`. Let parse errors propagate as a 400 with the underlying
     message — no bare `except: pass` (CLAUDE.md rule 8) — the user needs to know their `.gex` was
     invalid.
  4. `msgpack.packb(gex.gex_dict, ...)` (mirroring `msgpack_numpy`'s `.patch()` already applied in
     this router) and store as `System(name=name, gex=packed, project_id=project.id, is_public=False)`.
  5. Return the created system in the same per-row shape `GET` uses (`id`, `name`, `gex`,
     `created_at`, `project_id`, `is_public`), packed with msgpack, so the frontend can reuse one
     decode path and immediately select the new system.

  Note: check the actual attribute libaarhusxyz's `GEX` class exposes for the parsed dict before
  implementing (`gex.gex_dict` above is a placeholder name — confirm against
  `libaarhusxyz/gex.py` and against what `import_process.py` actually stores via
  `dataset_utils.write_dataset`, so the stored shape matches what `CreateModelDialog.jsx` already
  expects in `xyzData.system`).

- Router prefix changes from `/systems` to `/projects/{project_id}/systems` — update
  `backend/main.py`'s router include if the prefix is set there rather than in
  `routers/systems.py`.

---

## Frontend Changes

### 1. `frontend/src/datamodel/api.js`

Add `listSystems(projectId)` (GET, msgpack-decode via `unpackBinary`, same as today's inline logic
in `CreateModelDialog.jsx`) and `createSystem(projectId, {name, uploadId})` (POST JSON, msgpack-
decode the response). Follows the existing pattern of thin API wrappers other `datamodel/api.js`
functions use.

### 2. `frontend/src/datamodel/useQueries.js`

Add query key `systems: (projectId) => ['systems', projectId]`, plus:
- `useSystems(projectId)` — `useQuery`, `enabled: !!projectId`, reasonable `staleTime` (systems
  change rarely — 5 min, matching `useEnvironments`/`useProjects`).
- `useCreateSystem()` — `useMutation`, no auto-invalidation (per the `useCreateProcess` /
  `useCreatePublication` convention — caller invalidates explicitly), so `CreateModelDialog`
  invalidates `queryKeys.systems(projectId)` itself after a successful upload.

This also fixes `CreateModelDialog.jsx`'s pre-existing raw-`fetch()` tech debt (CLAUDE.md rule 5:
data fetching must go through TanStack Query hooks) as a natural side effect of touching this exact
code path — not a separate unrelated cleanup.

### 3. `frontend/src/widgets/AEMModelSimulator/CreateModelDialog.jsx`

- Pull `currentProject` from `ProcessContext` (same as `LoadModelDialog.jsx`/`SaveModelDialog.jsx`
  already do) and pass it into `useSystems(currentProject)`, replacing the `useEffect`/manual
  `fetch` block (lines 29-47) and the `systems` `useState`.
- Next to the `Survey System` dropdown, add a small `+` button (styled like the existing
  `+ Add Layer` / `+ Add` flightline buttons elsewhere in this widget — green, `+`, same
  padding/border-radius conventions) that opens a new, minimal modal:
  `AddSystemDialog.jsx` (new file, sibling to `AddFlightlineDialog.jsx`, same modal-overlay
  styling conventions as the rest of this widget) with:
  - A name text input (defaults to the uploaded filename minus extension, editable).
  - A file input using the existing `FileUploadField` pattern (`frontend/src/jsoneditor/FileUploadField.jsx`)
    — or a lighter-weight direct call to `uploadFile()` with its own progress bar, since this
    dialog isn't RJSF-schema-driven and doesn't need the full `CustomStringField` wiring. Prefer
    reusing `FileUploadField` directly as a plain component if it doesn't hard-require an RJSF
    context; otherwise inline the `uploadFile()` call with a local progress state, same as
    `FileUploadField` does internally.
  - On upload completion, calls `useCreateSystem()` with `{name, uploadId}`, invalidates
    `queryKeys.systems(currentProject)`, and calls back to `CreateModelDialog` with the new
    system's `id` so it can be pre-selected in the dropdown (mirrors `AddFlightlineDialog`'s
    `onCreate` callback shape).
- Since the dropdown's `oneOf` is rebuilt from `systems` (RJSF `key={`form-${systems.length}`}`
  already forces a remount on count change — reuse this to make the newly-created system appear
  selected without extra plumbing).

### 4. Note on the RJSF `system` field disappearing when a project has zero systems

Today, if `systems` is empty the `system` schema property is omitted entirely (`CreateModelDialog.jsx`
lines 94-108), so the form has no visible "no systems yet" affordance. Since project-scoped systems
means a brand-new project genuinely can start with zero systems, the `+` button must be visible and
usable even when the dropdown itself isn't rendered (i.e. render it unconditionally next to
wherever the dropdown would go, not only when `systems.length > 0`).

---

## Testing

- Migration: run `nagelfluh-migrate` against a copy of an existing dev DB; confirm the SkyTEM 304
  row ends up `project_id = NULL, is_public = true` and is still returned by
  `GET /projects/{any_project}/systems`.
- Backend: `POST /projects/{project_id}/systems` with a real `.gex` file (e.g.
  `data/20201231_20023_IVF_SkyTEM304_SKB.gex` if present in the repo/fixtures) as a non-member →
  403; as a member → 201 with a system whose `gex` round-trips through `unpackBinary` into the same
  shape `CreateModelDialog.jsx` already expects for `xyzData.system`.
- Frontend: open AEM Model Simulator → New Model in a project with zero project-owned systems
  (only the public SkyTEM 304 visible) → confirm dropdown shows it, `+` button visible → upload a
  `.gex` → confirm new system appears selected and a model can be created with it. Switch to a
  different project → confirm the first project's uploaded system is *not* visible there (while
  SkyTEM 304 still is).

---

## Out of Scope (possible follow-ups)

- Admin UI / any UI at all for toggling `is_public` or a `superpublic` tier.
- Rename/delete of project-owned systems.
- Badging public vs. project-owned systems in the dropdown (data is returned either way, since
  `project_id`/`is_public` are in the response — a follow-up can add the badge cheaply).

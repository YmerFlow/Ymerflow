# Process-Editor Defaults

## Goal

Let a user save the full contents of the process editor as a reusable, named **default** and later
re-apply it with one click. A default captures the process type, the parameter form, the resource
settings (CPU/memory/deadline/cluster), the pinned environment, and the selected tags (by name).
Defaults live in a project, or are **public** (searchable) or **superpublic** (admin-only, listed
directly). In the editor, a new selector above the process-type selector picks among them —
project-local + superpublic listed directly, public ones searchable at the bottom — rendered as
cards (title + description + process type), ordered by process type. Selecting a default fills the
entire form.

This mirrors the existing **Workspace versioning + visibility** model almost exactly (parent row
holds identity + sharing flags; a child `*_version` table holds the payload; append-only integer
versions; visibility on the parent; all versions embedded in every read). Where this doc says
"mirror workspaces", it means copy that code path's shape, not invent a new one.

---

## Design Decisions (confirmed with operator)

1. **Environment is hard-pinned.** A default version stores a concrete `environment_id`. On apply,
   that exact software version is selected. (Not "type only", not "fill-if-available".)

2. **Full version history, exactly like workspaces.** Parent `ProcessDefault` + child
   `ProcessDefaultVersion`, unique `(default_id, version)`, append-only `max(version)+1`, first = 1,
   no `latest` pointer. The parent's `to_dict()` **embeds the full ordered version list**; "list
   versions" and "read version" are pure client-side picks off that embedded list — **no separate
   version endpoints** (just like workspaces).

3. **Visibility lives on the parent** (`is_public` / `superpublic`), shared by all versions —
   exactly as `Workspace` carries them. Superpublic is admin-only, enforced inline
   (`if not auth.user.is_admin: raise 403`), and `superpublic=True` forces `is_public=True`.

4. **v1 operations:** save-new, save-new-version, list, list-versions, read-version. **No**
   delete / rename / edit-description / post-hoc visibility toggle in v1.

5. **Public-sensitive-content warning is schema-driven.** When saving a default as public/superpublic,
   scan the parameter schema for fields whose schema is `format: "uri"` or `x-format: "dataset"` and
   that have a value in `formData`; if any exist, confirm with the user before making it public.

6. **A public/superpublic default's pinned environment must itself be visible** (public/superpublic).
   If not, **block the save with an explanation** ("make the environment public/superpublic first").
   This check runs server-side whenever a default is created/saved with `is_public=True`.

7. **Apply is client-side and lenient on resources** (reusing logic already in `ProcessEditor`):
   - type + params + environment + deadline are set from the default.
   - **cluster** is filled in only if it is in the user's allowed set; otherwise left unset
     (falls back to the editor's default — first allowed cluster).
   - **cpu / memory / deadline** are **clamped** to the selected cluster's maxima via the existing
     `handleClusterChange` clamping, never exceeding what the user may request.

8. **Tags are stored by name, not id.** `ProcessTag` is per-project, so a public/superpublic
   default's tag ids would not resolve elsewhere. A default version stores the tag **names**; on
   apply, each name is re-matched against the target project's existing tags and selected if found,
   skipped if not (no auto-creation in v1).

9. **Superpublic `project_id` is nullable.** Following the `Environment`/`System` precedent, a
   superpublic (systemwide) default may have `project_id = NULL`. Project-owned defaults keep a
   non-null `project_id`.

10. **Naming:** model/table/endpoint are `ProcessDefault` / `process_defaults` /
    `/process-default[s]`. The field-level JSON-Schema `default` and process default params are
    unrelated; the collision is only nominal and acceptable per operator.

---

## Data captured by a default version

A default version stores the same fields the editor sends to `POST /projects/{id}/process`
(see `ProcessEditor.jsx` `handleSubmit`), minus the per-process `name`/`inputs`/`outputs`, with
tags stored by name:

| Field | Source in editor | Notes |
|---|---|---|
| `type` | `localType` | process-type key, e.g. `import_skytem` |
| `environment_id` | `localEnvironment` | **hard-pinned** |
| `parameters` | `formData` (cleaned) | JSON |
| `resource_requests` | `{cpu, memory, ephemeral-storage}` | JSON, same k8s notation |
| `deadline_seconds` | `deadlineMinutes*60` | int |
| `cluster_id` | `clusterId` | nullable; may be absent for a viewer who lacks it |
| `tag_names` | `selectedTags` → their names | JSON array of strings (Decision 8) |

The parent `ProcessDefault` additionally holds `title` (name), `description`, `project_id`
(nullable — NULL only for superpublic systemwide rows, Decision 9), `is_public`, `superpublic`,
`created_by`, `created_at`.

---

## Backend

### Model — `backend/models/process_default.py` (new), exported from `backend/models/__init__.py`

**Storage format — mirror `ProcessVersion`'s column split, tags excepted.** `ProcessVersion` does
**not** store the config as one JSON blob: it splits it into typed columns (`type`,
`environment_id`, `parameters` JSON — the only blob, holding the schema-defined params —
`resource_requests` JSON, `deadline_seconds`, `k8s_cluster_id`), keeps the process **name on the
parent `Process`**, and holds **tags as a many-to-many** via `process_version_tags_table` →
`ProcessTag` (per-project). `ProcessDefaultVersion` copies that column layout exactly (dropping the
runtime-only `state`/`dependencies`) and keeps the name on the parent. The **only** deviation is
tags: the association-table approach is per-project and cannot carry across projects for a
public/superpublic default, so tags are stored inline as a `tag_names` JSON array of strings
(Decision 8) instead of an association table.

Structurally, mirror `backend/models/workspace.py` (parent + child, versioning, visibility):

- `ProcessDefault` (parent): `id` String(255) uuid4 PK; `title` NOT NULL; `description` nullable;
  `project_id` FK→projects CASCADE **nullable** (indexed); `is_public` / `superpublic` Boolean
  NOT NULL default False `server_default="0"`; `created_by` FK→users SET NULL nullable; `created_at`.
  Relationship `versions` → `ProcessDefaultVersion`, cascade `all, delete-orphan`,
  `order_by="ProcessDefaultVersion.version"`.
- `ProcessDefaultVersion` (child): `__table_args__ = (UniqueConstraint("default_id", "version"),)`;
  `id` Integer autoincrement PK; `default_id` FK→process_defaults CASCADE indexed; `version` Integer;
  `type` String(100); `environment_id` FK→environments (RESTRICT, matching ProcessVersion);
  `parameters` JSON; `resource_requests` JSON; `deadline_seconds` Integer;
  `k8s_cluster_id` FK→clusters nullable; `tag_names` JSON (array of strings); `created_at`;
  `created_by`.
- `to_dict()` on both, mirroring workspace: parent embeds
  `[v.to_dict() for v in sorted(versions, key=version)]`; version dict exposes
  `version, type, environment_id, parameters, resource_requests, deadline_seconds,
  k8s_cluster_id, tag_names, created_at` (omit internal ids like workspace does).

### Migration — `backend/alembic/versions/<realentropy>_add_process_defaults.py`

Copy the style of `2312aa5235d3_add_environment_visibility_columns.py`:
`op.create_table` for both tables, `server_default="0"` booleans. **Generate the revision id with
`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`** and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` (CLAUDE.md rule 9). No seeded UUID rows needed.

### Router — `backend/routers/process_defaults.py` (new), included in `backend/main.py`

Mirror `backend/routers/workspaces.py`. Reuse the shared auth primitives from
`backend/services/auth_service.py`: `require_project_member` for writes,
`resolve_project_for_read` + `get_current_user_optional` for reads. Mirror `_reload_workspace_dict`
(selectinload after commit) to avoid async lazy-load errors.

| Endpoint | Method + Path | Auth | Body / Query | Returns |
|---|---|---|---|---|
| create default | `POST /projects/{project_id}/process-default` | `require_project_member` | `{title, description, is_public, superpublic, version:{type, environment_id, parameters, resource_requests, deadline_seconds, cluster_id, tag_names}}` | default `to_dict` |
| create version | `POST /projects/{project_id}/process-default/{default_id}/versions` | `require_project_member` | `{version:{...same...}}` | default `to_dict` |
| list | `GET /projects/{project_id}/process-defaults` | `resolve_project_for_read` | — | `[default.to_dict()]` where `or_(superpublic==True, project_id==access.project.id)` |
| list public | `GET /process-defaults/public` | `get_current_user_optional` | — | `[default.to_dict(project_name=…)]` for `is_public==True` |
| read single | `GET /projects/{project_id}/process-default/{default_id}` | `resolve_project_for_read` | — | default `to_dict` (embeds versions ⇒ "list versions"/"read version" are client-side) |

Validation on **create / create-version** (and whenever `is_public` is true):
- `superpublic` in body and not `auth.user.is_admin` → 403; `superpublic=True` ⇒ `is_public=True`.
- **Superpublic `project_id`:** allow NULL (systemwide). A non-admin always creates within their
  project (`project_id` = the path project); only an admin creating a superpublic default may omit
  the owning project.
- **Env-visibility block (Decision 6):** if the resulting default is `is_public` (or superpublic),
  load the pinned `environment`; if it is not `is_public`/`superpublic`, raise 400 with a message
  telling the user to make the environment public/superpublic first.
- Version numbering: `next = max((v.version for v in default.versions), default=0) + 1`; first = 1.

Note: the schema-driven **sensitive-content** warning (Decision 5) is a **frontend** confirm step
before calling the API; the backend does not re-scan params for it (it only enforces the hard
env-visibility rule). The type schema needed for the scan is only reliably available client-side.

---

## Frontend

### API — `frontend/src/datamodel/api.js`

Mirror the workspace block (`getWorkspaces`, `getPublicWorkspaces`, `getWorkspace`,
`saveWorkspace`, `saveWorkspaceVersion`): `getProcessDefaults(projectId)`,
`getPublicProcessDefaults()`, `getProcessDefault(defaultId, projectId)`,
`saveProcessDefault(projectId, body)`, `saveProcessDefaultVersion(projectId, defaultId, versionBody)`.

### Query hooks — `frontend/src/datamodel/useQueries.js`

Mirror: `useProcessDefaults(projectId)`, `usePublicProcessDefaults()` (`staleTime: 30*1000`),
`useProcessDefault(defaultId, projectId)`, `useSaveProcessDefault(projectId)`,
`useSaveProcessDefaultVersion(projectId)` (invalidate the `processDefaults` + `publicProcessDefaults`
keys). Add query keys alongside the workspace keys.

### Selector component — `frontend/src/widgets/ProcessDefaultSelect.jsx` (new)

Placed in `ProcessEditor.jsx` **above** `ProcessTypeSelect` (around line 282). Mirror the
`WorkspaceMenu` dropdown idiom (react-bootstrap `Dropdown`, controlled `show`/`onToggle`,
`autoClose="outside"`, the two `stopPropagation` guards — wrapper `onClick` + input `onKeyDown` —
and `data-rb-guard`, per `bootstrapDropdownConflictGuard.js`):

- **Directly-listed rows:** `useProcessDefaults(currentProject)` (project-local) merged with
  `usePublicProcessDefaults().filter(d => d.superpublic)` (superpublic), deduped by id — the
  WorkspaceList dedup pattern. **Grouped/ordered by process type**, then by title; render as cards
  (title + description + a type sub-label), reusing the `ProcessTypeSelect` card styling
  (`typeTitle`/`typeDescription` helpers). `public`/`superpublic` badges like `EnvironmentBadges`.
- **Bottom search:** copy `PublicWorkspaceSearch` → `PublicProcessDefaultSearch`, filtering
  `usePublicProcessDefaults()` by title substring (client-side; same fetch-all-then-filter idiom).
- A collapsed trigger showing the current selection (or "None").
- Selecting a default card/search-result calls `onApply(default, version=latest)`.

### Apply logic — in `ProcessEditor.jsx`

`onApply(def, version)` reads the chosen version (latest = `versions[versions.length-1]`) and
sets editor state, reusing the existing clamp path:
1. `setLocalEnvironment(v.environment_id)` (hard pin) and `setLocalType(v.type)`.
2. `setFormData(v.parameters || {})`.
3. **Tags by name (Decision 8):** map each name in `v.tag_names` to a tag in the current project's
   tag list; `setSelectedTags(matched)`; names with no matching project tag are skipped.
4. Parse `v.resource_requests` into `cpuCores`/`memoryGb` and `v.deadline_seconds/60` the same way
   the "edit existing version" effect (lines 142-156) already does.
5. **Cluster:** if `v.k8s_cluster_id` is in `clusters` (from `useAvailableClusters`), set it, then
   run the existing `handleClusterChange` to clamp cpu/mem/deadline to that cluster's maxima; else
   leave `clusterId` at the editor default and still clamp to that cluster's maxima.

### Save UI — in `ProcessDefaultSelect` dropdown action items (mirror WorkspaceMenu's Save items)

Two actions in the dropdown (below the list, above the search, with dividers):
- **Save as new default** → modal asking `title`, `description`, visibility
  (`private` / `public`; `superpublic` option only shown to admins).
- **Save as new version of…** → pick an existing editable (project-owned) default, append a version.

On save, build the version body from current editor state (same fields as `handleSubmit` minus
name/inputs/outputs; tags resolved to their **names**). **Before** calling the API, if visibility is
public/superpublic, run the **schema-driven sensitive scan** (Decision 5): walk the active type
schema (`types[localType].schema`) for properties with `format === "uri"` or
`x-format === "dataset"` that have a truthy value in `formData`; if any, show a confirm dialog
listing those field titles and require explicit confirmation before proceeding. The backend
separately enforces the hard env-visibility block (Decision 6) and returns a 400 the modal surfaces
if the pinned environment isn't public.

---

## Out of scope (v1)

Delete / rename / edit-description / post-hoc visibility change / fork of defaults; server-side
search; applying a default outside the process editor; migrating existing processes into defaults;
auto-creating project tags for unmatched tag names on apply.

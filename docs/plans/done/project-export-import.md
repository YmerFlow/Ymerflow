# Project Export / Import

## Goal

Let a project (processes, their versions, output datasets, uploads, and tags) move between
Nagelfluh installations as a single downloadable zip archive, and be re-imported on a different
(or the same) installation as a new project. This is the "take my project with me" / backup
capability — not a live sync or a partial-resource share (that's [Publications](publication-readonly-projects.md),
which is read-only sharing of a project that stays on the *same* installation).

---

## Background & Current State

No export/import mechanism exists today (confirmed by grep — no `export`/`import` project
endpoints or UI). What a project consists of, per the current data model:

### Blob storage (`docs/architecture/storage.md`)

Each project has a dedicated bucket, already shaped like a zip-friendly tree:

```
s3://nagelfluh-project-{project_id}/
├── uploads/{upload_id}/{filename}
└── processes/{process_id}/datasets/{dataset_id}/
    ├── root.msgpack
    └── parts/chunk-N.msgpack
```

### DB rows that constitute "the project"

- `Project` (`backend/models/project.py`) — id, name, storage backend reference.
- `Process` + `ProcessVersion` (`backend/models/process.py`) — name, type, `environment_id`,
  `flow_x`/`flow_y`; per version: `parameters`, `dependencies`, `resource_requests`,
  `deadline_seconds`, `state`, `k8s_cluster_id`, `tags`/`tags_history`.
- `Dataset` — `mime_type`, `dataset_name`, `parts` (JSON pointing at blob paths under the
  process's `datasets/{id}/` prefix).
- `Upload` — **not** FK'd to `project_id` at all (`backend/models/upload.py` has no such column).
  It's associated with a project only by the storage path its `file_url` lives under
  (`{bucket}/uploads/{id}/...`). Export must discover uploads by listing the bucket, not by a
  `project_id`-filtered query.
- `ProcessTag` (project-scoped tag definitions: name/color) and the `tags_history` log on each
  `ProcessVersion`.
- `ProcessLog` — timestamped log lines per version.

### Things that look like project data but are installation-local

These must **not** be copied verbatim into the archive/target — they either don't resolve on the
target install or would silently corrupt it:

- `Environment.docker_image` — points at *this* install's single app-wide container registry
  ([Registry Architecture](../architecture/registry.md)); almost certainly unpullable elsewhere.
- `ProcessVersion.k8s_cluster_id` — a specific `Cluster` row on this install.
- `Project.storage_backend_id` / stored access keys — this install's storage backend.
- `ProjectMember` / `ProjectInvite` — reference `User.id` rows that don't exist on the target.
- Every dataset/process reference **embedded inside** `ProcessVersion.parameters` and
  `Dataset.parts` — these are absolute URLs (`http://.../files/{bucket}/...` or the older
  `http://.../dataset/{id}`, see `Dataset.to_dict`) whose bucket name is
  `{bucket_prefix}{project_id}`. Since the imported project gets a **new** id (to avoid colliding
  with an existing project on the target, or with itself on re-import), every one of these breaks
  unless rewritten.

Confirmed out of scope: `Workspace` (the flexout layout, `backend/models/workspace.py`) has no
`project_id` column — layouts are global/user-level, not project data.

### How a dataset reference ends up embedded in `parameters`

`DatasetSelector.jsx` (`onChange(item.url)`) writes the dataset's *current* `url` string
(`Dataset.to_dict()["url"]`) directly into the JSON Schema form value at whatever path the field
lives at. Separately, `Process.extract_dependencies` re-parses `parameters` for those same URL
strings to build the structured `ProcessVersion.dependencies` list
(`{source_dataset_id, target_param_name}`) used for dependency resolution. So a dataset reference
exists in **two places that must stay consistent**: the structured `dependencies` list (easy to
remap — just swap `source_dataset_id`) and the literal URL string sitting inside `parameters` at
`target_param_name`'s JSON path (must be *regenerated* for the new dataset id, not just
find-and-replaced, since the URL format itself may change between installs/versions).

---

## Design Decisions

### 1. Archive format: zip with a JSON manifest, blob tree copied verbatim (chosen)

```
export.zip
├── manifest.json
├── uploads/{upload_id}/{filename}
└── processes/{process_id}/datasets/{dataset_id}/
    ├── root.msgpack
    └── parts/chunk-N.msgpack
```

The `uploads/` and `processes/` trees are a byte-for-byte copy of the bucket layout (Design
Decision requested by the user: "similar to what's on blob storage, in a zip container"). No
transcoding of dataset content — `root.msgpack`/`parts/*` move as opaque bytes. `manifest.json`
carries everything the DB knows; every dataset/upload reference inside it is a **zip-relative
path** (`./processes/{id}/datasets/{id}/root.msgpack`), never a live URL — that's what makes the
archive portable. JSON (not YAML) to match the rest of the codebase's DB-facing serialization
(every model's `to_dict()`, every JSON column).

Zip entries are stored uncompressed (`ZIP_STORED`) for dataset files — msgpack/GeoTIFF/etc. are
already compressed or don't compress well, and re-compressing large scientific datasets is exactly
the kind of "expensive backend operation" rule 7 in `CLAUDE.md` warns against. `manifest.json`
itself is small and can use normal deflate.

### 2. Environment handling: match by name, auto-create if missing (chosen — user decision)

On import, for each distinct `Environment` referenced by an exported process: look for an existing
`Environment` on the target with the same `name`. If found, use it (its `docker_image` may differ
from the source's — that's fine, that's the target's own environment). If not found, create a new
`Environment` row carrying over `name`, `docker_image`, and `process_types` from the export.
**Exporting/porting the actual container image is explicitly out of scope for this plan** — an
auto-created `Environment` pointing at a source-install image will fail to run on the target until
an admin retags/pushes a matching image or repoints it, but the imported project's history
(parameters, datasets, past results) is still fully intact and viewable. This is a deliberate
tradeoff: don't block import on registry portability, which is a much larger feature.

### 3. Export mechanism: background job + download link (chosen — user decision)

A large project (many/large datasets) streaming into a zip can take a while and risks a
synchronous request timing out. Export runs as a background job — the same shape as process
execution already uses (`asyncio.create_task`, state broadcast via `ws_manager`) — and the
finished zip is written to the project's own bucket (`exports/{export_id}/export.zip`), served
back through the existing `/files/` proxy the same way dataset/upload files already are. No new
storage location or auth model needed; it reuses the bucket the backend already has trusted access
to. The frontend polls/subscribes to the job the same way it does for `ProcessVersion.state`.

Import mirrors this: the zip is submitted like any other file (reuse the existing
`Upload`/upload-token flow rather than inventing a second upload mechanism), then an import job
processes it in the background and reports progress the same way.

### 4. Export scope: full history (chosen — user decision)

Every `ProcessVersion` regardless of `state` (not just `done`), plus `ProcessLog` and
`tags_history`, are included. This makes the export closer to a full backup/audit trail than a
"replay the current results" snapshot — nothing about the project's history is lost. Cost: larger
archives when logs are verbose, and a `queued`/`running` version imports as a version whose
`outputs` are empty and whose `state` is inherently stale (it was never going to finish on the
source install) — see Design Decision 6 for how that's handled on import.

### 5. Membership: importing user becomes sole owner (chosen — user decision)

Import creates exactly one `ProjectMember` row, for whoever ran the import. The source project's
`ProjectMember`/`ProjectInvite` rows are dropped entirely — they reference `User.id` values that
don't exist on the target install, so there's nothing meaningful to carry over. The importing user
can invite others afterward through the existing project-membership flow.

### 6. Non-terminal process versions on import: recorded as history, not resumed (chosen — user decision)

Because Design Decision 4 includes every version regardless of state, an imported `queued` or
`running` version has no Kubernetes job on the target and never will. Confirmed with the user: any
such version is rewritten to `failed` with a synthetic log line appended ("Interrupted by export")
— it's visible in history but the UI (which gates "Cancel"/live-log-tailing on `queued`/`running`)
doesn't try to attach to a job that doesn't exist. `done` and `failed` versions are unaffected.

Implementation detail (not put to the user, flagged here for review when the plan is read back):
this rewrite happens in the manifest at **export** time rather than as a post-processing step on
the newly created rows at import time — it only ever changes what's written into `manifest.json`,
never the source project's actual `ProcessVersion.state` in the DB. Doing it at export time keeps
the import job purely additive (create rows, copy blobs, rewrite references — Design Decision 8)
with no separate "now go back and patch state" pass.

### 7. ID remapping: always regenerate, never preserve source ids (proposed)

Every exported id (`Process.id`, `ProcessVersion` is keyed by `(process_id, version)` so no
separate id, `Dataset.id`, `Upload.id`, `ProcessTag.id`, and `Project.id` itself) gets a **fresh
UUID** on import; `manifest.json` only ever stores the *source* ids (to build the remap table and
because `parts`/`dependencies` reference each other by id internally). Rejected alternative:
preserve original ids. That would only work if the target install can guarantee no collision
against its own existing rows — false in general (importing the same export twice, or importing
into an install that happens to reuse UUID space is unlikely but not something to rely on for
correctness), and it would also mean import can never be safely re-run/retried after a partial
failure without first deleting whatever it already wrote. Regenerating ids makes import naturally
idempotent-on-retry: a failed import's partial `Project` row (and everything cascaded from it) is
simply deleted and the whole job restarted from the same zip.

### 8. Blob copy + reference rewriting order (proposed)

Import processes the manifest in dependency order: (1) create the new `Project` row against the
target's chosen storage backend (target's own default/active backend — never carried over from the
export, per the "installation-local" list above); (2) resolve/create `Environment`s (Decision 2);
(3) walk `processes[]` creating `Process`+`ProcessVersion` rows and copying each
`processes/{old_id}/datasets/{old_id}/...` blob to the new project's bucket under
`processes/{new_id}/datasets/{new_id}/...`, building the old-id→new-id map as it goes; (4) copy
`uploads/{old_id}/...` similarly; (5) second pass over every created `ProcessVersion.parameters`
and `Dataset.parts`, replacing embedded URLs: structured `dependencies` entries get their
`source_dataset_id`/`source_process_id` swapped via the id map, and the literal URL string at each
dependency's `target_param_name` path in `parameters` is **regenerated** from the new dataset's
current `to_dict()["url"]` (not string-substituted) so it matches whatever URL format the target
install's `Dataset.to_dict` currently produces — this is what keeps old- and new-format URLs from
ever needing to coexist. The two-pass structure (create everything with placeholder/self ids,
then rewrite) is required because a dependency can point at a dataset produced by a process that
sorts later in the manifest.

---

## Data Model

Two new small tables to track the async job lifecycle, following the existing `Upload`/`Cluster`
shape (flat row, no relationships beyond a project FK):

```python
# backend/models/project_export.py

class ProjectExport(Base):
    __tablename__ = "project_exports"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    state = Column(String(32), nullable=False, default="queued")  # queued, running, done, failed
    error = Column(Text, nullable=True)
    file_url = Column(String(500), nullable=True)  # storage URL of the finished zip, once done
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)


class ProjectImport(Base):
    __tablename__ = "project_imports"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    upload_id = Column(String(255), ForeignKey("uploads.id"), nullable=False)  # the submitted zip
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    state = Column(String(32), nullable=False, default="queued")
    error = Column(Text, nullable=True)
    project_id = Column(String(255), ForeignKey("projects.id"), nullable=True)  # set once the new project exists
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
```

Migration: new revision, `down_revision` = current head `cbd89ac575e8`. Generate the id with
`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"` and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` per repo rule 9 before committing.

### `manifest.json` shape (sketch, not final)

```jsonc
{
  "format_version": 1,
  "exported_at": "2026-08-09T12:00:00Z",
  "project": { "name": "..." },
  "environments": [
    { "id": "src-env-id", "name": "...", "docker_image": "...", "process_types": { ... } }
  ],
  "process_tags": [ { "id": "src-tag-id", "name": "...", "color": "..." } ],
  "processes": [
    {
      "id": "src-process-id",
      "name": "...", "type": "...", "environment_id": "src-env-id",
      "flow_x": 0, "flow_y": 0,
      "versions": [
        {
          "version": 1, "state": "done",
          "parameters": { "...": "..." },
          "dependencies": [ { "source_dataset_id": "src-dataset-id", "target_param_name": "input_data" } ],
          "resource_requests": { "cpu": "1000m", "memory": "2Gi" },
          "deadline_seconds": 3600,
          "tags": ["src-tag-id"], "tags_history": [ ... ],
          "logs": [ { "timestamp": "...", "message": "..." } ],
          "datasets": [
            { "id": "src-dataset-id", "dataset_name": "resistivity_model", "mime_type": "...",
              "parts": { "files": { "application/x-...": "./processes/src-process-id/datasets/src-dataset-id/root.msgpack" } } }
          ]
        }
      ]
    }
  ],
  "uploads": [
    { "id": "src-upload-id", "filename": "...", "content_type": "...", "path": "./uploads/src-upload-id/..." }
  ]
}
```

---

## Backend Changes

- `backend/services/project_export_service.py` (new): `run_export(db, project_id, export_id)` —
  background task. Lists the project's bucket (admin fsspec credentials, same as
  `storage_service.get_fsspec_storage_options`) to discover uploads (they aren't `project_id`
  queryable, per Background above), walks `Process`/`ProcessVersion`/`Dataset` with the necessary
  `selectinload`s, builds `manifest.json`, streams blob files straight from source storage into
  zip entries (no full-file buffering — same "stream large files" principle as
  `docs/architecture/storage.md`'s best practices), writes the finished zip to
  `exports/{export_id}/export.zip` in the project's own bucket, updates `ProjectExport.state`.
- `backend/services/project_import_service.py` (new): `run_import(db, import_id)` — opens the
  submitted `Upload`'s zip, parses `manifest.json`, executes the ordering from Design Decision 8,
  updates `ProjectImport.state`/`project_id`.
- `backend/routers/projects.py` additions:
  - `POST /projects/{project_id}/export` (`Depends(require_project_member)`) — creates a
    `ProjectExport` row, schedules `run_export`, returns its id.
  - `GET /projects/{project_id}/export/{export_id}` — poll state; once `done`, returns a
    `/files/...` download URL (`storage_url_to_http_url(file_url)`, the exact same helper
    `uploads.py` already uses).
  - `POST /projects/import` (`Depends(get_current_user)`, no project — one doesn't exist yet) —
    body `{upload_id}` (client uploads the zip via the existing `/upload` endpoint first, same
    pattern as any other file), creates a `ProjectImport` row, schedules `run_import`.
  - `GET /projects/import/{import_id}` — poll state; once `done`, returns `project_id`.
- State changes broadcast over the existing WebSocket state channel
  (`ws_manager.broadcast_state`), same mechanism `ProcessVersion.update_state` already uses, so the
  frontend doesn't need a new transport.

## Frontend Changes

Sketch only — not detailed in this pass, since the four user-facing design decisions above are the
load-bearing ones and the UI is comparatively mechanical once the API shape is fixed:

- Project settings/menu: "Export project" button → `POST .../export`, poll via
  `GET .../export/{id}` (or a `useProjectExport` hook following the existing TanStack Query +
  `ProcessContext` invalidation pattern), show progress, then a download link once `done`.
- "Import project" entry point (likely the Projects dropdown, alongside "Create project"): file
  picker → upload via existing `uploadFile()` → `POST /projects/import` → poll → on completion,
  invalidate `['projects']` and switch `currentProject` to the new id.

---

## Migration / Compatibility

- Two new additive tables (`project_exports`, `project_imports`) — no backfill.
- No change to existing endpoints or data shapes; export/import is purely new surface area.

---

## Implementation Steps

1. Migration: `ProjectExport`, `ProjectImport` models + table.
2. `project_export_service.run_export` — bucket listing for uploads, manifest construction
   (including `ProcessLog`/`tags_history` per Decision 4), zip streaming.
3. `project_import_service.run_import` — manifest parsing, environment match/auto-create
   (Decision 2), two-pass create + reference rewrite (Decision 8), non-terminal-version handling
   (Decision 6).
4. Export/import routes on `backend/routers/projects.py` + state broadcast wiring.
5. Frontend: export button + progress/download, import entry point + progress, following the
   sketch above.
6. Manual verification (below).

---

## Verification

- Export a project with: a `done` process with output datasets referencing another process's
  output as input (tests dependency-URL rewriting), a `failed` version, a `queued`/`running`
  version (tests Decision 6), an upload not referenced by any process, and at least one custom
  `ProcessTag` applied to a version.
- Import the resulting zip into a **different** installation (or a second local project, to
  exercise id collision avoidance) where no `Environment` with a matching name exists yet →
  confirm an `Environment` row is auto-created (Decision 2) and the process still shows its full
  parameter/history even though it can't currently run.
- Confirm: dataset input references resolve correctly in the imported process's parameters
  (open it in `ProcessEditor`, verify the dataset selector shows the right dataset, not a broken
  link); the queued/running version now shows `failed` with the synthetic log line; the upload is
  present and downloadable; the imported project has exactly one member (the importing user); logs
  from the source install are visible on the imported versions.
- Re-run the same export zip through import a second time (into the same or another installation)
  → succeeds as an independent second project with entirely new ids, no collision/error.
- Kill/fail an import partway through (e.g. malformed manifest) → confirm the partially-created
  `Project` (and everything cascaded from it) is cleaned up rather than left dangling.

---

## Open Questions

- [ ] **Export size limits** — no cap is proposed in this pass on how large a project (dataset
      volume) can be exported/imported in one job. Worth revisiting once real project sizes are
      known; zip64 support may be needed for archives over ~4GB depending on the zip library used.
- [ ] **Partial export** (a subset of processes rather than the whole project) is out of scope for
      this plan — the user's original ask was whole-project portability. A follow-up could reuse
      most of this machinery for a "duplicate selected processes into another project" feature.
- [ ] **Registry/image portability** (Design Decision 2's explicit out-of-scope item) — a real gap
      for actually *running* imported processes on a fresh install. Left for a future plan; would
      build on [Registry Architecture](../architecture/registry.md).

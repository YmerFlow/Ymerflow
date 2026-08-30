# Move `type` and `environment` from Process to ProcessVersion — Plan

## Goal

`type` and `environment_id` are stored as columns on **`Process`** (`backend/models/process.py:73-74`),
shared by every version of that process. But the process editor lets you pick a different environment
and process type when creating a **new version**, and the backend applies that choice by *mutating the
process row*:

```python
# backend/models/process.py:194-197  (create_queued)
if process:
    new_version = len(process.versions) + 1
    process.type = proc["type"]
    process.environment_id = environment_id
```

Consequences of the current model:

1. **History is falsified.** Submitting v3 with a different environment silently rewrites the
   process-level `type`/`environment`, so v1 and v2 now *report* v3's environment/type even though
   that isn't what they ran under. Reading a process, changing env/type on a new version, and writing
   it back does not round-trip.
2. **Wrong-image race (correctness).** `run_task` reads `process.type` /
   `process.environment_id` **at execution time** (`backend/models/process.py:969,986`), not a
   snapshot taken at submit. If an earlier version is still `queued`/`running` when a new version with
   a different environment is submitted, the in-flight job can launch against the **wrong** image.

`type` and `environment` are conceptually per-run: they determine which container image and which
process-type JSON Schema each version used. They belong on `ProcessVersion`.

## Decisions (agreed with operator)

- **D1 — Storage: drop the Process columns entirely.** `Process.type` and `Process.environment_id`
  are removed. The values live *only* on `ProcessVersion`. No denormalized "latest" mirror on Process.
- **D2 — Wire format: clean break.** API responses expose `type`/`environment` **only inside each
  version object**. `Process.to_dict()` no longer emits a top-level `type`/`environment`. All
  consumers (frontend + MCP tool docs) are updated to read them from a version.
- **D3 — Existing-row migration.** Every existing `ProcessVersion` inherits its parent process's
  current `type`/`environment_id` (copy-down). This is the best achievable — the true per-version
  history was never recorded — and it is no worse than today's behaviour. The migration is a data
  migration, not just a schema change.
- **D4 — `environment_id` FK on ProcessVersion.** `nullable=False`, `ForeignKey("environments.id")`.
  **`ondelete` changes from CASCADE to RESTRICT** (see D5). `type` stays `String(100)`, `nullable=False`.
- **D5 — Environment ↔ Process relationship.** Today `Process.environment_id` is
  `ondelete="CASCADE"` — deleting an Environment deletes every Process that used it (dubious, and now
  wrong-grained since it's per-version). Replace with `Environment.process_versions` via
  `ProcessVersion.environment_id`, `ondelete="RESTRICT"` so an environment in use cannot be deleted
  out from under historical versions. (If operator prefers keeping delete-cascades, flag at review —
  RESTRICT is the safer default.)
- **D6 — Export/import back-compat.** New exports write `type`/`environment_id` inside each version
  entry. Import accepts **both** shapes: if a process entry carries process-level `type`/
  `environment_id` (old manifest), apply it to every version; otherwise read per-version.

## Background — full blast radius

(Confirmed by reading the code, not prior docs.)

### Schema
- `Process` columns `type` (`String(100)`) and `environment_id`
  (`ForeignKey("environments.id", ondelete="CASCADE")`) — `backend/models/process.py:73-74`.
- `Process.to_dict()` emits top-level `"type"` and `"environment"` (minimal) —
  `backend/models/process.py:95,99`.
- `ProcessVersion.to_dict()` emits neither — `backend/models/process.py:376-389`.
- `Environment.processes` relationship via `Process.environment_id`, plus the reverse
  `Process.environment` back_populates — `backend/models/environment.py:24`,
  `backend/models/process.py:84`.

### Write paths
- `create_queued` sets/mutates `process.type` + `process.environment_id` for both the new-process and
  new-version branches — `backend/models/process.py:196-207`. Signature takes `environment_id`.
- `run_task` reads `process.environment_id` (to load the Environment for `docker_image`) and
  `process.type` (passed as `process_type` to `create_job`) — `backend/models/process.py:969,986`.

### API / routers
- `POST /projects/{id}/process` — `ProcessCreate` Pydantic model has top-level `type` +
  `environment: Ref`; endpoint pulls `environment_id = proc.environment.id` and passes to
  `create_queued` — `backend/routers/processes.py:38-46,92-108`. **This stays** — each submission is
  one version, so the request shape is already per-version; only where the values *land* changes.
- `list_processes` / `get_process` eager-load `selectinload(Process.environment)` —
  `backend/routers/processes.py:139,170`. Must become `selectinload(Process.versions).selectinload(ProcessVersion.environment)`.
- Clone endpoint builds `proc = {"type": process.type, "environment_id": process.environment_id, ...}`
  and passes `environment_id=process.environment_id` — `backend/routers/processes.py:305-324`. Must
  read from **`source_version`**, not the process.
- `utilities.py:204` — `"process_type": pv.process.type` (available-clusters helper). Change to
  `pv.type`.

### Stats (admin pivot)
- `backend/routers/stats.py:77,114` — `processes` entity dimension/filter `"type"` →
  `(Process.type, ...)` and `"environment"` → `(Process.environment_id, ...)`.
- `backend/routers/stats.py:82,83` — `versions` entity `"type"` → `(Process.type, ..., needs_join=True)`.
- Under D1 these move to `ProcessVersion.type` / `ProcessVersion.environment_id`. The `processes`
  entity `type`/`environment` dimensions can no longer be plain Process columns:
  - **Decision needed at implementation:** either (a) drop `type`/`environment` from the `processes`
    entity pivot (they're inherently per-version now), or (b) redefine them via a join to the latest
    version. Recommend **(a) drop from `processes`, keep on `versions`** — simplest and semantically
    honest. Flag in the PR.

### Export / import
- Export: `project_export_service.py:136-137` writes process-level `type`/`environment_id`;
  `:79-85` groups the manifest's `environments` list by `process.environment`. Move type/env into each
  version entry (`:113-131`); build the `environments` set by iterating **versions'** environments.
- Import: `project_import_service.py:171-178` sets `type`/`environment_id` on the `Process` row;
  `:183-190` builds `ProcessVersion` without them. Move to per-version, honoring D6 back-compat. The
  Great-Rename type remap (`:36-68`) already rewrites `proc["type"]` — keep that working for both
  manifest shapes.

### Frontend
- `ProcessEditor.jsx:142-143` reads `process.environment?.id` / `process.type` to seed the editor →
  read from the active `versionObj` instead.
- `FlowView/ProcessNode.jsx:159` renders `{process.type}` as the node label → render the latest
  version's type (`process.versions[process.versions.length-1].type`) via a small helper.
- `SaveModelDialog.jsx:85` checks `sourceProcess.type === 'import_ymerflow_aem'` → check the latest
  version's type.
- `api.js` helpers `getProcessVersion` / `getLatestVersion` already exist — add a
  `getLatestProcessType(process)` / read env from a version where needed.
- `ProcessComparison.jsx`, `ProcessInfo.jsx` — audit for `process.type`/`process.environment` use
  during implementation (not yet confirmed to reference them).

## Implementation steps

### 1. Schema + migration
- Add `type = Column(String(100), nullable=False)` and
  `environment_id = Column(String(255), ForeignKey("environments.id", ondelete="RESTRICT"), nullable=False, index=True)`
  to `ProcessVersion`; add `environment = relationship("Environment", ...)`.
- Remove `type`, `environment_id`, and the `environment` relationship from `Process`.
- Update `Environment`: replace `processes` with `process_versions` via
  `ProcessVersion.environment_id`.
- Alembic migration (hand-authored, so **generate the revision id with real entropy** —
  `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`, then `grep -rn "revision = '<id>'"` to
  confirm uniqueness across all migration dirs per CLAUDE.md rule 9):
  1. `add_column` `process_versions.type` (nullable first), `process_versions.environment_id`
     (nullable first) + FK.
  2. Data copy: `UPDATE process_versions SET type=(SELECT type FROM processes WHERE ...),
     environment_id=(SELECT environment_id FROM processes WHERE ...)`.
  3. `alter_column` both to `nullable=False`.
  4. Drop FK + columns `processes.type`, `processes.environment_id`.
  - `downgrade()` reverses (re-add process columns, copy the latest version's values back, drop
     version columns). Note the downgrade is lossy — document it.

### 2. Backend model
- `create_queued(... environment_id ...)`: stop mutating the process; set `type` + `environment_id`
  on the new `ProcessVersion`. New-process branch no longer sets them on `Process`.
- `run_task`: load Environment via `process_version.environment_id`; pass
  `process_type=process_version.type` to `create_job`.
- `Process.to_dict()`: drop top-level `type`/`environment`. `ProcessVersion.to_dict()`: add
  `"type": self.type` and `"environment": self.environment.to_dict(minimal=True) if self.environment
  else None` (requires `selectinload(ProcessVersion.environment)`).

### 3. Routers
- `list_processes` / `get_process`: change eager-load to
  `selectinload(Process.versions).selectinload(ProcessVersion.environment)`.
- Clone endpoint: read `type`/`environment_id` from `source_version`.
- `utilities.py:204`: `pv.type`.
- `stats.py`: move `type`/`environment` to `ProcessVersion` columns; adjust `processes` entity per
  the stats decision above.

### 4. Export / import
- Export: per-version `type`/`environment_id`; build `environments` set from versions.
- Import: D6 back-compat (accept process-level or per-version).

### 5. Frontend
- `ProcessEditor.jsx`, `FlowView/ProcessNode.jsx`, `SaveModelDialog.jsx`, and any confirmed reader:
  read type/environment from a version (latest, or the active version in the editor). Add an
  `api.js` helper.

### 6. MCP tool docstrings
- `get_process` / `list_processes` docs in `backend/routers/processes.py` describe the version
  object's fields — add `type` and `environment` to that description; remove any implication that
  they're process-level.

## Testing / verification
- Migration up+down on a copy of prod-shaped data; verify every version gets the right copied values
  and the columns drop cleanly.
- Submit a process, then a new version with a *different* environment/type; confirm each version
  reports its own env/type and the older version is unchanged.
- Verify the wrong-image race is closed: the in-flight version uses its own stored environment.
- Export a project, re-import it; verify per-version type/env survive. Import an **old** manifest
  (process-level) and verify back-compat.
- Admin stats pivot on `versions` by `type`; confirm the `processes` entity change is coherent.
- Frontend: FlowView node label, ProcessEditor seeding, SaveModelDialog update-detection.

## Out of scope
- Any change to how a *submission* specifies env/type (the `ProcessCreate` request shape is already
  per-version and stays as-is).
- Reconstructing true historical per-version env/type for existing rows (unrecoverable; D3 copy-down).

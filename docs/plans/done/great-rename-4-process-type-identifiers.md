# Great Rename — `import_nagelfluh_aem` Process-Type Key

## Goal

Rename the `import_nagelfluh_aem` process-type key to `import_ymerflow_aem`, **and** make the
project-export ZIP format backwards-compatible so a project exported under the old identifiers
reimports cleanly into the renamed system. This plan owns the **export-ZIP compatibility
mechanism** generally (an import-time translation table), because the process-type key is the
primary — but not only — old identifier that can be embedded in an export manifest.

Split into its own plan because, unlike everything in `great-rename-1-frontend-cosmetic.md` and
`great-rename-3-entrypoint-namespace.md`, this string is **domain data embedded in exported project
ZIPs**. Under the settled migration strategy (no in-place data migration ever — prod is
redeployed from scratch and projects move via GUI export→reimport, see
`great-rename-5-k8s-cloud-infra.md`), the compatibility must live in the **import path**, not a DB
migration.

## Background — current state

- `docker/base-runner/aem_processes/setup.py:39` registers the process type:
  ```
  "import_nagelfluh_aem=aem_processes.import_msgpack_process:MsgpackImporter",
  ```
  under the `nagelfluh.process_types` entry-point group (renamed to `ymerflow.process_types` by
  `great-rename-3-entrypoint-namespace.md` — this plan only concerns the **key itself**,
  `import_nagelfluh_aem`, independent of which group it's registered under).
- `frontend/src/widgets/AEMModelSimulator/SaveModelDialog.jsx:85,89` hard-codes the same string
  twice: `sourceProcess.type === 'import_nagelfluh_aem'` (checking whether an existing process is
  this type, to decide update-vs-create) and `type: 'import_nagelfluh_aem'` (the value sent when
  creating a new one).
- This process type's implementation is `MsgpackImporter`
  (`aem_processes.import_msgpack_process`) — going by the class name and sibling entries
  (`import_skytem`, `process_tem`, `invert_tem`, `forward_tem`, `grid_tem`), this looks like a
  generic **msgpack-format AEM model importer**, not something inherently tied to the
  "Nagelfluh" project name — `nagelfluh` in the key reads like a leftover from when this was the
  project's working name, not a deliberate description of the format or behavior.
- **`import_nagelfluh_aem` can be embedded in an exported project ZIP.** Confirmed by reading
  `backend/services/project_export_service.py` — the manifest carries, verbatim:
  - `processes[].type` (`_build_manifest` → `process.type`, line 133-141) — on import, written
    straight back to `Process.type` with **no validation** (`project_import_service.py:129`,
    `type=proc["type"]`). This is the identifier that actually breaks: a reimported old process
    keeps `type='import_nagelfluh_aem'`, which no longer resolves against the environment's
    (renamed) `process_types`, so it can't render or re-run.
  - `environments[].process_types` (the full JSON schemas, keyed by process-type name) and
    `environments[].docker_image` (e.g. `gcr.io/nagelfluh/nagelfluh-runner`) — but environments
    are matched by **name** on import (`project_import_service.py:89-103`), so the ZIP's copies
    only apply when auto-creating a missing environment; softer than the `type` case.
  - The manifest has an explicit `format_version` (currently `1`, `project_export_service.py:172`)
    — the hook to detect and translate old exports.
- **Bucket/namespace/cluster names do NOT travel in the ZIP** — storage URLs are rewritten to
  zip-relative `./processes/...` paths on export and regenerated for the target bucket on import
  (`_dataset_zip_relative_parts` / `_rewrite`). So none of the cloud-resource renames in
  `great-rename-5-k8s-cloud-infra.md` affect import compatibility; only the embedded *identifiers*
  above do.

## Resolved decisions (settled 2026-08-12)

### 1. New key name: `import_ymerflow_aem`

Literal brand swap, chosen over the descriptive alternatives (`import_msgpack_aem` /
`import_aem_model`) to keep the rename a pure prefix change and avoid scope-creeping a naming
cleanup into it. (The descriptive-rename idea is noted for a possible future cleanup, not done
here.)

### 2. Compatibility: import-time translation table, keyed off `format_version` — NOT an Alembic migration

Because prod is redeployed from scratch and no in-place DB is ever migrated (see
`great-rename-5-k8s-cloud-infra.md`), there is no live `processes` table to `UPDATE`. The only way
an old identifier reaches the renamed system is **through an imported ZIP**, so the compatibility
lives there:

- Add a small, self-contained old→new identifier map to `backend/services/project_import_service.py`.
  When reading a manifest, translate before creating rows:
  - `processes[].type`: `import_nagelfluh_aem` → `import_ymerflow_aem`.
  - `environments[].process_types` keys: the same remap applied to the schema-dict keys.
  - `environments[].docker_image`: rewrite an old `nagelfluh`-registry/image reference to the new
    one (belt-and-suspenders — usually overridden by name-matching an existing environment, but
    an auto-created environment should still get a valid image string). The exact registry/image
    naming comes from `great-rename-5-k8s-cloud-infra.md`.
- **Bump new exports to `format_version: 2`** in `project_export_service.py`. The import
  translation runs for `format_version <= 1` manifests (and is a harmless no-op on a version-2
  manifest, which already has only new identifiers). Keep the translation permanently — old ZIPs
  can be imported at any future time; this is not a time-boxed shim.

## Implementation Steps

1. Rename the entry-point key in `docker/base-runner/aem_processes/setup.py:39`
   (`import_nagelfluh_aem` → `import_ymerflow_aem`) and the two hard-coded strings in
   `frontend/src/widgets/AEMModelSimulator/SaveModelDialog.jsx:85,89`. Reinstall `aem_processes`
   (folds into `great-rename-3-entrypoint-namespace.md`'s reinstall step) / rebuild the runner image.
2. Add the import-time translation map + `format_version`-gated application to
   `project_import_service.py`; bump the export `format_version` to `2` in
   `project_export_service.py`.
3. Verify: export a project containing an AEM-model-import process **before** the rename (or hand-
   craft a `format_version: 1` manifest with `type='import_nagelfluh_aem'`), then import it into
   the renamed system and confirm the resulting process has `type='import_ymerflow_aem'` and
   renders/re-runs. Also confirm a fresh (`format_version: 2`) export round-trips unchanged.

## Open Questions

- [ ] None outstanding. (The descriptive-rename cleanup of the key name is explicitly deferred,
      not open for this rename.)

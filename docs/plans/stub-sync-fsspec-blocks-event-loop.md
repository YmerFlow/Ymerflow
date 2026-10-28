# STUB: synchronous fsspec calls block the asyncio event loop

Separate from
[`db-pool-commit-before-k8s-io.md`](db-pool-commit-before-k8s-io.md) (which fixes DB
*transaction* placement). This stub tracks a **distinct** bug found in the same audit: several
code paths call **synchronous** fsspec (`fs.ls` / `fs.exists` / `fs.open` / `fs.find` /
`f.read()`) directly in an async context, with no `asyncio.to_thread`/executor. Each such call
blocks the **whole event loop** — stalling every other request and task — for the duration of
the (potentially large / slow) object-store operation. This is orthogonal to connection pooling
and needs its own plan + remediation (wrap in `to_thread`, or use an async fs).

Not yet scoped or designed. Known sites from the audit (verify line numbers at planning time):

- `backend/models/process.py` `_create_outputs` — `fs.ls` (`~:1125`) + per-dataset
  `fs.open(...info.json)` loop (`~:1144`).
- `backend/services/plugin_registration.py` `compute_dataset_content_hash` — `fs.find` (`~:38`)
  + `fs.open(f).read()` hash loop (`~:40-41`).
- `backend/services/project_export_service.py` `_build_manifest` — `fs.ls` (`~:153`).
- `backend/routers/datasets.py` `get_file` — `fs.exists` (`~:316`).
- `backend/routers/plugins.py` asset serving — `fs.exists` (`~:316`).
- (Sweep for other bare `fs.`/`.open(`/`.ls(`/`.exists(`/`.find(` calls not wrapped in
  `to_thread` across `backend/`.)

Note: the DB-transaction plan deliberately does **not** change these calls' sync/async nature,
only the surrounding `commit`/`rollback`. Where both plans touch the same lines, coordinate.

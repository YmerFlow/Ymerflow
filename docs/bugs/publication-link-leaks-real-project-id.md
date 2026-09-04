# Bug: Publication (read-only) links leak the underlying real project id in output dataset URLs and file URLs

## Severity

**Medium** — an information-disclosure / capability-leak bug, not a direct data breach.
A publication link is *supposed* to be a self-contained, opaque capability: the holder
should only ever need (and only ever see) the publication id. Instead, essentially every
read response served through a publication link discloses the **real project id**, which
is a *different, more powerful* capability than the publication id the viewer was given.

## Symptoms

When a project is viewed through a **publication id** (a read-only, optionally-anonymous
share link — see `docs/plans/done/publication-readonly-projects.md`), the API is reached
at `/projects/{publication_id}/...`. The responses, however, are full of the **real
project id** rather than the publication id the caller used:

1. **Process output URLs** (`get_process`, `get_process_version_outputs`) come back as

   ```
   http://.../projects/<REAL_PROJECT_ID>/dataset/<dataset_id>
   ```

   not `/projects/<PUBLICATION_ID>/dataset/...`.

2. **Process / dataset JSON** carries a literal `"project_id": "<REAL_PROJECT_ID>"` field.

3. **Dataset file URLs** (the `url` field and every entry under `parts`) come back as

   ```
   http://.../files/<bucket_prefix><REAL_PROJECT_ID>/processes/<proc>/datasets/<ds>/root.msgpack
   ```

   i.e. the real project id is embedded in the **bucket name**, in every downloadable
   file URL.

So a viewer who was only ever handed a publication link can read the real project id out
of any output, any dataset, or any file URL.

## Why this matters

The whole point of the publication design is that a publication id is an **opaque,
independently-revocable capability** that stands in for the project id in the URL path
(`docs/plans/done/publication-readonly-projects.md`, Decision §2 and §7: "a project id
and a publication id are visually indistinguishable, which is what makes 'accept a
publication id anywhere a project id is accepted' a clean substitution"). Leaking the
real project id undermines that in two concrete ways:

- **Revocation is defeated.** Deleting the publication row is supposed to cut off access.
  But once a viewer has learned the real project id, that id is *itself* a valid
  `{project_id}` path segment for every read endpoint. Any **other** live publication on
  the same project — or the viewer later being added as a member, or any future
  code path that trusts a project id from the URL — is now reachable with an id the
  viewer was never meant to hold. The capability the viewer ends up with is broader and
  longer-lived than the one they were granted.

- **The `/files/` proxy is auth-free and keyed on the real bucket.** The file URLs handed
  to publication viewers point at `/files/<bucket_prefix><real_project_id>/...`, which the
  proxy reverse-resolves straight to the real project's bucket
  (`resolve_bucket`, `backend/services/storage_service.py:45-60`) with **no publication
  check at all**. The bucket name *is* `<prefix><real_project_id>`, so the real project id
  is structurally unavoidable in any working download URL. This also means the file layer
  has no notion of "this download came in via a read-only publication" — it just serves the
  bucket to anyone with the URL.

## Root cause

`resolve_project_for_read` resolves a publication id to the **real `Project` object**, and
then every downstream URL/id is built from that real object instead of from the
`project_id` path segment the caller actually used.

`ProjectReadAccess.project` is `publication.project` — the real project:

```python
# backend/services/auth_service.py:220-268
@dataclass
class ProjectReadAccess:
    project: Project
    read_only: bool
    publication: Publication | None = None
...
    return ProjectReadAccess(project=publication.project, read_only=True, publication=publication)
```

`access.project.id` is therefore the **real** project id, not the publication id. It is
correct to use `access.project.id` for **internal DB lookups** (a dataset's
`project_id` column holds the real id, so `dataset.project_id != access.project.id`
ownership checks must compare against the real id). The bug is that the **same real id is
then reflected back into caller-facing URLs and JSON**. The leak happens at several
independent sites:

### 1. Process version output URLs — `access.project.id`

```python
# backend/routers/processes.py:282-287  (get_process_version_outputs)
pv = await _load_process_version(db, access.project.id, process_id, version)
return {
    "version": pv.version,
    "state": pv.state.value,
    "outputs": pv.build_outputs(access.project.id),   # ← builds /projects/<REAL>/dataset/...
}
```

```python
# backend/models/process.py:387-397
def build_outputs(self, project_id: str) -> dict:
    return {
        dataset.dataset_name:
            f"{settings.backend_base_url}/projects/{project_id}/dataset/{dataset.id}"
        for dataset in self.datasets
    }
```

`get_process_version` (`to_detail_dict(access.project.id)`, `processes.py:254`) has the
same shape.

### 2. Process / dataset JSON built from `self.project_id`

`get_process` / `list_processes` render versions via `Process.to_dict`, which uses the
model's own real `self.project_id` unconditionally — it never even sees the publication id:

```python
# backend/models/process.py:117-120
"project_id": self.project_id,                                   # ← real id in JSON
...
"versions": [v.to_dict(self.project_id, verbose=True) for v in sorted_versions]  # ← real id in output URLs
```

`Dataset.to_dict` likewise emits `"project_id": self.project_id`
(`backend/models/dataset.py:68`).

### 3. Dataset file URLs embed the real bucket (`<prefix><real_project_id>`)

The file URLs are produced by `translate_urls_in_dict(..., to_storage=False)` →
`storage_url_to_http_url`, which turns a storage URL into
`/files/<bucket>/...`. The bucket is `<bucket_prefix><real_project_id>` by construction
(`resolve_bucket`, `storage_service.py:45-60`), so the real project id is embedded in the
`url` field and every `parts` entry returned by `get_dataset` / `search_datasets`
(`Dataset.to_dict`, `backend/models/dataset.py:44-70`). This one is the hardest to fix
because the id is baked into the physical storage layout, not just the URL string.

## Affected endpoints (read paths that accept a publication id)

- `GET /projects/{project_id}/process/{process_id}` (`get_process`) — `project_id` field + output URLs
- `GET /projects/{project_id}/processes` (`list_processes`, verbose) — output URLs
- `GET /projects/{project_id}/process/{process_id}/version` (`get_process_version`) — output URLs
- `GET /projects/{project_id}/process/{process_id}/version/outputs` (`get_process_version_outputs`) — output URLs
- `GET /projects/{project_id}/dataset/{dataset_id}` (`get_dataset`) — `project_id` field, `url`, `parts`
- `GET /projects/{project_id}/datasets` (`search_datasets`) — `project_id` field, `url`, `parts`
- WS `/ws/processes/updates` broadcasts (`ProcessVersion.update_state`, `backend/models/process.py:499-519`) — dataset dicts with real ids. This is actually a broader, separate bug (global + unauthenticated fan-out); written up in [`ws-state-broadcast-global-cross-project-leak.md`](ws-state-broadcast-global-cross-project-leak.md).

## Reproduction

1. As a project member, create a publication with anonymous access allowed for project
   `P_REAL` → publication id `P_PUB`.
2. Anonymously (or as a non-member) call
   `GET /projects/P_PUB/process/{proc}/version/outputs` for a completed version.
3. Observe the returned `outputs` URLs contain `P_REAL`, not `P_PUB`.
4. Call `GET /projects/P_PUB/dataset/{ds}` and observe `"project_id": "P_REAL"` and a
   `url` of `.../files/<prefix>P_REAL/...`.
5. `P_REAL` was never supposed to be visible to this viewer.

## Fix options (for discussion — not yet decided)

Per repo workflow, the concrete fix belongs in a plan; recording the option space here.

1. **Reflect the caller's id back (URL rewriting).** Thread the *requested* `project_id`
   path segment (the publication id) through the response builders so `build_outputs`,
   `to_dict`, and the file-URL translation emit `/projects/<PUBLICATION_ID>/dataset/...`
   and `/files/...` URLs that route back through a publication-aware endpoint. Keep
   `access.project.id` for internal DB lookups only.
   - Requires a publication-aware `/files/` path (the proxy currently keys on the real
     bucket with no publication check), or a signed/opaque file token, so the real bucket
     name never appears client-side.
   - Most faithful to the "opaque capability" intent; most work (touches the storage/bucket
     layer, which currently *is* the real project id).

2. **Strip / null the `project_id` field and internal ids from read-only responses.**
   When `access.read_only`, omit `project_id` from process/dataset dicts and refuse to emit
   `/projects/<real>/...` output URLs (or rewrite just the path segment). Cheaper, but the
   file-URL bucket leak (option-3 territory) remains.

3. **Accept the leak, document it, and harden revocation instead.** Decide that a
   publication viewer legitimately learns the real project id, and ensure that knowing the
   real id grants *nothing* without either membership or a live publication (i.e. never let
   a bare real project id from the URL bypass the publication/membership gate). This makes
   the leak benign-by-design but should be an explicit, reviewed decision rather than the
   current accidental behaviour.

The `ProjectReadAccess` dataclass already carries the `publication` object, so the
requested id is available at every call site — option 1/2 have the data they need without
new plumbing into the resolver.

## Notes

- This is the flip side of a deliberate design choice: `access.project.id` returning the
  real id is *required* for the internal ownership checks
  (`dataset.project_id != access.project.id`, `processes.py:194` etc.). The bug is purely
  that the same value escapes into caller-facing fields; the internal checks are correct.
- No write endpoint is affected — writes never accept a publication id
  (`require_project_member` raises 403). This is strictly a read-path disclosure.

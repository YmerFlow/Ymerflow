# Publication link id opacity — stop leaking the real project id

## Goal

Make a **publication (read-only) link** a genuinely opaque capability: a viewer who was
handed only a publication id must never see the underlying **real project id** — not in
metadata URLs, not in `project_id` JSON fields, and not in file download URLs.

This fixes the bug documented in
[`docs/bugs/publication-link-leaks-real-project-id.md`](../bugs/publication-link-leaks-real-project-id.md).

The mechanism: whenever a response is served through a publication link, every occurrence
of the real project id is rewritten to the **publication id** on the way out; and the
`/files/` proxy learns to accept a publication id where it expects a project-bucket and
resolve it back to the real project on the way in. A recognizable **prefix on publication
ids** (`pub-…`) lets the inbound file proxy detect the publication case with a cheap regex
instead of an extra DB round-trip on every (overwhelmingly real-project) file load.

As a bonus, this makes publication **file downloads revocable**: once the id in a file URL
is a publication id, deleting the publication makes those URLs 404 (real-project file URLs
remain auth-free and non-revocable exactly as today).

---

## Background & current state

See the bug report for the full leak inventory. The essentials:

- `resolve_project_for_read` (`backend/services/auth_service.py:227-290`) resolves a
  publication id to the **real `Project`**, exposed as `ProjectReadAccess.project` (and it
  also carries the `publication` object). Using `access.project.id` for **internal DB
  lookups is correct** (dataset/process rows store the real id); the bug is only that the
  real id then escapes into caller-facing fields.
- Real project id escapes in three shapes:
  1. **Metadata URLs** — `…/projects/<REAL>/dataset/<id>` from `build_outputs`
     (`backend/models/process.py:387-397`) called with `access.project.id`.
  2. **`project_id` JSON field** — `Process.to_dict` / `Dataset.to_dict` emit
     `self.project_id` (`backend/models/process.py:117`, `backend/models/dataset.py:68`).
  3. **File URLs** — `/files/<bucket_prefix><REAL>/…`, because the bucket name *is*
     `<bucket_prefix><project.id>` (`storage_protocols/s3.py:22-24`,
     `storage_service.py:45-60`) and `/files/` is auth-free ("the URL is the capability",
     `datasets.py:275-305`).

The frontend already treats the `p` URL segment (`currentProject`) as an opaque value and
threads it into every `/projects/{project_id}/…` call, so a `pub-…` id in that segment
already flows through unmodified — **no frontend change is expected** (to be confirmed by a
grep during implementation that nothing client-side parses a project id out of a bucket or
file URL).

---

## Design decisions

### 1. Rewrite the real id → publication id at the router boundary (chosen)

When `access.read_only` is true, pass the finished response payload through a single helper
that replaces every occurrence of `access.project.id` (the real id) with
`access.publication.id` (the id the caller used):

```python
# backend/services/auth_service.py (or a small new response_service.py)
def redact_project_id(payload, access: ProjectReadAccess):
    """When serving through a publication link, swap the real project id for the
    publication id everywhere it appears (project_id fields, /projects/<id>/... metadata
    URLs, and /files/<bucket_prefix><id>/... file URLs). No-op for real-membership reads."""
    if not access.read_only or access.publication is None:
        return payload
    return _deep_str_replace(payload, access.project.id, access.publication.id)
```

`_deep_str_replace` walks dicts/lists and does a plain substring replace on strings. The
real project id is a full uuid4, so a substring replace is safe:

- `"project_id": "<REAL>"` → `"<PUB>"`
- `".../projects/<REAL>/dataset/<id>"` → `".../projects/<PUB>/dataset/<id>"`
- `".../files/<bucket_prefix><REAL>/..."` → `".../files/<bucket_prefix><PUB>/..."`
  (the real id is a substring of the bucket segment, so the bucket segment becomes
  `<bucket_prefix><PUB>` — exactly what the inbound proxy will expect).

Applied at the `return` of every pure-read endpoint that uses `resolve_project_for_read`:
`get_process`, `list_processes`, `get_process_version`, `get_process_version_outputs`
(`routers/processes.py`), `get_dataset`, `search_datasets` (`routers/datasets.py`).

**Why this over threading publication context into every model method?** `build_outputs`,
`Process.to_dict`, `Dataset.to_dict`, and `translate_urls_in_dict` are all model-layer and
publication-unaware. A single boundary pass covers all three leak shapes (fields, metadata
URLs, file URLs incl. `parts` and translated `parameters`) with one choke point and no
model-signature churn. It also keeps `access.project.id` as the *only* value used for
internal ownership checks — those stay on the real id and are untouched.

**Collision safety:** the value replaced is a full uuid4; it cannot plausibly appear as a
substring of any non-id field in a JSON metadata response. Documented as an assumption.

### 2. Recognizable publication-id prefix `pub-` (chosen)

Change `Publication.id`'s default so new ids are `"pub-" + uuid4()`:

```python
# backend/models/project.py
id = Column(String(255), primary_key=True, default=lambda: "pub-" + str(uuid.uuid4()))
```

`String(255)` already has room (this is not a `String(36)` UUID column, so CLAUDE.md rule
10's width trap does not apply; the entropy is still a real `uuid4`). A real project id is a
bare uuid4 and never starts with `pub-`, so `^pub-` unambiguously distinguishes the two.

This makes the id **self-describing everywhere it appears** — the URL path segment, the
`project_id` field after rewrite, and (critically) the bucket segment of a file URL — so the
inbound file proxy can branch on a regex instead of a speculative DB lookup.

`resolve_project_for_read` is unaffected: it matches `Publication.id == project_id` exactly,
and a `pub-…` id still fails the real-membership query and falls through to the publication
lookup as today. (Optional micro-opt: skip the membership query when `project_id`
matches `^pub-`. Not required.)

### 3. Inbound `/files/` proxy resolves a `pub-`-prefixed bucket to the real project (chosen)

`resolve_bucket` (`storage_service.py:45-60`) currently strips `bucket_prefix` and looks up
the remainder as a `Project.id`. Extend it: if the remainder matches `^pub-`, look it up as
a `Publication.id` instead and return `publication.project` + backend.

Then `get_file` (`datasets.py:275-305`) and `download_file` (`uploads.py:185-…`) must build
the real storage URL from the **resolved project**, not from the client-supplied bucket
segment:

```python
project, backend = await resolve_bucket(db, bucket)          # bucket may be pub-prefixed
handler = get_protocol_handler(backend.protocol)
real_base = handler.storage_base_url(project, backend)        # <scheme>://<bucket_prefix><REAL>
rest = path.split("/", 1)[1] if "/" in path else ""
storage_url = f"{real_base}/{rest}" if rest else real_base
```

(`get_file` currently reuses the client `path` verbatim — fine when bucket == real bucket,
wrong for a `pub-` bucket. Reconstructing from `real_base` is correct in both cases, so this
is a strict improvement.)

**Cost:** real-project file loads (the overwhelming majority, logged-in users) never match
`^pub-`, so they take the existing single project lookup with **zero added DB work**. Only
`pub-`-bucket loads pay one publication lookup. This is the performance property the design
brief called for (no preventive per-load publication DB hit).

### 4. Revocation of publication file URLs falls out for free (chosen, documented)

Because a publication file URL now carries the publication id, deleting the publication row
makes `resolve_bucket`'s publication lookup miss → `get_file` returns 404. So publication
downloads become revocable. Real-project file URLs are unchanged: still auth-free, still
non-revocable (a member who saved a `/files/<prefix><REAL>/…` URL keeps it — same as today).

### 5. `/files/` stays auth-free even for publications (chosen, documented limitation)

The `/files/` proxy has no auth context, so it cannot enforce a non-anonymous publication's
login requirement on raw file reads — it can only enforce *existence* (revocation, §4). A
`pub-`-bucket file URL therefore serves to anyone holding the (unguessable, uuid-structured)
URL, consistent with how real-project file URLs already behave regardless of membership.
`allow_anonymous` continues to gate the **metadata** endpoints via
`resolve_project_for_read`. Tightening raw-file auth for non-anonymous publications is a
possible follow-up, not part of this plan.

---

### Legacy publications without the `pub-` prefix — let them break (decided)

No migration, no fallback. Changing the `default` prefixes **new** publications only.
Existing un-prefixed publications keep working for **metadata** (`resolve_project_for_read`
matches `Publication.id` exactly regardless of shape), but their **file URLs will 404**:
an old publication's file URL carries a bare-uuid bucket that `resolve_bucket` no longer
recognizes as a publication (`^pub-` miss) and can't match as a real project. This is
accepted — the publication feature only just landed and there are ~no external links in the
wild yet. Re-creating the publication yields a `pub-…` id that works end to end.

This keeps `resolve_bucket` simple: real project id → project lookup; `^pub-` → publication
lookup; anything else → 404. No speculative third lookup.

---

## Out of scope

### WebSocket `/ws/processes/updates` leak — separate bug

`broadcast_state` (`websocket_service.py:54-71`) is a **global, unauthenticated, unscoped**
fan-out: every connected client — logged in or not — receives every process's state updates,
including `outputs` dataset dicts with real ids and `/files/` URLs
(`ProcessVersion.update_state`, `models/process.py:499-519`). This is a broader pre-existing
cross-tenant exposure with **no per-connection publication (or user) context** to redact
against, so fixing it means authenticating and rescoping the broadcast (per-project
channels), not a one-line redaction. It is therefore **out of scope for this plan** and
written up separately in
[`docs/bugs/ws-state-broadcast-global-cross-project-leak.md`](../bugs/ws-state-broadcast-global-cross-project-leak.md).

---

## Implementation outline (after decisions locked)

1. `backend/models/project.py` — `Publication.id` default → `"pub-" + uuid.uuid4()`.
2. `backend/services/auth_service.py` (or new `response_service.py`) — add
   `redact_project_id(payload, access)` + `_deep_str_replace` helper.
3. `backend/routers/processes.py` — wrap returns of `get_process`, `list_processes`,
   `get_process_version`, `get_process_version_outputs` with `redact_project_id(..., access)`.
4. `backend/routers/datasets.py` — wrap returns of `get_dataset`, `search_datasets`; and in
   `get_file`, reconstruct `storage_url` from the resolved project's `storage_base_url`.
5. `backend/services/storage_service.py` — `resolve_bucket`: branch to a `Publication`
   lookup when the id after `bucket_prefix` matches `^pub-`.
6. `backend/routers/uploads.py` — `download_file`: same real-base reconstruction as `get_file`.
7. Grep the frontend to confirm nothing parses a project id out of a bucket/file URL
   (expected: no change needed).

## Testing

- **Metadata opacity:** as a non-member with an anonymous publication `pub-X` for project
  `REAL`, `GET /projects/pub-X/process/{p}/version/outputs`, `…/dataset/{d}`, `…/datasets`
  return **no** occurrence of `REAL` — all ids/URLs carry `pub-X`.
- **File round-trip:** a `/files/<bucket_prefix>pub-X/…` URL from those responses downloads
  the correct bytes (proxy resolves `pub-X` → `REAL` bucket).
- **Revocation:** delete the publication → the same `/files/<…>pub-X/…` URL now 404s; the
  equivalent real-bucket URL (member path) still serves.
- **No-regression / no added cost:** a member reading `/projects/REAL/…` sees `REAL`
  unchanged (redaction is a no-op) and file loads issue no publication query.
- **Guard:** a bare real project id is still not usable as a publication id — non-member
  `GET /projects/REAL/…` → 404 (unchanged; documents the boundary from the bug report).

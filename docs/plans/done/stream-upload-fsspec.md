# Stream file uploads through the backend with fsspec (raw-body PUT)

## Goal

The upload endpoint currently loads the **entire** uploaded file into the backend process's RAM
before writing it to object storage. For a large import (a 4.3 GB project-export zip) this means a
4.3 GB Python `bytes` object in the backend pod. It only works today because the backend pod has
**no memory limit** and the prod host happens to have ~55 GB free — the moment a memory limit is set
(or the host is busy) this OOMs. It also spools the whole body to the pod's ephemeral disk first
(Starlette's multipart parser), so a 4.3 GB upload needs 4.3 GB of pod scratch space too.

Change the endpoint so the request body is **streamed** from the client straight into the fsspec
object-store handle in bounded chunks. Backend memory stays flat (tens of MB) regardless of file
size, and nothing is buffered whole in RAM or on disk. s3fs turns chunked writes into an S3
multipart upload automatically.

**Chosen approach: Option C — raw-body upload.** The client sends the file as the raw request body
(`application/octet-stream`), not a `multipart/form-data` form. The backend consumes
`request.stream()` and writes each chunk to fsspec. This is the simplest code path to true streaming
(no multipart boundary parsing) and — because every frontend upload already funnels through one
wrapper — costs the frontend a single function change. See [D1](#d1--strategy-decided-option-c) for
why C over the alternatives, and the client inventory it touches.

Out of scope for this change (see [Follow-ups](#follow-ups)): the **download** endpoint has the same
whole-file-into-RAM problem, and the nginx `client_max_body_size`/timeout edge change that unblocked
large uploads (see the `prod-upload-size-413` memory / `frontend/snippets/app-locations.conf`).

## Current state

`backend/routers/uploads.py`:

- `upload_file()` (`@router.post("/projects/{project_id}/upload")`, line 45) auto-detects two body
  formats from `Content-Type`:
  - **JSON + base64** (`application/json`, line 75-83) — the MCP path, for files up to ~20 MB.
    Decodes base64 into `content: bytes`. Whole-file-in-RAM but capped small. **Kept as-is** (D3).
  - **multipart/form-data** (line 84-91) — the browser/curl path. `form = await request.form()`
    spools the file to a `SpooledTemporaryFile` (RAM then ephemeral disk); `content = await
    file.read()` then copies the whole spooled file into one `bytes` object. **This path is replaced
    by the raw-body path.**
- Both currently hand `content: bytes` to `_write_upload(content, ...)` (line 20-42):
  `with fsspec.open(file_url, "wb", **opts) as f: f.write(content)` in a thread — one blocking write
  of the whole buffer.
- `request_upload_token()` (line 96) issues the `upt_` token for large curl uploads — unchanged;
  only the curl command shape it documents changes.
- `download_file()` (line 130) also reads the whole file into RAM — related, out of scope here.

Helpers (exist, unchanged): `get_upload_storage_url` (`storage_service.py:80`),
`get_fsspec_storage_options` (`:69`), `storage_url_to_http_url` (`:86`).

### Client inventory (everything that hits this endpoint)

- **Frontend — one wrapper**, `uploadFile(file, onProgress, projectId)` in
  `frontend/src/datamodel/api.js:429`. All five call sites keep the same signature (no call-site
  edits): `ProjectModal.jsx:113` (export-zip import — the 4.3 GB case), `ProcessContext.jsx:369`
  (manual-edits diff), `jsoneditor/FileUploadField.jsx:21` (generic form file field),
  `AEMModelSimulator/SaveModelDialog.jsx:75` (saved model), `AEMModelSimulator/AddSystemDialog.jsx:47`
  (`.gex` system file).
- **curl / external + the `upt_` token flow** — documented `curl -F "file=@…"` examples in
  `backend/routers/uploads.py` (docstring l.56, l.65-67), `backend/main.py:136-137`, and
  `docs/mcp-tools.md` (l.350, l.364-365). **These break** (multipart → raw) and must be updated.
- **MCP `upload_file` tool** — uses the JSON+base64 branch, which we keep, so **unaffected**.
- **Not affected:** the backend's own export/import services write blobs directly to storage via
  fsspec (`project_import_service.py:274`), not through this endpoint.

Dep versions (verified in `env/`): starlette 0.50.0, fastapi 0.128.0, fsspec 2026.1.0, s3fs 2026.1.0.
Streaming works end-to-end because nginx `/api/` sets `proxy_request_buffering off` +
`client_max_body_size 0`, and uvicorn/Starlette impose no default body-size limit.

## Design decisions

### D1 — Strategy: DECIDED, Option C

Rejected: **A** (chunked copy via Starlette `UploadFile`) still spools the whole file to the pod's
ephemeral disk — not real streaming. **B** (streaming multipart parser) keeps the multipart contract
but needs manual boundary parsing. **C** is chosen: simplest true-streaming code, and the frontend
cost is one function because all uploads share `uploadFile`. C's price — a breaking change for curl
`-F` / token clients — is accepted and handled by updating all three doc sites. (C only pays off if
it *replaces* multipart rather than adding alongside it; we replace.)

### D1a — How filename & content-type travel (NEW, needs sign-off)

Raw body has no form field carrying the filename. Proposal:
- **Filename** via query param: `POST /projects/{id}/upload?filename=<url-encoded name>`.
- **Content-type** via the `Content-Type` request header (falls back to `application/octet-stream`).

Rationale: trivial to set in both axios (`params`, `headers`) and curl (`--data-binary @f` +
`?filename=` + `-H "Content-Type: …"`), and keeps the path scheme intact. Alternative was
`Content-Disposition: attachment; filename="…"`; query param is simpler. **Agree with query-param
filename + Content-Type header?**

### D2 — Chunk / s3fs part size
S3 allows max 10,000 parts, so part size ≥ ~450 KB for 4.3 GB; the s3fs default (tens of MB) is safe
and bounds memory to ~one part. **Proposal: accept the s3fs default, document the effective value, do
not pin unless testing shows a reason.** OK?

### D3 — Keep the JSON+base64 path
Keep it unchanged for MCP small files, but add an explicit guard rejecting bodies over a documented
cap (~25 MB) with a clear error instead of silently buffering. **OK?**

### D4 — Partial-upload / disconnect handling
On mid-stream disconnect we must not leave a committed, truncated object. **Proposal:** stream inside
`try/except`; on any error abort the S3 multipart (close-with-abort / `discard()`), and create the
`Upload` DB row **only after** a clean `close()`. **OK?**

## Change

### 1. `backend/routers/uploads.py` — raw-body streaming branch

- `upload_file(request, project, db)`: branch on `Content-Type`:
  - `application/json` → existing base64 path, plus the D3 size guard.
  - otherwise → **new raw-body streaming path** (replaces the multipart branch):
    1. `filename = request.query_params.get("filename", "upload")`;
       `mime = request.headers.get("content-type") or "application/octet-stream"`;
       `upload_id = uuid4()`.
    2. `file_url = await get_upload_storage_url(db, project.id, upload_id, filename)`;
       `storage_options = await get_fsspec_storage_options(db, project.id)`.
    3. Open the fsspec handle for writing **in a worker thread**
       (`fh = await asyncio.to_thread(lambda: fsspec.open(file_url, "wb", **storage_options).open())`
       — or resolve the filesystem and `fs.open(path, "wb")`), then:
       ```python
       try:
           async for chunk in request.stream():
               await asyncio.to_thread(fh.write, chunk)   # blocking S3 part upload off the loop
           await asyncio.to_thread(fh.close)              # finalize the multipart
       except BaseException:
           await asyncio.to_thread(_abort, fh)            # abort multipart, no committed object
           raise                                          # never swallow (repo rule 8)
       ```
    4. After a clean close, create the `Upload` row (`id`, `filename`, `content_type=mime`,
       `file_url`), commit, and return `{"id", "filename", "url": storage_url_to_http_url(file_url)}`
       — **identical response shape** to today.
- Retire `_write_upload`'s whole-buffer write (or repurpose it for the small JSON path only).
- Update the endpoint **docstring**: raw-body usage + new curl examples (below).

### 2. `frontend/src/datamodel/api.js` — `uploadFile` sends raw body

Replace the `FormData` body with the raw `File`; keep the signature and progress callback:
```js
export async function uploadFile(file, onProgress, projectId) {
  const response = await apiClient.post(
    `/projects/${projectId}/upload`,
    file,                                   // raw File as body
    {
      params: { filename: file.name },
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      onUploadProgress: (e) => {
        if (onProgress && e.lengthComputable) onProgress((e.loaded / e.total) * 100);
      },
    }
  );
  return response.data;
}
```
All five callers are unchanged. axios reports upload progress for a raw `File` body via XHR.

### 3. Docs & curl examples (the breaking-change surface)

Update every `curl -F "file=@…"` to raw-body form, in:
- `backend/routers/uploads.py` docstring (l.56, l.65-67)
- `backend/main.py:136-137` (MCP instruction string)
- `docs/mcp-tools.md` (l.350, l.364-365)

New shape:
```bash
curl -X POST "https://host/projects/{project_id}/upload?filename=survey.xyz" \
  -H "Authorization: Bearer upt_..." \
  -H "Content-Type: application/octet-stream" \
  --data-binary @survey.xyz
```
Note in `docs/mcp-tools.md` that `upload_file` (MCP JSON+base64) is unchanged; only the large-file
curl path switched from multipart to raw body.

## Testing

- **Small files, both paths:** raw-body upload (each of the 5 UI entry points) and JSON+base64 (MCP)
  → 200, object in MinIO, DB `Upload` row correct, `/files/…` URL downloads identical bytes.
- **Memory (acceptance criterion):** upload a multi-GB file while watching backend RSS
  (`kubectl top pod` / `/proc/<pid>/status`) — RSS stays flat (tens of MB), not linear in file size.
- **Scale reproduction:** re-run the 4.3 GB authenticated upload from the 413 investigation, now as a
  raw-body POST → 200, no backend restart, flat memory; then the real path: **create project from
  export → import** the 4.3 GB zip.
- **Disconnect (D4):** kill the client mid-upload → no committed object, no `Upload` row, no crash.
- **curl:** the new `--data-binary` + `?filename=` command (with a `upt_` token) works.
- **Regression:** MCP `upload_file` base64 small upload unchanged; oversize JSON rejected cleanly.

## Follow-ups (not in this plan)

- **Stream the download** symmetrically: `download_file()` (`uploads.py:130`) does `content = f.read()`
  then `Response(content=…)` — swap for a `StreamingResponse` over a chunked fsspec read.
- Consider direct-to-MinIO for very large export/import archives (bigger design change).

## Workflow (per CLAUDE.md rule 2)

Draft. Open items: confirm **D1a, D2, D3, D4**. Then: finalize → operator commits this file →
implement in a separate session → move to `docs/plans/done/` in the same commit as the code.

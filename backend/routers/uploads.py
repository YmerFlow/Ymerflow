import asyncio
import base64
import uuid
from datetime import timedelta

import fsspec
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.database import get_db
from backend.models import Upload, Project
from backend.services.storage_service import get_upload_storage_url, storage_url_to_http_url, get_fsspec_storage_options
from backend.services.auth_service import get_current_user, AuthContext, create_access_token, require_project_member

router = APIRouter(tags=["Uploads"])

# Max size for the in-RAM JSON+base64 upload path (MCP small files). Larger uploads
# must use the streaming raw-body path instead of being silently buffered whole.
MAX_JSON_UPLOAD_BYTES = 25 * 1024 * 1024


async def _create_upload_record(project_id: str, upload_id: str, filename: str,
                                content_type: str, file_url: str, db: AsyncSession) -> dict:
    """Create the Upload DB record and return the response dict."""
    upload = Upload(
        id=upload_id,
        filename=filename,
        content_type=content_type,
        file_url=file_url
    )
    db.add(upload)
    await db.commit()
    await db.refresh(upload)

    http_url = storage_url_to_http_url(file_url)
    return {"id": upload.id, "filename": upload.filename, "url": http_url}


async def _write_upload_bytes(content: bytes, project_id: str, upload_id: str, filename: str,
                              content_type: str, db: AsyncSession) -> dict:
    """Write a whole in-memory buffer to storage, create DB record, return response dict.

    Used only by the small JSON+base64 path; the large raw-body path streams instead.
    """
    file_url = await get_upload_storage_url(db, project_id, upload_id, filename)
    storage_options = await get_fsspec_storage_options(db, project_id)

    def _write():
        with fsspec.open(file_url, "wb", **storage_options) as f:
            f.write(content)
    await asyncio.to_thread(_write)

    return await _create_upload_record(project_id, upload_id, filename, content_type, file_url, db)


async def _stream_upload(request: Request, project_id: str, upload_id: str, filename: str,
                         content_type: str, db: AsyncSession) -> dict:
    """Stream the raw request body straight into the fsspec storage handle in bounded chunks.

    Backend memory stays flat regardless of file size; s3fs turns the chunked writes into an
    S3 multipart upload. On any mid-stream error the multipart is aborted so no truncated,
    committed object is left behind, and the Upload DB row is only created after a clean close.
    """
    file_url = await get_upload_storage_url(db, project_id, upload_id, filename)
    storage_options = await get_fsspec_storage_options(db, project_id)

    fh = await asyncio.to_thread(
        lambda: fsspec.open(file_url, "wb", **storage_options).open()
    )
    try:
        async for chunk in request.stream():
            if chunk:
                await asyncio.to_thread(fh.write, chunk)
        await asyncio.to_thread(fh.close)
    except BaseException:
        # Abort the S3 multipart so a partial/truncated object is never committed.
        # discard() aborts without finalizing; fall back to close() if unavailable.
        def _abort():
            discard = getattr(fh, "discard", None)
            if discard is not None:
                discard()
            else:
                fh.close()
        await asyncio.to_thread(_abort)
        raise  # never swallow (repo rule 8)

    return await _create_upload_record(project_id, upload_id, filename, content_type, file_url, db)


@router.post("/projects/{project_id}/upload", summary="Upload a raw input file")
async def upload_file(
    request: Request,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Upload a raw input file (e.g. AEM data, CSV) that is not the output of any process.

    Supports two body formats (auto-detected from Content-Type):

    **Raw body** (browser or curl — any file size; streamed straight to storage):
        curl -X POST "https://host/projects/{project_id}/upload?filename=data.xyz" \\
          -H "Content-Type: application/octet-stream" \\
          --data-binary @data.xyz

    The filename travels as the ``filename`` query parameter (URL-encoded) and the
    content type as the ``Content-Type`` request header. The body is streamed to object
    storage in bounded chunks, so backend memory stays flat regardless of file size.

    **JSON + base64** (MCP-friendly — for files up to ~25 MB):
        POST /projects/{project_id}/upload
        Content-Type: application/json
        {"filename": "data.xyz", "content": "<base64>", "content_type": "application/x-aarhusxyz-msgpack"}

    For large files, request an upload token with POST /upload/request-token, then
    upload using that token as the Bearer credential — no full session needed:
        curl -X POST "https://host/projects/{project_id}/upload?filename=survey.xyz" \\
          -H "Authorization: Bearer upt_..." \\
          -H "Content-Type: application/octet-stream" \\
          --data-binary @survey.xyz

    The response 'url' is a direct HTTP file URL (no auth needed to download it)
    ready to pass as input_data to create_process.
    """
    upload_id = str(uuid.uuid4())
    content_type_header = request.headers.get("content-type", "")

    if "application/json" in content_type_header:
        body = await request.json()
        filename = body.get("filename", "upload")
        content_b64 = body.get("content", "")
        mime = body.get("content_type", "application/octet-stream")
        try:
            content = base64.b64decode(content_b64)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 in 'content' field")
        if len(content) > MAX_JSON_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"JSON+base64 upload exceeds the {MAX_JSON_UPLOAD_BYTES // (1024 * 1024)} MB "
                    "limit. Use the raw-body upload path (Content-Type: application/octet-stream, "
                    "--data-binary @file, ?filename=) for large files."
                ),
            )
        return await _write_upload_bytes(content, project.id, upload_id, filename, mime, db)

    filename = request.query_params.get("filename", "upload")
    mime = content_type_header or "application/octet-stream"
    return await _stream_upload(request, project.id, upload_id, filename, mime, db)


@router.post("/upload/request-token", summary="Request a short-lived upload token for large file uploads")
async def request_upload_token(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Issue a short-lived Bearer token (prefix upt_) for uploading large files via curl.

    The token inherits the project scope of the current session (API key or JWT).
    Use it when you need to hand off a large file upload to curl without passing
    full session credentials:

        curl -X POST "https://host/projects/{project_id}/upload?filename=survey.xyz" \\
          -H "Authorization: Bearer {token}" \\
          -H "Content-Type: application/octet-stream" \\
          --data-binary @/path/to/survey.xyz

    The token is a signed JWT, expires after 1 hour, and is scoped to the same
    project as the current session. No server-side state is required.
    """
    project_id = auth.api_key_project_id
    if not project_id:
        raise HTTPException(
            status_code=400,
            detail="Upload tokens require a project-scoped session. Authenticate with an API key."
        )
    payload = {
        "uid": auth.user.id,
        "project_id": project_id,
        "token_type": "upload",
    }
    jwt_token = create_access_token(payload, expires_delta=timedelta(hours=1))
    token = f"upt_{jwt_token}"
    return {"token": token, "expires_in": 3600}


@router.get("/uploads/{file_id}", include_in_schema=False)
async def download_file(file_id: str, db: AsyncSession = Depends(get_db)):
    """Download an uploaded file (frontend / curl use only).

    Auth-free: uploaded file URLs (/files/...) can be fetched directly with curl.
    This endpoint is not exposed to MCP tools.
    """
    stmt = select(Upload).where(Upload.id == file_id)
    result = await db.execute(stmt)
    upload = result.scalar_one_or_none()

    if not upload:
        raise HTTPException(status_code=404, detail="File not found")

    # upload.file_url is a storage URL (<scheme>://<bucket>/uploads/...); reverse-resolve the
    # bucket to its project + backend and read with that backend's admin fsspec kwargs.
    from urllib.parse import urlparse
    from backend.services.storage_service import resolve_bucket
    bucket = urlparse(upload.file_url).netloc
    try:
        project, _backend = await resolve_bucket(db, bucket)
    except RuntimeError:
        raise HTTPException(status_code=404, detail="File not found")
    storage_options = await get_fsspec_storage_options(db, project.id)

    def _read():
        with fsspec.open(upload.file_url, "rb", **storage_options) as f:
            return f.read()
    content = await asyncio.to_thread(_read)

    return Response(
        content=content,
        media_type=upload.content_type,
        headers={"Content-Disposition": f'attachment; filename="{upload.filename}"'}
    )

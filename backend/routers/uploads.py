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


async def _write_upload(content: bytes, project_id: str, upload_id: str, filename: str,
                        content_type: str, db: AsyncSession) -> dict:
    """Write file to storage, create DB record, return response dict."""
    file_url = await get_upload_storage_url(db, project_id, upload_id, filename)
    storage_options = await get_fsspec_storage_options(db, project_id)

    def _write():
        with fsspec.open(file_url, "wb", **storage_options) as f:
            f.write(content)
    await asyncio.to_thread(_write)

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


@router.post("/projects/{project_id}/upload", summary="Upload a raw input file")
async def upload_file(
    request: Request,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Upload a raw input file (e.g. AEM data, CSV) that is not the output of any process.

    Supports two body formats (auto-detected from Content-Type):

    **Multipart/form-data** (browser or curl — any file size):
        curl -F "file=@data.xyz" "https://host/projects/{project_id}/upload"

    **JSON + base64** (MCP-friendly — for files up to ~20 MB):
        POST /projects/{project_id}/upload
        Content-Type: application/json
        {"filename": "data.xyz", "content": "<base64>", "content_type": "application/x-aarhusxyz-msgpack"}

    For large files, request an upload token with POST /upload/request-token, then
    upload using that token as the Bearer credential — no full session needed:
        curl -X POST "https://host/projects/{project_id}/upload" \\
          -H "Authorization: Bearer upt_..." \\
          -F "file=@survey.xyz"

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
    else:
        form = await request.form()
        file = form.get("file")
        if not file:
            raise HTTPException(status_code=400, detail="No 'file' field in form data")
        filename = file.filename or "upload"
        mime = file.content_type or "application/octet-stream"
        content = await file.read()

    return await _write_upload(content, project.id, upload_id, filename, mime, db)


@router.post("/upload/request-token", summary="Request a short-lived upload token for large file uploads")
async def request_upload_token(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Issue a short-lived Bearer token (prefix upt_) for uploading large files via curl.

    The token inherits the project scope of the current session (API key or JWT).
    Use it when you need to hand off a large file upload to curl without passing
    full session credentials:

        curl -X POST "https://host/upload" \\
          -H "Authorization: Bearer {token}" \\
          -F "file=@/path/to/survey.xyz"

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

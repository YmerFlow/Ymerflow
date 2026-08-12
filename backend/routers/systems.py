import asyncio
import tempfile
import os

import fsspec
import libaarhusxyz
import msgpack
import msgpack_numpy as m
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from backend.database import get_db
from backend.models import System, Project, Upload
from backend.services.auth_service import resolve_project_for_read, require_project_member, ProjectReadAccess
from backend.services.storage_service import get_fsspec_storage_options

# Configure msgpack to handle numpy arrays
m.patch()

router = APIRouter(tags=["Systems"])


def _system_dict(s: System) -> dict:
    gex_data = msgpack.unpackb(s.gex, raw=False)
    return {
        "id": s.id,
        "name": s.name,
        "gex": gex_data,
        "created_at": s.created_at.isoformat(),
        "project_id": s.project_id,
        "is_public": s.is_public,
    }


@router.get("/projects/{project_id}/systems")
async def list_systems(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    """List survey systems visible to a project: public systems plus this project's own.

    Returns msgpack (not JSON) to preserve numpy arrays inside each system's `gex` field.
    """
    project = access.project
    stmt = select(System).where(or_(System.is_public == True, System.project_id == project.id))
    result = await db.execute(stmt)
    systems = result.scalars().all()

    systems_data = [_system_dict(s) for s in systems]
    response_bytes = msgpack.packb(systems_data, use_bin_type=True)

    return Response(content=response_bytes, media_type="application/x-msgpack")


class CreateSystemBody(BaseModel):
    name: str
    upload_id: str


@router.post("/projects/{project_id}/systems")
async def create_system(
    body: CreateSystemBody,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """Create a project-owned survey system by parsing a previously-uploaded .gex file.

    Upload the .gex file first via POST /projects/{project_id}/upload, then pass the
    resulting upload id here. Returns the created system (msgpack, same shape as GET).
    """
    stmt = select(Upload).where(Upload.id == body.upload_id)
    result = await db.execute(stmt)
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=404, detail="Upload not found")

    storage_options = await get_fsspec_storage_options(db, project.id)

    def _read():
        with fsspec.open(upload.file_url, "rb", **storage_options) as f:
            return f.read()
    content = await asyncio.to_thread(_read)

    def _parse():
        with tempfile.NamedTemporaryFile(suffix=".gex", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            return libaarhusxyz.GEX(tmp_path).gex_dict
        finally:
            os.unlink(tmp_path)

    try:
        gex_dict = await asyncio.to_thread(_parse)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse .gex file: {e}")

    system = System(
        name=body.name,
        gex=msgpack.packb(gex_dict, use_bin_type=True),
        project_id=project.id,
        is_public=False,
    )
    db.add(system)
    await db.commit()
    await db.refresh(system)

    response_bytes = msgpack.packb(_system_dict(system), use_bin_type=True)
    return Response(content=response_bytes, media_type="application/x-msgpack")

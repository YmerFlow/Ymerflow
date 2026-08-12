from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, delete
from sqlalchemy.orm import selectinload
from typing import Dict
from datetime import datetime
import uuid

from backend.database import get_db
from backend.models import Process, ProcessVersion, Project
from backend.models.process import ProcessTag, process_version_tags_table
from backend.services.auth_service import get_current_user, AuthContext, require_project_member, resolve_project_for_read, ProjectReadAccess

router = APIRouter(tags=["Tags"])


@router.get("/projects/{project_id}/tags")
async def list_project_tags(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.project_id == access.project.id).order_by(ProcessTag.name)
    )
    return [t.to_dict() for t in result.scalars().all()]


@router.post("/projects/{project_id}/tags")
async def create_project_tag(
    body: Dict,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    tag = ProcessTag(
        id=str(uuid.uuid4()),
        project_id=project.id,
        name=body["name"],
        color=body.get("color", "#6c757d"),
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag.to_dict()


@router.put("/projects/{project_id}/tags/{tag_id}")
async def update_project_tag(
    tag_id: str,
    body: Dict,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id, ProcessTag.project_id == project.id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if "name" in body:
        tag.name = body["name"]
    if "color" in body:
        tag.color = body["color"]
    await db.commit()
    await db.refresh(tag)
    return tag.to_dict()


@router.delete("/projects/{project_id}/tags/{tag_id}")
async def delete_project_tag(
    tag_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id, ProcessTag.project_id == project.id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    await db.delete(tag)
    await db.commit()
    return {"status": "deleted"}


@router.post("/projects/{project_id}/process/{process_id}/versions/{version}/tags/{tag_id}")
async def add_version_tag(
    process_id: str,
    version: int,
    tag_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ProcessVersion).options(
        selectinload(ProcessVersion.process)
    ).where(
        ProcessVersion.process_id == process_id,
        ProcessVersion.version == version,
    )
    result = await db.execute(stmt)
    version_obj = result.scalar_one_or_none()
    if not version_obj or version_obj.process.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    project_id = project.id

    tag_result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id, ProcessTag.project_id == project_id)
    )
    tag = tag_result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    # Check if already added
    existing = await db.execute(
        select(process_version_tags_table).where(
            and_(
                process_version_tags_table.c.process_version_id == version_obj.id,
                process_version_tags_table.c.tag_id == tag_id,
            )
        )
    )
    if existing.first() is not None:
        return {"status": "already_exists"}

    await db.execute(
        process_version_tags_table.insert().values(
            process_version_id=version_obj.id,
            tag_id=tag_id,
            added_at=datetime.utcnow(),
            added_by=auth.user.username,
        )
    )

    history = list(version_obj.tags_history or [])
    history.append({
        "action": "added",
        "at": datetime.utcnow().isoformat(),
        "by": auth.user.username,
        "name": tag.name,
        "color": tag.color,
    })
    version_obj.tags_history = history

    await db.commit()
    return {"status": "added"}


@router.delete("/projects/{project_id}/process/{process_id}/versions/{version}/tags/{tag_id}")
async def remove_version_tag(
    process_id: str,
    version: int,
    tag_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ProcessVersion).options(
        selectinload(ProcessVersion.process)
    ).where(
        ProcessVersion.process_id == process_id,
        ProcessVersion.version == version,
    )
    result = await db.execute(stmt)
    version_obj = result.scalar_one_or_none()
    if not version_obj or version_obj.process.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    tag_result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id)
    )
    tag = tag_result.scalar_one_or_none()

    await db.execute(
        delete(process_version_tags_table).where(
            and_(
                process_version_tags_table.c.process_version_id == version_obj.id,
                process_version_tags_table.c.tag_id == tag_id,
            )
        )
    )

    if tag:
        history = list(version_obj.tags_history or [])
        history.append({
            "action": "removed",
            "at": datetime.utcnow().isoformat(),
            "by": auth.user.username,
            "name": tag.name,
            "color": tag.color,
        })
        version_obj.tags_history = history

    await db.commit()
    return {"status": "removed"}

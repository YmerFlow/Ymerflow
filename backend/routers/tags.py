import random

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, delete
from sqlalchemy.orm import selectinload
from typing import Optional
from datetime import datetime
import uuid

from backend.database import get_db
from backend.models import Process, ProcessVersion, Project
from backend.models.process import ProcessTag, process_version_tags_table
from backend.services.auth_service import get_current_user, AuthContext, require_project_member, resolve_project_for_read, ProjectReadAccess

router = APIRouter(tags=["Tags"])

# Mirrors TAG_COLORS in frontend/src/widgets/FlowView/TagSelector.jsx so
# backend-created tags get the same palette as the UI.
TAG_COLORS = ['#007bff', '#28a745', '#dc3545', '#fd7e14', '#6f42c1', '#20c997', '#e83e8c']


def random_tag_color() -> str:
    return random.choice(TAG_COLORS)


class TagCreate(BaseModel):
    name: str = Field(..., description="Tag name (unique within the project).")
    color: Optional[str] = Field(None, description="Hex color. Random from a palette if omitted.")


class TagUpdate(BaseModel):
    name: Optional[str] = Field(None, description="New tag name.")
    color: Optional[str] = Field(None, description="New hex color.")


class VersionTagBody(BaseModel):
    tag_id: Optional[str] = Field(None, description="Attach an existing tag by id.")
    tag_name: Optional[str] = Field(None, description="Attach a tag by name, creating it if the project has none by that name.")
    tag_color: Optional[str] = Field(None, description="Hex color for a created tag, or to recolor a matched one. Random from a palette if omitted.")


@router.get("/projects/{project_id}/tags", operation_id="list_tags", summary="List project tags")
async def list_project_tags(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    """List all tags defined in a project."""
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.project_id == access.project.id).order_by(ProcessTag.name)
    )
    return [t.to_dict() for t in result.scalars().all()]


@router.post("/projects/{project_id}/tags", operation_id="create_tag", summary="Create a project tag")
async def create_project_tag(
    body: TagCreate,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """Create a new tag in a project. Color defaults to a random palette color."""
    tag = ProcessTag(
        id=str(uuid.uuid4()),
        project_id=project.id,
        name=body.name,
        color=body.color or random_tag_color(),
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag.to_dict()


@router.put("/projects/{project_id}/tags/{tag_id}", operation_id="update_tag", summary="Update a project tag")
async def update_project_tag(
    tag_id: str,
    body: TagUpdate,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """Rename or recolor an existing project tag."""
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id, ProcessTag.project_id == project.id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if body.name is not None:
        tag.name = body.name
    if body.color is not None:
        tag.color = body.color
    await db.commit()
    await db.refresh(tag)
    return tag.to_dict()


@router.delete("/projects/{project_id}/tags/{tag_id}", operation_id="delete_tag", summary="Delete a project tag")
async def delete_project_tag(
    tag_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """Delete a project tag, detaching it from all versions."""
    result = await db.execute(
        select(ProcessTag).where(ProcessTag.id == tag_id, ProcessTag.project_id == project.id)
    )
    tag = result.scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    await db.delete(tag)
    await db.commit()
    return {"status": "deleted"}


@router.post("/projects/{project_id}/process/{process_id}/versions/{version}/tags/{tag_id}", include_in_schema=False)
@router.post("/projects/{project_id}/process/{process_id}/versions/{version}/tags", operation_id="add_version_tag", summary="Tag a process version")
async def add_version_tag(
    process_id: str,
    version: int,
    tag_id: Optional[str] = None,
    body: Optional[VersionTagBody] = None,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Attach a tag to a process version, by existing tag_id or by tag_name.

    Provide exactly one of tag_id or tag_name. A tag_name that doesn't exist in
    the project is created (with tag_color, or a random palette color). When
    tag_color is supplied the resolved tag is recolored, whether matched by id or
    by name.
    """
    project_id = project.id

    # Effective tag_id: path segment (legacy URL) or body.
    body_tag_id = body.tag_id if body else None
    body_tag_name = body.tag_name if body else None
    body_tag_color = body.tag_color if body else None
    effective_tag_id = tag_id or body_tag_id

    if bool(effective_tag_id) == bool(body_tag_name):
        raise HTTPException(status_code=400, detail="Provide exactly one of tag_id or tag_name")

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

    # Resolve the tag by id or by name (find-or-create).
    if effective_tag_id:
        tag_result = await db.execute(
            select(ProcessTag).where(ProcessTag.id == effective_tag_id, ProcessTag.project_id == project_id)
        )
        tag = tag_result.scalar_one_or_none()
        if not tag:
            raise HTTPException(status_code=404, detail="Tag not found")
    else:
        tag_result = await db.execute(
            select(ProcessTag).where(ProcessTag.name == body_tag_name, ProcessTag.project_id == project_id)
        )
        tag = tag_result.scalar_one_or_none()
        if not tag:
            tag = ProcessTag(
                id=str(uuid.uuid4()),
                project_id=project_id,
                name=body_tag_name,
                color=body_tag_color or random_tag_color(),
            )
            db.add(tag)
            await db.flush()

    # Uniform recolor: whenever a color is supplied, apply it to the resolved tag.
    if body_tag_color:
        tag.color = body_tag_color

    tag_id = tag.id

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
        # Attachment already present, but a create-if-absent tag and/or a recolor
        # above are real pending changes that must persist.
        await db.commit()
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


@router.delete("/projects/{project_id}/process/{process_id}/versions/{version}/tags/{tag_id}", operation_id="remove_version_tag", summary="Untag a process version")
async def remove_version_tag(
    process_id: str,
    version: int,
    tag_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Detach a tag from a process version. The tag itself is not deleted."""
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

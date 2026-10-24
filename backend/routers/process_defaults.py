import uuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy import select, or_
from typing import Optional, List

from backend.database import get_db
from backend.models import ProcessDefault, ProcessDefaultVersion, Project, Environment
from backend.services.auth_service import (
    get_current_user,
    get_current_user_optional,
    require_project_member,
    resolve_project_for_read,
    AuthContext,
    ProjectReadAccess,
)

# No router-level prefix: the project-scoped routes live under /projects/{project_id}/... while
# the public gallery lives under /process-defaults/public — so each route spells out its full
# path (mirrors environments.py). See docs/plans/process-editor-defaults.md.
router = APIRouter(tags=["Process Defaults"])

_LOAD = (selectinload(ProcessDefault.versions), selectinload(ProcessDefault.project))


class ProcessDefaultVersionBody(BaseModel):
    type: str
    environment_id: str
    parameters: dict = {}
    resource_requests: Optional[dict] = None
    deadline_seconds: Optional[int] = None
    cluster_id: Optional[str] = None
    tag_names: List[str] = []


class CreateProcessDefaultBody(BaseModel):
    title: str
    description: Optional[str] = None
    is_public: bool = False
    superpublic: bool = False
    version: ProcessDefaultVersionBody


class CreateProcessDefaultVersionBody(BaseModel):
    version: ProcessDefaultVersionBody


def _build_version(body: ProcessDefaultVersionBody, version_num: int, user_id: int) -> ProcessDefaultVersion:
    """Build a ProcessDefaultVersion row from a version body. `cluster_id` from the body maps
    onto the k8s_cluster_id column (same split as ProcessVersion)."""
    return ProcessDefaultVersion(
        version=version_num,
        type=body.type,
        environment_id=body.environment_id,
        parameters=body.parameters or {},
        resource_requests=body.resource_requests,
        deadline_seconds=body.deadline_seconds,
        k8s_cluster_id=body.cluster_id,
        tag_names=body.tag_names or [],
        created_by=user_id,
    )


async def _check_env_visible_if_public(db: AsyncSession, environment_id: str, is_public: bool):
    """Env-visibility block (Decision 6): a public/superpublic default's pinned environment must
    itself be public/superpublic, else it wouldn't resolve for other projects. Blocks the save
    with an explanation."""
    if not is_public:
        return
    env = (await db.execute(select(Environment).where(Environment.id == environment_id))).scalar_one_or_none()
    if env is None:
        raise HTTPException(status_code=400, detail="Pinned environment not found")
    if not (env.is_public or env.superpublic):
        raise HTTPException(
            status_code=400,
            detail="A public process default must pin a public environment. "
                   "Make the environment public/superpublic first.",
        )


async def _reload_default_dict(default_id: str, db: AsyncSession) -> dict:
    """Re-select a default with versions/project eagerly loaded and serialize it (after a commit
    the lazy relationships would raise MissingGreenlet under async SQLAlchemy)."""
    stmt = select(ProcessDefault).options(*_LOAD).where(ProcessDefault.id == default_id)
    default = (await db.execute(stmt)).scalar_one()
    return default.to_dict(project_name=default.project.name if default.project else None)


@router.post("/projects/{project_id}/process-default", operation_id="create_process_default")
async def create_process_default(
    project_id: str,
    body: CreateProcessDefaultBody,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new process default in a project, with an initial version-1 payload.

    Captures the full process editor state (type, parameters, resources, pinned environment,
    tag names). `superpublic` is admin-only and forces `is_public`. A public/superpublic default
    must pin a public/superpublic environment (else the save is rejected 400).
    """
    superpublic = body.superpublic
    if superpublic and not auth.user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required for superpublic defaults")
    is_public = body.is_public or superpublic

    await _check_env_visible_if_public(db, body.version.environment_id, is_public)

    default = ProcessDefault(
        id=str(uuid.uuid4()),
        title=body.title,
        description=body.description,
        project_id=project.id,
        is_public=is_public,
        superpublic=superpublic,
        created_by=auth.user.id,
    )
    db.add(default)
    default.versions.append(_build_version(body.version, 1, auth.user.id))

    await db.commit()

    return await _reload_default_dict(default.id, db)


@router.post("/projects/{project_id}/process-default/{default_id}/versions", operation_id="create_process_default_version")
async def create_process_default_version(
    project_id: str,
    default_id: str,
    body: CreateProcessDefaultVersionBody,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Append a new version to an existing project-owned process default.

    Only a default owned by this project may be versioned here. If the default is public, the
    pinned environment of the new version must itself be public (Decision 6).
    """
    stmt = select(ProcessDefault).options(*_LOAD).where(ProcessDefault.id == default_id)
    default = (await db.execute(stmt)).scalar_one_or_none()
    if not default:
        raise HTTPException(status_code=404, detail="Process default not found")
    if default.project_id != project.id:
        raise HTTPException(status_code=403, detail="Can only add versions to a process default owned by this project")

    await _check_env_visible_if_public(db, body.version.environment_id, default.is_public)

    next_version = max((v.version for v in default.versions), default=0) + 1
    default.versions.append(_build_version(body.version, next_version, auth.user.id))

    await db.commit()

    return await _reload_default_dict(default.id, db)


@router.get("/projects/{project_id}/process-defaults", operation_id="list_process_defaults")
async def list_process_defaults(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    """List the process defaults directly available to a project: its own plus every superpublic
    default. Each row embeds its full ordered version list (so "list/read version" are
    client-side picks)."""
    stmt = (
        select(ProcessDefault)
        .options(*_LOAD)
        .where(or_(ProcessDefault.superpublic == True, ProcessDefault.project_id == access.project.id))  # noqa: E712
    )
    result = await db.execute(stmt)
    return [d.to_dict() for d in result.scalars().all()]


@router.get("/process-defaults/public", operation_id="list_public_process_defaults")
async def list_public_process_defaults(
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """List every process default marked public, across all projects. Anyone (including
    anonymous) can browse this — it backs the searchable public list in the selector."""
    stmt = select(ProcessDefault).options(*_LOAD).where(ProcessDefault.is_public == True)  # noqa: E712
    result = await db.execute(stmt)
    return [d.to_dict(project_name=d.project.name if d.project else None) for d in result.scalars().all()]


@router.get("/projects/{project_id}/process-default/{default_id}", operation_id="get_process_default")
async def get_process_default(
    default_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    """Get a single process default including its full version history. Readable if it is
    public/superpublic or owned by the project in the viewing context."""
    stmt = select(ProcessDefault).options(*_LOAD).where(ProcessDefault.id == default_id)
    default = (await db.execute(stmt)).scalar_one_or_none()
    if not default or not (default.is_public or default.superpublic or default.project_id == access.project.id):
        raise HTTPException(status_code=404, detail="Process default not found")
    return default.to_dict(project_name=default.project.name if default.project else None)

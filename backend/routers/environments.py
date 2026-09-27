from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, Field
from typing import Optional

from backend.database import get_db
from backend.models import Environment, Process, Project, ProjectMember
from backend.services.auth_service import (
    get_current_user_optional,
    resolve_project_for_read,
    try_resolve_project_for_read,
    AuthContext,
    ProjectReadAccess,
)

# No router-level prefix: the project-scoped list lives under /projects/{project_id}/environments
# (mirroring systems.py), while the public gallery and per-environment routes live under
# /environments/... — so each route spells out its full path.
router = APIRouter(tags=["Environments"])


class CreateEnvironmentRequest(BaseModel):
    name: str = Field(..., description="Human-readable display name for the environment.")
    docker_image: str = Field(..., description="Fully-qualified Docker image reference, e.g. 'registry.example.com/myenv:latest'.")
    process_id: Optional[str] = Field(None, description="ID of the process that built this environment, if any. Used to link the environment back to its build job.")
    project_id: Optional[str] = Field(None, description="Home project that owns this environment. NULL only for operator/bootstrap environments.")
    is_public: bool = Field(False, description="Whether this environment is visible to every project (public gallery). Super-public (the always-listed base runners) is reserved for docker/build.sh and cannot be set here.")


async def _can_read_environment(
    environment: Environment,
    project_id: Optional[str],
    auth: Optional[AuthContext],
    db: AsyncSession,
) -> bool:
    """Whether the caller may read `environment`, allowed if ANY of (mirrors _can_read_workspace):

    A. Globally public — `environment.is_public` (covers superpublic, which implies is_public):
       anyone, including anonymous.
    B. Member — an authenticated caller who is a ProjectMember of the environment's home project.
    C. Publication-scoped — a `project_id` viewing context was supplied and resolves (as a real
       membership or a publication the caller may read) to the environment's own home project.
    """
    # A. Globally public.
    if environment.is_public:
        return True

    # A private environment always has a home project; a project-less non-public env is unreadable.
    if environment.project_id is None:
        return False

    # B. Member of the environment's home project.
    if auth is not None:
        stmt = (
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(Project.id == environment.project_id, ProjectMember.user_id == auth.user.id)
        )
        if (await db.execute(stmt)).scalar_one_or_none() is not None:
            return True

    # C. Publication-scoped: the viewing context must resolve to this env's own project.
    if project_id is not None:
        access = await try_resolve_project_for_read(project_id, auth, db)
        if access is not None and access.project.id == environment.project_id:
            return True

    return False


@router.get("/projects/{project_id}/environments", operation_id="list_environments", summary="List compute environments")
async def list_environments(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db),
):
    """List the compute environments available to a project.

    Returns the always-available super-public base runners plus this project's own
    environments. Each row is lightweight — id, name, created_at, and visibility fields
    (is_public, superpublic, project_id) — WITHOUT the process_types schemas. To get the
    process types of one environment, call get_environment_process_types.

    `project_id` accepts either a real project id (real membership required) or a read-only
    publication id (readable by whatever audience the publication permits).
    """
    stmt = select(Environment).where(
        or_(Environment.superpublic == True, Environment.project_id == access.project.id)  # noqa: E712
    )
    result = await db.execute(stmt)
    environments = result.scalars().all()

    return [e.to_dict() for e in environments]


@router.get("/environments/public", operation_id="list_public_environments", summary="List public compute environments")
async def list_public_environments(
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """List every compute environment marked public, across all projects.

    Anyone — including anonymous visitors — can browse this list. It's the public gallery
    backing the environment search box: find a public environment here, then select it for a
    process (which does require membership of the process's own project). Each entry includes
    its home project's name. Schemas are not included — call get_environment_process_types for
    an environment's process types.
    """
    stmt = (
        select(Environment)
        .options(selectinload(Environment.project))
        .where(Environment.is_public == True)  # noqa: E712
    )
    result = await db.execute(stmt)
    environments = result.scalars().all()

    return [e.to_dict(project_name=e.project.name if e.project else None) for e in environments]


@router.get("/environments/{env_id}/process-types", operation_id="get_environment_process_types", summary="Get all process type schemas for an environment")
async def get_process_types(
    env_id: str,
    project_id: Optional[str] = None,
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Return all process types available in an environment, keyed by type name.

    Each entry contains a JSON Schema describing the required and optional
    'params' for that process type. Use the schema to build the params dict
    when calling create_process. Dataset URL inputs will have
    'x-format': 'dataset' in their schema — pass a URL from search_datasets.

    To fetch the schema for a single type, use get_environment_process_type
    (GET /environments/{env_id}/process-types/{type_name}) instead.

    Readable only if the environment is public/super-public, the caller is a member of its
    home project, or a `project_id` viewing context (a real project id or publication id)
    resolves to its home project; returns 404 otherwise. Returns an empty dict if the
    environment has not finished registering its process types yet (environment setup is
    itself a process).
    """
    stmt = select(Environment).where(Environment.id == env_id)
    result = await db.execute(stmt)
    environment = result.scalar_one_or_none()

    if not environment or not await _can_read_environment(environment, project_id, auth, db):
        raise HTTPException(status_code=404, detail="Environment not found")

    return environment.process_types or {}


@router.get("/environments/{env_id}/process-types/{type_name}", operation_id="get_environment_process_type", summary="Get schema for a single process type")
async def get_process_type_schema(
    env_id: str,
    type_name: str,
    project_id: Optional[str] = None,
    auth: Optional[AuthContext] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Return the JSON Schema for exactly one named process type in an environment.

    Use this to fetch the schema for a specific type (e.g. 'import_skytem') without
    downloading schemas for all types. Even the largest schemas (~44 KB) fit easily
    in a single response; there is no need to break them down further.

    The schema describes the required and optional 'params' when calling create_process
    with this type. Fields with 'x-format': 'dataset' expect a file URL from
    search_datasets or get_dataset.

    Readable only if the environment is public/super-public, the caller is a member of its
    home project, or a `project_id` viewing context resolves to its home project. Returns 404
    if the environment is not readable/found or the type name is not found.
    """
    stmt = select(Environment).where(Environment.id == env_id)
    result = await db.execute(stmt)
    environment = result.scalar_one_or_none()

    if not environment or not await _can_read_environment(environment, project_id, auth, db):
        raise HTTPException(status_code=404, detail="Environment not found")

    process_types = environment.process_types or {}
    if type_name not in process_types:
        raise HTTPException(status_code=404, detail=f"Process type '{type_name}' not found in environment")

    return process_types[type_name]


@router.post("/environments", operation_id="create_environment", summary="Register a new compute environment")
async def create_environment(
    request: CreateEnvironmentRequest,
    db: AsyncSession = Depends(get_db)
):
    """Register a Docker image as a named compute environment.

    Typically called automatically by a build process after it has pushed a
    new Docker image. The registered environment immediately becomes available
    for create_process. Its process_types will be populated once the environment's
    setup job completes and reports back.

    An environment can be private (default) or public (is_public=true, listed in the public
    gallery). Super-public (the always-listed base runners) is reserved for docker/build.sh and
    cannot be set here.

    Call list_environments after registering to confirm the environment appears
    and to check whether process_types have been populated yet.
    """
    # Validate that process exists if process_id is provided
    if request.process_id:
        stmt = select(Process).where(Process.id == request.process_id)
        result = await db.execute(stmt)
        process = result.scalar_one_or_none()

        if not process:
            raise HTTPException(status_code=404, detail="Process not found")

    # Create environment (superpublic is never accepted here — build.sh only)
    environment = Environment(
        name=request.name,
        docker_image=request.docker_image,
        process_id=request.process_id,
        project_id=request.project_id,
        is_public=request.is_public,
        superpublic=False,
    )

    db.add(environment)
    await db.commit()
    await db.refresh(environment)

    return environment.to_dict()

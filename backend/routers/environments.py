from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, Field
from typing import Optional

from backend.database import get_db
from backend.models import Environment, Process

router = APIRouter(prefix="/environments", tags=["Environments"])


class CreateEnvironmentRequest(BaseModel):
    name: str = Field(..., description="Human-readable display name for the environment.")
    docker_image: str = Field(..., description="Fully-qualified Docker image reference, e.g. 'registry.example.com/myenv:latest'.")
    process_id: Optional[str] = Field(None, description="ID of the process that built this environment, if any. Used to link the environment back to its build job.")


@router.get("", operation_id="list_environments", summary="List compute environments")
async def list_environments(
    include_schemas: bool = Query(False, description="Include full JSON Schemas for each process type. Default false — use get_environment_process_type to fetch a single type's schema."),
    db: AsyncSession = Depends(get_db)
):
    """List available compute environments.

    Returns each environment's id, name, and process_types. By default process_types
    is a list of type names only. Pass include_schemas=true to embed full JSON Schemas
    (used by the frontend; LLM agents should call get_environment_process_type instead).
    """
    stmt = select(Environment)
    result = await db.execute(stmt)
    environments = result.scalars().all()

    return [e.to_dict(include_schemas=include_schemas) for e in environments]


@router.get("/{env_id}/process-types", operation_id="get_environment_process_types", summary="Get all process type schemas for an environment")
async def get_process_types(env_id: str, db: AsyncSession = Depends(get_db)):
    """Return all process types available in an environment, keyed by type name.

    Each entry contains a JSON Schema describing the required and optional
    'params' for that process type. Use the schema to build the params dict
    when calling create_process. Dataset URL inputs will have
    'x-format': 'dataset' in their schema — pass a URL from search_datasets.

    To fetch the schema for a single type, use get_environment_process_type
    (GET /environments/{env_id}/process-types/{type_name}) instead.

    Returns an empty dict if the environment has not finished registering its
    process types yet (environment setup is itself a process).
    """
    stmt = select(Environment).where(Environment.id == env_id)
    result = await db.execute(stmt)
    environment = result.scalar_one_or_none()

    if not environment:
        raise HTTPException(status_code=404, detail="Environment not found")

    return environment.process_types or {}


@router.get("/{env_id}/process-types/{type_name}", operation_id="get_environment_process_type", summary="Get schema for a single process type")
async def get_process_type_schema(env_id: str, type_name: str, db: AsyncSession = Depends(get_db)):
    """Return the JSON Schema for exactly one named process type in an environment.

    Use this to fetch the schema for a specific type (e.g. 'import_skytem') without
    downloading schemas for all types. Even the largest schemas (~44 KB) fit easily
    in a single response; there is no need to break them down further.

    The schema describes the required and optional 'params' when calling create_process
    with this type. Fields with 'x-format': 'dataset' expect a file URL from
    search_datasets or get_dataset.

    Returns 404 if the environment or type name is not found.
    """
    stmt = select(Environment).where(Environment.id == env_id)
    result = await db.execute(stmt)
    environment = result.scalar_one_or_none()

    if not environment:
        raise HTTPException(status_code=404, detail="Environment not found")

    process_types = environment.process_types or {}
    if type_name not in process_types:
        raise HTTPException(status_code=404, detail=f"Process type '{type_name}' not found in environment")

    return process_types[type_name]


@router.post("", operation_id="create_environment", summary="Register a new compute environment")
async def create_environment(
    request: CreateEnvironmentRequest,
    db: AsyncSession = Depends(get_db)
):
    """Register a Docker image as a named compute environment.

    Typically called automatically by a build process after it has pushed a
    new Docker image. The registered environment immediately becomes available
    for create_process. Its process_types will be populated once the environment's
    setup job completes and reports back.

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

    # Create environment
    environment = Environment(
        name=request.name,
        docker_image=request.docker_image,
        process_id=request.process_id
    )

    db.add(environment)
    await db.commit()
    await db.refresh(environment)

    return environment.to_dict()

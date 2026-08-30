import urllib.parse
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy import select
from typing import Dict, Optional
from pathlib import Path
import json

from backend.database import get_db
from backend.models import Workspace, WorkspaceVersion, Project, ProjectMember
from backend.services.auth_service import get_current_user, require_project_member, AuthContext
from backend.config import settings

router = APIRouter(prefix="/workspace", tags=["Workspaces"])

WIDGET_SCHEMAS_PATH = Path(__file__).parent.parent / "widget_schemas.json"

_WORKSPACE_LOAD_OPTIONS = (selectinload(Workspace.versions), selectinload(Workspace.project))


async def _reload_workspace_dict(workspace_id: str, db: AsyncSession) -> dict:
    """Re-select a workspace with its versions/project eagerly loaded and serialize it.

    Used after a commit — accessing the lazy `versions`/`project` relationships directly on
    a just-committed instance raises MissingGreenlet under async SQLAlchemy.
    """
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    workspace = result.scalar_one()
    return workspace.to_dict(project_name=workspace.project.name if workspace.project else None)


async def _require_workspace_member(workspace_id: str, auth: AuthContext, db: AsyncSession) -> Workspace:
    """Load a workspace and verify the current user is a member of its home project."""
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    workspace = result.scalar_one_or_none()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    if auth.api_key_project_id is not None and auth.api_key_project_id != workspace.project_id:
        raise HTTPException(status_code=403, detail="API key is not scoped to this project")

    stmt = (
        select(Project)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(Project.id == workspace.project_id, ProjectMember.user_id == auth.user.id)
    )
    result = await db.execute(stmt)
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member of this workspace's project")

    return workspace


@router.get("s", operation_id="list_workspaces")
async def list_workspaces(
    project_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """
    List the workspaces belonging to a project.

    Returns each workspace's metadata and full version history. Use this to discover
    what layouts exist in the project before fetching a specific version.
    """
    stmt = (
        select(Workspace)
        .options(*_WORKSPACE_LOAD_OPTIONS)
        .where(Workspace.project_id == project_id)
    )
    result = await db.execute(stmt)
    workspaces = result.scalars().all()

    return [w.to_dict() for w in workspaces]


@router.get("s/public", operation_id="list_public_workspaces")
async def list_public_workspaces(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    List every workspace that has been marked public, across all projects.

    Any authenticated user can browse this list — it's the "public gallery" used to
    discover workspaces worth forking into your own project. Each entry includes its
    home project's name and full version list (so callers can pick a specific version
    to fork rather than always taking the latest).
    """
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.is_public == True)  # noqa: E712
    result = await db.execute(stmt)
    workspaces = result.scalars().all()

    return [w.to_dict(project_name=w.project.name if w.project else None) for w in workspaces]


@router.get("-schema", operation_id="get_workspace_schema")
async def get_workspace_schema():
    """
    Get the JSON Schema for the full workspace layout format.

    Returns a JSON Schema describing the recursive node tree accepted when saving a
    workspace version. Includes all registered widget types as a discriminated union,
    with per-widget `layoutConfig` schemas and defaults.

    Always call this before constructing a workspace layout.
    Returns 503 if widget schemas have not been generated yet — run:
    `cd frontend && npm run export-schemas`
    """
    try:
        with open(WIDGET_SCHEMAS_PATH) as f:
            widget_schemas = json.load(f)
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail="Widget schema file not found. Run: cd frontend && npm run export-schemas",
        )
    except (json.JSONDecodeError, IOError) as e:
        raise HTTPException(status_code=503, detail=f"Failed to read widget schemas: {e}")

    if not widget_schemas:
        raise HTTPException(
            status_code=503,
            detail="Widget schema file is empty. Run: cd frontend && npm run export-schemas",
        )

    defs = {}
    all_node_refs = []

    # Built-in container widgets from the flexout layout system
    container_widgets = {
        "VerticalSplit": "Split the pane vertically into two resizable children.",
        "HorizontalSplit": "Split the pane horizontally into two resizable children.",
        "TabSet": "Tabbed pane — children are switchable tabs.",
    }
    for widget_name, description in container_widgets.items():
        defs[f"{widget_name}Node"] = {
            "type": "object",
            "title": widget_name,
            "description": description,
            "properties": {
                "id": {"type": "string", "description": "Unique pane identifier (UUID recommended)"},
                "widget": {"const": widget_name},
                "children": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Node"},
                    "minItems": 1,
                },
            },
            "required": ["id", "widget", "children"],
            "additionalProperties": False,
        }
        all_node_refs.append({"$ref": f"#/$defs/{widget_name}Node"})

    # Leaf widgets discovered from the frontend at export time
    for widget_name, widget_info in widget_schemas.items():
        layout_config_schema = widget_info.get("schema") or {}
        if widget_info.get("default") is not None:
            layout_config_schema = {**layout_config_schema, "default": widget_info["default"]}

        node_def = {
            "type": "object",
            "title": widget_info.get("title", widget_name),
            "properties": {
                "id": {"type": "string", "description": "Unique pane identifier (UUID recommended)"},
                "widget": {"const": widget_name},
            },
            "required": ["id", "widget"],
            "additionalProperties": False,
        }
        if layout_config_schema:
            node_def["properties"]["layoutConfig"] = layout_config_schema

        defs[f"{widget_name}Node"] = node_def
        all_node_refs.append({"$ref": f"#/$defs/{widget_name}Node"})

    defs["Node"] = {"oneOf": all_node_refs}

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Workspace Layout",
        "description": (
            "Recursive layout tree for a YmerFlow workspace. "
            "The root is typically a VerticalSplit or TabSet container."
        ),
        "$defs": defs,
        "$ref": "#/$defs/Node",
    }


@router.get("/app-url", operation_id="get_app_url")
def get_app_url(
    workspace_id: str,
    project_id: Optional[str] = None,
    process_id: Optional[str] = None,
    version: Optional[int] = None,
    part: Optional[str] = None,
    sounding: Optional[int] = None,
) -> dict:
    """
    Build a URL that opens the app with the specified state pre-selected.

    All parameters after `workspace_id` are optional — omit trailing ones to link at a
    coarser level (e.g. workspace only, or workspace + project + process with no sounding).
    Returns `{"url": "https://..."}` — a URL the user can click to land in the exact view.
    """
    path = f"/app/w/{workspace_id}"
    if project_id:
        path += f"/p/{project_id}"
    if process_id:
        path += f"/pr/{process_id}"
    if version is not None:
        path += f"/v/{version}"
    if part:
        path += f"/part/{urllib.parse.quote(part, safe='')}"
    if sounding is not None:
        path += f"/s/{sounding}"
    return {"url": f"{settings.frontend_base_url}{path}"}


@router.get("/{workspace_id}", operation_id="get_workspace")
async def get_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get a workspace, including its full version history.

    Returns 404 unless the workspace is public or the caller is a member of its
    home project. Each entry in `versions` holds a recursive JSON layout tree with
    `id`, `widget`, optional `children`, and widget-specific `layoutConfig` — call
    `get_workspace_schema` first to understand valid node structures and widget types.
    """
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    workspace = result.scalar_one_or_none()

    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    if not workspace.is_public:
        stmt = (
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(Project.id == workspace.project_id, ProjectMember.user_id == auth.user.id)
        )
        result = await db.execute(stmt)
        if not result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Workspace not found")

    return workspace.to_dict(project_name=workspace.project.name if workspace.project else None)


@router.post("", operation_id="create_workspace")
async def create_workspace(
    body: Dict,
    project_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new workspace in a project, with an initial version-1 layout.

    The `layout` field must conform to the schema returned by `get_workspace_schema`.
    Call `get_workspace_schema` before constructing a layout to discover valid widget
    types and their `layoutConfig` schemas.

    Returns the created workspace including its generated `id`.
    """
    title = body.get("title", "Untitled Workspace")
    layout = body.get("layout", {})

    ws = Workspace(
        id=str(uuid.uuid4()),
        title=title,
        project_id=project_id,
        created_by=auth.user.id,
    )
    db.add(ws)
    ws.versions.append(WorkspaceVersion(version=1, layout=layout, created_by=auth.user.id))

    await db.commit()

    return await _reload_workspace_dict(ws.id, db)


@router.post("/{workspace_id}/versions", operation_id="create_workspace_version")
async def create_workspace_version(
    workspace_id: str,
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Save a new version of an existing workspace's layout.

    Unlike create_workspace, this never overwrites — it appends the next version
    number so prior layouts stay browsable. Any member of the workspace's home
    project may add a version, whether or not the workspace is public.
    """
    workspace = await _require_workspace_member(workspace_id, auth, db)

    layout = body.get("layout", {})
    next_version = max((v.version for v in workspace.versions), default=0) + 1
    workspace.versions.append(WorkspaceVersion(version=next_version, layout=layout, created_by=auth.user.id))

    await db.commit()

    return await _reload_workspace_dict(workspace.id, db)


@router.patch("/{workspace_id}", operation_id="update_workspace")
async def update_workspace(
    workspace_id: str,
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Rename a workspace and/or toggle its public/superpublic status.

    Any member of the workspace's home project may publish/unpublish it (public tier).
    Only site admins may set it superpublic (listed directly in the toolbar dropdown).
    Setting superpublic=true always also sets is_public=true.
    """
    workspace = await _require_workspace_member(workspace_id, auth, db)

    if "title" in body:
        workspace.title = body["title"]
    if "superpublic" in body:
        if not auth.user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
        workspace.superpublic = bool(body["superpublic"])
        if workspace.superpublic:
            workspace.is_public = True
    if "is_public" in body and not workspace.superpublic:
        workspace.is_public = bool(body["is_public"])

    await db.commit()

    return await _reload_workspace_dict(workspace.id, db)


@router.post("/{workspace_id}/fork", operation_id="fork_workspace")
async def fork_workspace(
    workspace_id: str,
    body: Dict,
    project_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Copy a version of a public workspace into your own project as a new, independent workspace.

    This is a snapshot copy, not a live reference: the fork starts its own version-1
    history and never changes when the source workspace is edited afterward, and
    editing the fork never affects the source. `version` defaults to the source
    workspace's latest version if omitted.
    """
    stmt = select(Workspace).options(*_WORKSPACE_LOAD_OPTIONS).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    source = result.scalar_one_or_none()

    if not source or not source.is_public:
        raise HTTPException(status_code=404, detail="Workspace not found")

    requested_version = body.get("version")
    if requested_version is not None:
        source_version = next((v for v in source.versions if v.version == requested_version), None)
    else:
        source_version = max(source.versions, key=lambda v: v.version, default=None)

    if not source_version:
        raise HTTPException(status_code=404, detail="Workspace version not found")

    fork = Workspace(
        id=str(uuid.uuid4()),
        title=source.title,
        project_id=project_id,
        is_public=False,
        forked_from_workspace_id=source.id,
        forked_from_version=source_version.version,
        created_by=auth.user.id,
    )
    db.add(fork)
    fork.versions.append(WorkspaceVersion(version=1, layout=source_version.layout, created_by=auth.user.id))

    await db.commit()

    return await _reload_workspace_dict(fork.id, db)


@router.delete("/{workspace_id}", include_in_schema=False)
async def delete_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete workspace (cannot delete 'default')"""
    if workspace_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default workspace")

    workspace = await _require_workspace_member(workspace_id, auth, db)

    await db.delete(workspace)
    await db.commit()

    return {"message": "Workspace deleted successfully"}

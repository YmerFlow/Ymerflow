import urllib.parse
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Dict, Optional
from datetime import datetime
from pathlib import Path
import json

from backend.database import get_db
from backend.models import Workspace
from backend.config import settings

router = APIRouter(prefix="/workspace", tags=["Workspaces"])

WIDGET_SCHEMAS_PATH = Path(__file__).parent.parent / "widget_schemas.json"


@router.get("s")
async def list_workspaces(db: AsyncSession = Depends(get_db)):
    """
    List all saved workspaces.

    Returns id, title, and timestamps for each workspace. Use this to discover
    what layouts exist before fetching one with get_workspace.
    """
    stmt = select(Workspace)
    result = await db.execute(stmt)
    workspaces = result.scalars().all()

    return [w.to_dict(include_layout=False) for w in workspaces]


@router.get("-schema")
async def get_workspace_schema():
    """
    Get the JSON Schema for the full workspace layout format.

    Returns a JSON Schema describing the recursive node tree accepted by
    create_workspace's `layout` field. Includes all registered widget types as a
    discriminated union, with per-widget `layoutConfig` schemas and defaults.

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


@router.get("/app-url")
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


@router.get("/{workspace_id}")
async def get_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    """
    Get the full layout tree for a workspace.

    Returns a recursive JSON tree of nodes with `id`, `widget`, optional `children`,
    and widget-specific `layoutConfig`. Call `get_workspace_schema` first to understand
    valid node structures and widget types.
    """
    stmt = select(Workspace).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    workspace = result.scalar_one_or_none()

    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    return workspace.to_dict(include_layout=True)


@router.post("")
async def create_workspace(workspace: Dict, db: AsyncSession = Depends(get_db)):
    """
    Create a new workspace with a title and layout tree.

    The `layout` field must conform to the schema returned by `get_workspace_schema`.
    Call `get_workspace_schema` before constructing a layout to discover valid widget
    types and their `layoutConfig` schemas.

    Returns the created workspace including its generated `id`.
    """
    workspace_id = workspace.get("id")
    title = workspace.get("title", "Untitled Workspace")
    layout = workspace.get("layout", {})

    if workspace_id:
        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        ws = result.scalar_one_or_none()

        if ws:
            ws.title = title
            ws.layout = layout
            ws.updated_at = datetime.utcnow()
        else:
            ws = Workspace(id=workspace_id, title=title, layout=layout)
            db.add(ws)
    else:
        import uuid
        ws = Workspace(id=str(uuid.uuid4()), title=title, layout=layout)
        db.add(ws)

    await db.commit()
    await db.refresh(ws)

    return ws.to_dict(include_layout=True)


@router.delete("/{workspace_id}", include_in_schema=False)
async def delete_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    """Delete workspace (cannot delete 'default')"""
    if workspace_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default workspace")

    stmt = select(Workspace).where(Workspace.id == workspace_id)
    result = await db.execute(stmt)
    workspace = result.scalar_one_or_none()

    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    await db.delete(workspace)
    await db.commit()

    return {"message": "Workspace deleted successfully"}

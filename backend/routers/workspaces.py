import asyncio
import urllib.parse
import uuid
import fsspec
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy import select
from typing import Dict, List, Optional
from pathlib import Path
import json

from backend.database import get_db
from backend.models import Workspace, WorkspaceVersion, Project, ProjectMember, Process, ProcessVersion
from backend.services.auth_service import get_current_user, require_project_member, AuthContext
from backend.services.storage_service import get_fsspec_storage_options
from backend.config import settings

# The stats sidecar mime key inside a dataset's `parts["files"]` map. Its JSON body carries
# the dataset's column names — see backend/routers/datasets.py get_dataset for the structure.
_STATS_MIME = "application/vnd.ymerflow.stats+json"

router = APIRouter(prefix="/workspace", tags=["Workspaces"])

WIDGET_SCHEMAS_PATH = Path(__file__).parent.parent / "widget_schemas.json"

# Built-in container widgets from the flexout layout system (they carry `children`,
# not a `layoutConfig`). Leaf widgets are discovered from widget_schemas.json.
_CONTAINER_WIDGETS = {
    "VerticalSplit": "Split the pane vertically into two resizable children.",
    "HorizontalSplit": "Split the pane horizontally into two resizable children.",
    "TabSet": "Tabbed pane — children are switchable tabs.",
}

_NODE_ID_PROP = {"type": "string", "description": "Unique pane identifier (UUID recommended)"}


class CreateWorkspaceBody(BaseModel):
    title: str = "Untitled Workspace"
    # Object-typed so the MCP tool schema advertises an object and FastAPI returns
    # 422 (not a silently-stored string) when a caller serializes the layout to JSON.
    layout: dict


class CreateWorkspaceVersionBody(BaseModel):
    layout: dict


def _load_widget_schemas() -> dict:
    """Load the build-time widget schema export, or raise 503 with a fix hint."""
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
    return widget_schemas


def _container_node_def(widget_name: str, description: str) -> dict:
    """Node schema for a built-in container widget (`{id, widget, children}`)."""
    return {
        "type": "object",
        "title": widget_name,
        "description": description,
        "properties": {
            "id": _NODE_ID_PROP,
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


def _leaf_node_def_raw(widget_name: str, widget_info: dict) -> dict:
    """Node schema for a leaf widget as embedded in the full recursive dump.

    This reproduces the historical `get_workspace_schema` shape verbatim (the
    widget's exported `schema` is nested under `layoutConfig` as-is), so the
    `verbose=true` response is unchanged from before this refactor.
    """
    layout_config_schema = widget_info.get("schema") or {}
    if widget_info.get("default") is not None:
        layout_config_schema = {**layout_config_schema, "default": widget_info["default"]}

    node_def = {
        "type": "object",
        "title": widget_info.get("title", widget_name),
        "properties": {
            "id": _NODE_ID_PROP,
            "widget": {"const": widget_name},
        },
        "required": ["id", "widget"],
        "additionalProperties": False,
    }
    if layout_config_schema:
        node_def["properties"]["layoutConfig"] = layout_config_schema
    return node_def


def _widget_layout_config(widget_info: dict):
    """Return `(layout_config_schema, defs)` for a leaf widget, or `(None, {})`.

    A widget's exported `get_schema()` may return either a full node schema
    (`{id, widget, layoutConfig}` — as PlotView does) or a bare layoutConfig
    schema. Normalize both to just the layoutConfig sub-schema plus the `$defs`
    that its `#/$defs/...` refs resolve against.
    """
    schema = widget_info.get("schema")
    if not schema:
        return None, {}
    defs = schema.get("$defs", {})
    props = schema.get("properties", {})
    if "layoutConfig" in props:
        return props["layoutConfig"], defs
    return schema, defs


def _plot_layer_members(layout_config) -> list:
    """The `layers.items.anyOf` union members of a PlotView layoutConfig, or `[]`."""
    return (
        (layout_config or {})
        .get("properties", {})
        .get("layers", {})
        .get("items", {})
        .get("anyOf", [])
    )


def _collapse_plot_layers(layout_config: dict) -> dict:
    """Copy of a PlotView layoutConfig with `layers.items` collapsed to type names.

    The `anyOf` union of ~19 layer types is the bulk of the schema and overflows
    the tool-output limit; callers drill in with `list_plot_layer_types` /
    `get_plot_layer_schema` instead.
    """
    names = [m.get("title") for m in _plot_layer_members(layout_config)]
    collapsed = json.loads(json.dumps(layout_config))  # deep copy
    layers = collapsed.get("properties", {}).get("layers")
    if layers is not None:
        layers["items"] = {
            "type": "object",
            "description": (
                "One layer: an object with a single key naming its type, e.g. "
                '{"ResistivityCurtain": {...params...}}. Call '
                "list_plot_layer_types then get_plot_layer_schema(layer_type=...) "
                "for each type's parameter schema."
            ),
            "layer_types": names,
        }
    return collapsed

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

    if auth.api_key_project_ids is not None and workspace.project_id not in auth.api_key_project_ids:
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


def _build_full_workspace_schema(widget_schemas: dict) -> dict:
    """The full recursive node-tree JSON Schema (the historical `verbose` dump)."""
    defs = {}
    all_node_refs = []

    for widget_name, description in _CONTAINER_WIDGETS.items():
        defs[f"{widget_name}Node"] = _container_node_def(widget_name, description)
        all_node_refs.append({"$ref": f"#/$defs/{widget_name}Node"})

    for widget_name, widget_info in widget_schemas.items():
        defs[f"{widget_name}Node"] = _leaf_node_def_raw(widget_name, widget_info)
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


@router.get("-schema", operation_id="get_workspace_schema")
async def get_workspace_schema(verbose: bool = Query(False, include_in_schema=False)):
    """
    List the widget types available for a workspace layout.

    A workspace layout is a recursive tree of nodes. Every node is an object with
    `id` (a UUID) and `widget` (a type name from the index below); container
    widgets also carry `children` (an array of nodes) and leaf widgets may carry
    `layoutConfig` (widget-specific parameters). This returns a terse index — one
    short row per widget type plus the node envelope — so you can pick a widget,
    then drill in for its parameter schema:

      1. get_workspace_schema()                    → this widget index
      2. get_widget_schema(widget=...)             → one widget's node/param schema
      3. list_plot_layer_types(widget="PlotView")  → PlotView's layer types
      4. get_plot_layer_schema(widget="PlotView", layer_type=...)  → one layer's params

    `has_params` marks widgets whose node accepts a `layoutConfig`. PlotView is the
    only widget large enough to need the two layer tools above.

    Some layoutConfig fields reference live project data via an `x-format` — to enumerate
    valid values, call the matching completion tool with the project_id: `datasetPath` →
    `complete_dataset_path`, `processVersion` → `complete_process_version_path`, `expression`
    → `complete_column_path`. `current` in those paths is a placeholder for the viewer's
    selected process.

    Returns 503 if widget schemas have not been generated yet — run:
    `cd frontend && npm run export-schemas`
    """
    widget_schemas = _load_widget_schemas()

    if verbose:
        return _build_full_workspace_schema(widget_schemas)

    widgets = []
    for widget_name, description in _CONTAINER_WIDGETS.items():
        widgets.append({
            "widget": widget_name,
            "title": widget_name,
            "description": description,
            "container": True,
            "has_params": False,
        })
    for widget_name, widget_info in widget_schemas.items():
        layout_config, _ = _widget_layout_config(widget_info)
        widgets.append({
            "widget": widget_name,
            "title": widget_info.get("title", widget_name),
            "container": False,
            "has_params": layout_config is not None,
        })

    return {
        "widgets": widgets,
        "node_envelope": {
            "id": "<uuid>",
            "widget": "<name from widgets[].widget>",
            "children?": "[...nodes]  (container widgets only)",
            "layoutConfig?": "{...}  (leaf widgets where has_params is true)",
        },
    }


@router.get("-schema/widget/{widget}", operation_id="get_widget_schema")
async def get_widget_schema(widget: str):
    """
    Get the node schema for one widget type.

    For a container widget this is the `{id, widget, children}` shape; for a leaf
    widget it is `{id, widget, layoutConfig}` with `layoutConfig` being that
    widget's parameter schema. PlotView is special: its response gives the
    top-level layoutConfig shape but collapses its `layers` union to the list of
    layer-type names — enumerate them with list_plot_layer_types and fetch each
    layer's parameters with get_plot_layer_schema.

    A field marked `x-format` references live project data — enumerate valid values with the
    matching completion tool (pass the project_id): `datasetPath` → `complete_dataset_path`,
    `processVersion` → `complete_process_version_path`, `expression` → `complete_column_path`
    (PlotView's `layoutConfig.transforms` use `expression`). `current` is a placeholder for
    the viewer's selected process.
    """
    widget_schemas = _load_widget_schemas()

    if widget in _CONTAINER_WIDGETS:
        return _container_node_def(widget, _CONTAINER_WIDGETS[widget])

    if widget not in widget_schemas:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown widget '{widget}'. Call get_workspace_schema for the widget index.",
        )

    widget_info = widget_schemas[widget]
    layout_config, defs = _widget_layout_config(widget_info)

    node = {
        "type": "object",
        "title": widget_info.get("title", widget),
        "properties": {
            "id": _NODE_ID_PROP,
            "widget": {"const": widget},
        },
        "required": ["id", "widget"],
        "additionalProperties": False,
    }
    if layout_config is not None:
        if widget == "PlotView":
            layout_config = _collapse_plot_layers(layout_config)
        node["properties"]["layoutConfig"] = layout_config
        if defs:
            # $defs live at the document root so #/$defs/... refs resolve.
            node["$defs"] = defs
    return node


@router.get("-schema/widget/{widget}/layer", operation_id="list_plot_layer_types")
async def list_plot_layer_types(widget: str):
    """
    List the layer types available for a plotting widget (PlotView).

    Returns one short row per layer type. Non-plot widgets have no layers and
    return an empty list. Follow with get_plot_layer_schema for a layer's params.
    """
    widget_schemas = _load_widget_schemas()

    if widget not in _CONTAINER_WIDGETS and widget not in widget_schemas:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown widget '{widget}'. Call get_workspace_schema for the widget index.",
        )

    if widget not in widget_schemas:
        return []

    layout_config, _ = _widget_layout_config(widget_schemas[widget])
    rows = []
    for member in _plot_layer_members(layout_config):
        layer_type = member.get("title")
        inner = member.get("properties", {}).get(layer_type, {})
        rows.append({
            "layer_type": layer_type,
            "title": layer_type,
            "description": inner.get("description", ""),
        })
    return rows


@router.get("-schema/widget/{widget}/layer/{layer_type}", operation_id="get_plot_layer_schema")
async def get_plot_layer_schema(widget: str, layer_type: str):
    """
    Get the parameter schema for one layer type of a plotting widget.

    A layer is an object with a single key naming its type — e.g.
    `{"ResistivityCurtain": {...these params...}}`. Returns that inner parameter
    schema (with any `$defs` it references).

    Layer params often carry an `x-format` referencing live project data (e.g.
    `ResistivityCurtain.dataset` is `x-format: datasetPath`) — enumerate valid values with the
    matching completion tool (pass the project_id): `datasetPath` → `complete_dataset_path`,
    `processVersion` → `complete_process_version_path`, `expression` → `complete_column_path`.
    `current` is a placeholder for the viewer's selected process.
    """
    widget_schemas = _load_widget_schemas()

    if widget not in widget_schemas:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown widget '{widget}'. Call get_workspace_schema for the widget index.",
        )

    layout_config, defs = _widget_layout_config(widget_schemas[widget])
    members = _plot_layer_members(layout_config)
    member = next((m for m in members if m.get("title") == layer_type), None)
    if member is None:
        available = [m.get("title") for m in members]
        raise HTTPException(
            status_code=404,
            detail=f"Unknown layer type '{layer_type}' for widget '{widget}'. Available: {available}",
        )

    param_schema = dict(member.get("properties", {}).get(layer_type, {}))
    param_schema.setdefault("title", layer_type)
    if defs:
        param_schema["$defs"] = defs
    return param_schema


# ── Layout-path completion (Python peer of DatasetColumnCombobox.buildOptions) ───────────────
#
# Three workspace-layout string fields carry an `x-format` that the frontend turns into a
# live-data combobox; these endpoints are the headless/MCP equivalent, so an agent building a
# layoutConfig can enumerate valid dotted paths instead of reverse-engineering the React
# component. The grammar stays authoritative here on the server:
#
#   x-format: processVersion  →  complete_process_version_path  →  "current", "<proc>.<ver>"
#   x-format: datasetPath     →  complete_dataset_path          →  "current.<ds>", "<proc>.<ver>.<ds>"
#   x-format: expression      →  complete_column_path           →  "current.<ds>.<col>", "<proc>.<ver>.<ds>.<col>"
#
# `current` is a runtime placeholder — "whichever process/version the viewer has selected."
# The server has no such selection, so `current.*` completions are derived from a concrete
# process (see `example_process_id`) or, by default, the union across the whole project.
#
# Path segments are dot-joined, so any literal '.' in a process or dataset name is encoded to
# ',' (see `_encode_seg`) to keep each name a single dot-free segment — e.g. a process named
# "INV (ar 1.0)" appears as "INV (ar 1,0)" in every path. Version numbers and column names keep
# their real dots. These encoded strings are stored verbatim in workspace layout configs; the
# frontend resolves them the same way, so completions and stored paths stay byte-for-byte in
# sync. Use the returned values as-is; do not hand-write a path with a raw '.' inside a name.


async def _load_project_processes(project_id: str, db: AsyncSession) -> List[Process]:
    """Load a project's processes with versions → datasets eagerly loaded.

    Enough for every completion tool: fully-qualified paths come from
    version/dataset names, and column mode reads each dataset's stats sidecar.
    """
    stmt = (
        select(Process)
        .options(selectinload(Process.versions).selectinload(ProcessVersion.datasets))
        .where(Process.project_id == project_id)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


def _encode_seg(s: str) -> str:
    """Encode a single procName/datasetName segment for a dot-joined path.

    Dataset paths are dot-joined (`<proc>.<ver>.<ds>[.<col…>]`) and every consumer
    (frontend and gladly's Data._resolve) splits on '.' positionally, so a literal dot
    inside a name segment mis-segments the path. Replacing '.' with ',' keeps each name
    a single dot-free segment. MUST stay byte-for-byte identical to the frontend's
    `encodeSeg` (frontend/src/datamodel/datasetPath.js) — these paths are stored in
    workspace layout configs and resolved there. Only name segments are encoded;
    version numbers and the column tail keep their real dots.
    """
    return str(s).replace(".", ",")


def _matches(path: str, prefix_lower: str) -> bool:
    """The same case-insensitive substring filter the UI combobox applies."""
    return not prefix_lower or prefix_lower in path.lower()


def _sorted_versions(process: Process) -> List[ProcessVersion]:
    return sorted(process.versions, key=lambda v: v.version)


def _resolve_example_version(
    processes: List[Process], example_process_id: str, version: Optional[int]
) -> ProcessVersion:
    """Resolve `example_process_id` (+ optional version) to a concrete ProcessVersion whose
    outputs stand in for `current.*`. Raises 404 if the process/version isn't in the project."""
    process = next((p for p in processes if p.id == example_process_id), None)
    if process is None:
        raise HTTPException(
            status_code=404,
            detail=f"example_process_id '{example_process_id}' not found in this project",
        )
    versions = _sorted_versions(process)
    if version is not None:
        pv = next((v for v in versions if v.version == version), None)
    else:
        pv = versions[-1] if versions else None
    if pv is None:
        raise HTTPException(status_code=404, detail="Process version not found")
    return pv


def _current_dataset_names(
    processes: List[Process], example_process_id: Optional[str], version: Optional[int]
) -> List[str]:
    """Dataset names that back the `current.*` completions.

    With `example_process_id`, these are that process version's own output dataset names
    ("if the viewer selects a process shaped like this one"). Without it, the union of all
    distinct dataset names across the project (broad, still useful with zero args).
    """
    if example_process_id is not None:
        pv = _resolve_example_version(processes, example_process_id, version)
        return list(dict.fromkeys(ds.dataset_name for ds in pv.datasets))
    names = {}
    for process in processes:
        for ver in process.versions:
            for ds in ver.datasets:
                names[ds.dataset_name] = None
    return list(names.keys())


def _current_datasets(
    processes: List[Process], example_process_id: Optional[str], version: Optional[int]
):
    """`(dataset_name, Dataset)` pairs backing `current.*` for column completion.

    With `example_process_id`, the example version's datasets. Without it, one
    representative Dataset per distinct name (the last one seen), so each `current.<ds>`
    still resolves to a real stats sidecar to read columns from.
    """
    if example_process_id is not None:
        pv = _resolve_example_version(processes, example_process_id, version)
        return [(ds.dataset_name, ds) for ds in pv.datasets]
    by_name = {}
    for process in processes:
        for ver in process.versions:
            for ds in ver.datasets:
                by_name[ds.dataset_name] = ds
    return list(by_name.items())


def _dataset_stats_url(dataset) -> Optional[str]:
    """The raw storage URL of a dataset's stats sidecar, or None if it has none.

    Uses `dataset.parts` untranslated (storage URLs) since we read it backend-side with the
    project's admin fsspec kwargs. Only the new parts format (`{"files": {...}}`) carries stats.
    """
    parts = dataset.parts or {}
    files = parts.get("files")
    if isinstance(files, dict):
        return files.get(_STATS_MIME)
    return None


async def _dataset_columns(dataset, storage_options: dict) -> List[str]:
    """Column names for a dataset, read from its stats sidecar.

    Mirrors the JS combobox's notion of "columns": XYZ → `flightlines` + `layer_data` keys,
    MAG → `columns` keys, grid → `variables` keys (see get_dataset for the sidecar schema).
    A dataset with no stats sidecar (e.g. old-format) yields no columns.
    """
    stats_url = _dataset_stats_url(dataset)
    if not stats_url:
        return []

    def _read():
        with fsspec.open(stats_url, "r", **storage_options) as f:
            return json.load(f)

    try:
        stats = await asyncio.to_thread(_read)
    except FileNotFoundError:
        return []

    cols: List[str] = []
    for key in ("flightlines", "layer_data", "columns", "variables"):
        section = stats.get(key)
        if isinstance(section, dict):
            cols.extend(section.keys())
    return cols


def _stats_relevant(ds_path: str, prefix_lower: str) -> bool:
    """Whether a dataset's stats are worth reading given `prefix` (the lazy-fetch guard).

    A column path is `<ds_path>.<col>`. It can match `prefix` only if the dataset path is
    compatible with the typed prefix — either the prefix falls within the dataset path
    (`prefix ⊆ ds_path`, so every column qualifies) or the dataset path is a leading chunk of
    what's been typed (`ds_path ⊆ prefix`, the mid-type `current.smooth_model.rh` case). An
    unrelated prefix skips the dataset, so a narrow prefix doesn't fan out across the project.
    """
    if not prefix_lower:
        return True
    dl = ds_path.lower()
    return prefix_lower in dl or dl in prefix_lower


_EXAMPLE_PROCESS_DESC = (
    "Optional process id whose outputs stand in for the `current` placeholder — pass one to "
    "make `current.*` mean 'if the viewer selects a process shaped like this one'. When "
    "omitted, `current.*` is the union across the whole project."
)
_EXAMPLE_VERSION_DESC = "Version of `example_process_id` to use for `current.*`; defaults to its latest."
_PREFIX_DESC = "Case-insensitive substring filter applied to each candidate path (as the UI combobox does)."


@router.get("-schema/complete/process-version", operation_id="complete_process_version_path")
async def complete_process_version_path(
    prefix: str = Query("", description=_PREFIX_DESC),
    example_process_id: Optional[str] = Query(None, description=_EXAMPLE_PROCESS_DESC),
    version: Optional[int] = Query(None, description=_EXAMPLE_VERSION_DESC),
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
) -> List[str]:
    """Enumerate valid values for a workspace-layout field marked `x-format: processVersion`.

    Returns the bare `current` placeholder plus every `<processName>.<version>` in the
    project. `example_process_id`/`version` are accepted for signature parity with the other
    completion tools but don't affect the output here — `processVersion` fields only ever take
    the bare `current` token or a fully-qualified `<proc>.<ver>`.
    """
    prefix_lower = prefix.lower()
    processes = await _load_project_processes(project.id, db)

    out: List[str] = []
    if _matches("current", prefix_lower):
        out.append("current")
    for process in processes:
        for ver in _sorted_versions(process):
            path = f"{_encode_seg(process.name)}.{ver.version}"
            if _matches(path, prefix_lower):
                out.append(path)
    return out


@router.get("-schema/complete/dataset-path", operation_id="complete_dataset_path")
async def complete_dataset_path(
    prefix: str = Query("", description=_PREFIX_DESC),
    example_process_id: Optional[str] = Query(None, description=_EXAMPLE_PROCESS_DESC),
    version: Optional[int] = Query(None, description=_EXAMPLE_VERSION_DESC),
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
) -> List[str]:
    """Enumerate valid values for a workspace-layout field marked `x-format: datasetPath`.

    Returns `current.<datasetName>` entries plus every fully-qualified
    `<processName>.<version>.<datasetName>`. The `current.*` set comes from
    `example_process_id`'s outputs when given, else the union of distinct dataset names across
    the project (see `example_process_id`). Fully-qualified entries never depend on it.
    """
    prefix_lower = prefix.lower()
    processes = await _load_project_processes(project.id, db)

    out: List[str] = []
    for ds_name in _current_dataset_names(processes, example_process_id, version):
        path = f"current.{_encode_seg(ds_name)}"
        if _matches(path, prefix_lower):
            out.append(path)
    for process in processes:
        for ver in _sorted_versions(process):
            for ds in ver.datasets:
                path = f"{_encode_seg(process.name)}.{ver.version}.{_encode_seg(ds.dataset_name)}"
                if _matches(path, prefix_lower):
                    out.append(path)
    return out


@router.get("-schema/complete/column-path", operation_id="complete_column_path")
async def complete_column_path(
    prefix: str = Query("", description=_PREFIX_DESC),
    example_process_id: Optional[str] = Query(None, description=_EXAMPLE_PROCESS_DESC),
    version: Optional[int] = Query(None, description=_EXAMPLE_VERSION_DESC),
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
) -> List[str]:
    """Enumerate valid values for a workspace-layout field marked `x-format: expression`.

    Returns `current.<datasetName>.<column>` and `<processName>.<version>.<datasetName>.<column>`
    entries. Column names come from each dataset's stats sidecar (XYZ flightlines + layer_data,
    MAG columns, grid variables). The `current.*` set follows `example_process_id` as in
    `complete_dataset_path`. Sidecars are read lazily — only for datasets whose path is
    compatible with `prefix` — so a narrow prefix stays cheap.
    """
    prefix_lower = prefix.lower()
    processes = await _load_project_processes(project.id, db)
    storage_options = await get_fsspec_storage_options(db, project.id)

    out: List[str] = []

    for ds_name, ds in _current_datasets(processes, example_process_id, version):
        ds_path = f"current.{_encode_seg(ds_name)}"
        if not _stats_relevant(ds_path, prefix_lower):
            continue
        for col in await _dataset_columns(ds, storage_options):
            path = f"{ds_path}.{col}"
            if _matches(path, prefix_lower):
                out.append(path)

    for process in processes:
        for ver in _sorted_versions(process):
            for ds in ver.datasets:
                ds_path = f"{_encode_seg(process.name)}.{ver.version}.{_encode_seg(ds.dataset_name)}"
                if not _stats_relevant(ds_path, prefix_lower):
                    continue
                for col in await _dataset_columns(ds, storage_options):
                    path = f"{ds_path}.{col}"
                    if _matches(path, prefix_lower):
                        out.append(path)
    return out


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
    body: CreateWorkspaceBody,
    project_id: str,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new workspace in a project, with an initial version-1 layout.

    `layout` is a JSON object (a node tree), NOT a JSON string — pass it as an
    object. Discover valid widget types with `get_workspace_schema`, then drill in
    with `get_widget_schema` (and, for PlotView, `list_plot_layer_types` /
    `get_plot_layer_schema`) before constructing the layout.

    When a layoutConfig field carries an `x-format`, enumerate valid values with the matching
    completion tool (pass the project_id): `datasetPath` → `complete_dataset_path`,
    `processVersion` → `complete_process_version_path`, `expression` → `complete_column_path`.
    `current` in those paths is a placeholder for the viewer's selected process.

    Returns the created workspace including its generated `id`.
    """
    # Defensive: even though `layout` is typed as an object, guard any future
    # untyped path from reintroducing the string-stored-as-JSON footgun.
    if not isinstance(body.layout, dict):
        raise HTTPException(status_code=400, detail="layout must be a JSON object, not a string or array")

    ws = Workspace(
        id=str(uuid.uuid4()),
        title=body.title,
        project_id=project_id,
        created_by=auth.user.id,
    )
    db.add(ws)
    ws.versions.append(WorkspaceVersion(version=1, layout=body.layout, created_by=auth.user.id))

    await db.commit()

    return await _reload_workspace_dict(ws.id, db)


@router.post("/{workspace_id}/versions", operation_id="create_workspace_version")
async def create_workspace_version(
    workspace_id: str,
    body: CreateWorkspaceVersionBody,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Save a new version of an existing workspace's layout.

    `layout` is a JSON object (a node tree), NOT a JSON string. Unlike
    create_workspace, this never overwrites — it appends the next version number
    so prior layouts stay browsable. Any member of the workspace's home project
    may add a version, whether or not the workspace is public.
    """
    workspace = await _require_workspace_member(workspace_id, auth, db)

    if not isinstance(body.layout, dict):
        raise HTTPException(status_code=400, detail="layout must be a JSON object, not a string or array")

    next_version = max((v.version for v in workspace.versions), default=0) + 1
    workspace.versions.append(WorkspaceVersion(version=next_version, layout=body.layout, created_by=auth.user.id))

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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_mcp import FastApiMCP
import logging

from backend.config import settings
from backend.routers import (
    auth_router,
    projects_router,
    publications_router,
    environments_router,
    processes_router,
    datasets_router,
    workspaces_router,
    process_defaults_router,
    uploads_router,
    utilities_router,
    systems_router,
    tags_router,
    plugins_router,
    plugin_assets_router,
    internal_router,
    admin_router,
    stats_router,
    nav_router,
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(title="YmerFlow API", version="2.0.0")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_event():
    sweep_task = getattr(app.state, "sweep_task", None)
    if sweep_task is not None:
        sweep_task.cancel()
    from backend.services.k8s_client import k8s_clients
    await k8s_clients.close_all()


async def _orphan_sweep_loop():
    """Periodically re-attach monitors to orphaned versions and reap terminal-but-live Jobs.

    Supervisor loop: a transient failure in one pass (DB blip, a cluster briefly unreachable) is
    logged and the loop continues — it must never die permanently on one error, which would silently
    stop all orphan recovery. This logs (does not swallow, CLAUDE.md rule 8) and retries next tick.
    """
    import asyncio
    from backend.models import ProcessVersion
    while True:
        await asyncio.sleep(settings.monitor_sweep_interval_seconds)
        try:
            await ProcessVersion.resume_orphaned_monitors(respect_heartbeat=True)
        except Exception:
            logger.exception("Orphan-monitor sweep pass failed; will retry next interval")


@app.on_event("startup")
async def startup_event():
    """Initialize database, resume monitoring for active jobs, and start the periodic orphan sweep."""
    import asyncio
    from backend.models import ProcessVersion
    from backend.hooks import hooks
    from backend.plugin_assets import mount_plugin_assets

    # Mount backend-bundled plugin frontends and register plugin routers
    mount_plugin_assets(app)
    hooks.run.register_routers(app)

    # Startup pass: this fresh process has no live monitors yet, so re-attach EVERY non-terminal
    # version unconditionally (respect_heartbeat=False ignores the possibly-recent heartbeat the
    # now-dead monitors left behind) and reap any terminal-but-live Jobs.
    logger.info("Resuming monitoring for active jobs (startup sweep)...")
    await ProcessVersion.resume_orphaned_monitors(respect_heartbeat=False)

    # Then keep sweeping on an interval to catch monitors that die while the backend keeps running.
    app.state.sweep_task = asyncio.create_task(_orphan_sweep_loop())


# Include routers
app.include_router(auth_router)
app.include_router(projects_router)
app.include_router(publications_router)
app.include_router(environments_router)
app.include_router(processes_router)
app.include_router(datasets_router)
app.include_router(workspaces_router)
app.include_router(process_defaults_router)
app.include_router(uploads_router)
app.include_router(utilities_router)
app.include_router(systems_router)
app.include_router(tags_router)
app.include_router(plugins_router)
app.include_router(plugin_assets_router)
app.include_router(internal_router)
app.include_router(admin_router)
app.include_router(stats_router)
app.include_router(nav_router)


@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "name": "YmerFlow API",
        "version": "2.0.0",
        "status": "running"
    }


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy"}


@app.get("/public-config")
async def public_config():
    """Public, unauthenticated config for the landing page (shown before sign-in)."""
    return {"hosted_version_text": settings.hosted_version_text}


# Mount MCP server — exposes Projects, Processes, Datasets, Environments, Uploads and
# Workspaces as MCP tools at /mcp (Streamable HTTP transport). Auth via API key in the
# Authorization header; a key grants access to a *set* of projects (possibly empty), so
# every per-project endpoint takes project_id as an explicit path parameter.
#
# Raw data download endpoints (dataset/data, dataset/geography, /files/, /uploads/{id})
# are excluded from MCP via include_in_schema=False — they return binary content that
# overflows LLM context windows. Use the 'url' field from get_dataset / search_datasets
# and download with plain curl instead (no auth required for /files/ URLs).
mcp = FastApiMCP(
    app,
    name="YmerFlow",
    description=(
        "Geophysics data processing platform. "
        "Authenticate with an API key (Authorization: Bearer apk_<key>). A key grants "
        "access to a set of projects (possibly empty); every per-project endpoint takes "
        "project_id as an explicit path parameter — pass one from the key's set on every call.\n"
        "Typical workflow:\n"
        "0. list_projects() — discover the project(s) this key can access; use an entry's 'id' as "
        "project_id below. (Read-only publications may also appear, marked read_only:true.) "
        "If it returns none of your own projects, the key has an empty scope: call create_project() "
        "to make one — a project you create is automatically added to the key's scope, so the very "
        "next list_projects() will include it.\n"
        "0a. create_project(name=..., [storage_backend_id=...]) — create a new project. "
        "storage_backend_id is optional: omit it when only one backend is allowed; if several are, "
        "the 400 error lists them (or call list_storage_backends() to see the set).\n"
        "0b. list_public_publications() — discover public (findable) read-only projects shared by "
        "others. Any 'id' it returns is a publication id usable as project_id in the read-only tools "
        "below (list_processes, get_process, get_process_logs, search_datasets, get_dataset); write "
        "tools like create_process reject it.\n"
        "1. list_environments(project_id) — discover the environments available to a project "
        "(super-public base runners + project-local). list_public_environments() browses the "
        "public gallery across all projects.\n"
        "2. get_environment_process_type(env_id, type_name) — fetch schema for the specific type.\n"
        "3. For local files: upload_file(project_id, ...) (JSON+base64 for small files); or "
        "request_upload_token then curl -H 'Authorization: Bearer upt_...' "
        "-H 'Content-Type: application/octet-stream' --data-binary @path "
        "'/projects/{project_id}/upload?filename=path' for large files.\n"
        "4. create_process(project_id, ...) — submit a job; save the returned id and version number.\n"
        "5. get_process(project_id, process_id) — returns the process plus short version rows; "
        "poll until versions[-1].state is 'done' or 'failed'. (list_processes gives one short row "
        "per process; get_process drills into one process's versions.)\n"
        "6. get_process_version(project_id, process_id[, version]) — full detail (parameters, "
        "resources, cluster) for one version, defaulting to the latest. "
        "get_process_version_outputs(project_id, process_id[, version]) — that version's output "
        "dataset URLs (also defaults to latest).\n"
        "7. get_dataset(project_id, dataset_id) — resolve each output URL to its downloadable file "
        "'url' (extract the dataset id — the last path segment — from an outputs URL).\n"
        "8. curl '{url}' — download results; /files/ URLs need no authentication.\n"
        "Use get_dataset before downloading to check columns, record counts, and bbox.\n"
        "Workspaces (saved layouts/dashboards): get_workspace_schema() returns a terse widget "
        "index; drill in with get_widget_schema(widget=...), and for PlotView with "
        "list_plot_layer_types(widget='PlotView') then get_plot_layer_schema(widget='PlotView', "
        "layer_type=...). `layout` on create_workspace is a JSON object (a node tree), never a "
        "JSON string. Then create_workspace(project_id, title=..., layout={...})."
    ),
    include_tags=["Projects", "Processes", "Datasets", "Environments", "Uploads", "Workspaces", "Tags"],
)
mcp.mount_http()

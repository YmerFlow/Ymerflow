from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_mcp import FastApiMCP
import logging

from backend.config import settings
from backend.routers import (
    auth_router,
    projects_router,
    environments_router,
    processes_router,
    datasets_router,
    workspaces_router,
    uploads_router,
    utilities_router,
    systems_router,
    tags_router,
    plugins_router,
    plugin_assets_router,
    internal_router,
    admin_router,
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


@app.on_event("startup")
async def startup_event():
    """Initialize database and resume monitoring for active jobs"""
    import asyncio
    from backend.database import async_session_maker
    from backend.models import ProcessVersion, ProcessState
    from backend.hooks import hooks
    from backend.plugin_assets import mount_plugin_assets
    from sqlalchemy import select

    # Mount backend-bundled plugin frontends and register plugin routers
    mount_plugin_assets(app)
    hooks.run.register_routers(app)

    # Resume monitoring for any jobs that were running when backend restarted
    logger.info("Checking for active jobs to resume monitoring...")
    async with async_session_maker() as db:
        # Find all processes in QUEUED or RUNNING state
        stmt = select(ProcessVersion).where(
            ProcessVersion.state.in_([ProcessState.QUEUED, ProcessState.RUNNING])
        )
        result = await db.execute(stmt)
        active_processes = result.scalars().all()

        if active_processes:
            logger.info(f"Found {len(active_processes)} active job(s) to resume monitoring")
            for pv in active_processes:
                logger.info(f"  - Resuming: {pv.process_id} v{pv.version} (state: {pv.state.value})")
                # Start monitoring in background
                asyncio.create_task(ProcessVersion.monitor_job(pv.process_id, pv.version))
        else:
            logger.info("No active jobs found")


# Include routers
app.include_router(auth_router)
app.include_router(projects_router)
app.include_router(environments_router)
app.include_router(processes_router)
app.include_router(datasets_router)
app.include_router(workspaces_router)
app.include_router(uploads_router)
app.include_router(utilities_router)
app.include_router(systems_router)
app.include_router(tags_router)
app.include_router(plugins_router)
app.include_router(plugin_assets_router)
app.include_router(internal_router)
app.include_router(admin_router)


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


# Mount MCP server — exposes Processes, Datasets, Environments, and Uploads as MCP
# tools at /mcp (Streamable HTTP transport). Auth via API key in the Authorization
# header; each key is scoped to a single project so no project selection is needed.
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
        "Authenticate with an API key (Authorization: Bearer apk_<key>); "
        "the key is already scoped to a project.\n"
        "Typical workflow:\n"
        "1. list_environments(include_schemas=false) — discover environments and process type names.\n"
        "2. get_environment_process_type(env_id, type_name) — fetch schema for the specific type.\n"
        "3. For local files: upload_file (JSON+base64 for small files); or request_upload_token "
        "then curl -H 'Authorization: Bearer upt_...' -F file=@path /upload for large files.\n"
        "4. create_process — submit a job; save the returned id and version number.\n"
        "5. get_process(process_id) — poll until versions[-1].state is 'done' or 'failed'.\n"
        "6. get_dataset(dataset_id) — resolve output URLs from versions[-1].outputs.\n"
        "7. curl '{url}' — download results; /files/ URLs need no authentication.\n"
        "Use describe_dataset before downloading to check columns, record counts, and bbox."
    ),
    include_tags=["Processes", "Datasets", "Environments", "Uploads", "Workspaces"],
)
mcp.mount_http()

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field
import logging

from backend.database import get_db
from backend.models import Process, ProcessVersion, ProcessLog, Project, Environment
from backend.services.auth_service import get_current_user, AuthContext, require_project_member, resolve_project_for_read, ProjectReadAccess
from backend.services.websocket_service import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Processes"])


class ResourceRequests(BaseModel):
    cpu: str = Field("1000m", description="CPU request in Kubernetes notation, e.g. '500m' (0.5 cores) or '4' (4 cores). Default 1 CPU is fine for imports/processing; inversions require significantly more — set based on dataset size and available environment resources.")
    memory: str = Field("2Gi", description="Memory request, e.g. '512Mi' or '4Gi'. Default 2Gi is fine for imports/processing; inversions require significantly more — set based on dataset size and available environment resources.")
    ephemeral_storage: str = Field("10Gi", alias="ephemeral-storage", description="Temporary disk space for the job")

    model_config = {"populate_by_name": True}


class Ref(BaseModel):
    """Reference to an environment/cluster/similar object — {id, [name]}. The same shape is
    used for both reads (GET responses) and writes (POST bodies): a value read from a GET can
    be forwarded verbatim into a subsequent POST. Only `.id` is ever read server-side — `name`
    is surplus on input and silently ignored, never validated against."""
    id: str = Field(..., description="ID of the referenced object.")
    name: Optional[str] = Field(None, description="Ignored on input — present only because this is the same shape returned by GET.")

    model_config = {"extra": "ignore"}


class ProcessCreate(BaseModel):
    type: str = Field(..., description="Process type key, e.g. 'aem_processing' or 'aem_inversion'. Obtain valid types from get_environment_process_types.")
    environment: Ref = Field(..., description="Environment this job runs in — {id, [name]}. Obtain from list_environments (pass the object straight through, or just {\"id\": ...}).")
    name: Optional[str] = Field(None, description="Human-readable display name. Defaults to '<type>-process' if omitted.")
    params: Dict[str, Any] = Field(default_factory=dict, description="Process-type-specific input parameters. The required keys and their types are defined by the process type's JSON Schema (from get_environment_process_types). Dataset URLs from search_datasets can be passed here for input_data fields.")
    id: Optional[str] = Field(None, description="Existing process ID. When provided, creates a new version of that process instead of a new process record. Omit to create a fresh process.")
    resource_requests: Optional[ResourceRequests] = Field(None, description="Kubernetes resource requests for the job pod. IMPORTANT: always set this explicitly for inversions — the defaults (1 CPU, 2Gi RAM) are only suitable for imports and light processing. For inversions, determine the appropriate CPU and memory based on your dataset size and available environment resources before submitting.")
    deadline_seconds: int = Field(3600, description="Maximum wall-clock time in seconds before the job is killed. Default 3600s (1h) is fine for imports and processing. IMPORTANT: inversions routinely run for hours — a job killed by its deadline produces NO output. Estimate the required time based on your dataset size and set this explicitly before submitting an inversion.")
    cluster: Optional[Ref] = Field(None, description="Cluster to run this job on — {id, [name]}. Obtain from available_clusters. If omitted, the first cluster allowed for this request (by sort_order) is used automatically.")

    model_config = {"extra": "allow", "populate_by_name": True}


@router.post("/projects/{project_id}/process", summary="Submit a job (import, processing, inversion, or any other type)")
async def create_process(
    proc: ProcessCreate,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Submit any type of job — data import, processing, inversion, forward modelling, etc.

    The process type determines what the job does; all types are submitted through this
    single endpoint. Use list_environments + get_environment_process_type to discover
    available types and build the correct params dict.

    The job is queued and runs asynchronously in Kubernetes. Returns immediately with
    {"id": "<process_id>", "versions": [{"version": <n>}]}. State and outputs are NOT
    included — poll get_process(project_id, process_id) until versions[-1].state is 'done' or 'failed'.

    BEFORE SUBMITTING — retry vs. new process:
    - If you are retrying a failed job or correcting its parameters, you MUST pass the
      original process 'id'. Do NOT create a new process — that loses history and clutters
      the project.
    - Omit 'id' ONLY when starting a genuinely new workflow with no prior attempt.

    Versions:
    - Omit 'id' in the body to create a brand-new process (version 1).
    - 'id' (existing process UUID): Required when retrying a failed job or correcting
      parameters — pass the failed process's 'id' to append a new version to the same
      record. Creating a new process instead of a new version loses history and clutters
      the project. Use clone_process_version for small param tweaks on a completed job.
    - Save the returned 'id' and 'version'; you will need them when polling and fetching logs.

    RESOURCE SIZING — you MUST set resource_requests and deadline_seconds explicitly for inversions:
    - Imports / light processing: defaults are fine (1 CPU, 2Gi RAM, deadline 3600s).
    - Inversions: NEVER use defaults. Before submitting, reason about your dataset size and
      set cpu, memory, and deadline_seconds accordingly. A job killed by its deadline or
      OOM-killed produces NO output and must be restarted from scratch.

    For input_data fields (schema property with x-format: dataset), pass the 'url' field
    from get_dataset — NOT the /projects/{project_id}/dataset/{id} URL from get_process outputs directly.
    On failure, call get_process_logs(project_id, process_id, version) to diagnose.
    """
    environment_id = proc.environment.id
    stmt = select(Environment).where(Environment.id == environment_id)
    result = await db.execute(stmt)
    environment = result.scalar_one_or_none()
    if not environment:
        raise HTTPException(status_code=400, detail="Valid environment_id is required")

    # Convert Pydantic model back to dict for create_queued (existing contract)
    proc_dict = proc.model_dump(by_alias=True, exclude_none=True)

    process, version = await Process.create_queued(
        db=db,
        proc=proc_dict,
        project_id=project.id,
        environment_id=environment_id,
        username=auth.user.username
    )

    return {"id": process.id, "versions": [{"version": version}]}


@router.get("/projects/{project_id}/processes", summary="List data processing jobs")
async def list_processes(
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """List processes (jobs) in a project, with their status and outputs.

    Each process has a 'versions' array sorted ascending by version number; the most
    recent run is always versions[-1]. Each version entry has:
    - version: integer (1-based, increments with each re-run via the 'id' param)
    - state: 'queued' | 'running' | 'done' | 'failed'
    - outputs: dict mapping output name → /projects/{project_id}/dataset/{id} URL (populated when state == 'done')
    - parameters: the input params the job was run with

    Logs are not included — use get_process_logs for paginated log access.

    To check a specific process, prefer get_process(project_id, process_id) which is more efficient.
    To poll a specific run: find the process by .id, then find the version whose
    .version number matches what create_process returned; check .state on that entry.

    IMPORTANT: The URLs in 'outputs' are /projects/{project_id}/dataset/{id} metadata URLs, NOT
    directly usable as input_data for create_process. To get the actual file URL to pass as
    input_data, extract the dataset id from the URL (the last path segment) and call get_dataset,
    then use the 'url' field from that response.
    """
    stmt = select(Process).options(
        selectinload(Process.environment),
        selectinload(Process.versions).selectinload(ProcessVersion.datasets),
        selectinload(Process.versions).selectinload(ProcessVersion.tags),
        selectinload(Process.versions).selectinload(ProcessVersion.cluster),
    ).where(Process.project_id == access.project.id)

    result = await db.execute(stmt)
    processes = result.scalars().all()

    return [p.to_dict() for p in processes]


@router.get("/projects/{project_id}/process/{process_id}", summary="Get a single process by ID")
async def get_process(
    process_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Get a single process by its ID, including all versions with state, parameters, and outputs.

    Use this instead of list_processes when you already have a process ID (e.g. from
    create_process). It fetches only the one process you need rather than all processes
    in the project. Logs are not included — use get_process_logs for paginated log access.

    Returns 404 if the process is not found or not in the given project.

    After create_process returns an id, poll this endpoint until
    versions[-1].state becomes 'done' or 'failed'. Then read versions[-1].outputs
    for dataset URLs.
    """
    stmt = select(Process).options(
        selectinload(Process.environment),
        selectinload(Process.versions).selectinload(ProcessVersion.datasets),
        selectinload(Process.versions).selectinload(ProcessVersion.tags),
        selectinload(Process.versions).selectinload(ProcessVersion.cluster),
    ).where(Process.id == process_id)
    result = await db.execute(stmt)
    process = result.scalar_one_or_none()

    if not process or process.project_id != access.project.id:
        raise HTTPException(status_code=404, detail="Process not found")

    return process.to_dict()


@router.get("/projects/{project_id}/process/{process_id}/logs", summary="Get job execution logs")
async def get_process_logs(
    process_id: str,
    version: Optional[int] = None,
    offset: int = Query(0, description="Log entry offset. Positive = from the start; negative = from the end (e.g. -50 gives the last 50 lines)."),
    limit: Optional[int] = Query(None, description="Maximum number of log entries to return. Omit for all entries from offset."),
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Retrieve execution logs for a process job, optionally filtered to a specific version.

    Use this to diagnose why a job failed (state == 'failed'). Log entries
    include timestamps and messages.

    Always pass 'version' when diagnosing a specific run — omitting it returns
    logs from ALL versions interleaved.

    Pagination examples:
    - offset=0, limit=100   → first 100 lines
    - offset=100, limit=100 → next 100 lines
    - offset=-50            → last 50 lines (tail)
    - offset=-100, limit=50 → 50 lines starting 100 from the end
    """
    process_stmt = select(Process).where(Process.id == process_id)
    process_result = await db.execute(process_stmt)
    process = process_result.scalar_one_or_none()
    if not process or process.project_id != access.project.id:
        raise HTTPException(status_code=404, detail="Process not found")

    base = select(ProcessLog).where(ProcessLog.process_id == process_id)
    if version is not None:
        base = base.where(ProcessLog.version == version)

    actual_offset = offset
    if offset < 0:
        count_q = select(func.count()).select_from(
            base.order_by(None).subquery()
        )
        total = (await db.execute(count_q)).scalar()
        actual_offset = max(0, total + offset)

    stmt = base.order_by(ProcessLog.timestamp).offset(actual_offset)
    if limit is not None:
        stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    return [log.to_dict() for log in result.scalars().all()]


class CloneRequest(BaseModel):
    parameter_overrides: Optional[Dict[str, Any]] = Field(None, description="Keys to change relative to the source version. All other parameters are copied unchanged.")
    resource_requests: Optional[ResourceRequests] = Field(None, description="Override resource limits for the cloned run. IMPORTANT: always set this for inversions — the source version may have used the small defaults (1 CPU, 2Gi RAM) which are insufficient. Reason about your dataset size and set cpu and memory accordingly before submitting.")
    deadline_seconds: Optional[int] = Field(None, description="Override the deadline (seconds) for the cloned run. IMPORTANT: inversions routinely run for hours — a job killed by deadline produces NO output. Reason about your dataset size and set this explicitly. If omitted, inherits from the source version.")
    cluster: Optional[Ref] = Field(None, description="Override the cluster for the cloned run — {id, [name]}. Obtain from available_clusters. If omitted, inherits the source version's cluster (re-validated; falls back to the first allowed cluster if that cluster is no longer allowed/active).")


@router.post("/projects/{project_id}/process/{process_id}/versions/{version}/clone", summary="Clone a process version with parameter overrides")
async def clone_process_version(
    process_id: str,
    version: int,
    body: Optional[CloneRequest] = None,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new version of a process by copying parameters from an existing version with optional overrides.

    This enables the iterative tuning workflow: run a process, inspect results,
    adjust one or two parameters, and re-run — without re-specifying all parameters.

    Resource limits and deadline are inherited from the source version unless explicitly
    overridden in the request body.

    RESOURCE SIZING — if the process type is an inversion, always override resources:
    - The source version may have been created with defaults (1 CPU, 2Gi RAM, 1h deadline),
      which will cause the inversion job to be OOM-killed or hit the deadline with no output.
    - Before submitting, reason about your dataset size and the resources available in the
      environment, then set resource_requests and deadline_seconds explicitly.

    Returns the same {"id", "versions": [{"version"}]} format as create_process.
    Poll get_process(project_id, process_id) to track the new version's state.

    Example — clone version 2, change one parameter, sized for inversion:
        POST /projects/{project_id}/process/abc-123/versions/2/clone
        Body: {
          "parameter_overrides": {"regularization": 0.5},
          "resource_requests": {"cpu": "<based on data size>", "memory": "<based on data size>"},
          "deadline_seconds": <estimated runtime in seconds>
        }
    """
    stmt = select(ProcessVersion).options(
        selectinload(ProcessVersion.process)
    ).where(
        ProcessVersion.process_id == process_id,
        ProcessVersion.version == version
    )
    result = await db.execute(stmt)
    source_version = result.scalar_one_or_none()

    if not source_version:
        raise HTTPException(status_code=404, detail="Process version not found")

    process = source_version.process
    if process.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    from backend.services.storage_service import translate_urls_in_dict
    http_params = translate_urls_in_dict(source_version.parameters, to_storage=False)
    if body and body.parameter_overrides:
        http_params.update(body.parameter_overrides)

    resource_requests = (
        body.resource_requests.model_dump(by_alias=True) if body and body.resource_requests
        else source_version.resource_requests
    )
    deadline_seconds = (
        body.deadline_seconds if body and body.deadline_seconds is not None
        else source_version.deadline_seconds
    )
    cluster_id = (
        body.cluster.id if body and body.cluster is not None
        else source_version.k8s_cluster_id
    )

    proc = {
        "id": process_id,
        "type": process.type,
        "environment_id": process.environment_id,
        "params": http_params,
        "resource_requests": resource_requests,
        "deadline_seconds": deadline_seconds,
        "cluster": {"id": cluster_id} if cluster_id is not None else None
    }

    new_process, new_version = await Process.create_queued(
        db=db,
        proc=proc,
        project_id=process.project_id,
        environment_id=process.environment_id,
        username=auth.user.username
    )

    return {"id": new_process.id, "versions": [{"version": new_version}]}


@router.post("/projects/{project_id}/process/{process_id}/versions/{version}/cancel", summary="Cancel a running or queued process")
async def cancel_process_version(
    process_id: str,
    version: int,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Cancel a process version that is currently queued or running.

    Deletes the Kubernetes job (if one has been submitted) and marks the version as failed.
    Has no effect and returns 409 if the version is already in a terminal state (done/failed).
    """
    stmt = select(ProcessVersion).options(
        selectinload(ProcessVersion.process)
    ).where(
        ProcessVersion.process_id == process_id,
        ProcessVersion.version == version
    )
    result = await db.execute(stmt)
    version_obj = result.scalar_one_or_none()

    if not version_obj:
        raise HTTPException(status_code=404, detail="Process version not found")

    process = version_obj.process
    if process.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    from backend.models import ProcessState
    if version_obj.state not in (ProcessState.QUEUED, ProcessState.STARTING, ProcessState.RUNNING):
        raise HTTPException(status_code=409, detail=f"Process version is already in terminal state: {version_obj.state.value}")

    if version_obj.k8s_job_name:
        from backend.services.k8s_client import k8s_clients
        from backend.models.cluster import get_cluster_for_process_version
        try:
            cluster = await get_cluster_for_process_version(db, version_obj)
            await k8s_clients.get(cluster).delete_job(version_obj.k8s_job_name)
        except Exception as e:
            # Best-effort cleanup — the version is still marked FAILED below even if the
            # cluster is unreachable (e.g. retired/torn down), but surface the failure
            # instead of silently swallowing it (see CLAUDE.md "Never swallow errors").
            logger.warning(f"Could not delete K8s job {version_obj.k8s_job_name} on cancel: {e}")
            await version_obj.add_log_entry(db, f"WARNING: Could not delete cluster job (cluster may be unreachable): {e}")

    await version_obj.add_log_entry(db, "Process cancelled by user")
    await version_obj.update_state(db, ProcessState.FAILED, process.project_id)

    return {"status": "cancelled"}


class PositionUpdate(BaseModel):
    x: float
    y: float


@router.patch("/projects/{project_id}/process/{process_id}/position", status_code=204, summary="Save FlowView node position")
async def update_process_position(
    process_id: str,
    body: PositionUpdate,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Persist the FlowView canvas position for a process node."""
    stmt = select(Process).where(Process.id == process_id)
    result = await db.execute(stmt)
    process = result.scalar_one_or_none()

    if not process or process.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process not found")

    process.flow_x = body.x
    process.flow_y = body.y
    await db.commit()


@router.websocket("/ws/process/{process_id}/logs")
async def process_logs_websocket(websocket: WebSocket, process_id: str, version: Optional[int] = None):
    """WebSocket endpoint for streaming process logs"""
    await websocket.accept()
    await ws_manager.connect_logs(process_id, websocket)

    try:
        from backend.database import async_session_maker
        async with async_session_maker() as db:
            stmt = select(ProcessLog).where(ProcessLog.process_id == process_id)
            if version is not None:
                stmt = stmt.where(ProcessLog.version == version)
            stmt = stmt.order_by(ProcessLog.timestamp)

            result = await db.execute(stmt)
            logs = result.scalars().all()

            for log in logs:
                await websocket.send_json(log.to_dict())

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        await ws_manager.disconnect_logs(process_id, websocket)
    except Exception:
        await ws_manager.disconnect_logs(process_id, websocket)


@router.websocket("/ws/processes/updates")
async def process_state_websocket(websocket: WebSocket):
    """WebSocket endpoint for streaming global process state updates"""
    await websocket.accept()
    await ws_manager.connect_state(websocket)

    try:
        await websocket.send_json({"refetch": True})

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        await ws_manager.disconnect_state(websocket)
    except Exception:
        await ws_manager.disconnect_state(websocket)

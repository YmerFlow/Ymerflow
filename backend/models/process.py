from sqlalchemy import Column, String, DateTime, JSON, Integer, ForeignKey, Enum, Index, UniqueConstraint, Text, select, Table, Float
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import relationship, selectinload
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
import uuid
import enum
import asyncio

from backend.database import Base


def _iso8601_duration(delta: timedelta) -> str:
    """Format a timedelta as an ISO 8601 duration string (e.g. 'PT1H3M42S').

    Fractional seconds are preserved. Negative durations are not expected
    (completed_at should never precede started_at) but are represented with a
    leading '-' on the whole duration if they occur.
    """
    total = delta.total_seconds()
    sign = "-" if total < 0 else ""
    total = abs(total)
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    parts = []
    if hours:
        parts.append(f"{int(hours)}H")
    if minutes:
        parts.append(f"{int(minutes)}M")
    # Always emit seconds so a zero-length duration renders as 'PT0S'.
    if seconds or not parts:
        # Drop trailing ".0" for whole-second durations, keep fractions otherwise.
        parts.append(f"{seconds:g}S")
    return f"{sign}PT{''.join(parts)}"


class ProcessState(str, enum.Enum):
    QUEUED = "queued"
    STARTING = "starting"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class ProcessTag(Base):
    __tablename__ = "process_tags"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    color = Column(String(32), nullable=False, default="#6c757d")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "color": self.color}


process_version_tags_table = Table(
    "process_version_tags",
    Base.metadata,
    Column("process_version_id", Integer, ForeignKey("process_versions.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", String(255), ForeignKey("process_tags.id", ondelete="CASCADE"), primary_key=True),
    Column("added_at", DateTime, nullable=False),
    Column("added_by", String(255), nullable=False, default=""),
)


class Process(Base):
    __tablename__ = "processes"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    type = Column(String(100), nullable=False)
    environment_id = Column(String(255), ForeignKey("environments.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    flow_x = Column(Float, nullable=True)
    flow_y = Column(Float, nullable=True)
    # Attribution for the admin stats dashboard (docs/plans/admin-stats-dashboard.md); nullable,
    # SET NULL — see Project.created_by.
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    # Relationships
    environment = relationship("Environment", back_populates="processes", foreign_keys=[environment_id])
    project = relationship("Project", back_populates="processes")
    created_by_user = relationship("User", foreign_keys=[created_by])
    versions = relationship("ProcessVersion", back_populates="process", cascade="all, delete-orphan", order_by="ProcessVersion.version")
    logs = relationship("ProcessLog", back_populates="process", cascade="all, delete-orphan")

    def to_dict(self):
        """Convert to API response format"""
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            # minimal=True: only the process's own environment id/name are ever
            # consumed by the frontend — not worth shipping docker_image/process_id/
            # process_types (even just names) on every process.
            "environment": self.environment.to_dict(minimal=True) if self.environment else None,
            "project_id": self.project_id,
            "flow_x": self.flow_x,
            "flow_y": self.flow_y,
            "versions": [v.to_dict(self.project_id) for v in sorted(self.versions, key=lambda x: x.version)]
        }

    @staticmethod
    def extract_dependencies(params: Dict[str, Any]) -> list:
        """Extract dataset URLs from params and build dependency list"""
        dependencies = []

        def find_dataset_urls(obj, path=""):
            """Recursively find dataset URLs in nested structures"""
            if isinstance(obj, str):
                # Match both old format (/projects/{project_id}/dataset/{id}) and new format
                # (/files/.../datasets/{id}/...)
                import re
                from backend.config import settings
                dataset_url_pattern = re.compile(
                    rf"^{re.escape(settings.backend_base_url)}/projects/[^/]+/dataset/([^/]+)$"
                )
                files_url_prefix = f"{settings.backend_base_url}/files/"

                dataset_url_match = dataset_url_pattern.match(obj)
                if dataset_url_match:
                    # Old format: extract dataset_id from URL
                    dataset_id = dataset_url_match.group(1)
                    dependencies.append({
                        "source_dataset_id": dataset_id,
                        "target_param_name": path
                    })
                elif obj.startswith(files_url_prefix) and "/datasets/" in obj:
                    # New format: extract dataset_id from path
                    import re
                    match = re.search(r'/datasets/([^/]+)/', obj)
                    if match:
                        dataset_id = match.group(1)
                        dependencies.append({
                            "source_dataset_id": dataset_id,
                            "target_param_name": path
                        })
            elif isinstance(obj, dict):
                for key, value in obj.items():
                    new_path = f"{path}.{key}" if path else key
                    find_dataset_urls(value, new_path)
            elif isinstance(obj, list):
                for i, item in enumerate(obj):
                    new_path = f"{path}[{i}]"
                    find_dataset_urls(item, new_path)

        find_dataset_urls(params)
        return dependencies

    @classmethod
    async def create_queued(
        cls,
        db: AsyncSession,
        proc: Dict[str, Any],
        project_id: str,
        environment_id: str,
        username: str
    ) -> tuple:
        """
        Quickly create a process in QUEUED state and schedule background execution.

        Validates user existence, creates DB records, and returns immediately.
        Balance checking, dependency resolution, and K8s job submission happen
        in the background via run_task(). On any failure there, state becomes FAILED.

        Returns:
            Tuple of (Process, version_number)
        """
        from backend.models import User
        from backend.services.storage_service import translate_urls_in_dict, get_storage_base_url
        from backend.services.log_manager import LogRetrievalState
        from fastapi import HTTPException

        # Validate user exists (only existence check — balance checked in background)
        stmt = select(User).where(User.username == username)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()

        if not user:
            raise HTTPException(status_code=401, detail="User not found")

        # Check if this is a new version of an existing process
        existing_id = proc.get("id")
        process = None

        if existing_id:
            stmt = select(Process).options(selectinload(Process.versions)).where(Process.id == existing_id)
            result = await db.execute(stmt)
            process = result.scalar_one_or_none()

        if process:
            new_version = len(process.versions) + 1
            process.type = proc["type"]
            process.environment_id = environment_id
        else:
            process = Process(
                id=str(uuid.uuid4()),
                name=proc.get("name", f"{proc['type']}-process"),
                type=proc["type"],
                environment_id=environment_id,
                project_id=project_id,
                # Attribution for the admin stats dashboard — the acting user is loaded above.
                created_by=user.id,
            )
            db.add(process)
            new_version = 1

        # Translate HTTP URLs to storage URLs. The scheme must match the project's own storage
        # backend (s3 for MinIO, gs for GCS, …) so the pod opens the right fsspec filesystem — see
        # docs/plans/per-project-storage-routing.md.
        params = proc.get("params", {})
        storage_base = await get_storage_base_url(db, project_id)
        params = translate_urls_in_dict(params, to_storage=True, scheme=storage_base.split("://", 1)[0])

        resource_requests = proc.get("resource_requests", {
            "cpu": "1000m",
            "memory": "2Gi",
            "ephemeral-storage": "10Gi"
        })
        deadline_seconds = proc.get("deadline_seconds", 3600)

        # --- Resolve and validate the requested cluster ---
        # Re-derives the allowed set and limits server-side rather than trusting the
        # submitted cluster/resource_requests — the client already enforced the same
        # limits via sliders bounded by GET /projects/{project_id}/utilities/available-clusters.
        from backend.models.cluster import get_allowed_clusters
        from backend.services.k8s_client import k8s_clients, _parse_cpu_cores, _parse_memory_gb
        from backend.services.cluster_providers import get_cluster_provider

        allowed = await get_allowed_clusters(db, user, project_id, resource_requests)
        if not allowed:
            raise HTTPException(status_code=400, detail="No clusters available to run this process.")

        cluster_ref = proc.get("cluster")
        cluster_id = cluster_ref["id"] if cluster_ref else None
        if cluster_id is None:
            cluster = allowed[0]  # first by sort_order — MCP/script clients that omit cluster_id
        else:
            cluster = next((c for c in allowed if c.id == cluster_id), None)
            if cluster is None:
                raise HTTPException(status_code=400, detail=f"Cluster {cluster_id} is not allowed for this request.")

        # A pod is atomic — it must fit on one node — so the ceiling that actually bounds a task is
        # the cluster's single-node capacity, NOT the cluster-wide Kueue aggregate. Validating
        # against node_capacity() rejects an unschedulable task at submit instead of admitting it
        # on aggregate quota and letting its pod hang Unschedulable until its deadline burns. No
        # fallback: a provider that can't report capacity raises (a real misconfiguration to fix,
        # not a guessed ceiling). See docs/plans/done/single-node-task-size-accounting.md.
        provider = get_cluster_provider(cluster.cluster_type)
        limits = await provider.node_capacity(k8s_clients.get(cluster), cluster.provider_config)

        requested_cpu = _parse_cpu_cores(resource_requests.get("cpu", "1000m"))
        requested_memory = _parse_memory_gb(resource_requests.get("memory", "2Gi"))
        if requested_cpu > limits["max_cpu_cores"]:
            raise HTTPException(status_code=400, detail=f"Requested CPU ({requested_cpu} cores) exceeds single-node capacity ({limits['max_cpu_cores']} cores)")
        if requested_memory > limits["max_memory_gb"]:
            raise HTTPException(status_code=400, detail=f"Requested memory ({requested_memory} GB) exceeds single-node capacity ({limits['max_memory_gb']} GB)")
        if cluster.max_runtime_seconds is not None and deadline_seconds > cluster.max_runtime_seconds:
            raise HTTPException(status_code=400, detail=f"Requested deadline ({deadline_seconds}s) exceeds cluster limit ({cluster.max_runtime_seconds}s)")

        version_obj = ProcessVersion(
            process_id=process.id,
            version=new_version,
            parameters=params,
            state=ProcessState.QUEUED,
            dependencies=[],  # Resolved in background
            resource_requests=resource_requests,
            deadline_seconds=deadline_seconds,
            k8s_cluster_id=cluster.id,
            log_retrieval_state=LogRetrievalState.NOT_STARTED,
            # Attribution for the admin stats dashboard — every version records its submitter.
            created_by=user.id,
        )
        db.add(version_obj)

        await db.commit()

        # Broadcast QUEUED state to connected clients
        from backend.services.websocket_service import ws_manager
        state_update = {
            "process_id": process.id,
            "version": new_version,
            "state": ProcessState.QUEUED.value
        }
        await ws_manager.broadcast_state(state_update)

        # Schedule background task — balance check, dependency resolution, K8s submission
        asyncio.create_task(version_obj.run_task(username))

        return process, new_version


class ProcessVersion(Base):
    __tablename__ = "process_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    process_id = Column(String(255), ForeignKey("processes.id", ondelete="CASCADE"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    parameters = Column(JSON, nullable=False)  # Process parameters
    state = Column(Enum(ProcessState), default=ProcessState.QUEUED, nullable=False, index=True)
    dependencies = Column(JSON, default=list, nullable=False)  # Array of dependency objects
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    # Attribution for the admin stats dashboard (docs/plans/admin-stats-dashboard.md); nullable,
    # SET NULL — see Project.created_by.
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    # K8s execution fields
    resource_requests = Column(JSON, default=lambda: {"cpu": "1000m", "memory": "2Gi", "ephemeral-storage": "10Gi"}, nullable=True)
    deadline_seconds = Column(Integer, default=3600, nullable=True)  # 1 hour default
    k8s_job_name = Column(String(255), nullable=True)  # Unique by construction (process-{id}-v{version})
    k8s_namespace = Column(String(255), nullable=True)
    # Which Cluster this job ran/will run on. NULL on rows created before multi-cluster support —
    # those are resolved to the bootstrap default cluster by get_cluster_for_process_version().
    k8s_cluster_id = Column(String(36), ForeignKey("clusters.id"), nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # SHA-256 hex of the opaque STORAGE_REFRESH_TOKEN injected into the pod for this job (set only
    # for credential_strategy=short-lived; see backend/routers/internal.py). Never store the
    # plaintext token — same hash-and-compare pattern as ApiKey.key_hash.
    refresh_token_hash = Column(String(255), nullable=True)

    # Log retrieval tracking fields
    log_retrieval_state = Column(String(50), nullable=True)  # LogRetrievalState values
    log_last_timestamp = Column(DateTime, nullable=True)  # Last log timestamp retrieved
    log_stream_position = Column(String(255), nullable=True)  # K8s sinceTime for resume
    log_checkpoint = Column(JSON, nullable=True)  # Additional checkpoint data

    # Relationships
    process = relationship("Process", back_populates="versions")
    created_by_user = relationship("User", foreign_keys=[created_by])
    datasets = relationship("Dataset", back_populates="process_version")
    tags = relationship("ProcessTag", secondary=process_version_tags_table, viewonly=True)
    # viewonly=True: nothing should mutate cluster assignment through this relationship —
    # k8s_cluster_id stays the column that's actually written.
    cluster = relationship("Cluster", foreign_keys=[k8s_cluster_id], viewonly=True)

    # Tag history (append-only log of tag additions/removals, stored by name+color)
    tags_history = Column(JSON, default=list, nullable=True)

    # Constraints
    __table_args__ = (
        UniqueConstraint('process_id', 'version', name='uq_process_version'),
    )

    def to_dict(self, project_id: str):
        """Convert to API response format.

        Note: Requires self.datasets, self.tags, and self.cluster to be eagerly loaded.
        Use selectinload(ProcessVersion.datasets), selectinload(ProcessVersion.tags), and
        selectinload(ProcessVersion.cluster). Logs are not included — use
        GET /projects/{project_id}/process/{id}/logs for paginated log access.

        project_id must be passed explicitly (rather than read off self.process) to avoid
        a lazy-load on the process backref, which isn't populated by selectinload(Process.versions)
        and would raise a MissingGreenlet error in async context.
        """
        from backend.services.storage_service import translate_urls_in_dict

        parameters = translate_urls_in_dict(self.parameters, to_storage=False)

        from backend.config import settings
        outputs = {
            dataset.dataset_name: f"{settings.backend_base_url}/projects/{project_id}/dataset/{dataset.id}"
            for dataset in self.datasets
        }

        run_length = None
        if self.started_at is not None and self.completed_at is not None:
            run_length = _iso8601_duration(self.completed_at - self.started_at)

        return {
            "version": self.version,
            "parameters": parameters,
            "outputs": outputs,
            "state": self.state.value,
            "dependencies": self.dependencies,
            "resource_requests": self.resource_requests,
            "deadline_seconds": self.deadline_seconds,
            "cluster": self.cluster.to_dict() if self.cluster else None,
            "tags": [t.to_dict() for t in self.tags],
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "run_length": run_length,
        }

    async def update_state(self, db: AsyncSession, new_state: ProcessState, project_id: str = None):
        """Update process state and broadcast to all state listeners

        Args:
            db: Database session
            new_state: New process state
            project_id: Optional project_id to avoid lazy loading (pass if available)
        """
        import logging
        from backend.services.websocket_service import ws_manager
        from backend.services.storage_service import translate_urls_in_dict

        logger = logging.getLogger(__name__)

        logger.info(f"Updating process state: {self.process_id} v{self.version} -> {new_state.value}")
        self.state = new_state

        await db.commit()

        # Broadcast state change to all connected clients
        state_update = {
            "process_id": self.process_id,
            "version": self.version,
            "state": new_state.value
        }

        # Include outputs in broadcast when transitioning to DONE
        if new_state == ProcessState.DONE and self.datasets:
            # Build outputs list from datasets
            state_update["outputs"] = [dataset.to_dict() for dataset in self.datasets]

        # Use provided project_id or get from relationship (if already loaded)
        if project_id is None:
            # Only access relationship if it's already loaded (avoid lazy loading)
            if 'process' in self.__dict__:
                project_id = self.process.project_id
            else:
                # Fetch project_id directly without loading full relationship
                result = await db.execute(
                    select(Process.project_id).where(Process.id == self.process_id)
                )
                project_id = result.scalar_one()

        state_update = translate_urls_in_dict(state_update, to_storage=False)

        logger.info(f"Broadcasting state update: {state_update}")
        await ws_manager.broadcast_state(state_update)

    async def add_log_entry(self, db: AsyncSession, message: str):
        """Add a log entry and broadcast to connected clients"""
        log_entry = ProcessLog(
            process_id=self.process_id,
            version=self.version,
            timestamp=datetime.utcnow(),
            message=message
        )

        db.add(log_entry)
        await db.commit()

        # Broadcast to connected WebSocket clients
        from backend.services.websocket_service import ws_manager
        await ws_manager.broadcast_log(self.process_id, log_entry.to_dict())

    @staticmethod
    async def monitor_job(process_id: str, version: int):
        """Monitor K8s job status and update process state accordingly.

        This method uses LogManager for all log retrieval. It can be called both when
        a job is first created and on backend restart to resume monitoring.

        Args:
            process_id: Process ID
            version: Process version number
        """
        from backend.services.job_orchestrator import get_job_status
        from backend.services.k8s_client import k8s_clients
        from backend.models.cluster import get_cluster_for_process_version
        from backend.services.log_manager import LogManager
        from backend.database import async_session_maker
        from kubernetes_asyncio.client.exceptions import ApiException
        import logging

        logger = logging.getLogger(__name__)
        logger.info(f"🔍 Monitoring K8s job: {process_id} v{version}")

        # Initialize log manager
        log_manager = LogManager(process_id, version)

        try:
            async with async_session_maker() as db:
                from sqlalchemy.orm import selectinload

                # Fetch the process version with relationships loaded
                stmt = select(ProcessVersion).options(
                    selectinload(ProcessVersion.datasets),
                    selectinload(ProcessVersion.process)
                ).where(
                    ProcessVersion.process_id == process_id,
                    ProcessVersion.version == version
                )
                result = await db.execute(stmt)
                process_version = result.scalar_one_or_none()

                if not process_version:
                    logger.error(f"Process version not found: {process_id} v{version}")
                    return

                # Skip if already in terminal state
                if process_version.state in [ProcessState.DONE, ProcessState.FAILED]:
                    logger.info(f"Process already in terminal state {process_version.state}, skipping")
                    return

                process = process_version.process

                if not process:
                    logger.error(f"Process not found: {process_id}")
                    return

                # Check if job was already created
                if not process_version.k8s_job_name:
                    logger.error(f"No K8s job name found for {process_id} v{version} - cannot monitor")
                    await process_version.add_log_entry(db, "ERROR: No K8s job was created for this process")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                job_name = process_version.k8s_job_name
                cluster = await get_cluster_for_process_version(db, process_version)
                k8s_client = k8s_clients.get(cluster)

                # Check current job status immediately
                try:
                    current_status = await get_job_status(job_name, k8s_client)
                    logger.info(f"Current K8s job status: {current_status}")
                except ApiException as e:
                    if e.status == 404:
                        # Job was deleted (TTL cleanup)
                        logger.warning(f"Job {job_name} not found (deleted by TTL)")
                        await process_version.add_log_entry(db, "Job was cleaned up by Kubernetes TTL controller")
                        await log_manager.finalize_logs()
                        await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                        return
                    else:
                        raise

                # If job already completed, process it directly
                if current_status in ["succeeded", "failed"]:
                    logger.info(f"Job already completed with status: {current_status}")
                    await log_manager.finalize_logs()
                    await ProcessVersion._handle_job_completion(
                        process_version, process, job_name, current_status, db, logger, k8s_client
                    )
                    return

                # Wait for pod if still queued or starting (STARTING = pod coming up, e.g. on
                # backend restart mid-startup — resume waiting for the container to run).
                if process_version.state in [ProcessState.QUEUED, ProcessState.STARTING]:
                    logger.info(f"Job is queued/starting, waiting for pod to start")
                    pod_name = await ProcessVersion._wait_for_pod(
                        process_version, process, job_name, db, logger, log_manager, k8s_client
                    )

                    # Refresh process version state
                    await db.refresh(process_version)

                    # Check if job completed during wait
                    if process_version.state in [ProcessState.QUEUED, ProcessState.STARTING]:
                        final_status = await get_job_status(job_name, k8s_client)
                        if final_status in ["succeeded", "failed"]:
                            logger.info(f"Job completed during wait with status: {final_status}")
                            await log_manager.finalize_logs()
                            await ProcessVersion._handle_job_completion(
                                process_version, process, job_name, final_status, db, logger, k8s_client
                            )
                            return

                    # If pod started successfully, begin log retrieval
                    if pod_name and process_version.state == ProcessState.RUNNING:
                        await log_manager.start_retrieval()

                # Watch for completion using Kubernetes Watch API
                if process_version.state == ProcessState.RUNNING:
                    logger.info(f"Job is running, watching for completion")

                    # If not already retrieving logs (e.g., on restart), start now
                    if process_version.log_retrieval_state not in ["streaming", "complete"]:
                        await log_manager.start_retrieval()

                    # Use a bounded timeout so the watch never silently expires and leaves
                    # the process stuck at RUNNING. After each expiry we poll the actual job
                    # status before re-watching.
                    while True:
                        final_status = None
                        async for job in k8s_client.watch_job(job_name, timeout_seconds=300):
                            status = job.status
                            if status.succeeded:
                                final_status = "succeeded"
                                break
                            elif status.failed:
                                final_status = "failed"
                                break

                        if final_status:
                            await log_manager.finalize_logs()
                            await ProcessVersion._handle_job_completion(
                                process_version, process, job_name, final_status, db, logger, k8s_client
                            )
                            break

                        # Watch expired without a terminal event — poll before re-watching
                        try:
                            polled_status = await get_job_status(job_name, k8s_client)
                        except ApiException as e:
                            if e.status == 404:
                                logger.warning(f"Job {job_name} not found during poll (deleted by TTL)")
                                await process_version.add_log_entry(db, "Job was cleaned up by Kubernetes TTL controller")
                                await log_manager.finalize_logs()
                                await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                                break
                            raise

                        if polled_status in ["succeeded", "failed"]:
                            await log_manager.finalize_logs()
                            await ProcessVersion._handle_job_completion(
                                process_version, process, job_name, polled_status, db, logger, k8s_client
                            )
                            break

                        logger.info(f"Watch expired for {job_name}, job still running, re-watching")

        except Exception as e:
            logger.error(f"❌ Job monitoring error: {process_id} v{version} - {str(e)}", exc_info=True)
            try:
                # Finalize logs even on error
                await log_manager.finalize_logs()

                async with async_session_maker() as db:
                    stmt = select(ProcessVersion).options(
                        selectinload(ProcessVersion.process)
                    ).where(
                        ProcessVersion.process_id == process_id,
                        ProcessVersion.version == version
                    )
                    result = await db.execute(stmt)
                    process_version = result.scalar_one_or_none()
                    if process_version:
                        error_msg = f"Job monitoring failed: {type(e).__name__}: {str(e)}"
                        await process_version.add_log_entry(db, error_msg)
                        await process_version.update_state(db, ProcessState.FAILED, process_version.process.project_id)
            except Exception as inner_e:
                logger.error(f"Failed to update process state after monitoring error: {inner_e}", exc_info=True)

    @staticmethod
    async def _wait_for_pod(process_version: "ProcessVersion", process: "Process", job_name: str, db: AsyncSession, logger, log_manager, k8s_client):
        """Wait for pod to start and transition to RUNNING state.

        Uses LogManager for all log and event retrieval.

        Args:
            log_manager: LogManager instance for event/log retrieval
            k8s_client: K8sClient for the cluster this job was launched on

        Returns pod_name if successful, None otherwise.
        """
        from backend.services.job_orchestrator import get_job_status

        wait_start_time = datetime.utcnow()
        last_status_log_time = wait_start_time
        status_log_interval = 30
        pod_name = None

        while True:
            # Check for early completion
            early_status = await get_job_status(job_name, k8s_client)
            if early_status in ["succeeded", "failed"]:
                logger.info(f"Job completed quickly with status: {early_status}")
                return None  # Caller will handle completion

            # Check for pod
            pod = await k8s_client.get_pod_for_job(job_name)
            if pod:
                pod_name = pod.metadata.name

                # Retrieve job and pod events early
                await log_manager._retrieve_job_events(process_version, db)
                await log_manager._retrieve_pod_events(process_version, pod_name, db)

                # Check for pod-level errors (before container runs)
                has_error, error_msg = await k8s_client.get_pod_error_status(pod_name)
                if has_error:
                    logger.error(f"Pod error detected: {error_msg}")
                    await process_version.add_log_entry(db, f"ERROR: {error_msg}")

                    # CRITICAL: Retrieve actual container logs before failing
                    # The error_msg only contains Kubernetes metadata (exit code, reason)
                    # but not the actual stdout/stderr from the container
                    logger.info(f"Retrieving container logs for failed pod {pod_name}")
                    await log_manager._retrieve_historical_logs(process_version, pod_name, db)

                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return None

                # Pod exists with no pod-level error: it's coming up (scheduled / pulling image /
                # ContainerCreating) but its container isn't running yet. Move to STARTING and start
                # the billing clock here (from when the pod started coming up, not from submission).
                # Guarded so a re-observation doesn't reset the timestamp.
                if process_version.state == ProcessState.QUEUED:
                    if not process_version.started_at:
                        process_version.started_at = datetime.utcnow()
                    await process_version.update_state(db, ProcessState.STARTING, process.project_id)

                # Check if container is running
                if await k8s_client.is_pod_container_running(pod_name):
                    await process_version.update_state(db, ProcessState.RUNNING, process.project_id)
                    await process_version.add_log_entry(db, f"Pod {pod_name} started")
                    return pod_name
            else:
                # No pod yet - check for job-level errors
                has_job_error, job_error_msg = await k8s_client.get_job_error_status(job_name)
                if has_job_error:
                    logger.error(f"Job error detected: {job_error_msg}")
                    await process_version.add_log_entry(db, f"ERROR: {job_error_msg}")

                    # Retrieve job events
                    await log_manager._retrieve_job_events(process_version, db)

                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return None

            # Periodic status logging
            current_time = datetime.utcnow()
            if (current_time - last_status_log_time).total_seconds() >= status_log_interval:
                elapsed = int((current_time - wait_start_time).total_seconds())
                msg = f"Waiting for pod... ({elapsed}s elapsed)"
                logger.info(msg)
                await process_version.add_log_entry(db, msg)
                await db.commit()
                last_status_log_time = current_time

            await asyncio.sleep(5)


    @staticmethod
    async def _handle_job_completion(
        process_version: "ProcessVersion",
        process: "Process",
        job_name: str,
        status: str,
        db: AsyncSession,
        logger,
        k8s_client
    ):
        """Handle job completion (success or failure).

        NOTE: Log retrieval is handled by LogManager before this is called.
        This method only handles costs, transactions, outputs, and state updates.

        Args:
            k8s_client: K8sClient for the cluster this job was launched on
        """
        from sqlalchemy.orm import selectinload

        # Set completed_at if not already set
        if not process_version.completed_at:
            process_version.completed_at = datetime.utcnow()

        # Calculate runtime
        if process_version.started_at:
            runtime_seconds = (process_version.completed_at - process_version.started_at).total_seconds()
        else:
            runtime_seconds = 0

        # Check if job hit deadline (timeout)
        has_error, error_msg = await k8s_client.get_job_error_status(job_name)
        if has_error and "deadline" in error_msg.lower():
            await process_version.add_log_entry(db, f"Job timed out: {error_msg}")
            status = "failed"  # Ensure timeout is treated as failure

        # Billing: release hold + charge actual cost via hook
        from backend.hooks import hooks
        await hooks.run_async.job_completed(db, process, process_version, runtime_seconds, status)
        await db.commit()

        if status == "succeeded":
            await process_version.add_log_entry(db, f"Process completed in {runtime_seconds:.1f}s")

            # Create output datasets (skip if already exist - recovery case)
            if not process_version.datasets:
                try:
                    await process_version._create_outputs(db, process, process_version)
                except Exception as e:
                    logger.warning(f"Could not create outputs (may already exist): {e}")
                    # Continue anyway - datasets may have been created in a previous attempt

            # Re-query with datasets loaded
            stmt = select(ProcessVersion).options(
                selectinload(ProcessVersion.datasets)
            ).where(
                ProcessVersion.id == process_version.id
            )
            result = await db.execute(stmt)
            process_version = result.scalar_one()

            await process_version.update_state(db, ProcessState.DONE, process.project_id)
            logger.info(f"✅ Process completed: {process_version.process_id} v{process_version.version}")

        else:  # failed
            await process_version.add_log_entry(db, f"Process failed after {runtime_seconds:.1f}s")
            await process_version.update_state(db, ProcessState.FAILED, process.project_id)
            logger.error(f"❌ Process failed: {process_version.process_id} v{process_version.version}")

    async def run_task(self, username: str):
        """Check balance, resolve dependencies, create K8s job, and monitor it.

        Runs entirely in the background after create_queued() returns the HTTP response.
        On any failure (including insufficient balance) the process state becomes FAILED.
        """
        from backend.services.job_orchestrator import create_job
        from backend.database import async_session_maker
        import logging

        logger = logging.getLogger(__name__)
        logger.info(f"🚀 Starting background task: {self.process_id} v{self.version}")

        try:
            async with async_session_maker() as db:
                from sqlalchemy.orm import selectinload
                from backend.models import Dataset, Environment, User
                from backend.config import settings

                # Fetch process version
                stmt = select(ProcessVersion).options(
                    selectinload(ProcessVersion.datasets)
                ).where(
                    ProcessVersion.process_id == self.process_id,
                    ProcessVersion.version == self.version
                )
                result = await db.execute(stmt)
                process_version = result.scalar_one_or_none()

                if not process_version:
                    logger.error(f"Process version not found: {self.process_id} v{self.version}")
                    return

                # Fetch process
                stmt = select(Process).where(Process.id == self.process_id)
                result = await db.execute(stmt)
                process = result.scalar_one_or_none()

                if not process:
                    logger.error(f"Process not found: {self.process_id}")
                    return

                # --- Balance check (via billing hook) ---
                stmt = select(User).where(User.username == username)
                result = await db.execute(stmt)
                user = result.scalar_one_or_none()

                if not user:
                    await process_version.add_log_entry(db, "ERROR: User not found")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                from backend.hooks import hooks
                from backend.exceptions import UserError
                try:
                    await hooks.run_async.job_pre_run(db, user, process, process_version)
                except UserError as e:
                    await process_version.add_log_entry(db, f"ERROR: {e}")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return
                except Exception as e:
                    logger.error(f"Unexpected error in job_pre_run hook: {e}", exc_info=True)
                    await process_version.add_log_entry(db, f"Internal error in job_pre_run: {e}")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                # --- Resolve cluster for this job ---
                # Cluster choice was already made and validated at process-creation time (see
                # docs/plans/multi-cluster-selection.md) — process_version.k8s_cluster_id is set.
                from backend.models.cluster import get_cluster_for_process_version
                cluster = await get_cluster_for_process_version(db, process_version)

                # --- Resolve dependencies ---
                # Parameters are stored as storage URLs (s3://...) but extract_dependencies
                # looks for HTTP URL patterns — translate back before extraction.
                from backend.services.storage_service import translate_urls_in_dict as _translate_urls
                http_params = _translate_urls(process_version.parameters, to_storage=False)
                raw_dependencies = Process.extract_dependencies(http_params)
                dependencies = await Dataset.resolve_dependencies(db, raw_dependencies)
                process_version.dependencies = dependencies

                # Broadcast so the frontend refreshes and shows the resolved dependency edges
                from backend.services.websocket_service import ws_manager
                await ws_manager.broadcast_state({
                    "process_id": process.id,
                    "version": process_version.version,
                    "state": ProcessState.QUEUED.value
                })

                # --- Ensure storage credentials are ready before job launch ---
                from backend.services.storage_credentials import ensure_ready, get_strategy
                from backend.services.storage_protocols import get_protocol_handler
                from backend.models.project import Project
                from backend.models.storage_backend import StorageBackend
                stmt = select(Project).where(Project.id == process.project_id)
                result = await db.execute(stmt)
                project = result.scalar_one_or_none()
                if not project or not project.storage_backend_id:
                    await process_version.add_log_entry(db, "ERROR: Project has no storage backend assigned")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return
                await ensure_ready(db, project)

                stmt = select(StorageBackend).where(StorageBackend.id == project.storage_backend_id)
                result = await db.execute(stmt)
                storage_backend = result.scalar_one_or_none()
                if not storage_backend:
                    await process_version.add_log_entry(db, "ERROR: Storage backend not found")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                # --- Resolve the project's storage addressing via its StorageBackend's handler ---
                # The handler is the single addressing authority (docs/plans/per-project-storage-
                # routing.md): it produces the <scheme>://<bucket> base and the fsspec kwargs. The
                # pod receives **project-scoped** credentials only — never the backend's admin creds.
                handler = get_protocol_handler(storage_backend.protocol)
                storage_base = handler.storage_base_url(project, storage_backend)

                # --- Mint per-job credentials for short-lived backends ---
                # static-key (the default) hands the pod the persistent project-scoped credential.
                # short-lived mints a fresh credential for this job specifically and hands the runner
                # an opaque refresh token so it can re-mint via /internal/.../storage-credentials/
                # refresh as the job runs — see docs/plans/done/short-lived-storage-credentials-04-
                # runner-refresh-loop.md.
                credential_strategy = storage_backend.credential_strategy
                job_expires_at = None
                refresh_token = None
                if credential_strategy == "short-lived":
                    import secrets
                    import hashlib

                    strategy = get_strategy(credential_strategy)
                    mint_result = await asyncio.to_thread(strategy.mint, project, storage_backend)
                    project_scoped_creds = mint_result["credentials"]
                    job_expires_at = mint_result["expires_at"]

                    refresh_token = secrets.token_urlsafe(32)
                    process_version.refresh_token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
                else:
                    project_scoped_creds = {
                        "access_key": project.storage_access_key,
                        "secret_key": project.storage_secret_key,
                    }

                storage_kwargs = handler.fsspec_kwargs(storage_backend, project_scoped_creds)

                # --- Resolve registry pull credentials for the Job's own image ---
                # Mirrors the storage-backend resolution above, for the third pluggable-backend
                # axis (docs/plans/registry-backend-hooks.md). Design decision 4: mint a per-Job
                # pull credential here, at Job-creation time, rather than relying on a long-lived
                # synced Secret — job_orchestrator.create_job() creates an ephemeral
                # dockerconfigjson Secret from this value, owned by the Job so it's garbage
                # collected alongside it.
                from backend.models.registry_backend import RegistryBackend
                from backend.services.registry_protocols import get_registry_protocol_handler
                stmt = select(RegistryBackend).where(RegistryBackend.active == True).order_by(RegistryBackend.sort_order)
                result = await db.execute(stmt)
                registry_backend = result.scalars().first()
                if not registry_backend:
                    await process_version.add_log_entry(db, "ERROR: No active registry backend configured")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                registry_handler = get_registry_protocol_handler(registry_backend.protocol)
                registry_pull_credentials = await registry_handler.pull_credentials(registry_backend.config)

                # --- Create K8s job ---
                stmt = select(Environment).where(Environment.id == process.environment_id)
                result = await db.execute(stmt)
                environment = result.scalar_one_or_none()

                if not environment:
                    await process_version.add_log_entry(db, "ERROR: Environment not found")
                    await process_version.update_state(db, ProcessState.FAILED, process.project_id)
                    return

                # NOTE: started_at (the billing clock) is set at the STARTING transition in
                # _wait_for_pod — when the pod starts coming up — NOT here at submission, so
                # queue-wait time is not billed. A job that fails before any pod exists keeps
                # started_at=None → runtime_seconds=0 (see _handle_job_completion).
                job_name = await create_job(
                    docker_image=environment.docker_image,
                    process_id=process_version.process_id,
                    version=process_version.version,
                    process_type=process.type,
                    parameters=process_version.parameters,
                    resource_requests=process_version.resource_requests,
                    deadline_seconds=process_version.deadline_seconds,
                    project_id=process.project_id,
                    cluster=cluster,
                    storage_base=storage_base,
                    storage_kwargs=storage_kwargs,
                    registry_pull_credentials=registry_pull_credentials,
                    credential_strategy=credential_strategy,
                    expires_at=job_expires_at,
                    refresh_token=refresh_token
                )
                process_version.k8s_job_name = job_name
                process_version.k8s_namespace = cluster.namespace
                await db.commit()

                logger.info(f"▶️ K8s job created: {job_name}")
                await process_version.add_log_entry(db, f"K8s job created: {process_version.k8s_namespace}.{process_version.k8s_job_name}")

            # Delegate monitoring to monitor_job (resumable on backend restart)
            await ProcessVersion.monitor_job(self.process_id, self.version)

        except Exception as e:
            logger.error(f"❌ Process task error: {self.process_id} v{self.version} - {str(e)}", exc_info=True)
            try:
                async with async_session_maker() as db:
                    stmt = select(ProcessVersion).options(
                        selectinload(ProcessVersion.process)
                    ).where(
                        ProcessVersion.process_id == self.process_id,
                        ProcessVersion.version == self.version
                    )
                    result = await db.execute(stmt)
                    process_version = result.scalar_one_or_none()
                    if process_version:
                        await process_version.add_log_entry(db, f"Error: {str(e)}")
                        project_id = process_version.process.project_id if process_version.process else None
                        await process_version.update_state(db, ProcessState.FAILED, project_id)
            except Exception as inner_e:
                logger.error(f"Failed to update process state after task error: {inner_e}", exc_info=True)


    async def _create_outputs(self, db: AsyncSession, process: "Process", process_version: "ProcessVersion"):
        """Create output dataset records by reading info.json from storage bucket.

        Scans the storage bucket for datasets written by the pod and creates
        database records for each one found by reading their info.json files.

        Args:
            db: Database session
            process: Process object
            process_version: ProcessVersion object
        """
        from backend.models import Dataset
        from backend.services.storage_service import get_storage_base_url, get_fsspec_storage_options
        import fsspec
        import json
        import logging

        logger = logging.getLogger(__name__)

        # Build storage path to scan for datasets
        storage_base = await get_storage_base_url(db, process.project_id)
        datasets_prefix = f"{storage_base}/processes/{process.id}/{process_version.version}/datasets/"

        logger.info(f"Scanning storage for datasets at: {datasets_prefix}")

        # Get fsspec filesystem (backend-side admin credentials)
        storage_options = await get_fsspec_storage_options(db, process.project_id)
        fs = fsspec.filesystem(storage_base.split('://')[0], **storage_options)

        # Extract bucket and prefix path
        # Format: s3://bucket/processes/{id}/{version}/datasets/
        bucket_and_path = datasets_prefix.split('://', 1)[1]

        try:
            # List all directories under datasets/
            # This will give us paths like: bucket/processes/{id}/{version}/datasets/{dataset_id}/
            items = fs.ls(bucket_and_path, detail=True)

            # Filter for directories (dataset IDs)
            dataset_dirs = [item for item in items if item.get('type') == 'directory']

            logger.info(f"Found {len(dataset_dirs)} dataset directories")

            for dir_info in dataset_dirs:
                # Extract dataset_id from path
                # Path format: bucket/processes/{proc_id}/{version}/datasets/{dataset_id}
                dataset_id = dir_info['name'].split('/')[-1]

                # Read info.json from this dataset directory
                info_json_path = f"{dir_info['name']}/info.json"

                try:
                    logger.info(f"Reading info.json for dataset {dataset_id}")
                    with fs.open(info_json_path, 'r') as f:
                        info = json.load(f)

                    # Extract fields from info.json
                    dataset_name = info.get('dataset_name')
                    mime_type = info.get('mime_type')

                    # Get the parts structure - could be old or new format
                    # New format has: files={...}, parts={...}
                    # Old format has: ""={...}, part_name={...}
                    # We need to store both in the parts column for new format
                    parts = info.get('parts', {})
                    files = info.get('files')

                    # If new format, combine files and parts into one structure
                    if files is not None:
                        parts_data = {"files": files, "parts": parts}
                    else:
                        parts_data = parts

                    logger.info(f"Processing dataset {dataset_id} as '{dataset_name}'")

                    # Check if dataset already exists (recovery case)
                    stmt = select(Dataset).where(Dataset.id == dataset_id)
                    result = await db.execute(stmt)
                    existing_dataset = result.scalar_one_or_none()

                    if existing_dataset:
                        logger.info(f"Dataset {dataset_id} already exists, skipping")
                        continue

                    # Create Dataset record
                    dataset = Dataset(
                        id=dataset_id,
                        mime_type=mime_type,
                        process_id=process.id,
                        process_name=process.name,
                        process_version_id=process_version.id,
                        dataset_name=dataset_name,
                        project_id=process.project_id,
                        parts=parts_data
                    )

                    db.add(dataset)

                    logger.info(f"Created dataset record: {dataset_id} -> {dataset_name}")

                except FileNotFoundError:
                    error_msg = f"info.json not found for dataset directory: {dataset_id}"
                    logger.warning(error_msg)
                    await process_version.add_log_entry(db, error_msg)
                except json.JSONDecodeError as e:
                    import traceback
                    error_msg = f"Failed to parse info.json for dataset {dataset_id}: {str(e)}"
                    logger.error(error_msg)
                    await process_version.add_log_entry(db, error_msg)
                    await process_version.add_log_entry(db, "=== Traceback ===")
                    for line in traceback.format_exc().split('\n'):
                        if line.strip():
                            await process_version.add_log_entry(db, line)
                    await process_version.add_log_entry(db, "=== End of traceback ===")
                except Exception as e:
                    import traceback
                    error_msg = f"Error processing dataset {dataset_id}: {str(e)}"
                    logger.error(error_msg, exc_info=True)
                    await process_version.add_log_entry(db, error_msg)
                    await process_version.add_log_entry(db, "=== Traceback ===")
                    for line in traceback.format_exc().split('\n'):
                        if line.strip():
                            await process_version.add_log_entry(db, line)
                    await process_version.add_log_entry(db, "=== End of traceback ===")

            await db.commit()
            logger.info(f"Successfully created dataset records")

        except Exception as e:
            import traceback
            error_msg = f"Error scanning storage for datasets: {str(e)}"
            logger.error(error_msg, exc_info=True)
            await process_version.add_log_entry(db, error_msg)
            await process_version.add_log_entry(db, "=== Traceback ===")
            for line in traceback.format_exc().split('\n'):
                if line.strip():
                    await process_version.add_log_entry(db, line)
            await process_version.add_log_entry(db, "=== End of traceback ===")
            # If scanning fails, continue without failing the whole process
            pass

        # Check for environment.json (created by create_environment process)
        try:
            env_json_path = f"{storage_base}/processes/{process.id}/environment.json".split('://', 1)[1]
            logger.info(f"Checking for environment.json at: {env_json_path}")

            with fs.open(env_json_path, 'r') as f:
                env_info = json.load(f)

            logger.info(f"Found environment.json, creating environment: {env_info['name']}")

            # Create environment record
            from backend.models import Environment

            environment = Environment(
                name=env_info['name'],
                docker_image=env_info['docker_image'],
                process_id=env_info['process_id'],
                process_types=env_info.get('process_types', {}),
                # Attribution for the admin stats dashboard — inherit the creating process's user.
                created_by=process.created_by,
            )

            db.add(environment)
            await db.commit()

            logger.info(f"✓ Environment created: {environment.id} -> {env_info['docker_image']}")
            logger.info(f"  Process types: {list(env_info.get('process_types', {}).keys())}")

        except FileNotFoundError:
            # No environment.json - this is normal for non-create_environment processes
            logger.debug(f"No environment.json found (this is normal for most processes)")
        except Exception as e:
            import traceback
            error_msg = f"Error creating environment from environment.json: {str(e)}"
            logger.error(error_msg, exc_info=True)
            await process_version.add_log_entry(db, error_msg)
            await process_version.add_log_entry(db, "=== Traceback ===")
            for line in traceback.format_exc().split('\n'):
                if line.strip():
                    await process_version.add_log_entry(db, line)
            await process_version.add_log_entry(db, "=== End of traceback ===")
            # Continue without failing the whole process
            pass

        # Check for plugin.json (created by build_frontend_plugin process) — auto-register the
        # built MF remote as a Plugin/PluginVersion, mirroring the environment.json handling above.
        try:
            plugin_json_path = f"{storage_base}/processes/{process.id}/plugin.json".split('://', 1)[1]
            logger.info(f"Checking for plugin.json at: {plugin_json_path}")

            with fs.open(plugin_json_path, 'r') as f:
                plugin_info = json.load(f)

            logger.info(f"Found plugin.json, registering plugin: {plugin_info.get('remote_name')}")

            from backend.services.plugin_registration import register_built_plugin
            await register_built_plugin(db, process, process_version, plugin_info)

        except FileNotFoundError:
            # No plugin.json - normal for non-plugin builds
            logger.debug(f"No plugin.json found (this is normal for most processes)")
        except Exception as e:
            import traceback
            error_msg = f"Error registering plugin from plugin.json: {str(e)}"
            logger.error(error_msg, exc_info=True)
            await process_version.add_log_entry(db, error_msg)
            await process_version.add_log_entry(db, "=== Traceback ===")
            for line in traceback.format_exc().split('\n'):
                if line.strip():
                    await process_version.add_log_entry(db, line)
            await process_version.add_log_entry(db, "=== End of traceback ===")
            # Continue without failing the whole process
            pass


class ProcessLog(Base):
    __tablename__ = "process_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    process_id = Column(String(255), ForeignKey("processes.id", ondelete="CASCADE"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    message = Column(Text, nullable=False)

    # Relationships
    process = relationship("Process", back_populates="logs")

    # Composite index for efficient log retrieval
    __table_args__ = (
        Index('ix_process_log_lookup', 'process_id', 'version', 'timestamp'),
    )

    def to_dict(self):
        """Convert to API response format"""
        return {
            "timestamp": self.timestamp.isoformat(),
            "message": self.message
        }

    @classmethod
    async def add_entry(cls, db: AsyncSession, process_id: str, version: int, message: str):
        """Add a log entry and broadcast to connected clients"""
        from backend.services.websocket_service import ws_manager

        log_entry = cls(
            process_id=process_id,
            version=version,
            timestamp=datetime.utcnow(),
            message=message
        )

        db.add(log_entry)
        await db.commit()

        # Broadcast to connected WebSocket clients
        await ws_manager.broadcast_log(process_id, log_entry.to_dict())

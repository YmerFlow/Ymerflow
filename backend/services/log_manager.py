"""Log Manager - Unified log retrieval for Kubernetes jobs"""

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Optional, Set

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session_maker
from backend.models.process import ProcessVersion, ProcessLog, Process
from backend.services.k8s_client import k8s_clients, API_REQUEST_TIMEOUT_SECONDS
from backend.models.cluster import get_cluster_for_process_version

logger = logging.getLogger(__name__)


class LogRetrievalState:
    """Log retrieval states"""
    NOT_STARTED = "not_started"
    STREAMING = "streaming"
    STREAM_ENDED = "stream_ended"
    HISTORICAL = "historical"
    COMPLETE = "complete"
    UNAVAILABLE = "unavailable"


class LogManager:
    """Manages log retrieval lifecycle for a process version"""

    def __init__(self, process_id: str, version: int):
        self.process_id = process_id
        self.version = version
        self.stream_task: Optional[asyncio.Task] = None
        self.events_retrieved: Set[str] = set()
        self._checkpoint_counter = 0
        self._last_checkpoint_time = datetime.utcnow()
        self._k8s_client = None  # resolved lazily, cached — a job's cluster never changes

    async def _get_k8s_client(self, pv: ProcessVersion, db: AsyncSession):
        if self._k8s_client is None:
            cluster = await get_cluster_for_process_version(db, pv)
            self._k8s_client = k8s_clients.get(cluster)
        return self._k8s_client

    async def _get_process_version(self, db: AsyncSession) -> ProcessVersion:
        """Fetch process version with relationships loaded"""
        from sqlalchemy.orm import selectinload

        stmt = select(ProcessVersion).options(
            selectinload(ProcessVersion.process)
        ).where(
            ProcessVersion.process_id == self.process_id,
            ProcessVersion.version == self.version
        )
        result = await db.execute(stmt)
        return result.scalar_one()

    async def start_retrieval(self):
        """Main entry point - called once when pod is available"""
        async with async_session_maker() as db:
            pv = await self._get_process_version(db)

            # Check current state
            if pv.log_retrieval_state == LogRetrievalState.COMPLETE:
                logger.info(f"Logs already complete for {self.process_id} v{self.version}")
                return  # Already done

            if pv.log_retrieval_state == LogRetrievalState.STREAMING:
                # Resume from checkpoint (backend restart case)
                logger.info(f"Resuming log streaming for {self.process_id} v{self.version}")
                await self._resume_streaming(pv, db)
            else:
                # Start fresh
                logger.info(f"Starting new log retrieval for {self.process_id} v{self.version}")
                await self._start_new_retrieval(pv, db)

    async def _start_new_retrieval(self, pv: ProcessVersion, db: AsyncSession):
        """Start log retrieval for the first time"""
        if not pv.k8s_job_name:
            logger.warning(f"No K8s job name for {self.process_id} v{self.version}")
            return

        client = await self._get_k8s_client(pv, db)
        # End the read transaction before the K8s call; writes below re-open and commit.
        await db.commit()
        pod = await client.get_pod_for_job(pv.k8s_job_name)

        if not pod:
            # No pod yet - wait for it
            pv.log_retrieval_state = LogRetrievalState.NOT_STARTED
            await db.commit()
            logger.info(f"No pod yet for job {pv.k8s_job_name}")
            return

        pod_name = pod.metadata.name
        logger.info(f"Found pod {pod_name} for job {pv.k8s_job_name}")

        # Retrieve job-level events FIRST (before pod starts)
        await self._retrieve_job_events(pv, db)

        # Check if container is running
        if await client.is_pod_container_running(pod_name):
            # Container running - start streaming
            logger.info(f"Container running, starting log stream for pod {pod_name}")
            await self._start_streaming(pv, pod_name, db)
        else:
            # Container not running yet or already terminated
            container_status = await self._get_container_status(pod_name, client)
            logger.info(f"Container status: {container_status}")

            if container_status == "waiting":
                # Waiting to start (image pull, etc.)
                await self._retrieve_pod_events(pv, pod_name, db)
                pv.log_retrieval_state = LogRetrievalState.NOT_STARTED
            elif container_status == "terminated":
                # Already finished - retrieve historical logs
                logger.info(f"Container already terminated, retrieving historical logs")
                await self._retrieve_historical_logs(pv, pod_name, db)

        await db.commit()

    async def _get_container_status(self, pod_name: str, client) -> str:
        """Get container status: waiting, running, or terminated"""
        try:
            pod = await client.core_api.read_namespaced_pod(pod_name, client.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
            if pod.status.container_statuses:
                for container_status in pod.status.container_statuses:
                    if container_status.state.waiting:
                        return "waiting"
                    elif container_status.state.running:
                        return "running"
                    elif container_status.state.terminated:
                        return "terminated"
            return "unknown"
        except Exception as e:
            logger.error(f"Error getting container status: {e}")
            return "unknown"

    async def _start_streaming(self, pv: ProcessVersion, pod_name: str, db: AsyncSession):
        """Start streaming logs from running container"""
        pv.log_retrieval_state = LogRetrievalState.STREAMING
        pv.log_stream_position = datetime.utcnow().isoformat()
        await db.commit()

        # Start streaming task (non-blocking)
        self.stream_task = asyncio.create_task(
            self._stream_logs(pod_name)
        )

    async def _stream_logs(self, pod_name: str):
        """Stream logs with checkpoint tracking"""
        pending = []  # (message, timestamp) buffered since the last checkpoint flush
        try:
            since_time = None
            async with async_session_maker() as db:
                pv = await self._get_process_version(db)
                if pv.log_stream_position:
                    since_time = pv.log_stream_position
                client = await self._get_k8s_client(pv, db)

            logger.info(f"Starting log stream for pod {pod_name}, since_time={since_time}")

            # Stream with sinceTime for resume capability
            log_stream = await client.stream_pod_logs(
                pod_name,
                since_time=since_time
            )

            # The DB session object is held open for the whole stream, but — crucially — NO SQL is
            # emitted between checkpoints, so no transaction (and thus no pooled connection) is held
            # while the `async for` awaits the next line. Lines are buffered in a Python list and
            # persisted in a batch only at each checkpoint, where the transaction opens, commits,
            # and closes. Each line is still broadcast live as it arrives (broadcast needs no DB).
            # See docs/plans/done/db-pool-commit-before-k8s-io.md.
            from backend.services.websocket_service import ws_manager

            async with async_session_maker() as db:
                pv = await self._get_process_version(db)
                # pv was just loaded; end that read transaction so nothing is held while buffering.
                await db.commit()

                async def _flush():
                    """Persist buffered lines + advance the checkpoint, in one short transaction."""
                    if not pending:
                        return
                    last_ts = None
                    for msg, ts in pending:
                        await self._add_log_deduplicated(pv, db, msg, ts, broadcast=False)
                        last_ts = ts
                    if last_ts is not None:
                        pv.log_stream_position = last_ts.isoformat()
                        pv.log_last_timestamp = last_ts
                    await db.commit()
                    pending.clear()

                async for line in log_stream.content:
                    log_line = line.decode('utf-8').strip()
                    if not log_line:
                        continue

                    timestamp = datetime.utcnow()

                    # Broadcast live (no DB); persistence is batched below.
                    await ws_manager.broadcast_log(
                        pv.process_id, {"timestamp": timestamp.isoformat(), "message": log_line}
                    )
                    pending.append((log_line, timestamp))
                    self._checkpoint_counter += 1

                    # Flush periodically (every N logs or time interval)
                    if self._should_checkpoint():
                        await _flush()
                        self._checkpoint_counter = 0
                        self._last_checkpoint_time = datetime.utcnow()

                # Stream ended naturally
                logger.info(f"Log stream ended for pod {pod_name}")
                await _flush()
                pv.log_retrieval_state = LogRetrievalState.STREAM_ENDED
                await db.commit()

        except asyncio.CancelledError:
            logger.info(f"Log stream cancelled for pod {pod_name}")
            raise
        except Exception as e:
            logger.error(f"Stream error for pod {pod_name}: {e}", exc_info=True)
            async with async_session_maker() as db:
                pv = await self._get_process_version(db)
                # Persist whatever was buffered but not yet flushed (already broadcast live), then
                # the interruption warning. Keep state STREAMING so it can be resumed.
                for msg, ts in pending:
                    await self._add_log_deduplicated(pv, db, msg, ts, broadcast=False)
                await self._add_log_deduplicated(
                    pv, db, f"WARNING: Log stream interrupted: {e}", datetime.utcnow()
                )
                await db.commit()

    async def _resume_streaming(self, pv: ProcessVersion, db: AsyncSession):
        """Resume streaming after backend restart"""
        if not pv.k8s_job_name:
            logger.warning(f"No K8s job name for resuming {self.process_id} v{self.version}")
            return

        client = await self._get_k8s_client(pv, db)
        # End the read transaction before the K8s call; writes below re-open and commit.
        await db.commit()
        pod = await client.get_pod_for_job(pv.k8s_job_name)

        if not pod:
            # Pod deleted - switch to historical or unavailable
            logger.warning(f"Pod deleted for job {pv.k8s_job_name}")
            await self._handle_pod_deleted(pv, db)
            return

        pod_name = pod.metadata.name

        # Check if container still running
        if await client.is_pod_container_running(pod_name):
            # Still running - resume stream from checkpoint
            logger.info(f"Resuming stream from checkpoint for pod {pod_name}")
            await self._start_streaming(pv, pod_name, db)
        else:
            # Container terminated - retrieve remaining logs
            logger.info(f"Container terminated, retrieving remaining logs for pod {pod_name}")
            await self._retrieve_historical_logs(pv, pod_name, db)

    async def finalize_logs(self):
        """Called when job reaches terminal state"""
        logger.info(f"Finalizing logs for {self.process_id} v{self.version}")

        async with async_session_maker() as db:
            pv = await self._get_process_version(db)

            # Stop streaming if active
            if self.stream_task and not self.stream_task.done():
                logger.info(f"Cancelling active stream task")
                self.stream_task.cancel()
                try:
                    await self.stream_task
                except asyncio.CancelledError:
                    pass

            # Retrieve any remaining logs
            if not pv.k8s_job_name:
                logger.warning(f"No K8s job name for finalization")
                pv.log_retrieval_state = LogRetrievalState.UNAVAILABLE
                await db.commit()
                return

            client = await self._get_k8s_client(pv, db)
            # End the read transaction (pv fetch + possible cluster SELECT) before the K8s calls
            # below; the sub-helpers and the COMPLETE-state write re-open and commit as needed.
            await db.commit()
            pod = await client.get_pod_for_job(pv.k8s_job_name)
            if pod:
                pod_name = pod.metadata.name
                logger.info(f"Retrieving final logs from pod {pod_name}")

                # Get final logs that came after stream ended
                await self._retrieve_historical_logs(
                    pv, pod_name, db,
                    since_time=pv.log_stream_position
                )

                # Get final pod events
                await self._retrieve_pod_events(pv, pod_name, db)
            else:
                logger.warning(f"Pod not found for job {pv.k8s_job_name}")
                await self._handle_pod_deleted(pv, db)

            pv.log_retrieval_state = LogRetrievalState.COMPLETE
            await db.commit()
            logger.info(f"Log retrieval complete for {self.process_id} v{self.version}")

    async def _retrieve_historical_logs(self, pv: ProcessVersion, pod_name: str, db: AsyncSession, since_time: Optional[str] = None):
        """Retrieve logs from terminated/stopped container"""
        # Resolve the client (may SELECT the cluster on first use) and set state in one
        # transaction, then commit so nothing is held across the K8s log fetch below. See
        # docs/plans/done/db-pool-commit-before-k8s-io.md.
        client = await self._get_k8s_client(pv, db)
        pv.log_retrieval_state = LogRetrievalState.HISTORICAL
        await db.commit()

        logger.info(f"Retrieving historical logs from pod {pod_name}, since_time={since_time}")

        # Retry logic
        for attempt in range(3):
            try:
                if attempt > 0:
                    await asyncio.sleep(2.0)

                # Get logs with optional since_time
                logs = await client.get_pod_logs(
                    pod_name,
                    since_time=since_time
                )

                if logs:
                    lines = logs.split('\n')
                    logger.info(f"Retrieved {len(lines)} log lines from pod {pod_name}")

                    for line in lines:
                        if line.strip():
                            await self._add_log_deduplicated(
                                pv, db, line, datetime.utcnow()
                            )

                    await db.commit()
                    return True
                else:
                    logger.warning(f"No logs retrieved from pod {pod_name} on attempt {attempt + 1}")

            except Exception as e:
                logger.warning(f"Historical log retrieval attempt {attempt + 1} failed: {e}")

        # Failed to retrieve
        await self._add_log_deduplicated(
            pv, db,
            "WARNING: Could not retrieve historical logs after 3 attempts",
            datetime.utcnow()
        )
        await db.commit()
        return False

    async def _retrieve_job_events(self, pv: ProcessVersion, db: AsyncSession):
        """Retrieve job-level events (quota, scheduling, etc.)"""
        if not pv.k8s_job_name:
            return

        logger.info(f"Retrieving job events for {pv.k8s_job_name}")
        client = await self._get_k8s_client(pv, db)
        # End any read transaction (client resolution may SELECT the cluster) before the K8s fetch.
        await db.commit()
        events = await client.get_job_events(pv.k8s_job_name)

        for event in events:
            event_id = self._event_id(event)
            if event_id not in self.events_retrieved:
                await self._add_log_deduplicated(
                    pv, db, f"[JOB EVENT] {event}", datetime.utcnow()
                )
                self.events_retrieved.add(event_id)

        await db.commit()

    async def _retrieve_pod_events(self, pv: ProcessVersion, pod_name: str, db: AsyncSession):
        """Retrieve pod-level events (image pull, container errors, etc.)"""
        logger.info(f"Retrieving pod events for {pod_name}")
        client = await self._get_k8s_client(pv, db)
        # End any read transaction (client resolution may SELECT the cluster) before the K8s fetch.
        await db.commit()
        events = await client.get_pod_events(pod_name)

        for event in events:
            event_id = self._event_id(event)
            if event_id not in self.events_retrieved:
                await self._add_log_deduplicated(
                    pv, db, f"[POD EVENT] {event}", datetime.utcnow()
                )
                self.events_retrieved.add(event_id)

        await db.commit()

    async def _handle_pod_deleted(self, pv: ProcessVersion, db: AsyncSession):
        """Handle case where pod was deleted by TTL"""
        await self._add_log_deduplicated(
            pv, db,
            "WARNING: Pod deleted by TTL controller - logs may be incomplete",
            datetime.utcnow()
        )
        pv.log_retrieval_state = LogRetrievalState.UNAVAILABLE
        await db.commit()

    async def _add_log_deduplicated(self, pv: ProcessVersion, db: AsyncSession, message: str, timestamp: datetime, broadcast: bool = True):
        """Add log with deduplication.

        broadcast=False suppresses the WebSocket fan-out — used by the streaming flush, which
        broadcasts each line live as it arrives and only persists (in batches) at checkpoints.
        """
        # Check if exact message already exists (within 1 second window)
        stmt = select(ProcessLog).where(
            ProcessLog.process_id == pv.process_id,
            ProcessLog.version == pv.version,
            ProcessLog.message == message,
            ProcessLog.timestamp >= timestamp - timedelta(seconds=1),
            ProcessLog.timestamp <= timestamp + timedelta(seconds=1)
        ).limit(1)

        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()

        if existing:
            # Duplicate - skip
            return

        # Add new log
        log_entry = ProcessLog(
            process_id=pv.process_id,
            version=pv.version,
            timestamp=timestamp,
            message=message
        )
        db.add(log_entry)

        # Broadcast to WebSocket (existing code)
        if broadcast:
            from backend.services.websocket_service import ws_manager
            await ws_manager.broadcast_log(pv.process_id, log_entry.to_dict())

    def _event_id(self, event_message: str) -> str:
        """Generate unique ID for event (for deduplication)"""
        return hashlib.md5(event_message.encode()).hexdigest()

    def _should_checkpoint(self) -> bool:
        """Decide when to commit checkpoint (every 10 logs or 5 seconds)"""
        time_elapsed = (datetime.utcnow() - self._last_checkpoint_time).total_seconds()
        return self._checkpoint_counter >= 10 or time_elapsed >= 5

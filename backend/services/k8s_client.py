from kubernetes_asyncio import client, config, watch
import aiohttp
import os
import asyncio
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Bounds every K8s API call so a retired/torn-down cluster (active=False — see
# docs/plans/multi-cluster-selection.md) fails fast with a clear timeout error instead of
# hanging the request/background task forever (per CLAUDE.md's hung-process guidance).
API_REQUEST_TIMEOUT_SECONDS = 30
# For long-lived streaming calls (follow=True log stream, job watch) a total timeout would
# kill a healthy, actively-streaming connection — only bound connection establishment there.
CONNECT_TIMEOUT = aiohttp.ClientTimeout(connect=10, sock_connect=10)


def _parse_cpu_cores(value: str) -> float:
    """Parse a Kubernetes CPU quantity string to cores (float)."""
    value = value.strip()
    if value.endswith('m'):
        return int(value[:-1]) / 1000.0
    return float(value)


def _parse_memory_gb(value: str) -> float:
    """Parse a Kubernetes memory quantity string to GiB (float), treating Gi == GB for UI purposes."""
    value = value.strip()
    if value.endswith('Gi'):
        return float(value[:-2])
    if value.endswith('G'):
        return float(value[:-1])
    if value.endswith('Mi'):
        return float(value[:-2]) / 1024.0
    if value.endswith('M'):
        return float(value[:-1]) / 1000.0
    if value.endswith('Ki'):
        return float(value[:-2]) / (1024.0 ** 2)
    return float(value) / (1024.0 ** 3)


def classify_workload(wl: dict) -> dict:
    """Derive the queue-relevant facts from a raw Kueue Workload dict.

    Returns:
      admitted        - True once Kueue has admitted the workload (running), else False (pending).
      owner_job_name  - the owning batch/Job's name (== ProcessVersion.k8s_job_name), or None.
      created_at      - metadata.creationTimestamp string (Kueue's pending FIFO tie-break).
      priority        - spec.priority int (higher runs first); 0 when unset.
      pod_resources   - merged {cpu, memory, ...} requests summed across podSets, for foreign
                        (non-member, no matching ProcessVersion) workloads.
    """
    meta = wl.get("metadata", {})
    status = wl.get("status", {})
    spec = wl.get("spec", {})

    admitted = "admission" in status and status.get("admission") is not None
    if not admitted:
        for cond in status.get("conditions", []):
            if cond.get("type") in ("Admitted", "QuotaReserved") and cond.get("status") == "True":
                admitted = True
                break

    owner_job_name = None
    for ref in meta.get("ownerReferences", []):
        if ref.get("kind") == "Job":
            owner_job_name = ref.get("name")
            break

    pod_resources = {}
    for pod_set in spec.get("podSets", []):
        count = pod_set.get("count", 1) or 1
        containers = (
            pod_set.get("template", {}).get("spec", {}).get("containers", [])
        )
        for container in containers:
            requests = container.get("resources", {}).get("requests", {})
            for res_name, res_val in requests.items():
                if res_name == "cpu":
                    pod_resources["cpu"] = pod_resources.get("cpu", 0.0) + _parse_cpu_cores(str(res_val)) * count
                elif res_name == "memory":
                    pod_resources["memory"] = pod_resources.get("memory", 0.0) + _parse_memory_gb(str(res_val)) * count

    return {
        "admitted": admitted,
        "owner_job_name": owner_job_name,
        "created_at": meta.get("creationTimestamp"),
        "priority": spec.get("priority") or 0,
        "pod_resources": pod_resources,
    }


class K8sClient:
    def __init__(self, namespace=None, kubeconfig=None):
        self.namespace = namespace or os.getenv('K8S_NAMESPACE', 'ymerflow-jobs')
        # kubeconfig: optional dict, resolved by a ClusterProvider from Cluster.provider_config
        # (backend/services/cluster_providers/), to load an explicit config for this cluster.
        # None = auto-detect (in-cluster config or local kubeconfig) — the behavior every cluster
        # had before multi-cluster support, and still the default for the bootstrap cluster.
        self.kubeconfig = kubeconfig
        self._initialized = False
        self.batch_api = None
        self.core_api = None

    async def _ensure_initialized(self):
        """Lazily initialize the K8s client"""
        if self._initialized:
            return

        if self.kubeconfig:
            await config.load_kube_config_from_dict(self.kubeconfig)
        else:
            # Auto-detect: in-cluster or local kubeconfig
            try:
                config.load_incluster_config()
            except Exception:
                await config.load_kube_config()

        self.batch_api = client.BatchV1Api()
        self.core_api = client.CoreV1Api()
        self._initialized = True

    async def create_job(self, job_manifest):
        await self._ensure_initialized()
        return await self.batch_api.create_namespaced_job(self.namespace, job_manifest, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)

    async def create_secret(self, secret_manifest):
        await self._ensure_initialized()
        return await self.core_api.create_namespaced_secret(self.namespace, secret_manifest, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)

    async def delete_job(self, job_name):
        await self._ensure_initialized()
        return await self.batch_api.delete_namespaced_job(job_name, self.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)

    async def get_job_status(self, job_name):
        await self._ensure_initialized()
        job = await self.batch_api.read_namespaced_job(job_name, self.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
        return job.status

    async def get_pod_for_job(self, job_name):
        await self._ensure_initialized()
        pods = await self.core_api.list_namespaced_pod(
            self.namespace,
            label_selector=f"job-name={job_name}",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS
        )
        return pods.items[0] if pods.items else None

    async def stream_pod_logs(self, pod_name, since_time=None):
        """Stream logs with optional since_time for resume capability

        Args:
            pod_name: Name of the pod
            since_time: Optional ISO format timestamp string to stream logs from
                       (will be converted to since_seconds for K8s API)
        """
        await self._ensure_initialized()

        kwargs = {
            "follow": True,
            "_preload_content": False,
            "_request_timeout": CONNECT_TIMEOUT,
        }

        if since_time:
            # Convert ISO timestamp to seconds ago (K8s API uses since_seconds, not since_time)
            try:
                # Parse the ISO timestamp
                timestamp = datetime.fromisoformat(since_time.replace('Z', '+00:00'))
                # Ensure it's timezone-aware (assume UTC if naive)
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                # Calculate seconds difference from now
                now = datetime.now(timezone.utc)
                seconds_ago = int((now - timestamp).total_seconds())
                # K8s API requires positive value (seconds before now)
                if seconds_ago > 0:
                    kwargs["since_seconds"] = seconds_ago
                    logger.debug(f"Streaming logs from {seconds_ago} seconds ago (since_time={since_time})")
            except (ValueError, AttributeError) as e:
                logger.warning(f"Invalid since_time format '{since_time}', ignoring: {e}")

        return await self.core_api.read_namespaced_pod_log(
            pod_name,
            self.namespace,
            **kwargs
        )

    async def get_pod_logs(self, pod_name, since_time=None):
        """Get all available logs from a pod (non-streaming).

        Args:
            pod_name: Name of the pod
            since_time: Optional ISO format timestamp string to get logs from
                       (will be converted to since_seconds for K8s API)

        Returns logs as a string, or None if no logs are available.
        Useful for getting logs from failed/terminated pods.
        """
        await self._ensure_initialized()
        try:
            kwargs = {"follow": False, "_request_timeout": API_REQUEST_TIMEOUT_SECONDS}

            if since_time:
                # Convert ISO timestamp to seconds ago (K8s API uses since_seconds, not since_time)
                try:
                    # Parse the ISO timestamp
                    timestamp = datetime.fromisoformat(since_time.replace('Z', '+00:00'))
                    # Ensure it's timezone-aware (assume UTC if naive)
                    if timestamp.tzinfo is None:
                        timestamp = timestamp.replace(tzinfo=timezone.utc)
                    # Calculate seconds difference from now
                    now = datetime.now(timezone.utc)
                    seconds_ago = int((now - timestamp).total_seconds())
                    # K8s API requires positive value (seconds before now)
                    if seconds_ago > 0:
                        kwargs["since_seconds"] = seconds_ago
                        logger.debug(f"Retrieving logs from {seconds_ago} seconds ago (since_time={since_time})")
                except (ValueError, AttributeError) as e:
                    logger.warning(f"Invalid since_time format '{since_time}', ignoring: {e}")

            logs = await self.core_api.read_namespaced_pod_log(
                pod_name,
                self.namespace,
                **kwargs
            )
            return logs if logs else None
        except Exception:
            return None

    async def get_pod_events(self, pod_name):
        """Get events related to a pod.

        Returns a list of event messages, or empty list if no events found.
        """
        await self._ensure_initialized()
        try:
            events = await self.core_api.list_namespaced_event(
                self.namespace,
                field_selector=f"involvedObject.name={pod_name}",
                _request_timeout=API_REQUEST_TIMEOUT_SECONDS
            )
            return [
                f"[{event.type}] {event.reason}: {event.message}"
                for event in events.items
            ]
        except Exception:
            return []

    async def get_job_events(self, job_name):
        """Get events related to a job.

        Returns a list of event messages, or empty list if no events found.
        Useful for diagnosing Job-level failures (quota issues, invalid config, etc.)
        """
        await self._ensure_initialized()
        try:
            events = await self.core_api.list_namespaced_event(
                self.namespace,
                field_selector=f"involvedObject.name={job_name}",
                _request_timeout=API_REQUEST_TIMEOUT_SECONDS
            )
            return [
                f"[{event.type}] {event.reason}: {event.message}"
                for event in events.items
            ]
        except Exception:
            return []

    async def get_job_error_status(self, job_name):
        """Check if job has error conditions and return error message if any

        Returns:
            tuple: (has_error: bool, error_message: str or None)
        """
        await self._ensure_initialized()
        try:
            job = await self.batch_api.read_namespaced_job(job_name, self.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
            status = job.status

            # Check for job failures
            if status.failed and status.failed > 0:
                conditions = status.conditions or []
                for condition in conditions:
                    if condition.type == 'Failed' and condition.status == 'True':
                        error_msg = f"Job failed: {condition.reason}"
                        if condition.message:
                            error_msg += f" - {condition.message}"
                        return True, error_msg
                return True, f"Job failed ({status.failed} failed pods)"

            # Check for deadline exceeded
            if status.conditions:
                for condition in status.conditions:
                    if condition.type == 'Failed' and condition.reason == 'DeadlineExceeded':
                        return True, f"Job deadline exceeded: {condition.message or 'Timeout reached'}"

            return False, None

        except Exception as e:
            return False, None

    async def is_pod_container_running(self, pod_name):
        """Check if any container in the pod is running"""
        await self._ensure_initialized()
        try:
            pod = await self.core_api.read_namespaced_pod(pod_name, self.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
            if pod.status.container_statuses:
                for container_status in pod.status.container_statuses:
                    if container_status.state.running:
                        return True
            return False
        except Exception:
            return False

    async def get_pod_error_status(self, pod_name):
        """Check if pod has error conditions and return error message if any

        Returns:
            tuple: (has_error: bool, error_message: str or None)
        """
        await self._ensure_initialized()
        try:
            pod = await self.core_api.read_namespaced_pod(pod_name, self.namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)

            # Check container statuses for waiting states with errors
            if pod.status.container_statuses:
                for container_status in pod.status.container_statuses:
                    if container_status.state.waiting:
                        reason = container_status.state.waiting.reason
                        message = container_status.state.waiting.message

                        # Error reasons that indicate failure
                        error_reasons = [
                            'ImagePullBackOff', 'ErrImagePull',
                            'CrashLoopBackOff', 'CreateContainerConfigError',
                            'InvalidImageName', 'CreateContainerError'
                        ]

                        if reason in error_reasons:
                            error_msg = f"Container error: {reason}"
                            if message:
                                error_msg += f" - {message}"
                            return True, error_msg

                    # Check for terminated state with non-zero exit code
                    if container_status.state.terminated:
                        if container_status.state.terminated.exit_code != 0:
                            reason = container_status.state.terminated.reason
                            message = container_status.state.terminated.message
                            error_msg = f"Container terminated: {reason} (exit code {container_status.state.terminated.exit_code})"
                            if message:
                                error_msg += f" - {message}"
                            return True, error_msg

            # Check pod phase for failures
            if pod.status.phase == 'Failed':
                return True, f"Pod failed: {pod.status.reason or 'Unknown reason'}"

            return False, None

        except Exception as e:
            return False, None

    async def get_cluster_queue_limits(self, queue_name: str = "ymerflow-cluster-queue") -> dict:
        """Read nominalQuota from a Kueue ClusterQueue and return cpu/memory limits.

        Returns dict with keys 'max_cpu_cores' (float) and 'max_memory_gb' (float),
        or None if the ClusterQueue cannot be read.
        """
        await self._ensure_initialized()
        try:
            custom_api = client.CustomObjectsApi()
            cq = await custom_api.get_cluster_custom_object(
                group="kueue.x-k8s.io",
                version="v1beta2",
                plural="clusterqueues",
                name=queue_name,
                _request_timeout=API_REQUEST_TIMEOUT_SECONDS
            )
            cpu_cores = None
            memory_gb = None
            for rg in cq.get("spec", {}).get("resourceGroups", []):
                for flavor in rg.get("flavors", []):
                    for res in flavor.get("resources", []):
                        name = res.get("name")
                        quota = str(res.get("nominalQuota", ""))
                        if name == "cpu":
                            cpu_cores = _parse_cpu_cores(quota)
                        elif name == "memory":
                            memory_gb = _parse_memory_gb(quota)
            if cpu_cores is not None and memory_gb is not None:
                return {"max_cpu_cores": cpu_cores, "max_memory_gb": memory_gb}
        except Exception as e:
            logger.warning(f"Could not read ClusterQueue {queue_name}: {e}")
        return None

    async def list_workloads(self) -> list:
        """List Kueue Workload objects in this client's jobs namespace (raw dicts).

        Does NOT swallow errors (CLAUDE.md rule 8) — the caller decides per-cluster
        degradation (a 403 on a not-yet-repatched cluster must surface as queue_error,
        not fail the whole cross-cluster request).
        """
        await self._ensure_initialized()
        custom_api = client.CustomObjectsApi()
        resp = await custom_api.list_namespaced_custom_object(
            group="kueue.x-k8s.io",
            version="v1beta2",
            namespace=self.namespace,
            plural="workloads",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
        return resp.get("items", [])

    async def watch_job(self, job_name, timeout_seconds=None):
        """Watch a job for status changes using Kubernetes Watch API.

        Yields job objects as they change. Completes when job reaches terminal state
        (succeeded or failed) or timeout is reached.

        Args:
            job_name: Name of the job to watch
            timeout_seconds: Optional timeout in seconds

        Yields:
            Job objects as they are updated
        """
        await self._ensure_initialized()

        w = watch.Watch()
        try:
            # Watch for changes to the specific job
            async for event in w.stream(
                self.batch_api.list_namespaced_job,
                namespace=self.namespace,
                field_selector=f'metadata.name={job_name}',
                timeout_seconds=timeout_seconds,
                _request_timeout=CONNECT_TIMEOUT
            ):
                job = event['object']
                event_type = event['type']

                logger.debug(f"Job {job_name} event: {event_type}, status: {job.status}")

                # Yield the job object
                yield job

                # Stop watching if job reached terminal state
                if job.status.succeeded or job.status.failed:
                    logger.info(f"Job {job_name} reached terminal state")
                    break

        except asyncio.CancelledError:
            logger.info(f"Watch for job {job_name} was cancelled")
            raise
        except Exception as e:
            logger.error(f"Error watching job {job_name}: {e}")
            raise
        finally:
            await w.close()


class K8sClientRegistry:
    """One lazily-initialized K8sClient per Cluster row, keyed by cluster id — replaces the
    old module-level singleton now that jobs can run on more than one cluster."""

    def __init__(self):
        self._clients = {}

    def get(self, cluster) -> K8sClient:
        if cluster.id not in self._clients:
            from backend.services.cluster_providers import get_cluster_provider

            provider = get_cluster_provider(cluster.cluster_type)
            self._clients[cluster.id] = provider.connect(cluster.provider_config, cluster.namespace)
        return self._clients[cluster.id]


k8s_clients = K8sClientRegistry()

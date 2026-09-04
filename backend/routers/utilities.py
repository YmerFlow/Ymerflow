from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Optional
import logging
import projnames

from backend.database import get_db
from backend.services.k8s_client import k8s_clients, classify_workload
from backend.services.cluster_providers import get_cluster_provider
from backend.services.auth_service import get_current_user, AuthContext, resolve_project_for_read, ProjectReadAccess
from backend.models.cluster import get_allowed_clusters
from backend.models.storage_backend import get_allowed_storage_backends
from backend.models.process import ProcessVersion, Process
from backend.models.project import ProjectMember

router = APIRouter(tags=["Utilities"])

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_LIMITS = {"max_cpu_cores": 8.0, "max_memory_gb": 32.0}


@router.get("/projects/{project_id}/utilities/available-clusters", operation_id="available_clusters", tags=["Processes"])
async def available_clusters(
    cpu: Optional[str] = None,
    memory: Optional[str] = None,
    deadline_seconds: Optional[int] = None,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Return the clusters the current user may run on, each with live resource limits.

    Two distinct ceilings are returned per cluster because a pod is atomic — it must fit on one
    node — so the number that bounds a single task is NOT the cluster-wide aggregate:

    - `max_cpu_cores` / `max_memory_gb` — the **single-node** capacity (the largest pod this
      cluster can ever schedule), from the provider's `node_capacity()`. These are the keys the
      editor's sliders bind to and that submit-time validation enforces. There is no fallback: a
      provider that can't report capacity raises, surfacing a real misconfiguration.
    - `aggregate_max_cpu_cores` / `aggregate_max_memory_gb` — the cluster-wide autoscaled ceiling,
      from the live Kueue ClusterQueue nominalQuota (display only), falling back to
      DEFAULT_QUEUE_LIMITS when the ClusterQueue can't be read.

    Combines the select_clusters hook's allowed-cluster set with these live lookups per cluster
    and the stored max_runtime_seconds ceiling. Sorted by sort_order, same order the
    process-creation dropdown should present.
    """
    resource_requests = {"cpu": cpu, "memory": memory} if cpu or memory else None
    clusters = await get_allowed_clusters(db, auth.user, access.project.id, resource_requests)
    out = []
    for cluster in clusters:
        k8s_client = k8s_clients.get(cluster)
        aggregate = await k8s_client.get_cluster_queue_limits()
        if aggregate is None:
            aggregate = DEFAULT_QUEUE_LIMITS
        provider = get_cluster_provider(cluster.cluster_type)
        node_cap = await provider.node_capacity(k8s_client, cluster.provider_config)
        out.append({
            **cluster.to_dict(),
            "max_cpu_cores": node_cap["max_cpu_cores"],
            "max_memory_gb": node_cap["max_memory_gb"],
            "aggregate_max_cpu_cores": aggregate["max_cpu_cores"],
            "aggregate_max_memory_gb": aggregate["max_memory_gb"],
        })
    return out


def _workload_owner_job(wl: dict) -> Optional[str]:
    """The owning batch/Job name from a raw Kueue Workload (== ProcessVersion.k8s_job_name),
    used to match the workload to its pod before classify_workload. Mirrors the ownerReferences
    lookup classify_workload does internally."""
    for ref in wl.get("metadata", {}).get("ownerReferences", []):
        if ref.get("kind") == "Job":
            return ref.get("name")
    return None


def _foreign_resource_requests(pod_resources: dict) -> dict:
    """Format classify_workload's numeric pod_resources (cpu cores, memory GiB) back into
    k8s quantity strings so member and non-member entries share one frontend parser."""
    out = {}
    if "cpu" in pod_resources:
        out["cpu"] = f"{int(round(pod_resources['cpu'] * 1000))}m"
    if "memory" in pod_resources:
        out["memory"] = f"{pod_resources['memory']:g}Gi"
    return out


@router.get("/utilities/cluster-queues")
async def cluster_queues(
    include_limits: bool = True,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[dict]:
    """Live per-cluster Kueue queue view across all clusters the current user may access.

    For each accessible cluster, lists Kueue Workload objects and returns them in Kueue's
    actual (future) execution order — admitted/running first, then pending by priority then
    creation-time FIFO. Visibility is by project membership, exactly like FlowView: full
    details for processes in the user's member projects, resource/position/state only for
    everything else. Redaction is server-side (see the plan's Security invariant): non-member
    entries never carry identity fields in the JSON at all.

    This is a cross-project per-user view; anonymous/publication access is intentionally
    excluded (get_current_user, not resolve_project_for_read).
    """
    member_ids = set(
        await db.scalars(
            select(ProjectMember.project_id).where(ProjectMember.user_id == auth.user.id)
        )
    )
    clusters = await get_allowed_clusters(db, auth.user, None)

    out = []
    for cluster in clusters:
        entry = {
            **cluster.to_dict(),
            "limits": None,
            "queue_error": None,
            "queue": [],
        }

        try:
            client = k8s_clients.get(cluster)
            workloads = await client.list_workloads()
            pods = await client.list_pods()
        except Exception as e:
            # Per-cluster graceful degradation (Decision 4): a not-yet-repatched cluster
            # (403 on workloads/pods) surfaces the error instead of failing the whole request.
            logger.warning(f"Could not list workloads/pods for cluster {cluster.id}: {e}")
            entry["queue_error"] = str(e)
            out.append(entry)
            continue

        # Index pods by their owning Job (the `job-name` label the Job controller stamps on
        # every pod it creates == ProcessVersion.k8s_job_name), so each workload's live state
        # is derived from its own pod.
        pod_by_job = {}
        for pod in pods:
            labels = (getattr(pod.metadata, "labels", None) or {}) if getattr(pod, "metadata", None) else {}
            job_name = labels.get("job-name")
            if job_name:
                pod_by_job[job_name] = pod

        # Classify each workload against its pod (matched by the workload's owning Job name),
        # then drop terminal (done/failed) rows — a Finished/errored Workload holds no quota
        # and is out of Kueue's live queue (fixes the "finished shows as running" bug).
        # Remaining rows carry state ∈ {queued, starting, running}.
        classified = []
        for wl in workloads:
            owner_job = _workload_owner_job(wl)
            classified.append(classify_workload(wl, pod_by_job.get(owner_job)))
        classified = [c for c in classified if c["state"] not in ("done", "failed")]

        # One DB query enriching by owner job name (Decision 2), eager-loading process→project
        # and tags so serialization touches no lazy relationships.
        job_names = [c["owner_job_name"] for c in classified if c["owner_job_name"]]
        pv_by_job = {}
        if job_names:
            rows = await db.scalars(
                select(ProcessVersion)
                .where(ProcessVersion.k8s_job_name.in_(job_names))
                .options(
                    selectinload(ProcessVersion.process).selectinload(Process.project),
                    selectinload(ProcessVersion.tags),
                )
            )
            pv_by_job = {pv.k8s_job_name: pv for pv in rows}

        # Order: admitted first (tie-break started_at/creation asc), then pending by
        # (−priority, workload creationTimestamp asc). Sort keys are strings/ints only.
        def sort_key(c):
            pv = pv_by_job.get(c["owner_job_name"])
            if c["admitted"]:
                started = pv.started_at.isoformat() if (pv and pv.started_at) else (c["created_at"] or "")
                return (0, 0, started)
            return (1, -c["priority"], c["created_at"] or "")

        classified.sort(key=sort_key)

        queue = []
        for position, c in enumerate(classified):
            pv = pv_by_job.get(c["owner_job_name"])
            member = pv is not None and pv.process.project_id in member_ids
            # Badge state is the pod-derived lifecycle state (queued/starting/running), identical
            # to the monitor's DB transitions. Admission drives ORDER (sort_key), not the badge.
            state = c["state"]

            if member:
                # Full entry — build a fresh dict with detail keys (never build-then-delete).
                queue.append({
                    "position": position,
                    "state": state,
                    "member": True,
                    "resource_requests": pv.resource_requests,
                    "deadline_seconds": pv.deadline_seconds,
                    "project_name": pv.process.project.name if pv.process.project else None,
                    "process_id": pv.process_id,
                    "process_name": pv.process.name,
                    "version": pv.version,
                    "process_type": pv.type,
                    "tags": [t.to_dict() for t in pv.tags],
                })
            else:
                # Redacted entry — the authorization boundary. No identity key is ever added,
                # so nothing to leak. Resources from the ProcessVersion if we have one (a
                # non-member process the user still can't see), else from the workload podSets.
                if pv is not None:
                    resource_requests = pv.resource_requests
                    deadline_seconds = pv.deadline_seconds
                else:
                    resource_requests = _foreign_resource_requests(c["pod_resources"])
                    deadline_seconds = None
                queue.append({
                    "position": position,
                    "state": state,
                    "member": False,
                    "resource_requests": resource_requests,
                    "deadline_seconds": deadline_seconds,
                })

        entry["queue"] = queue

        if include_limits:
            limits = await k8s_clients.get(cluster).get_cluster_queue_limits()
            entry["limits"] = limits if limits is not None else DEFAULT_QUEUE_LIMITS

        out.append(entry)

    return out


@router.get("/utilities/available-storage-backends", operation_id="list_storage_backends", tags=["Projects"])
async def available_storage_backends(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the storage backends the current user may create a project against.

    Mirrors /projects/{project_id}/utilities/available-clusters: select_storage_backends hook's
    allowed-backend set, sorted by sort_order — the same order the project-creation dropdown presents.
    """
    backends = await get_allowed_storage_backends(db, auth.user)
    return [b.to_dict() for b in backends]


@router.get("/utilities/epsg-codes")
async def get_epsg_codes() -> Dict[int, str]:
    """Get all EPSG codes with names for coordinate system selection.

    Returns a dictionary mapping EPSG code (integer) to projection name (string).
    """
    logger.info(f"Returning {len(projnames.by_epsg)} EPSG codes")
    return projnames.by_epsg

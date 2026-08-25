#!/usr/bin/env python
"""Unit test for GET /utilities/cluster-queues.

See docs/plans/done/cluster-queue-widget.md (original) and
docs/plans/done/cluster-queue-state-fixes.md (this revision).

Runs against an in-memory async SQLite DB with a faked K8sClient (list_workloads + list_pods),
exercising the security-critical logic directly on the endpoint function: Kueue admission
ordering, membership (not creator) driven visibility, server-side redaction, per-cluster
graceful degradation, and — new in the state-fixes plan — the pod-derived lifecycle state
(queued/starting/running) with terminal (done/failed) workloads dropped from the queue.

Run with:  python -m pytest backend/test_cluster_queues.py -q
"""

import asyncio
import types

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

import backend.models  # noqa: F401 — registers every table on Base.metadata
from backend.database import Base
from backend.models.user import User
from backend.models.project import Project, ProjectMember
from backend.models.environment import Environment
from backend.models.cluster import Cluster
from backend.models.process import Process, ProcessVersion, ProcessTag, ProcessState
from backend.models.process import process_version_tags_table

from backend.routers import utilities


def _workload(job_name, *, admitted, created, priority=0, pod_requests=None):
    """Build a raw Kueue Workload dict as list_workloads would return."""
    status = {"admission": {"clusterQueue": "ymerflow-cluster-queue"}} if admitted else {}
    pod_sets = []
    if pod_requests is not None:
        pod_sets = [{
            "count": 1,
            "template": {"spec": {"containers": [{"resources": {"requests": pod_requests}}]}},
        }]
    return {
        "metadata": {
            "name": f"wl-{job_name}",
            "creationTimestamp": created,
            "ownerReferences": ([{"kind": "Job", "name": job_name}] if job_name else []),
        },
        "spec": {"priority": priority, "podSets": pod_sets},
        "status": status,
    }


def _pod(job_name, *, phase=None, running=False, terminated_exit=None, waiting_reason=None):
    """Build a V1Pod-shaped stub (attribute access, matching kubernetes_asyncio objects).

    Only the fields _pod_lifecycle_state reads are populated: metadata.labels['job-name'],
    status.phase, and status.container_statuses[].state.{running,terminated,waiting}.
    """
    container_statuses = None
    if running or terminated_exit is not None or waiting_reason is not None:
        state = types.SimpleNamespace(
            running=(types.SimpleNamespace() if running else None),
            terminated=(types.SimpleNamespace(exit_code=terminated_exit)
                        if terminated_exit is not None else None),
            waiting=(types.SimpleNamespace(reason=waiting_reason)
                     if waiting_reason is not None else None),
        )
        container_statuses = [types.SimpleNamespace(state=state)]
    return types.SimpleNamespace(
        metadata=types.SimpleNamespace(labels={"job-name": job_name}),
        status=types.SimpleNamespace(phase=phase, container_statuses=container_statuses),
    )


class _FakeClient:
    def __init__(self, workloads=None, pods=None, raise_exc=None):
        self._workloads = workloads or []
        self._pods = pods or []
        self._raise = raise_exc

    async def list_workloads(self):
        if self._raise is not None:
            raise self._raise
        return self._workloads

    async def list_pods(self):
        if self._raise is not None:
            raise self._raise
        return self._pods

    async def get_cluster_queue_limits(self, queue_name="ymerflow-cluster-queue"):
        return {"max_cpu_cores": 8.0, "max_memory_gb": 32.0}


async def _seed_and_run():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        user_a = User(username="alice", password_hash="x")
        user_b = User(username="bob", password_hash="x")
        db.add_all([user_a, user_b])
        await db.flush()

        # P1: both A and B are members.  P2: only B.
        p1 = Project(id="p1", name="Shared Survey")
        p2 = Project(id="p2", name="Bob Only")
        db.add_all([p1, p2])
        await db.flush()
        db.add_all([
            ProjectMember(project_id="p1", user_id=user_a.id),
            ProjectMember(project_id="p1", user_id=user_b.id),
            ProjectMember(project_id="p2", user_id=user_b.id),
        ])

        env = Environment(id="env1", name="env", docker_image="img")
        db.add(env)

        # C1 active (has workloads), C2 active (k8s read fails), C3 inactive (must be excluded).
        c1 = Cluster(id="c1", name="Cluster One", sort_order=0, active=True)
        c2 = Cluster(id="c2", name="Cluster Two", sort_order=1, active=True)
        c3 = Cluster(id="c3", name="Retired", sort_order=2, active=False)
        db.add_all([c1, c2, c3])

        tag = ProcessTag(id="t1", project_id="p1", name="prod", color="#28a745")
        db.add(tag)

        # proc1: in P1, STARTED BY B, running pod — A must still see it in FULL (membership).
        proc1 = Process(id="proc1", name="invert_aem", type="aem_inversion",
                        environment_id="env1", project_id="p1")
        # proc3: in P1, pod coming up (Pending) — A member, full, state "starting".
        proc3 = Process(id="proc3", name="grid_mag", type="mag_gridding",
                        environment_id="env1", project_id="p1")
        # proc2: in P2, no pod yet — A is NOT a member, redacted, state "queued".
        proc2 = Process(id="proc2", name="secret_proc", type="secret_type",
                        environment_id="env1", project_id="p2")
        # proc_done: in P1 (MEMBER), Succeeded pod — a finished member job must DROP OUT
        #            (this is bug #1: finished jobs used to render as running).
        proc_done = Process(id="proc_done", name="old_run", type="aem_inversion",
                            environment_id="env1", project_id="p1")
        db.add_all([proc1, proc2, proc3, proc_done])
        await db.flush()

        from datetime import datetime
        pv1 = ProcessVersion(process_id="proc1", version=1, parameters={},
                             state=ProcessState.RUNNING, k8s_job_name="process-proc1-v1",
                             k8s_cluster_id="c1", resource_requests={"cpu": "1000m", "memory": "2Gi"},
                             deadline_seconds=3600, started_at=datetime(2026, 1, 1, 0, 0, 5))
        pv2 = ProcessVersion(process_id="proc2", version=1, parameters={},
                             state=ProcessState.QUEUED, k8s_job_name="process-proc2-v1",
                             k8s_cluster_id="c1", resource_requests={"cpu": "2000m", "memory": "8Gi"},
                             deadline_seconds=7200)
        pv3 = ProcessVersion(process_id="proc3", version=2, parameters={},
                             state=ProcessState.STARTING, k8s_job_name="process-proc3-v1",
                             k8s_cluster_id="c1", resource_requests={"cpu": "500m", "memory": "1Gi"},
                             deadline_seconds=1800)
        pv_done = ProcessVersion(process_id="proc_done", version=1, parameters={},
                                 state=ProcessState.DONE, k8s_job_name="process-done-v1",
                                 k8s_cluster_id="c1", resource_requests={"cpu": "1000m", "memory": "2Gi"},
                                 deadline_seconds=3600)
        db.add_all([pv1, pv2, pv3, pv_done])
        await db.flush()

        # tag proc1 v1
        await db.execute(process_version_tags_table.insert().values(
            process_version_id=pv1.id, tag_id="t1", added_at=datetime(2026, 1, 1), added_by=""))
        await db.commit()

        # Workloads on C1, deliberately out of order to prove the endpoint sorts them.
        c1_workloads = [
            _workload("process-proc3-v1", admitted=False, created="2026-01-01T00:01:00Z"),
            _workload("process-proc2-v1", admitted=False, created="2026-01-01T00:00:00Z"),
            _workload("process-proc1-v1", admitted=True, created="2026-01-01T00:00:00Z"),
            # finished MEMBER workload — Succeeded pod → dropped (fixes bug #1).
            _workload("process-done-v1", admitted=True, created="2026-01-01T00:00:30Z"),
            # foreign workload, pod coming up (Pending) → state "starting", resources from podSets.
            _workload("process-ghost-v9", admitted=False, created="2026-01-01T00:02:00Z",
                      pod_requests={"cpu": "4000m", "memory": "16Gi"}),
            # foreign workload whose pod FAILED → dropped (terminal, out of the live queue).
            _workload("process-failghost-v1", admitted=False, created="2026-01-01T00:03:00Z",
                      pod_requests={"cpu": "1000m", "memory": "4Gi"}),
        ]
        c1_pods = [
            _pod("process-proc1-v1", phase="Running", running=True),      # → running
            _pod("process-proc3-v1", phase="Pending"),                    # → starting
            # process-proc2-v1: NO pod → queued
            _pod("process-done-v1", phase="Succeeded"),                   # → done (drop)
            _pod("process-ghost-v9", phase="Pending"),                    # → starting
            _pod("process-failghost-v1", phase="Failed"),                 # → failed (drop)
        ]

        clients = {
            "c1": _FakeClient(workloads=c1_workloads, pods=c1_pods),
            "c2": _FakeClient(raise_exc=RuntimeError("403 workloads forbidden")),
        }
        fake_registry = types.SimpleNamespace(get=lambda cluster: clients[cluster.id])
        orig_registry = utilities.k8s_clients
        utilities.k8s_clients = fake_registry

        # Bypass any installed select_clusters plugin hook: exercise the "no hooks → all active
        # clusters" behavior deterministically (this test is about the queue assembly, not cluster
        # access policy, which get_allowed_clusters covers elsewhere).
        from sqlalchemy import select as _select
        async def _all_active(db_, user_, project_id=None, resource_requests=None):
            rows = await db_.scalars(
                _select(Cluster).where(Cluster.active == True).order_by(Cluster.sort_order))
            return list(rows)
        orig_allowed = utilities.get_allowed_clusters
        utilities.get_allowed_clusters = _all_active
        try:
            auth = types.SimpleNamespace(user=user_a)
            result = await utilities.cluster_queues(include_limits=True, auth=auth, db=db)
        finally:
            utilities.k8s_clients = orig_registry
            utilities.get_allowed_clusters = orig_allowed

    await engine.dispose()
    return result


def test_cluster_queues():
    result = asyncio.run(_seed_and_run())

    by_id = {c["id"]: c for c in result}

    # (d) inactive cluster excluded; both active clusters present.
    assert set(by_id) == {"c1", "c2"}

    # (e) C2's k8s read failed → queue_error surfaced, empty queue, whole request still succeeded.
    assert by_id["c2"]["queue_error"] == "403 workloads forbidden"
    assert by_id["c2"]["queue"] == []

    c1 = by_id["c1"]
    assert c1["queue_error"] is None
    assert c1["limits"] == {"max_cpu_cores": 8.0, "max_memory_gb": 32.0}
    queue = c1["queue"]

    # (f) terminal workloads (Succeeded/Failed pods) are DROPPED — fixes bug #1. 6 workloads in,
    # 2 terminal → 4 rows out. No entry carries a terminal state.
    assert len(queue) == 4
    assert all(q["state"] in ("queued", "starting", "running") for q in queue)
    # the finished member job is gone entirely (not just re-labelled).
    assert all(q.get("process_id") != "proc_done" for q in queue)

    # (a) ordering: admitted first, then pending by creation-time asc; positions assigned in order.
    # After drops: admitted proc1 (0); pending proc2 (00:00) < proc3 (00:01) < ghost (00:02).
    assert [q["position"] for q in queue] == [0, 1, 2, 3]
    assert queue[0]["process_id"] == "proc1"

    # (b) badge state is POD-DERIVED (not admission), and matches each pod, for member & foreign.
    assert queue[0]["state"] == "running"     # member, running pod
    assert queue[1]["state"] == "queued"      # redacted (p2), no pod
    assert queue[2]["state"] == "starting"    # member, Pending pod
    assert queue[3]["state"] == "starting"    # foreign, Pending pod

    # (c) membership (NOT creator) drives full visibility: proc1 started by Bob, but Alice is a
    # member of its project p1, so she sees it fully.
    e0 = queue[0]
    assert e0["member"] is True
    assert e0["project_name"] == "Shared Survey"
    assert e0["process_name"] == "invert_aem"
    assert e0["version"] == 1
    assert e0["process_type"] == "aem_inversion"
    assert e0["tags"] == [{"id": "t1", "name": "prod", "color": "#28a745"}]
    assert e0["resource_requests"] == {"cpu": "1000m", "memory": "2Gi"}
    assert e0["deadline_seconds"] == 3600

    # proc3 (position 2) is also in p1 → full, and its pod-derived state is "starting".
    proc3_entry = next(q for q in queue if q.get("process_id") == "proc3")
    assert proc3_entry["member"] is True
    assert proc3_entry["project_name"] == "Shared Survey"
    assert proc3_entry["state"] == "starting"

    # (c) redaction is server-side: the p2 process (Alice not a member) carries ONLY
    # position/state/member/resource_requests/deadline_seconds — no identity keys in the payload.
    redacted = queue[1]
    assert redacted["member"] is False
    assert set(redacted) == {"position", "state", "member", "resource_requests", "deadline_seconds"}
    for leaked in ("process_id", "process_name", "project_name", "version", "process_type", "tags"):
        assert leaked not in redacted
    assert redacted["resource_requests"] == {"cpu": "2000m", "memory": "8Gi"}
    assert redacted["deadline_seconds"] == 7200

    # foreign workload (no matching ProcessVersion): redacted, resources read from podSets,
    # deadline omitted (None), state pod-derived ("starting").
    ghost = queue[3]
    assert ghost["member"] is False
    assert ghost["resource_requests"] == {"cpu": "4000m", "memory": "16Gi"}
    assert ghost["deadline_seconds"] is None
    assert "process_id" not in ghost


if __name__ == "__main__":
    test_cluster_queues()
    print("✓ cluster-queues test passed")

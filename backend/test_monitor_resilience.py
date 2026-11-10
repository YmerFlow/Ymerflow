#!/usr/bin/env python
"""Unit/integration tests for the job-monitor resilience changes.

Covers docs/plans/db-monitor-resilience-retry-and-sweep.md:

  * Change B — a monitor that hits an arbitrary exception NEVER records a terminal state; it logs,
    finalizes, and returns with the version left non-terminal (the sweep re-attaches). The heartbeat
    it already wrote survives.
  * Change C — the TTL-404 path consults the durable completion marker: present => succeeded (runs
    the normal completion path), absent => FAILED.
  * Change D — resume_orphaned_monitors re-attaches monitors to orphaned non-terminal versions
    (respecting the heartbeat + "has a Job" rules) and reaps terminal-but-live Jobs.
  * _reap_job is 404-/error-tolerant (best effort, never fatal).
  * SDK runner writes the version-level info.json marker on success and NOT on the failure path.

Runs against an in-memory async SQLite DB with faked K8s clients, directly on the model methods.

Run with:  python -m pytest backend/test_monitor_resilience.py -q
"""

import asyncio
import contextlib
import importlib.util
import io
import logging
import os
import types
from unittest import mock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

import backend.models  # noqa: F401 — registers every table on Base.metadata
from backend.database import Base
from backend.models.project import Project
from backend.models.environment import Environment
from backend.models.cluster import Cluster
from backend.models.process import Process, ProcessVersion, ProcessState

logger = logging.getLogger("test_monitor_resilience")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


async def _make_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def _seed_version(Session, *, state, k8s_job_name="job-1", last_monitored_at=None, version=1):
    """Seed a project/environment/process/process_version and return (process_id, version)."""
    async with Session() as db:
        db.add(Project(id="p1", name="Proj"))
        db.add(Environment(id="env1", name="env", docker_image="img"))
        await db.flush()
        proc = Process(id="proc-1", name="P", project_id="p1")
        db.add(proc)
        await db.flush()
        pv = ProcessVersion(
            process_id="proc-1", version=version, type="import", environment_id="env1",
            parameters={}, state=state, k8s_job_name=k8s_job_name,
            last_monitored_at=last_monitored_at,
        )
        db.add(pv)
        await db.commit()
    return "proc-1", version


async def _get_state(Session, process_id, version):
    async with Session() as db:
        pv = (await db.execute(select(ProcessVersion).where(
            ProcessVersion.process_id == process_id, ProcessVersion.version == version
        ))).scalar_one()
        return pv.state, pv.last_monitored_at


class _FakeLogManager:
    def __init__(self, *a, **k):
        pass

    async def finalize_logs(self):
        pass

    async def start_retrieval(self):
        pass


# --------------------------------------------------------------------------- Change B

async def _run_catch_all_leaves_state():
    Session = await _make_db()
    pid, ver = await _seed_version(Session, state=ProcessState.RUNNING)

    async def _boom(*a, **k):
        raise RuntimeError("simulated monitor-side failure (e.g. pool timeout)")

    async def _fake_cluster(db, pv):
        return types.SimpleNamespace(id="c1")

    with mock.patch("backend.database.async_session_maker", Session), \
         mock.patch("backend.services.log_manager.LogManager", _FakeLogManager), \
         mock.patch("backend.models.cluster.get_cluster_for_process_version", _fake_cluster), \
         mock.patch("backend.services.k8s_client.k8s_clients.get", lambda cluster: mock.Mock()), \
         mock.patch("backend.services.job_orchestrator.get_job_status", _boom):
        # Must NOT raise, and must NOT terminalize.
        await ProcessVersion.monitor_job(pid, ver)

    state, hb = await _get_state(Session, pid, ver)
    assert state == ProcessState.RUNNING, f"monitor self-failed: state={state}"
    assert hb is not None, "heartbeat should have been written before the failing K8s call"


def test_catch_all_never_self_fails():
    asyncio.run(_run_catch_all_leaves_state())


# --------------------------------------------------------------------------- Change C

async def _run_ttl_404(marker_present):
    Session = await _make_db()
    pid, ver = await _seed_version(Session, state=ProcessState.RUNNING)
    called = {}

    async def _marker(db, process, version):
        return marker_present

    async def _spy_completion(pv, process, job_name, status, db, lg, kc):
        called["status"] = status
        await pv.update_state(db, ProcessState.DONE, process.project_id)

    async with Session() as db:
        pv = (await db.execute(select(ProcessVersion).options().where(
            ProcessVersion.process_id == pid, ProcessVersion.version == ver
        ))).scalar_one()
        process = (await db.execute(select(Process).where(Process.id == pid))).scalar_one()

        with mock.patch.object(ProcessVersion, "_completion_marker_present", staticmethod(_marker)), \
             mock.patch.object(ProcessVersion, "_handle_job_completion", staticmethod(_spy_completion)):
            await ProcessVersion._resolve_ttl_404(
                pv, process, "job-1", db, logger, _FakeLogManager(), mock.Mock()
            )

    state, _ = await _get_state(Session, pid, ver)
    return state, called


def test_ttl_404_marker_present_succeeds():
    state, called = asyncio.run(_run_ttl_404(marker_present=True))
    assert called.get("status") == "succeeded", "marker present must drive the succeeded completion path"
    assert state == ProcessState.DONE


def test_ttl_404_marker_absent_fails():
    state, called = asyncio.run(_run_ttl_404(marker_present=False))
    assert "status" not in called, "marker absent must NOT run the completion path"
    assert state == ProcessState.FAILED


# --------------------------------------------------------------------------- Change D (recover)

async def _run_resume_recover():
    from datetime import datetime, timedelta
    Session = await _make_db()
    fresh = datetime.utcnow()
    stale = datetime.utcnow() - timedelta(seconds=10_000)

    # Three non-terminal versions + relationships, plus a terminal one that must be ignored.
    async with Session() as db:
        db.add(Project(id="p1", name="Proj"))
        db.add(Environment(id="env1", name="env", docker_image="img"))
        await db.flush()
        db.add(Process(id="proc-1", name="P", project_id="p1"))
        await db.flush()

        def mk(v, state, job, hb):
            return ProcessVersion(process_id="proc-1", version=v, type="import", environment_id="env1",
                                  parameters={}, state=state, k8s_job_name=job,
                                  last_monitored_at=hb)
        db.add(mk(1, ProcessState.RUNNING, "job-stale", stale))   # orphan -> re-attach
        db.add(mk(2, ProcessState.STARTING, "job-null", None))    # never monitored -> re-attach
        db.add(mk(3, ProcessState.RUNNING, "job-fresh", fresh))   # live monitor -> skip
        db.add(mk(4, ProcessState.QUEUED, None, None))            # pre-job setup (no job) -> skip
        db.add(mk(5, ProcessState.DONE, "job-done", stale))       # terminal -> not a recover target
        await db.commit()

    attached = []

    async def _spy_monitor(process_id, version):
        attached.append((process_id, version))

    with mock.patch("backend.database.async_session_maker", Session), \
         mock.patch.object(ProcessVersion, "monitor_job", staticmethod(_spy_monitor)):
        await ProcessVersion.resume_orphaned_monitors(respect_heartbeat=True)
        # let the create_task'd spies run
        for _ in range(5):
            await asyncio.sleep(0)

    return sorted(v for (_, v) in attached)


def test_resume_recover_respects_heartbeat_and_job():
    attached = asyncio.run(_run_resume_recover())
    assert attached == [1, 2], f"should re-attach only stale/never-monitored versions that have a Job; got {attached}"


async def _run_resume_recover_startup():
    """respect_heartbeat=False (startup): re-attach EVERY non-terminal version regardless of heartbeat."""
    from datetime import datetime
    Session = await _make_db()
    async with Session() as db:
        db.add(Project(id="p1", name="Proj"))
        db.add(Environment(id="env1", name="env", docker_image="img"))
        await db.flush()
        db.add(Process(id="proc-1", name="P", project_id="p1"))
        await db.flush()
        db.add(ProcessVersion(process_id="proc-1", version=1, type="import", environment_id="env1",
                              parameters={}, state=ProcessState.RUNNING, k8s_job_name="j1",
                              last_monitored_at=datetime.utcnow()))
        db.add(ProcessVersion(process_id="proc-1", version=2, type="import", environment_id="env1",
                              parameters={}, state=ProcessState.DONE, k8s_job_name="j2",
                              last_monitored_at=None))
        await db.commit()

    attached = []

    async def _spy_monitor(process_id, version):
        attached.append(version)

    with mock.patch("backend.database.async_session_maker", Session), \
         mock.patch.object(ProcessVersion, "monitor_job", staticmethod(_spy_monitor)):
        await ProcessVersion.resume_orphaned_monitors(respect_heartbeat=False)
        for _ in range(5):
            await asyncio.sleep(0)
    return sorted(attached)


def test_resume_startup_reattaches_even_fresh_heartbeat():
    attached = asyncio.run(_run_resume_recover_startup())
    assert attached == [1], "startup must re-attach the running version (fresh heartbeat ignored) but not the terminal one"


# --------------------------------------------------------------------------- Change D (reap)

class _FakeJob:
    def __init__(self, name):
        self.metadata = types.SimpleNamespace(name=name)


class _FakeK8s:
    def __init__(self, job_names):
        self._jobs = [_FakeJob(n) for n in job_names]
        self.deleted = []

    async def list_jobs(self):
        return self._jobs

    async def delete_job(self, job_name, propagation_policy="Background"):
        self.deleted.append(job_name)


async def _run_resume_reap():
    from datetime import datetime, timedelta
    Session = await _make_db()
    stale = datetime.utcnow() - timedelta(seconds=10_000)
    fresh = datetime.utcnow()

    async with Session() as db:
        db.add(Project(id="p1", name="Proj"))
        db.add(Environment(id="env1", name="env", docker_image="img"))
        db.add(Cluster(id="c1", name="C1", active=True))
        await db.flush()
        db.add(Process(id="proc-1", name="P", project_id="p1"))
        await db.flush()
        # Terminal + live Job + no live monitor -> REAP.
        db.add(ProcessVersion(process_id="proc-1", version=1, type="import", environment_id="env1",
                              parameters={}, state=ProcessState.FAILED, k8s_job_name="job-leftover",
                              last_monitored_at=stale))
        # Terminal + live Job but a monitor is still live (fresh heartbeat) -> skip (it reaps inline).
        db.add(ProcessVersion(process_id="proc-1", version=2, type="import", environment_id="env1",
                              parameters={}, state=ProcessState.DONE, k8s_job_name="job-livemon",
                              last_monitored_at=fresh))
        # A live Job whose version is still RUNNING -> never reaped.
        db.add(ProcessVersion(process_id="proc-1", version=3, type="import", environment_id="env1",
                              parameters={}, state=ProcessState.RUNNING, k8s_job_name="job-running",
                              last_monitored_at=fresh))
        await db.commit()

    fake = _FakeK8s(["job-leftover", "job-livemon", "job-running", "job-unknown"])

    async def _noop_monitor(process_id, version):
        pass

    with mock.patch("backend.database.async_session_maker", Session), \
         mock.patch("backend.services.k8s_client.k8s_clients.get", lambda cluster: fake), \
         mock.patch.object(ProcessVersion, "monitor_job", staticmethod(_noop_monitor)):
        await ProcessVersion.resume_orphaned_monitors(respect_heartbeat=True)
        for _ in range(5):
            await asyncio.sleep(0)

    return fake.deleted


def test_resume_reaps_only_terminal_unmonitored_jobs():
    deleted = asyncio.run(_run_resume_reap())
    assert deleted == ["job-leftover"], f"only the terminal, unmonitored, still-live Job should be reaped; got {deleted}"


# --------------------------------------------------------------------------- _reap_job robustness

async def _run_reap_job_tolerant():
    from kubernetes_asyncio.client.exceptions import ApiException

    class _Raises404:
        async def delete_job(self, job_name, propagation_policy="Background"):
            raise ApiException(status=404)

    class _RaisesOther:
        async def delete_job(self, job_name, propagation_policy="Background"):
            raise RuntimeError("cluster unreachable")

    deleted = []

    class _OK:
        async def delete_job(self, job_name, propagation_policy="Background"):
            deleted.append(job_name)

    # None/empty are no-ops; 404 and arbitrary errors must not propagate.
    await ProcessVersion._reap_job(None, "j", logger)
    await ProcessVersion._reap_job(_OK(), "", logger)
    await ProcessVersion._reap_job(_Raises404(), "j", logger)
    await ProcessVersion._reap_job(_RaisesOther(), "j", logger)
    await ProcessVersion._reap_job(_OK(), "j", logger)
    return deleted


def test_reap_job_is_best_effort():
    deleted = asyncio.run(_run_reap_job_tolerant())
    assert deleted == ["j"], "only the healthy delete should record; 404/errors swallowed-but-logged"


# --------------------------------------------------------------------------- SDK marker (Change A)

def _load_runner_module():
    path = os.path.join(REPO_ROOT, "deps", "Ymerflow-process-sdk", "ymerflow_runner", "runner.py")
    spec = importlib.util.spec_from_file_location("sdk_runner_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _CaptureFsspec:
    def __init__(self):
        self.opened = []

    def open(self, url, mode="r", **kwargs):
        self.opened.append(url)

        @contextlib.contextmanager
        def _cm():
            yield io.StringIO()
        return _cm()


def _run_runner(mod, process_run):
    """Run the SDK runner.main() with a fake process class; return captured marker writes + exit code."""
    cap = _CaptureFsspec()

    class _FakeEP:
        name = "mytype"

        def load(self):
            return types.SimpleNamespace(run=staticmethod(process_run))

    env = {
        "PROCESS_TYPE": "mytype", "PROCESS_ID": "proc-9", "VERSION": "3", "PROJECT_ID": "p1",
        "PARAMETERS_JSON": "{}", "BACKEND_URL": "http://b", "STORAGE_BASE": "s3://bucket",
        "STORAGE_KWARGS_JSON": "{}",
    }
    with mock.patch.dict(os.environ, env, clear=False), \
         mock.patch.object(mod, "fsspec", cap), \
         mock.patch.object(mod, "get_entry_points", lambda group: [_FakeEP()]):
        try:
            mod.main()
            code = 0
        except SystemExit as e:
            code = e.code
    return cap.opened, code


def test_sdk_writes_marker_on_success():
    mod = _load_runner_module()
    opened, code = _run_runner(mod, lambda storage_context=None, **kw: {"outputs": {}})
    assert code == 0
    assert "s3://bucket/processes/proc-9/3/info.json" in opened, f"marker not written on success: {opened}"


def test_sdk_no_marker_on_failure():
    mod = _load_runner_module()

    def _boom(storage_context=None, **kw):
        raise ValueError("process failed")

    opened, code = _run_runner(mod, _boom)
    assert code == 1
    assert opened == [], f"no marker may be written on the failure path: {opened}"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-q"]))

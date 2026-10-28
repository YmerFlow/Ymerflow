#!/usr/bin/env python
"""End-to-end stress driver for the DB connection-pool fix.

This is the validation gate for docs/plans/db-pool-commit-before-k8s-io.md. It drives a LIVE
deployment over HTTP — it is NOT a unit test and must run against the real stack:

  * a **Postgres-backed** backend with the prod-like 5 + 10 pool. The dev default
    (`sqlite:///`, backend/config.py) uses a different async pool and will NOT reproduce the
    `QueuePool ... timeout` failure — running this against SQLite proves nothing about the bug.
  * a running cluster (minikube/prod-like) so jobs actually get scheduled.

What it does (see the plan's "Local validation" section):

  1. Select or create a project + environment.
  2. Burst-create N (default 25) XYZ-import processes pointed at garbage input. Every job is
     EXPECTED to end `failed` — that still drives run_task → monitor_job → _wait_for_pod →
     _handle_job_completion(failed) + the log stream, exercising the connection-holding paths.
  3. Concurrently, for the whole run, hammer the HTTP API and the Group-C storage/file
     endpoints, asserting none 500 / time out.
  4. Poll every job to terminal, then check the FAILURE MODE (see below).

Pass / fail — the failure *mode* is the signal:
  GOOD: every job reaches `failed` via the normal path with a log explaining the input problem;
        every API/file request succeeds.
  BAD : any `QueuePool limit ... TimeoutError` / `Job monitoring failed: ... QueuePool` in any
        job log; any create or API/file request returning 500 / timeout during the burst; any
        job stuck `queued`/`starting`; any orphaned pod after its job is terminal.

Run it on today's code first (expect RED), then after the fix (expect GREEN).

Config via env vars (or flags):
  YF_BASE_URL        API base URL                (default http://localhost:8000)
  YF_TOKEN           Bearer token (JWT / apk_)   (required unless YF_USERNAME/YF_PASSWORD given)
  YF_USERNAME        username to log in with      (used to mint a token when YF_TOKEN unset)
  YF_PASSWORD        password to log in with
  YF_PROJECT_ID      existing project to use      (default: create a throwaway project)
  YF_ENVIRONMENT_ID  environment to run in        (default: first env the project can read)
  YF_PROCESS_TYPE    import process type name     (default: an env type whose name has "import")
  YF_N_JOBS          jobs to burst                (default 25)
  YF_FILE_URLS       comma-separated /files/... or /uploads/... paths to hammer (Group C)
  YF_TIMEOUT         per-request timeout seconds  (default 30, matching pool_timeout)
  YF_POLL_SECONDS    max seconds to wait for all jobs terminal (default 900)

Example:
  YF_TOKEN=apk_... YF_BASE_URL=https://ymerflow.earth YF_N_JOBS=30 \
    env/bin/python backend/stress/stress_pool.py
"""
import argparse
import asyncio
import os
import sys
import time
import uuid

import httpx

TERMINAL = {"done", "failed"}


def _cfg(args):
    return {
        "base_url": (args.base_url or os.environ.get("YF_BASE_URL", "http://localhost:8000")).rstrip("/"),
        "token": args.token or os.environ.get("YF_TOKEN"),
        "username": os.environ.get("YF_USERNAME"),
        "password": os.environ.get("YF_PASSWORD"),
        "project_id": args.project_id or os.environ.get("YF_PROJECT_ID"),
        "environment_id": args.environment_id or os.environ.get("YF_ENVIRONMENT_ID"),
        "process_type": args.process_type or os.environ.get("YF_PROCESS_TYPE"),
        "n_jobs": int(args.n_jobs or os.environ.get("YF_N_JOBS", "25")),
        "file_urls": [u for u in (args.file_urls or os.environ.get("YF_FILE_URLS", "")).split(",") if u.strip()],
        "timeout": float(os.environ.get("YF_TIMEOUT", "30")),
        "poll_seconds": float(os.environ.get("YF_POLL_SECONDS", "900")),
    }


class Findings:
    """Collects every BAD signal; a run is GREEN iff this stays empty."""

    def __init__(self):
        self.errors = []

    def bad(self, msg):
        self.errors.append(msg)
        print(f"  BAD: {msg}", flush=True)

    def ok(self, msg):
        print(f"  ok : {msg}", flush=True)


async def _get_json(client, path, findings, label):
    try:
        r = await client.get(path)
    except Exception as e:
        findings.bad(f"{label} {path} raised {type(e).__name__}: {e}")
        return None
    if r.status_code >= 500:
        findings.bad(f"{label} {path} -> {r.status_code}")
        return None
    return r


async def ensure_project(client, cfg, findings):
    if cfg["project_id"]:
        return cfg["project_id"]
    name = f"stress-pool-{uuid.uuid4().hex[:8]}"
    r = await client.post("/projects", json={"name": name})
    if r.status_code >= 300:
        findings.bad(f"could not create project: {r.status_code} {r.text[:200]}")
        sys.exit(2)
    pid = r.json()["id"]
    print(f"created project {pid} ({name})", flush=True)
    return pid


async def ensure_environment(client, cfg, project_id, findings):
    if cfg["environment_id"]:
        return cfg["environment_id"]
    r = await client.get("/environments", params={"project_id": project_id})
    if r.status_code >= 300:
        findings.bad(f"could not list environments: {r.status_code}")
        sys.exit(2)
    envs = r.json()
    if not envs:
        findings.bad("no environments available to run jobs in")
        sys.exit(2)
    return envs[0]["id"]


async def pick_process_type(client, cfg, env_id, findings):
    if cfg["process_type"]:
        return cfg["process_type"]
    r = await client.get(f"/environments/{env_id}/process-types")
    if r.status_code >= 300:
        findings.bad(f"could not list process types: {r.status_code}")
        sys.exit(2)
    types = r.json()
    names = list(types.keys()) if isinstance(types, dict) else [t.get("type") or t.get("name") for t in types]
    for n in names:
        if n and "import" in n.lower():
            return n
    if names:
        return names[0]
    findings.bad("environment exposes no process types")
    sys.exit(2)


async def burst_create(client, cfg, project_id, env_id, ptype, findings):
    """Burst-create N import jobs pointed at a garbage input URL. 500/timeout on create is BAD."""
    bogus_input = f"{cfg['base_url']}/files/nonexistent-bucket/does-not-exist-{uuid.uuid4().hex}.xyz"

    async def _one(i):
        body = {
            "name": f"stress-{i}-{uuid.uuid4().hex[:6]}",
            "type": ptype,
            "environment": {"id": env_id},
            # Bad input on purpose: the job fails, which is fine — it still exercises the full
            # run_task/monitor/completion path. input_data is the conventional dataset field name;
            # unknown extra params are harmless for this purpose.
            "parameters": {"input_data": bogus_input},
        }
        try:
            r = await client.post(f"/projects/{project_id}/process", json=body)
        except Exception as e:
            findings.bad(f"create #{i} raised {type(e).__name__}: {e}")
            return None
        if r.status_code >= 500:
            findings.bad(f"create #{i} -> {r.status_code} {r.text[:150]}")
            return None
        if r.status_code >= 300:
            # 4xx (e.g. schema rejects our minimal params) is a driver/config issue, not the bug.
            print(f"  note: create #{i} -> {r.status_code} {r.text[:150]}", flush=True)
            return None
        return r.json()["id"]

    ids = await asyncio.gather(*[_one(i) for i in range(cfg["n_jobs"])])
    ids = [i for i in ids if i]
    print(f"burst-created {len(ids)}/{cfg['n_jobs']} processes", flush=True)
    return ids


async def hammer(client, cfg, project_id, proc_ids, findings, stop_evt):
    """For the whole run: list/get/edit-save + Group-C file reads. Any 500/timeout is BAD."""
    rounds = 0
    while not stop_evt.is_set():
        rounds += 1
        await _get_json(client, f"/projects/{project_id}/processes", findings, "list")
        if proc_ids:
            pid = proc_ids[rounds % len(proc_ids)]
            await _get_json(client, f"/projects/{project_id}/process/{pid}", findings, "get")
            # Edit save (a real write through get_db): save a FlowView node position.
            try:
                r = await client.patch(
                    f"/projects/{project_id}/process/{pid}/position",
                    json={"flow_x": float(rounds % 100), "flow_y": float(rounds % 50)},
                )
                if r.status_code >= 500:
                    findings.bad(f"edit-save {pid} -> {r.status_code}")
            except Exception as e:
                findings.bad(f"edit-save {pid} raised {type(e).__name__}: {e}")
        # Group C: file/storage reads.
        for fu in cfg["file_urls"]:
            path = fu if fu.startswith("/") else "/" + fu
            await _get_json(client, path, findings, "file")
        await asyncio.sleep(0.25)
    print(f"hammer ran {rounds} rounds", flush=True)


async def poll_terminal(client, cfg, project_id, proc_ids, findings):
    deadline = time.monotonic() + cfg["poll_seconds"]
    states = {}
    while time.monotonic() < deadline:
        r = await _get_json(client, f"/projects/{project_id}/processes", findings, "poll-list")
        if r is None:
            await asyncio.sleep(2)
            continue
        by_id = {p["id"]: p for p in r.json()}
        states = {}
        for pid in proc_ids:
            p = by_id.get(pid, {})
            states[pid] = (p.get("latest_state") or "unknown")
        remaining = [pid for pid, s in states.items() if s not in TERMINAL]
        print(f"  terminal {len(proc_ids) - len(remaining)}/{len(proc_ids)} "
              f"(remaining states: {sorted({states[p] for p in remaining})})", flush=True)
        if not remaining:
            return states
        await asyncio.sleep(5)
    # Timed out
    stuck = {pid: s for pid, s in states.items() if s not in TERMINAL}
    for pid, s in stuck.items():
        findings.bad(f"job {pid} stuck in '{s}' after {cfg['poll_seconds']}s")
    return states


async def check_failure_mode(client, cfg, project_id, proc_ids, states, findings):
    """Every job should be `failed` via the normal path — never via a QueuePool monitoring error."""
    for pid in proc_ids:
        r = await _get_json(client, f"/projects/{project_id}/process/{pid}/logs", findings, "logs")
        if r is None:
            continue
        payload = r.json()
        entries = payload if isinstance(payload, list) else payload.get("logs", payload)
        text = " \n".join(
            (e.get("message", "") if isinstance(e, dict) else str(e)) for e in entries
        ) if isinstance(entries, list) else str(entries)
        low = text.lower()
        if "queuepool" in low:
            findings.bad(f"job {pid} log contains QueuePool error")
        if "job monitoring failed" in low:
            findings.bad(f"job {pid} log contains 'Job monitoring failed'")


async def _login(cfg):
    """Mint a JWT from username/password via POST /login when no token was supplied."""
    async with httpx.AsyncClient(base_url=cfg["base_url"], timeout=cfg["timeout"]) as c:
        r = await c.post("/login", json={"username": cfg["username"], "password": cfg["password"]})
        r.raise_for_status()
        return r.json()["access_token"]


async def run(cfg):
    if not cfg["token"]:
        if cfg["username"] and cfg["password"]:
            cfg["token"] = await _login(cfg)
        else:
            print("ERROR: set YF_TOKEN, or YF_USERNAME+YF_PASSWORD.", file=sys.stderr)
            sys.exit(2)

    findings = Findings()
    headers = {"Authorization": f"Bearer {cfg['token']}"}
    async with httpx.AsyncClient(base_url=cfg["base_url"], headers=headers,
                                 timeout=cfg["timeout"]) as client:
        print(f"== stress_pool against {cfg['base_url']} ==", flush=True)
        project_id = await ensure_project(client, cfg, findings)
        env_id = await ensure_environment(client, cfg, project_id, findings)
        ptype = await pick_process_type(client, cfg, env_id, findings)
        print(f"project={project_id} env={env_id} type={ptype} n_jobs={cfg['n_jobs']}", flush=True)

        proc_ids = await burst_create(client, cfg, project_id, env_id, ptype, findings)

        stop_evt = asyncio.Event()
        hammer_task = asyncio.create_task(hammer(client, cfg, project_id, proc_ids, findings, stop_evt))
        try:
            states = await poll_terminal(client, cfg, project_id, proc_ids, findings)
        finally:
            stop_evt.set()
            await hammer_task

        await check_failure_mode(client, cfg, project_id, proc_ids, states, findings)

    print("\n== RESULT ==", flush=True)
    if findings.errors:
        print(f"RED — {len(findings.errors)} bad signal(s):", flush=True)
        for e in findings.errors:
            print(f"  - {e}", flush=True)
        print("\nReminder: a run against SQLite proves nothing — this gate requires Postgres.", flush=True)
        return 1
    print("GREEN — every job terminal via the normal path; no 500s/timeouts; no QueuePool errors.", flush=True)
    print("Still verify out-of-band: `kubectl -n ymerflow-jobs get pods` is clean, and "
          "`SELECT state,count(*) FROM pg_stat_activity GROUP BY state` shows no growing "
          "'idle in transaction' set.", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="DB pool stress driver (see module docstring).")
    ap.add_argument("--base-url")
    ap.add_argument("--token")
    ap.add_argument("--project-id")
    ap.add_argument("--environment-id")
    ap.add_argument("--process-type")
    ap.add_argument("--n-jobs")
    ap.add_argument("--file-urls", help="comma-separated /files/... or /uploads/... paths")
    args = ap.parse_args()
    sys.exit(asyncio.run(run(_cfg(args))))


if __name__ == "__main__":
    main()

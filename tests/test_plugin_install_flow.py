"""End-to-end test of the frontend-plugin user-install lifecycle WITHOUT a Kubernetes cluster.

Exercises the whole chain:

    build (local, via ymerflow_plugin_build)
      -> write built dist/ as an output dataset in a (file://) project bucket
      -> POST /plugins (register)  -> Plugin + PluginVersion rows, content_hash, latest_version_id
      -> POST /plugins/{id}/enable -> UserPlugin pinned to latest version
      -> GET  /plugins/me          -> source 'remote', base_url /plugin-assets/{hash}/
      -> GET  /plugin-assets/{hash}/remoteEntry.js -> streams the built remote

Run with:  env/bin/python tests/test_plugin_install_flow.py
(self-contained; uses an in-memory sqlite DB and a file:// storage bucket — no MinIO, no k8s).
"""

import asyncio
import json
import os
import sys
import tempfile
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)


async def amain():
    # --- 1. Build the plugin locally from a server-local npm source dir --------------------------
    from ymerflow_plugin_build import build_frontend

    work = tempfile.mkdtemp(prefix="nf-plugin-e2e-")
    src_pkg = os.path.join(work, "srcplugin")
    npm_src = os.path.join(work, "npmsrc")
    dist = os.path.join(work, "dist")
    os.makedirs(os.path.join(src_pkg, "src"))
    os.makedirs(npm_src)

    with open(os.path.join(src_pkg, "package.json"), "w") as f:
        json.dump({
            "name": "e2e-user-plugin",
            "version": "1.0.0",
            "peerDependencies": {"react": "^18.2.0", "react-dom": "^18.2.0"},
            "ymerflow": {"remoteName": "e2e_user_plugin", "entry": "src/index.jsx"},
        }, f)
    with open(os.path.join(src_pkg, "src", "index.jsx"), "w") as f:
        f.write(
            "import W from './W'\n"
            "if (typeof window !== 'undefined' && window.__ymerflow_registerHook)\n"
            "  window.__ymerflow_registerHook('widgets', () => [{ name: 'E2EWidget', component: W }])\n"
        )
    with open(os.path.join(src_pkg, "src", "W.jsx"), "w") as f:
        f.write("import React from 'react'\nexport default function W(){return <div>e2e</div>}\n")

    import subprocess
    subprocess.run(["npm", "pack", "--pack-destination", npm_src, src_pkg], check=True,
                   capture_output=True)
    build_result = build_frontend("e2e-user-plugin", "1.0.0", dist, npm_source_dir=npm_src)
    assert os.path.exists(os.path.join(dist, "remoteEntry.js")), "build produced no remoteEntry.js"
    assert build_result["remote_name"] == "e2e_user_plugin"
    print("[1] build OK — remote_name=%s built_against=%s"
          % (build_result["remote_name"], build_result["built_against"]))

    # --- 2. Point storage at a local file:// bucket and write the dist as a dataset --------------
    from backend.config import settings
    bucket_root = os.path.join(work, "buckets")
    os.makedirs(bucket_root)
    settings.storage_protocol = "file"
    settings.storage_endpoint = None
    settings.storage_bucket_prefix = bucket_root.rstrip("/") + "/bucket-"
    settings.backend_base_url = "http://test"

    project_id = "proj-e2e"
    process_id = "proc-e2e"
    process_version = 1
    dataset_id = "ds-e2e"

    from backend.services.storage_service import get_storage_base_url
    storage_base = get_storage_base_url(project_id)
    ds_prefix = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}"
    ds_dir = ds_prefix.split("://", 1)[1]
    # copy dist tree into the dataset dir
    for root, _d, files in os.walk(dist):
        for fn in files:
            lp = os.path.join(root, fn)
            rel = os.path.relpath(lp, dist)
            dest = os.path.join(ds_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(lp, dest)
    print("[2] wrote dataset to %s" % ds_dir)

    # --- 3. Fresh in-memory sqlite with all tables ----------------------------------------------
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
    import backend.models  # registers all models + billing hooks
    from backend.database import Base
    from backend.models import (User, Project, ProjectMember, Process, ProcessVersion,
                                 Dataset, Environment)
    from backend.models.process import ProcessState

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        user = User(username="alice", email="a@x.com", password_hash="x", is_admin=False)
        db.add(user)
        await db.flush()
        project = Project(id=project_id, name="E2E")
        db.add(project)
        db.add(ProjectMember(project_id=project_id, user_id=user.id))
        env = Environment(id="env-e2e", name="env", docker_image="img")
        db.add(env)
        proc = Process(id=process_id, name="build", type="build_frontend_plugin",
                       project_id=project_id, environment_id="env-e2e")
        db.add(proc)
        await db.flush()
        pv = ProcessVersion(process_id=process_id, version=process_version,
                            parameters={}, state=ProcessState.DONE)
        db.add(pv)
        await db.flush()
        ds = Dataset(id=dataset_id, mime_type="application/x-mf-remote",
                     process_id=process_id, process_name="build",
                     process_version_id=pv.id, dataset_name="dist",
                     project_id=project_id,
                     parts={"files": {"application/x-mf-remote": f"{ds_prefix}/remoteEntry.js"}})
        db.add(ds)
        await db.commit()
        user_id = user.id
    print("[3] DB seeded")

    # AuthContext shim
    class Auth:
        def __init__(self, u):
            self.user = u
            self.api_key_project_id = None

    from backend.routers import plugins as P

    # --- 4. Register ----------------------------------------------------------------------------
    async with Session() as db:
        user = await db.get(User, user_id)
        req = P.PluginRegisterRequest(process_id=process_id, process_version=process_version,
                                      scope="user", display_name="E2E User Plugin")
        reg = await P.register_plugin(req, db=db, auth=Auth(user))
    assert reg["name"] == "e2e_user_plugin", reg
    assert reg["base_url"].startswith("/plugin-assets/"), reg
    plugin_id = reg["id"]
    content_hash = reg["content_hash"]
    print("[4] register OK — plugin_id=%s hash=%s" % (plugin_id, content_hash))

    # Re-register identical build is a no-op (same content_hash, same version)
    async with Session() as db:
        user = await db.get(User, user_id)
        reg2 = await P.register_plugin(
            P.PluginRegisterRequest(process_id=process_id, process_version=process_version,
                                    scope="user"),
            db=db, auth=Auth(user))
        from backend.models.plugin import PluginVersion
        from sqlalchemy import select, func
        n = (await db.execute(select(func.count()).select_from(PluginVersion))).scalar()
    assert reg2["content_hash"] == content_hash
    assert n == 1, f"expected idempotent re-register, got {n} versions"
    print("[5] idempotent re-register OK — still 1 PluginVersion")

    # --- 6. Enable ------------------------------------------------------------------------------
    async with Session() as db:
        user = await db.get(User, user_id)
        en = await P.enable_plugin(plugin_id, db=db, auth=Auth(user))
    assert en["status"] == "enabled"
    print("[6] enable OK")

    # --- 7. /plugins/me -------------------------------------------------------------------------
    class FakeReq:
        class app:
            class state:
                backend_frontend_plugins = []
    async with Session() as db:
        user = await db.get(User, user_id)
        me = await P.get_my_plugins(FakeReq(), db=db, auth=Auth(user))
    remote = [p for p in me if p["source"] == "remote"]
    assert remote and remote[0]["name"] == "e2e_user_plugin", me
    assert remote[0]["base_url"] == f"/plugin-assets/{content_hash}/", remote
    assert remote[0]["upgrade_available"] is False
    print("[7] /plugins/me OK — %s" % remote[0])

    # --- 8. Serve the remoteEntry.js ------------------------------------------------------------
    async with Session() as db:
        resp = await P.serve_plugin_asset(content_hash, "remoteEntry.js", FakeReq(), db=db)
    # StreamingResponse exposes an async body_iterator
    body = b""
    async for chunk in resp.body_iterator:
        body += chunk if isinstance(chunk, bytes) else chunk.encode()
    assert b"" is not None and len(body) > 0, "served empty remoteEntry.js"
    assert resp.media_type in ("text/javascript", "application/javascript"), resp.media_type
    print("[8] serve OK — remoteEntry.js %d bytes, media_type=%s" % (len(body), resp.media_type))

    await engine.dispose()
    shutil.rmtree(work, ignore_errors=True)
    print("\nALL STEPS PASSED — frontend-plugin user-install path works end-to-end.")


if __name__ == "__main__":
    asyncio.run(amain())

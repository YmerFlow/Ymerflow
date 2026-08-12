"""Background job that packs a project (processes, versions, output datasets, uploads, tags)
into a downloadable zip archive. See docs/plans/done/project-export-import.md.
"""
import asyncio
import json
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime

import fsspec
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backend.database import async_session_maker
from backend.models import (
    Process, ProcessVersion, ProcessLog, ProcessTag, Environment, Upload, ProcessState,
)
from backend.models.project import Project
from backend.models.project_export import ProjectExport
from backend.services.storage_service import get_storage_base_url, get_fsspec_storage_options
from backend.services.websocket_service import ws_manager

logger = logging.getLogger(__name__)


def _dataset_zip_relative_parts(process_id: str, dataset_id: str, parts: dict, file_copy_jobs: list) -> dict:
    """Rewrite a Dataset.parts JSON tree, replacing every storage URL with a zip-relative
    path ("./processes/{process_id}/datasets/{dataset_id}/...") and appending
    (zip_path, source_storage_url) to file_copy_jobs for each one found.
    """
    def _walk(node):
        if isinstance(node, dict):
            return {k: _walk(v) for k, v in node.items()}
        elif isinstance(node, str) and "://" in node:
            marker = f"/datasets/{dataset_id}/"
            if marker in node:
                rel = node.split(marker, 1)[1]
            else:
                rel = node.rsplit("/", 1)[-1]
            zip_path = f"processes/{process_id}/datasets/{dataset_id}/{rel}"
            file_copy_jobs.append((zip_path, node))
            return f"./{zip_path}"
        else:
            return node

    return _walk(parts or {})


async def _build_manifest(db, project_id: str):
    """Return (manifest_dict, file_copy_jobs) where file_copy_jobs is a list of
    (zip_relative_path, source_storage_url) tuples for every blob to stream into the zip.
    """
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one()

    stmt = (
        select(Process)
        .options(
            selectinload(Process.environment),
            selectinload(Process.versions).selectinload(ProcessVersion.datasets),
            selectinload(Process.versions).selectinload(ProcessVersion.tags),
        )
        .where(Process.project_id == project_id)
        .order_by(Process.created_at)
    )
    processes = (await db.execute(stmt)).scalars().all()

    tags = (await db.execute(
        select(ProcessTag).where(ProcessTag.project_id == project_id).order_by(ProcessTag.name)
    )).scalars().all()

    file_copy_jobs = []
    environments_by_id = {}
    process_entries = []

    for process in processes:
        env = process.environment
        if env is not None and env.id not in environments_by_id:
            environments_by_id[env.id] = {
                "id": env.id,
                "name": env.name,
                "docker_image": env.docker_image,
                "process_types": env.process_types,
            }

        version_entries = []
        for version in sorted(process.versions, key=lambda v: v.version):
            logs = (await db.execute(
                select(ProcessLog)
                .where(ProcessLog.process_id == process.id, ProcessLog.version == version.version)
                .order_by(ProcessLog.timestamp)
            )).scalars().all()
            log_entries = [log.to_dict() for log in logs]

            state = version.state.value
            if version.state in (ProcessState.QUEUED, ProcessState.RUNNING):
                # Design Decision 6: no K8s job survives export — record as failed history,
                # never resumed on import. Only the manifest is rewritten; the source
                # project's actual row is untouched.
                state = ProcessState.FAILED.value
                log_entries = log_entries + [{
                    "timestamp": datetime.utcnow().isoformat(),
                    "message": "Interrupted by export",
                }]

            dataset_entries = []
            for dataset in version.datasets:
                rewritten_parts = _dataset_zip_relative_parts(
                    process.id, dataset.id, dataset.parts, file_copy_jobs
                )
                dataset_entries.append({
                    "id": dataset.id,
                    "dataset_name": dataset.dataset_name,
                    "mime_type": dataset.mime_type,
                    "parts": rewritten_parts,
                })

            version_entries.append({
                "version": version.version,
                "state": state,
                "parameters": version.parameters,
                "dependencies": version.dependencies,
                "resource_requests": version.resource_requests,
                "deadline_seconds": version.deadline_seconds,
                "tags": [t.id for t in version.tags],
                "tags_history": version.tags_history,
                "logs": log_entries,
                "datasets": dataset_entries,
            })

        process_entries.append({
            "id": process.id,
            "name": process.name,
            "type": process.type,
            "environment_id": process.environment_id,
            "flow_x": process.flow_x,
            "flow_y": process.flow_y,
            "versions": version_entries,
        })

    # Uploads aren't project_id-queryable (backend/models/upload.py has no such column) —
    # discover them by listing the bucket, then look up each id's row for metadata.
    storage_base = await get_storage_base_url(db, project_id)
    storage_options = await get_fsspec_storage_options(db, project_id)
    fs = fsspec.filesystem(storage_base.split("://", 1)[0], **storage_options)
    uploads_prefix = f"{storage_base}/uploads/".split("://", 1)[1]

    upload_entries = []
    try:
        upload_dirs = [item for item in fs.ls(uploads_prefix, detail=True) if item.get("type") == "directory"]
    except FileNotFoundError:
        upload_dirs = []

    if upload_dirs:
        upload_ids = {item["name"].rstrip("/").rsplit("/", 1)[-1] for item in upload_dirs}
        uploads = (await db.execute(
            select(Upload).where(Upload.id.in_(upload_ids))
        )).scalars().all()
        for upload in uploads:
            zip_path = f"uploads/{upload.id}/{upload.filename}"
            file_copy_jobs.append((zip_path, upload.file_url))
            upload_entries.append({
                "id": upload.id,
                "filename": upload.filename,
                "content_type": upload.content_type,
                "path": f"./{zip_path}",
            })

    manifest = {
        "format_version": 1,
        "exported_at": datetime.utcnow().isoformat(),
        "project": {"name": project.name},
        "environments": list(environments_by_id.values()),
        "process_tags": [t.to_dict() for t in tags],
        "processes": process_entries,
        "uploads": upload_entries,
    }
    return manifest, file_copy_jobs


async def run_export(project_id: str, export_id: str):
    async with async_session_maker() as db:
        export_row = (await db.execute(
            select(ProjectExport).where(ProjectExport.id == export_id)
        )).scalar_one_or_none()
        if export_row is None:
            logger.error(f"ProjectExport not found: {export_id}")
            return

        try:
            export_row.state = "running"
            await db.commit()
            await ws_manager.broadcast_state({"type": "project_export", "id": export_id, "state": "running"})

            manifest, file_copy_jobs = await _build_manifest(db, project_id)

            storage_base = await get_storage_base_url(db, project_id)
            storage_options = await get_fsspec_storage_options(db, project_id)
            scheme = storage_base.split("://", 1)[0]
            fs = fsspec.filesystem(scheme, **storage_options)
            zip_storage_url = f"{storage_base}/exports/{export_id}/export.zip"

            def _build_and_upload_zip():
                tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip")
                os.close(tmp_fd)
                try:
                    with zipfile.ZipFile(tmp_path, "w", allowZip64=True) as zf:
                        manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
                        zf.writestr("manifest.json", manifest_bytes, compress_type=zipfile.ZIP_DEFLATED)

                        now_tuple = datetime.utcnow().timetuple()[:6]
                        for zip_path, source_storage_url in file_copy_jobs:
                            src_path = source_storage_url.split("://", 1)[1]
                            zinfo = zipfile.ZipInfo(zip_path, date_time=now_tuple)
                            zinfo.compress_type = zipfile.ZIP_STORED
                            with fs.open(src_path, "rb") as src, zf.open(zinfo, "w") as dst:
                                shutil.copyfileobj(src, dst, length=1024 * 1024)

                    with open(tmp_path, "rb") as zf_file, fsspec.open(
                        zip_storage_url, "wb", **storage_options
                    ) as out:
                        shutil.copyfileobj(zf_file, out, length=1024 * 1024)
                finally:
                    os.remove(tmp_path)

            await asyncio.to_thread(_build_and_upload_zip)

            export_row.state = "done"
            export_row.file_url = zip_storage_url
            export_row.completed_at = datetime.utcnow()
            await db.commit()
            await ws_manager.broadcast_state({"type": "project_export", "id": export_id, "state": "done"})

        except Exception as e:
            logger.error(f"Project export failed: {export_id} - {e}", exc_info=True)
            try:
                async with async_session_maker() as fresh_db:
                    row = (await fresh_db.execute(
                        select(ProjectExport).where(ProjectExport.id == export_id)
                    )).scalar_one_or_none()
                    if row is not None:
                        row.state = "failed"
                        row.error = str(e)
                        await fresh_db.commit()
                await ws_manager.broadcast_state({"type": "project_export", "id": export_id, "state": "failed"})
            except Exception as inner_e:
                logger.error(f"Failed to record export failure for {export_id}: {inner_e}", exc_info=True)

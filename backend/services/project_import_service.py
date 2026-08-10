"""Background job that unpacks a project export zip into a brand-new project on this
installation. See docs/plans/done/project-export-import.md (Design Decisions 2, 5-8).
"""
import asyncio
import copy
import io
import json
import logging
import re
import uuid
import zipfile
from datetime import datetime
from urllib.parse import urlparse

import fsspec
from sqlalchemy import select, insert

from backend.database import async_session_maker
from backend.models import (
    Process, ProcessVersion, ProcessLog, ProcessTag, Environment, Dataset, Upload, User, ProcessState,
)
from backend.models.process import process_version_tags_table
from backend.models.project import Project, ProjectMember
from backend.models.storage_backend import get_allowed_storage_backends
from backend.models.project_export import ProjectImport
from backend.services.storage_service import (
    get_storage_base_url, get_fsspec_storage_options, resolve_bucket,
    storage_url_to_http_url, translate_urls_in_dict,
)
from backend.services.storage_credentials import ensure_ready
from backend.services.websocket_service import ws_manager

logger = logging.getLogger(__name__)

_PATH_TOKEN_RE = re.compile(r'([^.\[\]]+)|\[(\d+)\]')


def _set_path_value(root, path, value):
    """Set a value at a dotted/indexed path built by Process.extract_dependencies
    (e.g. "input_data" or "a.b[2].c")."""
    tokens = []
    for m in _PATH_TOKEN_RE.finditer(path):
        tokens.append(m.group(1) if m.group(1) is not None else int(m.group(2)))
    obj = root
    for t in tokens[:-1]:
        obj = obj[t]
    obj[tokens[-1]] = value


def _dataset_url(mime_type, parts):
    """Mirrors Dataset.to_dict()'s url derivation, on a parts dict of storage URLs."""
    if "files" in parts:
        return parts.get("files", {}).get(mime_type)
    elif "" in parts:
        root_part = parts.get("")
        return root_part.get("file_url") if root_part else None
    return None


def _resolve_zip_entry(zip_path: str) -> str:
    return zip_path[2:] if zip_path.startswith("./") else zip_path


async def _do_import(db, import_row: ProjectImport, manifest: dict, zf: zipfile.ZipFile, created: dict) -> str:
    """created is a mutable out-param: created['project_id'] is set the moment the Project row
    is committed, so run_import can find (and clean up) it even if we raise before returning —
    e.g. mid-way through storage provisioning or blob copying.
    """
    user = (await db.execute(select(User).where(User.id == import_row.created_by_id))).scalar_one()

    allowed_backends = await get_allowed_storage_backends(db, user)
    if not allowed_backends:
        raise RuntimeError("No storage backend available to create the imported project against")
    backend = allowed_backends[0]

    project = Project(
        id=str(uuid.uuid4()),
        name=manifest.get("project", {}).get("name", "Imported Project"),
        created_at=datetime.utcnow(),
        storage_status="pending",
        storage_backend_id=backend.id,
    )
    db.add(project)

    # Design Decision 5: importing user becomes sole owner — source ProjectMember/ProjectInvite
    # rows aren't even in the manifest.
    db.add(ProjectMember(project_id=project.id, user_id=user.id, joined_at=datetime.utcnow()))
    await db.commit()
    created["project_id"] = project.id

    await ensure_ready(db, project)
    project.storage_status = "ready"
    await db.commit()

    target_storage_base = await get_storage_base_url(db, project.id)
    target_scheme = target_storage_base.split("://", 1)[0]
    storage_options = await get_fsspec_storage_options(db, project.id)

    # --- Design Decision 2: match Environment by name, auto-create if missing ---
    env_id_map = {}
    for env in manifest.get("environments", []):
        existing = (await db.execute(
            select(Environment).where(Environment.name == env["name"])
        )).scalars().first()
        if existing is not None:
            env_id_map[env["id"]] = existing.id
        else:
            new_env = Environment(
                id=str(uuid.uuid4()),
                name=env["name"],
                docker_image=env["docker_image"],
                process_types=env.get("process_types"),
            )
            db.add(new_env)
            env_id_map[env["id"]] = new_env.id

    # --- Process tags ---
    tag_id_map = {}
    for tag in manifest.get("process_tags", []):
        new_tag = ProcessTag(
            id=str(uuid.uuid4()),
            project_id=project.id,
            name=tag["name"],
            color=tag.get("color", "#6c757d"),
        )
        db.add(new_tag)
        tag_id_map[tag["id"]] = new_tag.id

    # --- Pass 1: create Process/ProcessVersion/Dataset rows with placeholder ids, compute
    # final blob destinations (pure string work, no I/O yet) ---
    dataset_id_map = {}
    dataset_url_map = {}  # new_dataset_id -> new HTTP url
    file_copy_jobs = []  # (zip_path, dest_storage_url)
    pending_versions = []  # (ProcessVersion row, src_dependencies, src_parameters_http)

    for proc in manifest.get("processes", []):
        new_process = Process(
            id=str(uuid.uuid4()),
            name=proc["name"],
            type=proc["type"],
            environment_id=env_id_map[proc["environment_id"]],
            project_id=project.id,
            flow_x=proc.get("flow_x"),
            flow_y=proc.get("flow_y"),
        )
        db.add(new_process)

        for version in proc.get("versions", []):
            version_row = ProcessVersion(
                process_id=new_process.id,
                version=version["version"],
                parameters=version["parameters"],  # rewritten in pass 2
                state=ProcessState(version["state"]),
                dependencies=[],  # rewritten in pass 2
                resource_requests=version.get("resource_requests"),
                deadline_seconds=version.get("deadline_seconds"),
                tags_history=version.get("tags_history"),
            )
            db.add(version_row)
            await db.flush()  # need version_row.id for datasets/tag links below

            for src_tag_id in version.get("tags", []):
                new_tag_id = tag_id_map.get(src_tag_id)
                if new_tag_id is None:
                    continue
                await db.execute(insert(process_version_tags_table).values(
                    process_version_id=version_row.id,
                    tag_id=new_tag_id,
                    added_at=datetime.utcnow(),
                    added_by="",
                ))

            for log in version.get("logs", []):
                db.add(ProcessLog(
                    process_id=new_process.id,
                    version=version["version"],
                    timestamp=datetime.fromisoformat(log["timestamp"]),
                    message=log["message"],
                ))

            for ds in version.get("datasets", []):
                new_dataset_id = str(uuid.uuid4())
                dataset_id_map[ds["id"]] = new_dataset_id

                def _rewrite(node):
                    if isinstance(node, dict):
                        return {k: _rewrite(v) for k, v in node.items()}
                    elif isinstance(node, str) and node.startswith("./"):
                        zip_path = node[2:]
                        rel = zip_path.split(f"/datasets/{ds['id']}/", 1)[-1]
                        dest_url = f"{target_storage_base}/processes/{new_process.id}/datasets/{new_dataset_id}/{rel}"
                        file_copy_jobs.append((zip_path, dest_url))
                        return dest_url
                    else:
                        return node

                new_parts = _rewrite(ds["parts"])
                db.add(Dataset(
                    id=new_dataset_id,
                    mime_type=ds["mime_type"],
                    process_id=new_process.id,
                    process_name=proc["name"],
                    process_version_id=version_row.id,
                    dataset_name=ds["dataset_name"],
                    project_id=project.id,
                    parts=new_parts,
                ))
                new_url = _dataset_url(ds["mime_type"], new_parts)
                dataset_url_map[new_dataset_id] = storage_url_to_http_url(new_url) if new_url else None

            pending_versions.append((version_row, version.get("dependencies", []), version["parameters"]))

    # --- Pass 2 (Design Decision 8, step 5): remap dependency dataset ids and regenerate the
    # literal URL string embedded in parameters at each dependency's target_param_name path ---
    for version_row, src_dependencies, src_parameters in pending_versions:
        params = copy.deepcopy(src_parameters)
        new_dependencies = []
        for dep in src_dependencies:
            new_dataset_id = dataset_id_map.get(dep["source_dataset_id"])
            if new_dataset_id is None:
                continue  # dataset wasn't part of the export (shouldn't happen)
            new_url = dataset_url_map.get(new_dataset_id)
            if new_url is not None:
                _set_path_value(params, dep["target_param_name"], new_url)
            new_dependencies.append({
                "source_dataset_id": new_dataset_id,
                "target_param_name": dep["target_param_name"],
            })
        version_row.dependencies = new_dependencies
        version_row.parameters = translate_urls_in_dict(params, to_storage=True, scheme=target_scheme)

    # --- Uploads ---
    for upload in manifest.get("uploads", []):
        new_upload_id = str(uuid.uuid4())
        dest_url = f"{target_storage_base}/uploads/{new_upload_id}/{upload['filename']}"
        file_copy_jobs.append((_resolve_zip_entry(upload["path"]), dest_url))
        db.add(Upload(
            id=new_upload_id,
            filename=upload["filename"],
            content_type=upload["content_type"],
            file_url=dest_url,
        ))

    await db.commit()

    # --- Copy every dataset/upload blob out of the zip into the new project's bucket ---
    def _copy_blobs():
        for zip_path, dest_storage_url in file_copy_jobs:
            with zf.open(_resolve_zip_entry(zip_path)) as src, fsspec.open(
                dest_storage_url, "wb", **storage_options
            ) as dst:
                dst.write(src.read())

    await asyncio.to_thread(_copy_blobs)

    return project.id


async def run_import(import_id: str):
    # created['project_id'] is set by _do_import the moment the Project row is committed, so
    # it's visible here even if _do_import later raises (e.g. mid-way through storage
    # provisioning or blob copying) — needed to clean up the partial project on failure.
    created = {}
    try:
        async with async_session_maker() as db:
            import_row = (await db.execute(
                select(ProjectImport).where(ProjectImport.id == import_id)
            )).scalar_one_or_none()
            if import_row is None:
                logger.error(f"ProjectImport not found: {import_id}")
                return

            import_row.state = "running"
            await db.commit()
            await ws_manager.broadcast_state({"type": "project_import", "id": import_id, "state": "running"})

            upload = (await db.execute(select(Upload).where(Upload.id == import_row.upload_id))).scalar_one_or_none()
            if upload is None:
                raise RuntimeError("Uploaded zip not found")

            bucket = urlparse(upload.file_url).netloc
            src_project, _backend = await resolve_bucket(db, bucket)
            src_storage_options = await get_fsspec_storage_options(db, src_project.id)

            def _read_zip_bytes():
                with fsspec.open(upload.file_url, "rb", **src_storage_options) as f:
                    return f.read()
            zip_bytes = await asyncio.to_thread(_read_zip_bytes)

            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                manifest = json.loads(zf.read("manifest.json"))
                created_project_id = await _do_import(db, import_row, manifest, zf, created)

            import_row.project_id = created_project_id
            import_row.state = "done"
            import_row.completed_at = datetime.utcnow()
            await db.commit()
            await ws_manager.broadcast_state({
                "type": "project_import", "id": import_id, "state": "done", "project_id": created_project_id,
            })

    except Exception as e:
        logger.error(f"Project import failed: {import_id} - {e}", exc_info=True)
        try:
            async with async_session_maker() as db:
                created_project_id = created.get("project_id")
                if created_project_id is not None:
                    # Design Decision 7: import is idempotent-on-retry — a partial Project
                    # (and everything cascaded from it) is deleted rather than left dangling.
                    proj = (await db.execute(
                        select(Project).where(Project.id == created_project_id)
                    )).scalar_one_or_none()
                    if proj is not None:
                        await db.delete(proj)

                import_row = (await db.execute(
                    select(ProjectImport).where(ProjectImport.id == import_id)
                )).scalar_one_or_none()
                if import_row is not None:
                    import_row.state = "failed"
                    import_row.error = str(e)
                    import_row.project_id = None
                    await db.commit()
            await ws_manager.broadcast_state({"type": "project_import", "id": import_id, "state": "failed"})
        except Exception as inner_e:
            logger.error(f"Failed to record import failure for {import_id}: {inner_e}", exc_info=True)

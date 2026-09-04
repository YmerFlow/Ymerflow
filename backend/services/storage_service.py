"""Storage service: resolves a project's StorageBackend and delegates all runtime addressing +
fsspec kwargs to that backend's StorageProtocolHandler.

Runtime storage addressing is per-project. Every read/write path resolves the project's own
StorageBackend (protocol / endpoint / bucket / credentials) through its StorageProtocolHandler —
never the global `settings.storage_*` values, which survive only as the seed for the default
backend row at install time. See docs/plans/per-project-storage-routing.md.

Backend-side (trusted) I/O uses the backend's **admin** credentials, so it may read/write any
project's bucket on that backend; the backend enforces its own access control. The untrusted
pod/runner never goes through this module — it receives project-scoped kwargs built in
`job_orchestrator.py`.
"""
import re
from typing import Any, Dict, Tuple

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backend.config import settings
from backend.models.project import Project, Publication
from backend.models.storage_backend import StorageBackend
from backend.services.storage_protocols import get_protocol_handler


async def resolve_project_backend(db, project_id: str) -> Tuple[Project, StorageBackend]:
    """Load a project and its StorageBackend. Raises if either is missing — storage cannot be
    addressed without a backend."""
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise RuntimeError(f"project {project_id} not found")
    if not project.storage_backend_id:
        raise RuntimeError(f"project {project_id} has no storage backend assigned")
    backend = (
        await db.execute(select(StorageBackend).where(StorageBackend.id == project.storage_backend_id))
    ).scalar_one_or_none()
    if backend is None:
        raise RuntimeError(
            f"project {project_id} references missing storage_backend_id {project.storage_backend_id}"
        )
    return project, backend


async def resolve_bucket(db, bucket_name: str) -> Tuple[Project, StorageBackend]:
    """Reverse-resolve a bucket name (the first path segment of a `/files/` URL) to its owning
    project + backend. A bucket is `<bucket_prefix><project_id>` for every protocol, so the
    embedded id is the join key. Used by the `/files/` proxy and upload download, which are given
    a bucket, not a project.

    The embedded id is normally a real project id, but when a file URL was served through a
    publication link the id is a `pub-`-prefixed Publication id (see
    docs/plans/done/publication-link-id-opacity.md). A `^pub-` id is looked up as a Publication
    and resolves to its real project; a bare id is looked up as a project. Real-project loads
    (the overwhelming majority) never match `^pub-`, so they pay zero added DB work. Legacy
    publications minted before the prefix carry a bare-uuid bucket that no longer matches a
    publication and 404 — accepted, see the plan."""
    result = await db.execute(select(StorageBackend))
    for backend in result.scalars().all():
        prefix = backend.bucket_prefix or ""
        if bucket_name.startswith(prefix):
            embedded_id = bucket_name[len(prefix):]
            if embedded_id.startswith("pub-"):
                publication = (
                    await db.execute(
                        select(Publication)
                        .options(selectinload(Publication.project))
                        .where(Publication.id == embedded_id)
                    )
                ).scalar_one_or_none()
                if publication is not None and publication.project.storage_backend_id == backend.id:
                    return publication.project, backend
                continue
            project = (
                await db.execute(select(Project).where(Project.id == embedded_id))
            ).scalar_one_or_none()
            if project is not None and project.storage_backend_id == backend.id:
                return project, backend
    raise RuntimeError(f"no project/backend owns bucket {bucket_name!r}")


async def get_storage_base_url(db, project_id: str) -> str:
    """The `<scheme>://<bucket>` root for a project's data on its backend."""
    project, backend = await resolve_project_backend(db, project_id)
    return get_protocol_handler(backend.protocol).storage_base_url(project, backend)


async def get_fsspec_storage_options(db, project_id: str) -> Dict[str, Any]:
    """Backend-side (trusted) fsspec kwargs for a project's backend, using **admin** credentials."""
    project, backend = await resolve_project_backend(db, project_id)
    return _admin_fsspec_kwargs(backend)


def _admin_fsspec_kwargs(backend: StorageBackend) -> Dict[str, Any]:
    handler = get_protocol_handler(backend.protocol)
    return handler.fsspec_kwargs(backend, handler.admin_credentials(backend))


async def get_upload_storage_url(db, project_id: str, upload_id: str, filename: str) -> str:
    """Storage URL for an upload file under the project's bucket."""
    base = await get_storage_base_url(db, project_id)
    return f"{base}/uploads/{upload_id}/{filename}"


def storage_url_to_http_url(storage_url: str) -> str:
    """Convert a storage URL to the auth-free HTTP `/files/` URL, stripping whatever scheme it
    carries (s3/gs/az/file — all map to the same `/files/<bucket>/<rest>` shape).

    Examples:
        s3://project-bucket/processes/proc-123/datasets/ds-456/root.msgpack
        -> http://localhost:8000/files/project-bucket/processes/proc-123/datasets/ds-456/root.msgpack
    """
    if storage_url.startswith(('s3://', 'gs://', 'az://', 'file://')):
        match = re.match(r'^(\w+)://(.+)$', storage_url)
        if match:
            path = match.group(2)
            return f"{settings.backend_base_url}/files/{path}"
    return storage_url


def http_url_to_storage_url(http_url: str, scheme: str) -> str:
    """Convert an HTTP `/files/` URL back to a storage URL under the given scheme (the project
    backend's scheme — `s3`, `gs`, …). `scheme` is required because different backends use
    different schemes; the caller resolves it from the project's StorageBackend.
    """
    files_url_prefix = f"{settings.backend_base_url}/files/"
    if http_url.startswith(files_url_prefix):
        path = http_url.replace(files_url_prefix, '')
        return f"{scheme}://{path}"
    return http_url


def translate_urls_in_dict(data: Any, to_storage: bool = True, scheme: str = None) -> Any:
    """Recursively translate URLs in a nested dict/list structure.

    Args:
        data: Dict, list, or primitive value
        to_storage: If True, translate HTTP `/files/` URLs -> storage URLs (needs `scheme`, the
            project backend's URL scheme). If False, translate storage URLs -> HTTP (scheme-agnostic).
        scheme: Required when to_storage=True — the project backend's URL scheme (e.g. "s3", "gs").
    """
    if to_storage and scheme is None:
        raise ValueError("scheme is required when to_storage=True")

    if isinstance(data, dict):
        return {k: translate_urls_in_dict(v, to_storage, scheme) for k, v in data.items()}
    elif isinstance(data, list):
        return [translate_urls_in_dict(item, to_storage, scheme) for item in data]
    elif isinstance(data, str):
        if to_storage:
            files_url_prefix = f"{settings.backend_base_url}/files/"
            if data.startswith(files_url_prefix):
                return http_url_to_storage_url(data, scheme)
            return data
        else:
            if data.startswith(('s3://', 'gs://', 'az://', 'file://')):
                return storage_url_to_http_url(data)
            return data
    else:
        return data

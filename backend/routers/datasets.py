from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, cast, String
from sqlalchemy.orm import selectinload
import asyncio
import mimetypes
import re
import fsspec

from backend.database import get_db
from backend.models import Dataset, ProcessVersion, ProcessState
from backend.services.auth_service import resolve_project_for_read, ProjectReadAccess, redact_project_id
from backend.services.storage_service import get_fsspec_storage_options

router = APIRouter(tags=["Datasets"])


@router.get("/projects/{project_id}/datasets", operation_id="search_datasets", summary="Search for output datasets")
async def search_datasets(
    search: str = "",
    completed_only: bool = True,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Search for datasets produced by completed processing jobs in a project.

    Datasets are the outputs of processes. Each dataset has an 'id', a
    'url' (use in process params as an input), 'dataset_name', 'process_name',
    and 'mime_type'.

    The 'url' field can be downloaded directly with curl — no authentication required:
        curl "{url}" -o /tmp/result.msgpack

    The search string is matched case-insensitively against
    '<process_name> / v<version> / <dataset_name>'. Pass a process name or
    dataset name fragment to narrow results.

    Set completed_only=false to also include datasets from still-running or failed jobs
    (rarely useful).
    """
    stmt = (
        select(Dataset)
        .options(selectinload(Dataset.process_version))
        .join(ProcessVersion, Dataset.process_version_id == ProcessVersion.id)
        .where(Dataset.project_id == access.project.id)
    )

    # Filter by search: case-insensitive substring match against the full display string
    # e.g. "FFT / 1" matches "Super cool FFT / 12 / output"
    if search:
        combined = (
            Dataset.process_name + ' / v' +
            cast(ProcessVersion.version, String) + ' / ' +
            Dataset.dataset_name
        )
        stmt = stmt.where(combined.ilike(f"%{search}%"))

    if completed_only:
        stmt = stmt.where(ProcessVersion.state == ProcessState.DONE)

    result = await db.execute(stmt)
    datasets = result.scalars().all()

    return redact_project_id([d.to_dict() for d in datasets], access)


@router.get("/projects/{project_id}/dataset/{dataset_id}", operation_id="get_dataset", summary="Get dataset metadata")
async def get_dataset(
    dataset_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Return metadata for a specific dataset including its mime_type, parts structure,
    and the process version that produced it.

    The 'url' field in the response is the actual file URL for the dataset's content.
    This URL can be downloaded directly with curl — no authentication is required:
        curl "{url}" -o /tmp/result.msgpack

    Use the 'url' field as input_data when passing this dataset to create_process.

    The `files` dict in the response (nested under `"files"` at the root and under
    `"parts".<name>."files"` for each part) may contain a key
    `"application/vnd.ymerflow.stats+json"`. Fetching that URL returns a JSON
    document with pre-computed statistics. Each stat object has:
    `count`, `min`, `max`, `mean`, `rms`, `geometric_mean`, `std`,
    percentiles `p5`/`p25`/`p50`/`p75`/`p95`, `skewness`, `kurtosis`.
    Constant columns/flightlines appear as `{"constant": true, "value": X}` instead.

    Structure by dataset type:

    XYZ/AEM (`application/x-aarhusxyz-msgpack`):
      `flightlines`: dict of per-flightline-column stat objects.
      `layer_data`: dict keyed by channel name. Channels that are constant across
        all soundings (e.g. dep_top, dep_bot, gate times) appear as
        `{"constant": true, "values": [...]}` — one value per layer. Varying
        channels (e.g. rho, doi) appear as `{"all": {stat object},
        "layers": {"count": [...], "min": [...], ...}}` where each key holds
        an array of values indexed by layer number.

    MAG (`application/x-magdata-msgpack`):
      `columns`: dict of per-column stat objects.

    Grid/webxtile (`application/x-webxtile`):
      `variables`: dict keyed by variable name, each with `"all"` (stat object
        over the entire 3-D array) and, for 3-D variables, `"slices"`:
        `{"count": [...], "min": [...], ...}` — arrays indexed by z-slice.

    Use the stats URL to inspect a dataset without downloading the full binary file.
    """
    stmt = select(Dataset).options(selectinload(Dataset.process_version)).where(Dataset.id == dataset_id)
    result = await db.execute(stmt)
    dataset = result.scalar_one_or_none()

    if not dataset or dataset.project_id != access.project.id:
        raise HTTPException(status_code=404, detail="Dataset not found")

    return redact_project_id(dataset.to_dict(), access)


@router.get("/projects/{project_id}/dataset/{dataset_id}/data", include_in_schema=False)
async def get_dataset_data(
    dataset_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Download the raw content of a dataset's root part (frontend use only).

    For LLM agents: use the 'url' from get_dataset and download with curl instead —
    no authentication required. This endpoint is not exposed to MCP tools.
    """
    return await get_dataset_part_data(dataset_id, "", access, db)


@router.get("/projects/{project_id}/dataset/{dataset_id}/geography", include_in_schema=False)
async def get_dataset_geography(
    dataset_id: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Get GeoJSON geography for a dataset (root part). Frontend use only."""
    return await get_dataset_part_geography(dataset_id, "", access, db)


@router.get("/projects/{project_id}/dataset/{dataset_id}/{part_path:path}/data", include_in_schema=False)
async def get_dataset_part_data(
    dataset_id: str,
    part_path: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Get data for a specific part of a dataset"""
    stmt = select(Dataset).where(Dataset.id == dataset_id)
    result = await db.execute(stmt)
    dataset = result.scalar_one_or_none()

    if not dataset or dataset.project_id != access.project.id:
        raise HTTPException(status_code=404, detail="Dataset not found")

    # Determine format by checking structure
    is_new_format = "files" in dataset.parts and "parts" in dataset.parts

    part_file_url = None
    mime_type = dataset.mime_type

    if part_path == "":
        # Root part
        if is_new_format:
            # New format: files at top level
            part_file_url = dataset.parts.get("files", {}).get(dataset.mime_type)
        else:
            # Old format: parts[""] with file_url
            part_info = dataset.parts.get("")
            if part_info:
                part_file_url = part_info.get("file_url")
                mime_type = part_info.get("mime_type", dataset.mime_type)
    else:
        # Child part
        if is_new_format:
            # New format: parts nested under "parts" key
            parts_dict = dataset.parts.get("parts", {})
            part_info = parts_dict.get(part_path)
            if not part_info:
                raise HTTPException(status_code=404, detail="Part not found")

            if "files" in part_info and dataset.mime_type in part_info["files"]:
                part_file_url = part_info["files"][dataset.mime_type]
        else:
            # Old format: parts at top level
            part_info = dataset.parts.get(part_path)
            if not part_info:
                raise HTTPException(status_code=404, detail="Part not found")

            part_file_url = part_info.get("file_url")
            mime_type = part_info.get("mime_type", dataset.mime_type)

    if not part_file_url:
        raise HTTPException(status_code=404, detail="Part data not found")

    storage_options = await get_fsspec_storage_options(db, dataset.project_id)
    def _read():
        with fsspec.open(part_file_url, 'rb', **storage_options) as f:
            return f.read()
    data = await asyncio.to_thread(_read)

    return Response(
        content=data,
        media_type=mime_type
    )


@router.get("/projects/{project_id}/dataset/{dataset_id}/{part_path:path}/geography", include_in_schema=False)
async def get_dataset_part_geography(
    dataset_id: str,
    part_path: str,
    access: ProjectReadAccess = Depends(resolve_project_for_read),
    db: AsyncSession = Depends(get_db)
):
    """Get GeoJSON geography for a specific part of a dataset. Frontend use only."""
    stmt = select(Dataset).where(Dataset.id == dataset_id)
    result = await db.execute(stmt)
    dataset = result.scalar_one_or_none()

    if not dataset or dataset.project_id != access.project.id:
        raise HTTPException(status_code=404, detail="Dataset not found")

    # Determine format by checking structure
    is_new_format = "files" in dataset.parts and "parts" in dataset.parts

    part_geography_url = None

    if part_path == "":
        # Root part
        if is_new_format:
            # New format: files at top level
            part_geography_url = dataset.parts.get("files", {}).get("application/geo+json")
        else:
            # Old format: parts[""] with geography_url
            part_info = dataset.parts.get("")
            if part_info:
                part_geography_url = part_info.get("geography_url")
    else:
        # Child part
        if is_new_format:
            # New format: parts nested under "parts" key
            parts_dict = dataset.parts.get("parts", {})
            part_info = parts_dict.get(part_path)
            if not part_info:
                raise HTTPException(status_code=404, detail="Part not found")

            if "files" in part_info and "application/geo+json" in part_info["files"]:
                part_geography_url = part_info["files"]["application/geo+json"]
        else:
            # Old format: parts at top level
            part_info = dataset.parts.get(part_path)
            if not part_info:
                raise HTTPException(status_code=404, detail="Part not found")

            part_geography_url = part_info.get("geography_url")

    if not part_geography_url:
        raise HTTPException(status_code=404, detail="Part geography not found")

    storage_options = await get_fsspec_storage_options(db, dataset.project_id)
    def _read():
        with fsspec.open(part_geography_url, 'r', **storage_options) as f:
            return f.read()
    data = await asyncio.to_thread(_read)

    return Response(
        content=data,
        media_type="application/geo+json"
    )


FILE_MIME_TYPES = {
    ".msgpack": "application/x-aarhusxyz-msgpack",
    ".geojson": "application/geo+json",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".xyz": "text/x-aarhusxyz",
    ".gex": "text/x-aarhusxyz-gex",
    ".vtk": "model/vnd.vtk",
    ".glb": "model/gltf-binary",
    ".gpkg": "application/geopackage+sqlite3",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".zip": "application/zip",
    ".shp": "application/x-esri-shape",
    ".shx": "application/x-esri-shape-index",
    ".dbf": "application/x-dbf",
    ".prj": "text/plain",
    ".cpg": "text/plain",
    ".gml": "application/gml+xml",
    ".kml": "application/vnd.google-earth.kml+xml",
    ".kmz": "application/vnd.google-earth.kmz",
    ".pdf": "application/pdf",
    ".png": "image/png",
}

TEXT_MIME_TYPES = {"application/geo+json", "application/json", "text/csv", "text/plain"}


def _sanitize_filename_part(name: str) -> str:
    return re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('._-')


async def _download_filename(db: AsyncSession, path: str) -> str:
    """Compose a download name from the dataset name and part, since every dataset file on
    disk is called root.msgpack / root.geojson / <part>.msgpack."""
    basename = path.rsplit('/', 1)[-1]
    match = re.search(r'/datasets/([^/]+)/', path)
    if not match:
        return _sanitize_filename_part(basename) or "download"

    result = await db.execute(select(Dataset.dataset_name).where(Dataset.id == match.group(1)))
    dataset_name = _sanitize_filename_part(result.scalar_one_or_none() or "")
    if not dataset_name:
        return _sanitize_filename_part(basename) or "download"

    stem, _, ext = basename.partition('.')
    suffix = f".{ext}" if ext else ""
    stem = _sanitize_filename_part(stem)
    if not stem or stem == "root":
        return f"{dataset_name}{suffix}"
    return f"{dataset_name}_{stem}{suffix}"


@router.get("/files/{path:path}", include_in_schema=False)
async def get_file(
    path: str,
    content_disposition: str | None = Query(None, alias="content-disposition"),
    db: AsyncSession = Depends(get_db),
):
    """Unified file endpoint for datasets and uploads (frontend / curl use only).

    Auth-free: any /files/ URL can be fetched with a plain curl — no token needed.
    LLM agents should use this URL directly rather than calling this as an MCP tool.

    The first path segment is the project's bucket (`<bucket_prefix><project_id>` on every
    backend), so it reverse-resolves to the owning project + StorageBackend; the file is then read
    with that backend's admin fsspec kwargs and the correct URL scheme (s3/gs/…). This is trusted,
    backend-side I/O — the proxy may read across projects because the backend enforces access
    itself (the endpoint is intentionally auth-free; the URL is the capability).

    Files are served inline by default. Add `?content-disposition=attachment` to the URL to
    have the browser download the file instead, named after its dataset and part. The export
    widget appends this so its links download; plot/map views omit it and fetch inline. (fetch()
    ignores Content-Disposition anyway, so the choice only matters for a click/navigation.)

    Examples:
        /files/project-bucket/processes/proc-123/datasets/ds-456/root.msgpack
        -> s3://project-bucket/processes/proc-123/datasets/ds-456/root.msgpack

        /files/project-bucket/uploads/up-789/file.csv
        -> gs://project-bucket/uploads/up-789/file.csv
    """
    from backend.services.storage_service import resolve_bucket, get_fsspec_storage_options
    from backend.services.storage_protocols import get_protocol_handler

    bucket = path.split("/", 1)[0]
    try:
        project, backend = await resolve_bucket(db, bucket)
    except RuntimeError:
        raise HTTPException(status_code=404, detail="File not found")

    # Rebuild the storage URL from the RESOLVED project's bucket, not the client-supplied bucket
    # segment. For a real-project bucket these are identical; for a pub-prefixed bucket the client
    # segment is <bucket_prefix>pub-X and resolve_bucket mapped it to the real project, so we must
    # substitute the real bucket here. See docs/plans/done/publication-link-id-opacity.md.
    real_base = get_protocol_handler(backend.protocol).storage_base_url(project, backend)
    rest = path.split("/", 1)[1] if "/" in path else ""
    storage_url = f"{real_base}/{rest}" if rest else real_base

    # Determine MIME type based on file extension. Our list is authoritative (it carries the
    # domain-specific types mimetypes doesn't know); fall back to the stdlib guess, then octet-stream.
    basename = path.rsplit('/', 1)[-1]
    extension = f".{basename.rsplit('.', 1)[-1].lower()}" if '.' in basename else ''
    mime_type = (
        FILE_MIME_TYPES.get(extension)
        or mimetypes.guess_type(basename)[0]
        or "application/octet-stream"
    )

    # Read file from storage (backend-side admin credentials)
    storage_options = await get_fsspec_storage_options(db, project.id)
    try:
        mode = 'r' if mime_type in TEXT_MIME_TYPES else 'rb'
        def _read():
            with fsspec.open(storage_url, mode, **storage_options) as f:
                return f.read()
        data = await asyncio.to_thread(_read)

        # The caller opts into a download via ?content-disposition=attachment; default is inline.
        headers = {}
        if content_disposition == "attachment":
            filename = await _download_filename(db, path)
            headers["Content-Disposition"] = f'attachment; filename="{filename}"'

        return Response(
            content=data,
            media_type=mime_type,
            headers=headers
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading file: {str(e)}")

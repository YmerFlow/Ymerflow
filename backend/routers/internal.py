"""Endpoints called by runner pods (not by the frontend/API clients).

Auth here is deliberately not the usual JWT/API-key `get_current_user` dependency — a runner pod
has neither. Instead each ProcessVersion gets its own opaque, per-job STORAGE_REFRESH_TOKEN (see
backend/models/process.py's run_task(), which sets `refresh_token_hash`), hash-compared the same
way ApiKey.key_hash is (backend/services/auth_service.py's hash_api_key/SHA-256), scoped to exactly
the one job that was issued it.
"""
import asyncio
import hashlib
import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backend.database import get_db
from backend.models.process import ProcessVersion
from backend.models.project import Project
from backend.models.storage_backend import StorageBackend

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Internal"])


@router.post("/internal/process/{process_id}/versions/{version}/storage-credentials/refresh")
async def refresh_storage_credentials(
    process_id: str,
    version: int,
    x_storage_refresh_token: str = Header(..., alias="X-Storage-Refresh-Token"),
    db: AsyncSession = Depends(get_db),
):
    """Re-mint a storage credential for a running job.

    Called by the runner's refresher subprocess (docker/base-runner/storage_credential_refresher.py)
    on a cadence tied to the current credential's expiry, not by end users — there is no rate
    limiting here beyond what the refresher's own backoff/jitter imposes on itself.

    Returns handler-built, project-scoped fsspec kwargs (`{"kwargs": {...}, "expires_at": ...}`),
    not raw key/secret — the runner passes them straight to fsspec, protocol-general (see
    docs/plans/per-project-storage-routing.md).
    """
    from backend.services.storage_credentials import get_strategy
    from backend.services.storage_protocols import get_protocol_handler

    token_hash = hashlib.sha256(x_storage_refresh_token.encode()).hexdigest()

    stmt = (
        select(ProcessVersion)
        .options(selectinload(ProcessVersion.process))
        .where(ProcessVersion.process_id == process_id, ProcessVersion.version == version)
    )
    result = await db.execute(stmt)
    process_version = result.scalar_one_or_none()

    if process_version is None or not process_version.refresh_token_hash:
        raise HTTPException(status_code=404, detail="No refreshable storage credential for this job")

    if process_version.refresh_token_hash != token_hash:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    project_id = process_version.process.project_id
    stmt = select(Project).where(Project.id == project_id)
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project is None or not project.storage_backend_id:
        raise HTTPException(status_code=404, detail="Project has no storage backend configured")

    stmt = select(StorageBackend).where(StorageBackend.id == project.storage_backend_id)
    result = await db.execute(stmt)
    backend = result.scalar_one_or_none()
    if backend is None:
        raise HTTPException(status_code=404, detail="Storage backend not found")

    strategy = get_strategy(backend.credential_strategy)
    mint_result = await asyncio.to_thread(strategy.mint, project, backend)

    handler = get_protocol_handler(backend.protocol)
    kwargs = handler.fsspec_kwargs(backend, mint_result["credentials"])

    return {
        "kwargs": kwargs,
        "expires_at": mint_result["expires_at"].isoformat() if mint_result["expires_at"] else None,
    }

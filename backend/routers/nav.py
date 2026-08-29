"""Navigation-view ingest endpoint (GUI usage tracking).

POST /nav/view records one nav_views row per dwelled navigation coordinate the
frontend reports. See docs/plans/done/gui-usage-nav-tracking.md.

Deliberately **optional-auth** (Decision 6): public workspaces and read-only
publications are viewable without login and we want those views counted too, so
the endpoint requires no authentication and records no identity regardless of
whether a token is present. The trade-off (mild count-inflation via anonymous
writes) is bounded by validation here and the fact this only feeds an admin-only
aggregate.
"""
import logging
from datetime import datetime
from typing import Any, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import NavView

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Navigation"])

# Bounded validation (Decision 6): cap the batch, drop overflow rather than reject
# the whole request (a slow tab could legitimately accumulate a burst).
MAX_BATCH = 50
_STR_MAX = 255


class NavViewIn(BaseModel):
    # Coordinates are typed permissively (Any) so a single malformed value normalises to null
    # in the handler rather than 422-ing the whole batch (Decision 6: only a bad *request shape*
    # — views not being a list — is a hard error). _coerce_str / _coerce_int do the normalisation.
    workspace: Optional[Any] = None
    workspace_version: Optional[Any] = None
    project: Optional[Any] = None
    process: Optional[Any] = None
    version: Optional[Any] = None
    part: Optional[Any] = None
    sounding: Optional[Any] = None


class NavViewBatch(BaseModel):
    # A malformed *request shape* (not a list under "views") is a 422/400 via pydantic —
    # not swallowed. Individual unparseable coordinates are normalised below, not rejected.
    views: List[NavViewIn] = Field(default_factory=list)


def _coerce_str(value) -> Optional[str]:
    """Normalise a coordinate string: None/empty/"all" → None, else truncated to the column width."""
    if value is None:
        return None
    s = str(value)
    if s == "" or s == "all":
        return None
    return s[:_STR_MAX]


def _coerce_int(value) -> Optional[int]:
    """Best-effort int coercion; an unparseable coordinate normalises to null (not a hard error)."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@router.post("/nav/view")
async def record_nav_views(batch: NavViewBatch, db: AsyncSession = Depends(get_db)):
    """Optional-auth batch insert of dwelled navigation coordinates. Server-stamps created_at
    (client clock is untrusted; day+ bucket granularity makes server time sufficient)."""
    now = datetime.utcnow()
    rows = []
    for v in batch.views[:MAX_BATCH]:
        workspace = _coerce_str(v.workspace)
        project = _coerce_str(v.project)
        process = _coerce_str(v.process)
        part = _coerce_str(v.part)
        # Skip a wholly-empty coordinate (bare /app should never be recorded, but guard anyway).
        if not (workspace or project or process):
            continue
        rows.append(NavView(
            created_at=now,
            workspace=workspace,
            workspace_version=_coerce_int(v.workspace_version),
            project=project,
            process=process,
            version=_coerce_int(v.version),
            part=part,
            sounding=_coerce_int(v.sounding),
        ))
    if rows:
        db.add_all(rows)
        await db.commit()
    return {"recorded": len(rows)}

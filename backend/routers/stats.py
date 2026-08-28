"""Admin-only stats dashboard endpoints.

Three generic, parameterised aggregation endpoints (see docs/plans/admin-stats-dashboard.md
Design decision 4) — all guarded by require_admin, same as backend/routers/admin.py:

  GET /admin/stats/summary     — headline scalar counts, each as {all, year, month}
  GET /admin/stats/breakdown   — one grouped-count query (drives the drill-down pivot)
  GET /admin/stats/timeseries  — bucketed counts over time (drives the line charts)

All aggregation is a bounded, indexed GROUP BY in the database — no per-row Python work
(CLAUDE.md Best Practice 7). Dimension / filter names are a server-side whitelist and never
raw-interpolated (mirrors the sort-column whitelist in the paged-users plan).
"""
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, distinct
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db, engine
from backend.auth_deps import require_admin
from backend.models import Project, Process, ProcessVersion, Environment, User, ProcessState

router = APIRouter(tags=["Admin"])

WINDOWS = ("all", "year", "month")
GRANULARITIES = ("day", "week", "month")
# Cap on distinct series in a timeseries split; the rest fold into an "(other)" series.
MAX_SERIES = 8

# entity -> ORM model (the row being counted)
_ENTITY_MODEL = {
    "projects": Project,
    "processes": Process,
    "versions": ProcessVersion,
    "environments": Environment,
    "users": User,
}

# entity -> creation-timestamp column the window WHERE clause bounds
_CREATED_AT = {
    "projects": Project.created_at,
    "processes": Process.created_at,
    "versions": ProcessVersion.created_at,
    "environments": Environment.created_at,
    "users": User.created_at,
}

# entity -> {dimension: (group-by column, label-kind, needs_process_join)}.
# label-kind drives human-readable labelling of the raw group value below. A join to processes
# is needed for the versions.type / versions.project dimensions (they live on Process).
_DIMENSIONS = {
    "projects": {
        "user": (Project.created_by, "user", False),
    },
    "processes": {
        "user": (Process.created_by, "user", False),
        "project": (Process.project_id, "project", False),
        "type": (Process.type, "raw", False),
        "environment": (Process.environment_id, "environment", False),
    },
    "versions": {
        "user": (ProcessVersion.created_by, "user", False),
        "state": (ProcessVersion.state, "state", False),
        "type": (Process.type, "raw", True),
        "project": (Process.project_id, "project", True),
    },
    "environments": {
        "user": (Environment.created_by, "user", False),
    },
    "users": {
        "admin": (User.is_admin, "admin", False),
    },
}

# entity -> {filter-name: (column, needs_process_join)} — the accumulated pivot filters.
# Query params are filter_user / filter_project / filter_type / filter_state (mapped below).
_FILTERS = {
    "projects": {
        "user": (Project.created_by, False),
        "project": (Project.id, False),
    },
    "processes": {
        "user": (Process.created_by, False),
        "project": (Process.project_id, False),
        "type": (Process.type, False),
        "environment": (Process.environment_id, False),
    },
    "versions": {
        "user": (ProcessVersion.created_by, False),
        "state": (ProcessVersion.state, False),
        "type": (Process.type, True),
        "project": (Process.project_id, True),
    },
    "environments": {
        "user": (Environment.created_by, False),
    },
    "users": {
        "admin": (User.is_admin, False),
    },
}


def _window_start(window: str) -> Optional[datetime]:
    """Lower bound (inclusive) on the creation timestamp for a window, or None for all-time.

    year/month mean the *current* calendar year/month, UTC (matching datetime.utcnow() used
    throughout the codebase)."""
    if window not in WINDOWS:
        raise HTTPException(status_code=400, detail=f"invalid window {window!r}")
    now = datetime.utcnow()
    if window == "year":
        return datetime(now.year, 1, 1)
    if window == "month":
        return datetime(now.year, now.month, 1)
    return None  # all


def _bucket_expr(col, granularity: str):
    """Dialect-aware date-bucket expression (Design decision 5). Grouping stays in the DB so no
    Python row-bucketing happens. Returns an ISO-ish string key; the frontend maps it to an
    ordinal x-position."""
    if granularity not in GRANULARITIES:
        raise HTTPException(status_code=400, detail=f"invalid granularity {granularity!r}")
    if engine.dialect.name == "postgresql":
        fmt = {"day": "YYYY-MM-DD", "week": "IYYY-IW", "month": "YYYY-MM"}[granularity]
        return func.to_char(col, fmt)
    # sqlite (dev) and any other dialect
    fmt = {"day": "%Y-%m-%d", "week": "%Y-%W", "month": "%Y-%m"}[granularity]
    return func.strftime(fmt, col)


def _collect_filters(entity: str, filter_user, filter_project, filter_type, filter_state, filter_environment=None) -> Dict[str, str]:
    """Gather the non-empty pivot filters and validate them against the entity's whitelist."""
    raw = {"user": filter_user, "project": filter_project, "type": filter_type,
           "state": filter_state, "environment": filter_environment}
    fmap = _FILTERS[entity]
    out = {}
    for name, value in raw.items():
        if value is None or value == "":
            continue
        if name not in fmap:
            raise HTTPException(status_code=400, detail=f"filter {name!r} is not valid for entity {entity!r}")
        out[name] = value
    return out


def _coerce_filter(name: str, value: str):
    """Turn a raw filter string into (coerced_value, is_null). The sentinel string '__null__'
    (and 'null') selects the NULL / (unknown) bucket."""
    if value in ("__null__", "null"):
        return None, True
    if name == "user":
        try:
            return int(value), False
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"filter_user must be an integer user id, got {value!r}")
    if name == "state":
        try:
            return ProcessState(value), False
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid state {value!r}")
    if name == "admin":
        return value in ("true", "1", "True"), False
    return value, False


def _filters_need_join(entity: str, filters: Dict[str, str]) -> bool:
    fmap = _FILTERS[entity]
    return any(fmap[name][1] for name in filters)


def _apply_window_filters(stmt, entity: str, window: str, filters: Dict[str, str]):
    start = _window_start(window)
    if start is not None:
        stmt = stmt.where(_CREATED_AT[entity] >= start)
    fmap = _FILTERS[entity]
    for name, value in filters.items():
        col, _ = fmap[name]
        coerced, is_null = _coerce_filter(name, value)
        stmt = stmt.where(col.is_(None) if is_null else col == coerced)
    return stmt


def _with_process_join(stmt, entity: str, needs_join: bool):
    if needs_join:
        # versions.type / versions.project live on Process; every version has exactly one
        # process, so this inner join never changes the row count.
        stmt = stmt.join(Process, Process.id == ProcessVersion.process_id)
    return stmt


async def _resolve_labels(db: AsyncSession, kind: str, raw_keys: List) -> Dict:
    """Bulk-resolve raw group keys to human labels for id-valued dimensions (user/project/
    environment). Raw dimensions (type/state/admin) need no lookup."""
    non_null = [k for k in raw_keys if k is not None]
    if not non_null:
        return {}
    if kind == "user":
        rows = await db.execute(select(User.id, User.username).where(User.id.in_(non_null)))
        return {r.id: r.username for r in rows}
    if kind == "project":
        rows = await db.execute(select(Project.id, Project.name).where(Project.id.in_(non_null)))
        return {r.id: r.name for r in rows}
    if kind == "environment":
        rows = await db.execute(select(Environment.id, Environment.name).where(Environment.id.in_(non_null)))
        return {r.id: r.name for r in rows}
    return {}


def _serialize_key(kind: str, raw) -> Optional[str]:
    """The stable string form of a group key that the frontend passes straight back as the next
    drill filter (None for the NULL/(unknown) bucket)."""
    if raw is None:
        return None
    if kind == "state":
        return raw.value if hasattr(raw, "value") else str(raw)
    if kind == "admin":
        return "true" if raw else "false"
    return str(raw)


def _label_for(kind: str, raw, lookup: Dict) -> str:
    if raw is None:
        return "(unknown)"
    if kind == "state":
        return raw.value if hasattr(raw, "value") else str(raw)
    if kind == "admin":
        return "Admins" if raw else "Non-admins"
    if kind in ("user", "project", "environment"):
        return lookup.get(raw) or f"({kind} {raw})"
    return str(raw)


async def _count(db: AsyncSession, entity: str, window: str, filters: Dict[str, str]) -> int:
    model = _ENTITY_MODEL[entity]
    stmt = select(func.count()).select_from(model)
    stmt = _with_process_join(stmt, entity, _filters_need_join(entity, filters))
    stmt = _apply_window_filters(stmt, entity, window, filters)
    return (await db.execute(stmt)).scalar() or 0


# ── GET /admin/stats/summary ──────────────────────────────────────────────────────────────────

@router.get("/admin/stats/summary")
async def stats_summary(auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Headline counts, each as {all, year, month}. ~18 small indexed scalar queries."""
    # (key, model, created_at, distinct-column-or-None)
    specs = [
        ("projects", Project, Project.created_at, None),
        ("processes", Process, Process.created_at, None),
        ("versions", ProcessVersion, ProcessVersion.created_at, None),
        ("environments", Environment, Environment.created_at, None),
        ("users", User, User.created_at, None),
        ("process_types", Process, Process.created_at, Process.type),
    ]
    result: Dict[str, Dict[str, int]] = {}
    for key, model, created_at, distinct_col in specs:
        cell = {}
        for window in WINDOWS:
            start = _window_start(window)
            agg = func.count(distinct(distinct_col)) if distinct_col is not None else func.count()
            stmt = select(agg).select_from(model)
            if start is not None:
                stmt = stmt.where(created_at >= start)
            cell[window] = (await db.execute(stmt)).scalar() or 0
        result[key] = cell
    return result


# ── GET /admin/stats/breakdown ────────────────────────────────────────────────────────────────

@router.get("/admin/stats/breakdown")
async def stats_breakdown(
    entity: str,
    group_by: str,
    window: str = "all",
    filter_user: Optional[str] = None,
    filter_project: Optional[str] = None,
    filter_type: Optional[str] = None,
    filter_state: Optional[str] = None,
    filter_environment: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    auth=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """One grouped count query. Top-N by count; the remainder folds into an '(other)' row."""
    if entity not in _ENTITY_MODEL:
        raise HTTPException(status_code=400, detail=f"unknown entity {entity!r}")
    dims = _DIMENSIONS[entity]
    if group_by not in dims:
        raise HTTPException(status_code=400, detail=f"group_by {group_by!r} is not valid for entity {entity!r}")
    group_col, kind, group_join = dims[group_by]
    filters = _collect_filters(entity, filter_user, filter_project, filter_type, filter_state, filter_environment)

    total = await _count(db, entity, window, filters)

    model = _ENTITY_MODEL[entity]
    needs_join = group_join or _filters_need_join(entity, filters)
    stmt = select(group_col.label("key"), func.count().label("count")).select_from(model)
    stmt = _with_process_join(stmt, entity, needs_join)
    stmt = _apply_window_filters(stmt, entity, window, filters)
    stmt = stmt.group_by(group_col).order_by(func.count().desc()).limit(limit)
    grouped = (await db.execute(stmt)).all()

    lookup = await _resolve_labels(db, kind, [r.key for r in grouped])
    rows = [
        {"key": _serialize_key(kind, r.key), "label": _label_for(kind, r.key, lookup), "count": r.count}
        for r in grouped
    ]
    shown = sum(r.count for r in grouped)
    other = total - shown
    if other > 0:
        rows.append({"key": "__other__", "label": "(other)", "count": other})

    return {"entity": entity, "group_by": group_by, "window": window, "total": total, "rows": rows}


# ── GET /admin/stats/timeseries ───────────────────────────────────────────────────────────────

@router.get("/admin/stats/timeseries")
async def stats_timeseries(
    entity: str,
    granularity: str = "month",
    window: str = "all",
    series_by: Optional[str] = None,
    filter_user: Optional[str] = None,
    filter_project: Optional[str] = None,
    filter_type: Optional[str] = None,
    filter_state: Optional[str] = None,
    filter_environment: Optional[str] = None,
    auth=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Bucketed counts over time, optionally split into one series per top-N group value.
    Missing buckets are zero-filled server-side so every series is bucket-aligned."""
    if entity not in _ENTITY_MODEL:
        raise HTTPException(status_code=400, detail=f"unknown entity {entity!r}")
    filters = _collect_filters(entity, filter_user, filter_project, filter_type, filter_state, filter_environment)

    series_col = None
    kind = None
    series_join = False
    if series_by is not None:
        dims = _DIMENSIONS[entity]
        if series_by not in dims:
            raise HTTPException(status_code=400, detail=f"series_by {series_by!r} is not valid for entity {entity!r}")
        series_col, kind, series_join = dims[series_by]

    model = _ENTITY_MODEL[entity]
    needs_join = series_join or _filters_need_join(entity, filters)
    bucket = _bucket_expr(_CREATED_AT[entity], granularity)

    cols = [bucket.label("bucket")]
    if series_col is not None:
        cols.append(series_col.label("skey"))
    cols.append(func.count().label("count"))

    stmt = select(*cols).select_from(model)
    stmt = _with_process_join(stmt, entity, needs_join)
    stmt = _apply_window_filters(stmt, entity, window, filters)
    group_cols = [bucket] + ([series_col] if series_col is not None else [])
    stmt = stmt.group_by(*group_cols).order_by(bucket)
    rows = (await db.execute(stmt)).all()

    buckets = sorted({r.bucket for r in rows})
    bucket_index = {b: i for i, b in enumerate(buckets)}

    if series_col is None:
        counts = [0] * len(buckets)
        for r in rows:
            counts[bucket_index[r.bucket]] = r.count
        series = [{"key": None, "label": "all", "counts": counts}]
    else:
        per_key: Dict = {}
        totals: Dict = {}
        for r in rows:
            arr = per_key.setdefault(r.skey, [0] * len(buckets))
            arr[bucket_index[r.bucket]] = r.count
            totals[r.skey] = totals.get(r.skey, 0) + r.count
        ranked = sorted(totals, key=lambda k: totals[k], reverse=True)
        top = ranked[:MAX_SERIES]
        lookup = await _resolve_labels(db, kind, top)
        series = [
            {"key": _serialize_key(kind, k), "label": _label_for(kind, k, lookup), "counts": per_key[k]}
            for k in top
        ]
        rest = ranked[MAX_SERIES:]
        if rest:
            other_counts = [0] * len(buckets)
            for k in rest:
                for i, c in enumerate(per_key[k]):
                    other_counts[i] += c
            series.append({"key": "__other__", "label": "(other)", "counts": other_counts})

    return {"entity": entity, "granularity": granularity, "buckets": buckets, "series": series}

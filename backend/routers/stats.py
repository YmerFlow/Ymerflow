"""Admin-only stats dashboard endpoints.

Generic, parameterised aggregation endpoints (see docs/plans/admin-stats-pivot-redesign.md) —
all guarded by require_admin, same as backend/routers/admin.py:

  GET /admin/stats/summary   — headline scalar counts, each as {all, year, month}
  GET /admin/stats/schema    — per-entity dimension / filter whitelist served to the frontend
  GET /admin/stats/pivot     — free N-dimensional GROUP BY (breakdown + time series + cross-tab)

The `pivot` endpoint supersedes the original single-dimension `breakdown` and single-series
`timeseries` routes: a breakdown is `group_by=[dim]`, a time series is `group_by=[t_month]`, a
cross-tab is `group_by=[dimA, t_monthB]`. All aggregation is a bounded, indexed GROUP BY in the
database — no per-row Python work (CLAUDE.md Best Practice 7). Dimension / filter names are a
server-side whitelist and never raw-interpolated (mirrors the sort-column whitelist in the
paged-users plan).
"""
import logging
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, distinct, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db, engine
from backend.auth_deps import require_admin
from backend.models import Project, Process, ProcessVersion, Environment, User, ProcessState, Workspace, NavView

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Admin"])

WINDOWS = ("all", "year", "month")
GRANULARITIES = ("day", "week", "month")
# Top-N pass keeps the top `limit` dim-1 values; a global row backstop guards a pathological
# high-cardinality second dimension. If tripped the response sets truncated=True and logs —
# never a silent drop (Decision 4).
MAX_PIVOT_ROWS = 5000

# Temporal grouping dimensions (Decision 2). All three resolve to _bucket_expr against the
# entity's created_at column, so at most one may appear in a single group_by list. Available on
# every entity; label-kind "bucket" (identity label = the ISO-ish bucket string itself).
_TEMPORAL_DIMS = {"t_day": "day", "t_week": "week", "t_month": "month"}
_TEMPORAL_LABELS = {"t_day": "Day", "t_week": "Week", "t_month": "Month"}

# entity -> ORM model (the row being counted)
_ENTITY_MODEL = {
    "projects": Project,
    "processes": Process,
    "versions": ProcessVersion,
    "environments": Environment,
    "users": User,
    "navigation": NavView,
}

# entity -> creation-timestamp column the window WHERE clause bounds
_CREATED_AT = {
    "projects": Project.created_at,
    "processes": Process.created_at,
    "versions": ProcessVersion.created_at,
    "environments": Environment.created_at,
    "users": User.created_at,
    "navigation": NavView.created_at,
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
    # Self-contained table (Decisions 1-4): every coordinate is a plain column, no joins.
    "navigation": {
        "workspace": (NavView.workspace, "workspace", False),
        "workspace_version": (NavView.workspace_version, "raw", False),
        "project": (NavView.project, "project", False),
        "process": (NavView.process, "process", False),
        "version": (NavView.version, "raw", False),
        "part": (NavView.part, "raw", False),
        "sounding": (NavView.sounding, "raw", False),
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
    "navigation": {
        "workspace": (NavView.workspace, False),
        "workspace_version": (NavView.workspace_version, False),
        "project": (NavView.project, False),
        "process": (NavView.process, False),
        "version": (NavView.version, False),
        "part": (NavView.part, False),
        "sounding": (NavView.sounding, False),
    },
}

# Human labels for dimensions / filters, and the value-picker type per filter (Decision 5,
# served by GET /admin/stats/schema so the frontend never mirrors this whitelist).
_DIM_LABELS = {
    "user": "User", "project": "Project", "type": "Type", "state": "State",
    "environment": "Environment", "admin": "Admin",
    "workspace": "Workspace", "workspace_version": "Workspace version",
    "process": "Process", "version": "Version", "part": "Part", "sounding": "Sounding",
}
_FILTER_TYPES = {
    "user": "user", "project": "project", "type": "string", "state": "state",
    "environment": "environment", "admin": "admin",
    "workspace": "workspace", "workspace_version": "number", "process": "process",
    "version": "number", "part": "string", "sounding": "number",
}
_ENTITY_LABELS = {
    "projects": "Projects", "processes": "Processes", "versions": "Process versions",
    "environments": "Environments", "users": "Users", "navigation": "Navigation views",
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


def _collect_filters(entity: str, filter_user, filter_project, filter_type, filter_state,
                     filter_environment=None, filter_workspace=None, filter_workspace_version=None,
                     filter_process=None, filter_version=None, filter_part=None,
                     filter_sounding=None) -> Dict[str, str]:
    """Gather the non-empty pivot filters and validate them against the entity's whitelist."""
    raw = {"user": filter_user, "project": filter_project, "type": filter_type,
           "state": filter_state, "environment": filter_environment,
           "workspace": filter_workspace, "workspace_version": filter_workspace_version,
           "process": filter_process, "version": filter_version, "part": filter_part,
           "sounding": filter_sounding}
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
    # navigation integer coordinates: string-compare against an Integer column is not portable
    # to Postgres, so coerce (Decision 5 / _coerce_filter extension).
    if name in ("version", "sounding", "workspace_version"):
        try:
            return int(value), False
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"filter_{name} must be an integer, got {value!r}")
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
    if kind == "process":
        rows = await db.execute(select(Process.id, Process.name).where(Process.id.in_(non_null)))
        return {r.id: r.name for r in rows}
    if kind == "workspace":
        # Workspace's human name is its `title` column.
        rows = await db.execute(select(Workspace.id, Workspace.title).where(Workspace.id.in_(non_null)))
        return {r.id: r.title for r in rows}
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
    if kind in ("user", "project", "environment", "process", "workspace"):
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
        ("navigation", NavView, NavView.created_at, None),
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


# ── GET /admin/stats/schema ─────────────────────────────────────────────────────────────────

@router.get("/admin/stats/schema")
async def stats_schema(auth=Depends(require_admin)):
    """Per-entity dimension / filter whitelist (Decision 5). Static per deploy — the single
    source of truth the frontend renders its builders from, killing the duplicated mirror. Every
    entity additionally exposes the three temporal grouping dimensions."""
    entities = {}
    for entity, dims in _DIMENSIONS.items():
        dimensions = [
            {"key": key, "label": _DIM_LABELS.get(key, key), "temporal": False}
            for key in dims
        ]
        dimensions += [
            {"key": key, "label": _TEMPORAL_LABELS[key], "temporal": True}
            for key in _TEMPORAL_DIMS
        ]
        filters = [
            {"key": key, "label": _DIM_LABELS.get(key, key), "type": _FILTER_TYPES.get(key, "string")}
            for key in _FILTERS[entity]
        ]
        entities[entity] = {
            "label": _ENTITY_LABELS.get(entity, entity),
            "dimensions": dimensions,
            "filters": filters,
        }
    return {"entities": entities}


# ── GET /admin/stats/pivot ──────────────────────────────────────────────────────────────────

def _pivot_columns(entity: str, group_by: List[str]):
    """Validate an ordered group_by list against the entity whitelist and resolve each dim to a
    SQL expression. Returns a list of (dim_key, sql_expr, label_kind, needs_join). Temporal dims
    resolve lazily to _bucket_expr against this entity's created_at column; at most one temporal
    dim is allowed in a single list (they all share the one timestamp column)."""
    dims = _DIMENSIONS[entity]
    out = []
    temporal_seen = 0
    for dim in group_by:
        if dim in _TEMPORAL_DIMS:
            temporal_seen += 1
            expr = _bucket_expr(_CREATED_AT[entity], _TEMPORAL_DIMS[dim])
            out.append((dim, expr, "bucket", False))
        elif dim in dims:
            col, kind, needs_join = dims[dim]
            out.append((dim, col, kind, needs_join))
        else:
            raise HTTPException(status_code=400, detail=f"group_by {dim!r} is not valid for entity {entity!r}")
    if temporal_seen > 1:
        raise HTTPException(status_code=400, detail="at most one temporal dimension may be grouped at a time")
    return out


@router.get("/admin/stats/pivot")
async def stats_pivot(
    entity: str,
    group_by: List[str] = Query(default=[]),
    window: str = "all",
    filter_user: Optional[str] = None,
    filter_project: Optional[str] = None,
    filter_type: Optional[str] = None,
    filter_state: Optional[str] = None,
    filter_environment: Optional[str] = None,
    filter_workspace: Optional[str] = None,
    filter_workspace_version: Optional[str] = None,
    filter_process: Optional[str] = None,
    filter_version: Optional[str] = None,
    filter_part: Optional[str] = None,
    filter_sounding: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    auth=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Free N-dimensional GROUP BY (Decisions 1-4). Top-N applies to the first group-by dim; each
    kept dim-1 value is returned fully cross-tabulated across the remaining dims, the rest fold
    into a single __other__ row. A global row backstop guards a pathological second dimension."""
    if entity not in _ENTITY_MODEL:
        raise HTTPException(status_code=400, detail=f"unknown entity {entity!r}")
    filters = _collect_filters(entity, filter_user, filter_project, filter_type, filter_state,
                               filter_environment, filter_workspace, filter_workspace_version,
                               filter_process, filter_version, filter_part, filter_sounding)
    total = await _count(db, entity, window, filters)

    cols = _pivot_columns(entity, group_by)
    temporal = [c[0] for c in cols if c[0] in _TEMPORAL_DIMS]

    # Empty group_by → grand total only (Decision 3).
    if not cols:
        return {"entity": entity, "group_by": [], "temporal": [], "total": total,
                "truncated": False, "rows": []}

    model = _ENTITY_MODEL[entity]
    needs_join = any(c[3] for c in cols) or _filters_need_join(entity, filters)

    dim1_key, dim1_expr, dim1_kind, _ = cols[0]

    # Pass 1 — top-N values of dim 1 by count (Decision 4).
    top_stmt = select(dim1_expr.label("k"), func.count().label("c")).select_from(model)
    top_stmt = _with_process_join(top_stmt, entity, needs_join)
    top_stmt = _apply_window_filters(top_stmt, entity, window, filters)
    top_stmt = top_stmt.group_by(dim1_expr).order_by(func.count().desc()).limit(limit)
    top_rows = (await db.execute(top_stmt)).all()
    if not top_rows:
        return {"entity": entity, "group_by": group_by, "temporal": temporal, "total": total,
                "truncated": False, "rows": []}
    kept = [r.k for r in top_rows]
    kept_non_null = [k for k in kept if k is not None]
    kept_has_null = any(k is None for k in kept)

    # Pass 2 — full multi-dim cross-tab restricted to the kept dim-1 values.
    group_exprs = [c[1] for c in cols]
    full_stmt = select(*group_exprs, func.count().label("count")).select_from(model)
    full_stmt = _with_process_join(full_stmt, entity, needs_join)
    full_stmt = _apply_window_filters(full_stmt, entity, window, filters)
    keep_conds = []
    if kept_non_null:
        keep_conds.append(dim1_expr.in_(kept_non_null))
    if kept_has_null:
        keep_conds.append(dim1_expr.is_(None))
    full_stmt = full_stmt.where(or_(*keep_conds))
    full_stmt = full_stmt.group_by(*group_exprs).limit(MAX_PIVOT_ROWS + 1)
    result_rows = (await db.execute(full_stmt)).all()

    truncated = len(result_rows) > MAX_PIVOT_ROWS
    if truncated:
        result_rows = result_rows[:MAX_PIVOT_ROWS]
        logger.warning(
            "stats pivot truncated: entity=%s group_by=%s hit MAX_PIVOT_ROWS=%d — response marked truncated",
            entity, group_by, MAX_PIVOT_ROWS,
        )

    # Per-dimension bulk label resolution (id → name for user/project/environment).
    lookups = []
    for i, (_, _, kind, _) in enumerate(cols):
        raw_keys = [row[i] for row in result_rows]
        lookups.append(await _resolve_labels(db, kind, raw_keys))

    rows = []
    for row in result_rows:
        keys, labels = [], []
        for i, (_, _, kind, _) in enumerate(cols):
            raw = row[i]
            keys.append(_serialize_key(kind, raw))
            labels.append(_label_for(kind, raw, lookups[i]))
        rows.append({"keys": keys, "labels": labels, "count": row[-1]})

    # Fold everything outside the kept dim-1 values into one __other__ row (Decision 4).
    shown = sum(r["count"] for r in rows)
    other = total - shown
    if other > 0:
        n = len(cols)
        rows.append({
            "keys": ["__other__"] + ["*"] * (n - 1),
            "labels": ["(other)"] + [""] * (n - 1),
            "count": other,
        })

    return {"entity": entity, "group_by": group_by, "temporal": temporal, "total": total,
            "truncated": truncated, "rows": rows}

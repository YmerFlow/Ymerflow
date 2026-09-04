# Admin Stats Dashboard — Counts, Breakdowns & Time-series (with drill-down)

## Goal

Add an admin-only **Stats** dashboard (a new tab under `/admin`) showing, for the whole
deployment:

1. **Headline counts** — number of **projects**, **processes**, **process versions**,
   **environments**, **users**, and **distinct process-types** — each shown for **all-time**,
   **current year**, and **current month**.
2. **Breakdowns with drill-down** — every count can be expanded *in place* by the next dimension:
   overall → **per user** → **per project** → **per process-type** (and per **state** for versions).
   Clicking a bar/row appends that slice as a filter and re-pivots by the next dimension. This is
   the "dimension pivot in place" interaction (Design decision 2).
3. **Graphs over time** — counts of each entity created per time bucket (day / week / month),
   optionally split into series by a dimension, rendered with **gladly** (`gladly-plot`).
4. **Admin-only API** — every stats endpoint is guarded by `require_admin`, same as the rest of
   `backend/routers/admin.py`.

All aggregation is a bounded, indexed `GROUP BY` in the database — no per-row Python work, no
expensive backend computation (CLAUDE.md Best Practice 7).

---

## Background & Current State

### What already exists (no schema needed for counts / time-series / by-type)

Every metric **except the per-user breakdown** is computable from existing columns:

| Entity          | Model / table                          | Creation timestamp        | Type/state dimension |
|-----------------|----------------------------------------|---------------------------|----------------------|
| Project         | `backend/models/project.py` `projects` | `created_at`              | —                    |
| Process         | `backend/models/process.py` `processes`| `created_at`              | `type` (string)      |
| Process version | `process_versions`                     | `created_at` / `started_at` / `completed_at` | `state` (indexed enum) |
| Environment     | `backend/models/environment.py` `environments` | `created_at`      | `process_types` (JSON keys) |
| User            | `backend/models/user.py` `users`       | `created_at`              | `is_admin`           |

`Process.type` gives process-type counts directly; `state` on `process_versions` is already indexed.
No stats endpoint exists yet (`grep` for stats/analytics/metrics in `backend/routers/` is empty).

### The gap: no per-user attribution

There is **no `created_by`/owner** column on `Project`, `Process`, `ProcessVersion`, or
`Environment`. Users link to projects only through the many-to-many `ProjectMember` (no owner flag).
Relevant facts that make adding attribution cheap:

- `create_project` (`backend/routers/projects.py:130`) has `auth.user` in scope and already inserts
  the creator as the first `ProjectMember`.
- `create_process` (`backend/routers/processes.py:52`) has `auth.user` and passes
  `username=auth.user.username` into `Process.create_queued(...)`, which already loads the `User`
  row (`backend/models/process.py:174`) — so the user id is in hand for both the `Process` and every
  `ProcessVersion`.
- Environments are created in the background pod-scan path (`ProcessVersion._create_outputs`,
  `backend/models/process.py:1152`), where the **creating `Process` is in scope** — so an
  environment can inherit `created_by` from its process.

The billing plugin's `UserTransaction` (`plugins/billing/billing/models.py`) *does* tie process runs
to `user_id` + `process_id` + `process_version`, but core admin stats must not depend on a plugin,
so we add first-class attribution to core instead (Design decision 1).

### Admin UI plumbing that already exists

- `AdminPage.jsx` renders a `TabbedPage` with `basePath="/admin"`, `hookName="admin_tabs"`, and a
  `builtinTabs` array (Users / Clusters / Storage / Terms of Service). We add a `stats` builtin tab.
- The admin area is URL-routed (`/admin/:tab?`); we add query-string state for the pivot/time
  controls, exactly like the paged-users plan (`docs/plans/admin-users-paged-sortable-searchable.md`).
- Charting: the frontend bundles **`gladly-plot` ^0.0.19** (`frontend/src/widgets/PlotView/index.jsx`
  uses `Plot` + `DataGroup`). gladly ships built-in **`bars`**, **`lines`**, and **`points`** layer
  types (`node_modules/gladly-plot/src/layers/{BarsLayer,LinesLayer,PointsLayer}.js`), fed via the
  same `DataGroup`/`_children` column pattern PlotView already uses. No new chart dependency.

---

## Design Decisions

### Decision 1: Per-user attribution — **add `created_by` columns** (chosen)

Add a **nullable** `created_by` FK → `users.id` to `projects`, `processes`, `process_versions`, and
`environments`, indexed for `GROUP BY`. Populate at every creation path (the acting user is already
in scope everywhere, see above). Nullable because historical rows and system-created rows have no
known creator; NULL renders as an **"(unknown)"** bucket in the UI.

Rejected: deriving per-user from `ProjectMember` (a shared project fans out to every member and
double-counts) or from the billing ledger (plugin-coupled, only covers submitted runs).

### Decision 2: Drill-down — **dimension pivot in place** (chosen)

Clicking a total/bar/row expands it by the next dimension without leaving the page:
`overall → per user → per project → per process-type` (versions also offer `per state`). Each click
appends the clicked slice to an ordered **filter path** (e.g. `user=alice` then `project=P`) and
re-queries the breakdown grouped by the next unused dimension. The filter path lives in the URL query
string so a drilled view is reload-safe and shareable. A breadcrumb shows the current path with
per-level "×" to pop back up.

### Decision 3: Charts — **gladly (`gladly-plot`)** (chosen by operator)

Reuse the in-house WebGL plotting stack. A small reusable `StatChart` wrapper instantiates a gladly
`Plot` with the built-in `bars` (breakdowns, categorical) and `lines` (time-series) layer types,
feeding a `DataGroup` built from the API response. No new npm dependency. See Frontend Design for the
quantity-kind / axis handling this requires.

### Decision 4: Aggregation shape — **three endpoints** (chosen)

- `GET /admin/stats/summary` — all headline scalar cards in one cheap call.
- `GET /admin/stats/breakdown` — one grouped-count query, parameterised by entity + group-by
  dimension + time window + accumulated filters (drives the pivot tables/bar charts).
- `GET /admin/stats/timeseries` — bucketed counts over time, parameterised by entity + granularity
  + window + optional series-split + filters (drives the line charts).

A generic parameterised shape (rather than one endpoint per metric) means the drill-down pivot and
the charts are all the same two calls with different params.

### Decision 5: Date bucketing — **dialect-aware SQL `GROUP BY`** (chosen)

Dev is SQLite, prod is Postgres. `date_trunc` is Postgres-only, so a tiny helper emits the right
bucket expression per dialect (`db.bind.dialect.name`):

- Postgres: `to_char(col, 'YYYY-MM-DD' | 'IYYY-IW' | 'YYYY-MM')`
- SQLite: `strftime('%Y-%m-%d' | '%Y-%W' | '%Y-%m', col)`

Grouping stays in the database (no Python row-bucketing), keeping the backend a lightweight
coordinator. The bucket key is returned as an ISO-ish string; the frontend maps buckets to ordinal
x-positions and formats tick labels.

### Decision 6: Time windows — **all-time / current-year / current-month** (chosen)

`window ∈ {all, year, month}` computed from the server clock (UTC, matching `datetime.utcnow()` used
throughout). `year`/`month` mean the *current* calendar year/month. The window bounds the `WHERE`
clause on the entity's creation timestamp before grouping.

---

## Database Changes

### Migration: add `created_by` to four tables (main Alembic chain)

Create with `alembic -c backend/alembic.ini revision -m "add created_by attribution columns"` (or
hand-authored) chaining from the current main head **`d1266f2f6e68`**
(`d1266f2f6e68_generic_seed_default_cluster.py`). **Generate the revision id with real entropy**
(`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`) and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` (CLAUDE.md rule 9 — the version namespace is flat
across core + all plugin migration dirs). The repo already carries multiple heads
(`d1266f2f6e68`, `1b1030f46ec9`, `b8c9d0e1f2a3`) which `yf-migrate` upgrades together; branching one
new revision off the main head is consistent with that.

Columns (all identical shape):

```python
# projects, processes, process_versions, environments
sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"),
          nullable=True)
op.create_index("ix_<table>_created_by", "<table>", ["created_by"])
```

`ondelete="SET NULL"` so deleting a user never cascades away their projects/processes; the stats just
re-bucket into "(unknown)".

### Best-effort backfill (pure-core only, inside the same migration)

- `projects.created_by` ← the **earliest** `project_members.user_id` per project (min `joined_at`).
  This reconstructs the creator, since `create_project` inserts the creator as the first member.
- `processes.created_by`, `process_versions.created_by`, `environments.created_by` ← left **NULL**
  for historical rows. Their creator isn't recoverable from pure-core data. (Optional, **out of
  scope for this migration**: a separate admin/ops script could backfill `process_versions.created_by`
  from `billing.user_transactions` where that plugin is installed — a core migration must not assume a
  plugin table exists.)

### Model changes

Add `created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
index=True)` to `Project`, `Process`, `ProcessVersion`, `Environment`, plus a
`created_by_user = relationship("User", foreign_keys=[created_by])` where a username is convenient for
responses. These `to_dict()` methods do **not** need to change (stats endpoints build their own
projections), avoiding churn on hot paths.

### Capture the creator at creation

| Path | File / line | Change |
|------|-------------|--------|
| Project create | `backend/routers/projects.py:153` | `Project(..., created_by=auth.user.id)` |
| Process + first version | `backend/models/process.py` `create_queued` | on new `Process(...)` set `created_by=user.id`; on **every** `ProcessVersion(...)` set `created_by=user.id` (the `user` row is already loaded at line 174) |
| Environment (pod scan) | `backend/models/process.py:1165` `_create_outputs` | `Environment(..., created_by=process.created_by)` (the creating `Process` is in scope) |

No other write paths create these rows. `deadline`/billing paths are untouched.

---

## Backend Design

New router module `backend/routers/stats.py` (mounted like `admin.py`, `tags=["Admin"]`), all routes
`Depends(require_admin)`. A shared helper module handles the dialect-aware bucket expression and the
entity registry.

### Entity registry (single source of truth)

```python
# entity -> (model, created_at column, {dimension: group-by column-or-expr})
ENTITIES = {
  "projects":  (Project,        Project.created_at,        {"user": Project.created_by}),
  "processes": (Process,        Process.created_at,        {"user": Process.created_by,
                                                            "project": Process.project_id,
                                                            "type": Process.type,
                                                            "environment": Process.environment_id}),
  "versions":  (ProcessVersion, ProcessVersion.created_at, {"user": ProcessVersion.created_by,
                                                            "state": ProcessVersion.state,
                                                            "type": None,  # via join to Process
                                                            "project": None}),
  "environments": (Environment, Environment.created_at,    {"user": Environment.created_by}),
  "users":     (User,           User.created_at,           {"admin": User.is_admin}),
}
```

Dimensions are a **server-side whitelist** (never raw-interpolated), mirroring the sort-column
whitelist pattern in the paged-users plan. `versions.type`/`versions.project` resolve via a join to
`processes`.

### `GET /admin/stats/summary`

Returns headline counts, each as `{all, year, month}`:

```json
{
  "projects":      {"all": 128, "year": 40, "month": 7},
  "processes":     {"all": 3120, "year": 900, "month": 210},
  "versions":      {"all": 8840, "year": 2600, "month": 640},
  "environments":  {"all": 22, "year": 5, "month": 1},
  "users":         {"all": 210, "year": 65, "month": 9},
  "process_types": {"all": 14, "year": 12, "month": 8}
}
```

Each cell is a `SELECT count(*)` (or `count(distinct type)` for `process_types`) with the window
`WHERE`. Small, indexed, ~18 scalar queries — cheap enough for one endpoint; can be issued
concurrently with `asyncio.gather` if needed.

### `GET /admin/stats/breakdown`

Query params:

| Param | Type | Notes |
|-------|------|-------|
| `entity` | str | whitelist key from `ENTITIES` |
| `group_by` | str | dimension whitelist for that entity |
| `window` | str | `all` \| `year` \| `month` (default `all`) |
| `filter_user` / `filter_project` / `filter_type` / `filter_state` | str | optional accumulated pivot filters |
| `limit` | int | default 50, clamped (top-N by count; remainder folded into an `"(other)"` row) |

Response:

```json
{
  "entity": "processes", "group_by": "user", "window": "month", "total": 210,
  "rows": [
    {"key": "12", "label": "alice", "count": 88},
    {"key": null,  "label": "(unknown)", "count": 5},
    {"key": "__other__", "label": "(other)", "count": 17}
  ]
}
```

`key` is the raw group value (stable for the next drill filter); `label` is human-readable
(username, project name, type string, state value). One `GROUP BY … ORDER BY count DESC LIMIT`.

### `GET /admin/stats/timeseries`

Query params: `entity`, `granularity` (`day` | `week` | `month`, default `month`), `window`,
optional `series_by` (a dimension → returns one series per top-N group value), plus the same
`filter_*`. Response:

```json
{
  "entity": "versions", "granularity": "month",
  "buckets": ["2026-01", "2026-02", "2026-03"],
  "series": [
    {"key": null, "label": "all", "counts": [120, 260, 300]}
  ]
}
```

`GROUP BY <bucket_expr>[, <series col>] ORDER BY bucket`. Buckets are the sorted distinct bucket keys
across all series (missing buckets zero-filled server-side so every series is bucket-aligned).

### Router registration

Mount in the same place `admin.py`/`auth.py` routers are included (`backend/main.py`) — one
`app.include_router(stats.router)`.

---

## Frontend Design

### API layer — `frontend/src/datamodel/api.js`

```js
export async function getAdminStatsSummary() { return (await apiClient.get('/admin/stats/summary')).data; }
export async function getAdminStatsBreakdown(params) { return (await apiClient.get('/admin/stats/breakdown', { params })).data; }
export async function getAdminStatsTimeseries(params) { return (await apiClient.get('/admin/stats/timeseries', { params })).data; }
```

### Query hooks — `frontend/src/datamodel/useAuthQueries.js`

`useAdminStatsSummary()`, `useAdminStatsBreakdown(params)`, `useAdminStatsTimeseries(params)` — each a
`useQuery` with the params in the `queryKey` and `keepPreviousData: true` so pivoting/re-windowing
doesn't flicker. (Read-only; no invalidation wiring needed.)

### New tab — `AdminPage.jsx`

Add to `builtinTabs`:

```js
{ key: 'stats', title: 'Stats', render: () => <StatsAdminPanel /> }
```

`StatsAdminPanel` (new `frontend/src/StatsAdminPanel.jsx`):

- **Window switch** (All / This year / This month) — a segmented control writing `?window=`.
- **Headline cards** from `useAdminStatsSummary()` — one card per entity showing the three windowed
  numbers; the active window is emphasised. Clicking a card seeds the pivot (`entity` set, empty
  filter path, `group_by` = first dimension).
- **Pivot section** driven by URL query state:
  - `entity`, `group_by`, `window`, and an ordered `path` of `dim=value` filters (encoded in the
    query string, e.g. `?entity=processes&window=month&f=user:12&f=project:abc`).
  - Renders a `StatChart` (bars) + a sortable table from `useAdminStatsBreakdown`. Clicking a
    bar/row **appends** `{dim: group_by, value: key}` to `path` and advances `group_by` to the next
    unused dimension (drill-down). A breadcrumb shows the path with per-level remove.
  - When no further dimension remains, the row is a leaf (no further drill).
- **Time-series section** — a `StatChart` (lines) from `useAdminStatsTimeseries`, honouring the same
  `entity`/`window`/filters, with a `granularity` toggle (day/week/month) and an optional
  `series_by` selector.

State lives in the URL via `useSearchParams`, merged (not clobbered) so the `:tab` path segment is
untouched — same helper pattern as the paged-users plan.

### `StatChart` — gladly wrapper — `frontend/src/StatChart.jsx`

A thin component that owns a gladly `Plot` (mirrors `PlotView/index.jsx` but far simpler — no
process/dataset machinery):

1. `const plot = new Plot(containerRef.current, { margin })` on mount; dispose on unmount.
2. Build a `DataGroup` with a single child (e.g. `stats`) whose columns are `Float32Array`s:
   - **bars**: `stats.x` = ordinal index `0..n-1`, `stats.count` = values. Config layer
     `{ type: "bars", parameters: { xData: "stats.x", yData: "stats.count", color } }`
     (field names per `BarsLayer._getAxisConfig`: `xData`, `yData`, `xAxis`, `yAxis`, `orientation`,
     `color`).
   - **lines**: one `lines` layer per series, `xData` = bucket ordinal, `yData` = series counts.
3. **Quantity kinds / axes**: register a `count` quantity kind (linear, integer-formatted) for the y
   axis and a categorical/ordinal x axis; store the ordinal→label map (usernames / project names /
   bucket strings) and render tick labels from it (gladly axes are numeric/continuous, so categorical
   and date x-values are passed as ordinals with a label lookup — this is the one bit of glue the
   dashboard needs beyond PlotView's usage). Follow the QK-registration approach in
   `datamodel/dataset.js` / `widgets/PlotView/quantityKinds.js`.
4. Click handling: `plot.on('click', …)` / `plot.pick(x, y)` to resolve the clicked bar's ordinal →
   `key`, invoking an `onDrill(key)` callback (drives the pivot). Same event API PlotView uses
   (see MEMORY "PlotView Event Handling").

`StatChart` takes props `{ kind: 'bars'|'lines', data, labels, onDrill }` and is reused by both the
breakdown and time-series sections.

---

## Metrics Catalogue (what the dashboard exposes)

- **Projects**: total / year / month; per user; over time.
- **Processes**: total / year / month; per user, per project, per type, per environment; over time
  (optionally split by type).
- **Process versions**: total / year / month; per user, per state, per type, per project; over time
  (optionally split by state).
- **Environments**: total / year / month; per user; over time.
- **Process-types**: distinct-type count per window; and as the `type` breakdown/series dimension on
  processes & versions.
- **Users**: total / year / month; per admin flag; sign-ups over time.

---

## Implementation Steps

1. **Migration** — add `created_by` (nullable, indexed, `SET NULL` FK) to `projects`, `processes`,
   `process_versions`, `environments`; backfill `projects.created_by` from earliest `ProjectMember`.
   Real-entropy revision id; chain off `d1266f2f6e68`; verify id uniqueness repo-wide. Apply with
   `env/bin/python backend/bin/yf-migrate`.
2. **Models** — add the column + `created_by_user` relationship to the four models.
3. **Capture creator** — `create_project`, `Process.create_queued` (process + every version),
   `_create_outputs` (environment ← process.created_by).
4. **Backend stats router** — `backend/routers/stats.py`: entity/dimension registry, dialect-aware
   bucket helper, `summary` / `breakdown` / `timeseries` endpoints, all `require_admin`; register in
   `backend/main.py`.
5. **Frontend API + hooks** — three functions in `api.js`, three hooks in `useAuthQueries.js`.
6. **`StatChart`** — gladly wrapper (bars/lines, ordinal-label axes, click→drill).
7. **`StatsAdminPanel`** — cards, window switch, pivot (breakdown + drill), time-series; URL-query
   state via `useSearchParams`.
8. **Register tab** — add the `stats` builtin tab in `AdminPage.jsx`.
9. **Manual verification** (below).

---

## Verification

- **Admin guard**: every `/admin/stats/*` route returns 401/403 without an admin token; works with
  one. A non-admin user sees no Stats tab data.
- **Summary**: card numbers match hand-run `SELECT count(*)` for each entity and window; `year`
  ⊇ `month` counts; `process_types` uses distinct type.
- **Attribution**: create a project/process/version as user A → they appear under A in the per-user
  breakdown; historical rows appear under **(unknown)**; `projects` backfill attributes old projects
  to their earliest member.
- **Drill-down**: clicking a per-user bar re-pivots to per-project for that user; the breadcrumb
  shows `user=A`; removing it pops back; the URL round-trips a drilled view on reload.
- **Windows**: switching All/Year/Month refilters both breakdown and time-series consistently.
- **Time-series**: bucket counts sum to the windowed total; day/week/month toggles re-bucket;
  `series_by=state` splits versions into per-state lines that sum to the "all" series; missing
  buckets render as zero, not gaps.
- **Charts**: gladly bars/lines render, tick labels show names/bucket strings (not raw ordinals),
  and clicking a bar drills.
- **Portability**: bucket expressions produce identical bucket keys on dev SQLite and prod Postgres.
- **Regression**: other admin tabs and the `/admin/:tab` routing are unaffected; process/project
  creation still succeeds (created_by populated).

---

## Open Questions

- [ ] Should `process_types` also expose a per-user distinct-type breakdown card, or only the global
      distinct count + the `type` dimension on processes/versions? (Plan does the latter.)
- [ ] Top-N `limit` for breakdowns — is 50 + an "(other)" fold row the right default, or add a
      "show all" affordance?
- [ ] Optional follow-up: an ops script to backfill `process_versions.created_by` from
      `billing.user_transactions` where the billing plugin is installed (deliberately excluded from
      the core migration).
- [ ] Do we want a **cost/usage** overlay (compute-seconds, tokens) sourced from the billing plugin
      via an `admin_tabs`/hook extension, or keep this dashboard purely count-based for v1? (Plan is
      count-only; billing stats would be a separate plugin-provided tab.)
```

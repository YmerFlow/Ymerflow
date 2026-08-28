# Admin Stats — Pivot Redesign (free N-dimensional grouping + filtering, chart layout fix)

## Goal

Rework the admin **Stats** dashboard (landed in `f8d6352`,
`docs/plans/done/admin-stats-dashboard.md`) so it becomes a proper **OLAP-style pivot explorer**
instead of a fixed single-dimension drill chain. Two problems drove this redesign:

1. **The drill-down is a fixed single-dimension chain, not free multi-dimensional analysis.** The
   backend groups by exactly one dimension (`GET /admin/stats/breakdown`, one `GROUP BY`), and the
   frontend walks a **hardcoded drill order** per entity (`processes: user → project → type →
   environment`, `StatsAdminPanel.jsx:31-37`). Time is not a grouping dimension at all — "per
   month" lives only in a disjoint "Over time" line chart (`granularity`). There is no way to ask
   "processes **per user per month**" or "**per process-type and user**", because those need **two
   group-by dimensions at once** (a cross-tab) and one of them (month) isn't a dimension.

2. **The gladly chart overlays the whole page.** `StatChart`'s container is `width:100%;
   height:Npx` with **no positioning context** (`StatChart.jsx:150-155`). gladly's `Plot` appends
   absolutely-positioned canvas/axis layers; with no `position: relative` ancestor establishing a
   containing block (and no `overflow` clip), those layers escape and paint over the rest of the
   page. `PlotView` does this correctly — its Plot container sits inside a
   `position: relative; minHeight: 0` parent (`widgets/PlotView/index.jsx:320-323`); `StatChart`
   just omits it.

**Design goal (settled with operator):** replace "one `group_by` + fixed drill order" with **pick
any ordered set of group-by dimensions (including a Time dimension at day/week/month granularity) +
any set of filters, in any combination**. Results render **table-primary** (a pivot table that
handles any dimensionality exactly, with totals) and **chart-secondary** (the first one–two
group-by dims visualised — bars when the x dimension is categorical, lines when it is temporal).

All aggregation stays a bounded, indexed `GROUP BY` in the database — no per-row Python work, no
expensive backend computation (CLAUDE.md Best Practice 7).

---

## Background & current state

(Confirmed by reading the implemented code.)

### Backend — `backend/routers/stats.py` (397 lines)

- Three endpoints, all `Depends(require_admin)`, `tags=["Admin"]`, registered in `backend/main.py`
  (`app.include_router(stats_router)`):
  - `GET /admin/stats/summary` — headline `{all, year, month}` counts for six specs. **Kept as-is.**
  - `GET /admin/stats/breakdown` — single `group_by`, one `GROUP BY group_col ORDER BY count DESC
    LIMIT n`, remainder folded into `__other__`. **Superseded by `pivot`.**
  - `GET /admin/stats/timeseries` — bucketed counts, optional single `series_by`. **Superseded by
    `pivot`** (a time dimension as group-by dim 1 is exactly a time series).
- Everything is a **server-side whitelist**, never raw-interpolated:
  - `_ENTITY_MODEL` (33-39), `_CREATED_AT` (42-48).
  - `_DIMENSIONS` (53-75): per-entity `{dim: (column, label_kind, needs_process_join)}`.
  - `_FILTERS` (79-102): per-entity `{name: (column, needs_process_join)}`.
- Helpers already present and reusable: `_window_start` (105), `_bucket_expr` (120, dialect-aware
  day/week/month), `_collect_filters` (134), `_coerce_filter` (149, `__null__` sentinel → NULL
  bucket, int/enum/bool coercion), `_apply_window_filters` (174), `_with_process_join` (186),
  `_resolve_labels` (194, bulk id→label for user/project/environment), `_serialize_key` (212),
  `_label_for` (224).

### Frontend

- `StatsAdminPanel.jsx` (337 lines) — URL-state-driven; **duplicates** the backend dimension
  whitelist (`DIMENSIONS`/`DIM_LABELS`, lines 31-42, plus hardcoded `['user','project','type',
  'state','environment']` at lines 57, 118, 132). Fixed drill: `drill()` (116) appends the clicked
  value as a filter and auto-advances group-by to the next unused dimension. Separate "Over time"
  section (283-331).
- `StatChart.jsx` (156 lines) — the only gladly consumer. gladly axes are numeric/continuous, so
  categories/buckets are passed as **ordinals 0..n-1** with labels rendered by the caller. Builds
  bars (`buildBars`) and multi-series lines (`buildLines`, per-series turbo colour column).
  Registers `stat_ordinal`/`stat_count`/`stat_series` quantity kinds once.
- `datamodel/api.js` (71-86): `getAdminStatsSummary/Breakdown/Timeseries`.
- `datamodel/useAuthQueries.js` (204-229): `useAdminStatsSummary/Breakdown/Timeseries`,
  `keepPreviousData: true`.
- `AdminPage.jsx` (181-185): registers the `stats` tab → `<StatsAdminPanel />`.

### No schema/model changes needed

The `created_by` attribution columns and all creation-path capture already landed with the original
plan (migration `...fe144ca5f_add_created_by_attribution_columns.py`, model edits). This redesign is
**query-shape + UI only** — no migration, no new columns.

---

## Design decisions

### Decision 1: One generic `pivot` endpoint supersedes `breakdown` + `timeseries` (chosen)

`GET /admin/stats/pivot` generalises both: a breakdown is `group_by=[dim]`, a time series is
`group_by=[<time-dim>]`, a cross-tab is `group_by=[dimA, timeB]`. One endpoint, one query shape, one
frontend hook. `summary` stays separate (it is a different shape — the six headline cards).

`breakdown` and `timeseries` routes + their `api.js`/`useAuthQueries.js` hooks are **removed** (this
feature is admin-only and just landed; nothing else consumes them — confirmed by the exploration).

### Decision 2: Time is a first-class grouping dimension (chosen)

Add temporal dimensions to every entity's `_DIMENSIONS`, keyed `t_day` / `t_week` / `t_month`
(labels "Day"/"Week"/"Month"), each resolving to `_bucket_expr(_CREATED_AT[entity], granularity)`
with a new label-kind `"bucket"` (label = the ISO-ish bucket string itself; `_serialize_key` returns
it verbatim). Because all three share the one `created_at` column, **at most one temporal dimension
may appear in a single `group_by` list** (validated server-side — grouping by both `t_day` and
`t_month` is rejected). This makes "per user per month" simply `group_by=[user, t_month]`.

### Decision 3: Response is a flat list of grouped rows; the frontend pivots (chosen)

The endpoint returns a flat list of `{keys, labels, count}` — one row per realised combination of
group-by values. The **frontend** reshapes this into the nested/grid pivot table and the chart.
Keeping the wire format flat (not a nested tree or a dense matrix) keeps the backend a thin
`GROUP BY` projector and lets the table render any dimensionality uniformly.

```jsonc
GET /admin/stats/pivot?entity=processes&group_by=user&group_by=t_month&window=all&filter_type=fft
{
  "entity": "processes",
  "group_by": ["user", "t_month"],
  "temporal": ["t_month"],          // which group-by dims are time buckets (drives chart line vs bar)
  "total": 210,
  "rows": [
    { "keys": ["12", "2026-01"], "labels": ["alice", "2026-01"], "count": 12 },
    { "keys": ["12", "2026-02"], "labels": ["alice", "2026-02"], "count": 18 },
    { "keys": [null, "2026-01"], "labels": ["(unknown)", "2026-01"], "count": 1 },
    { "keys": ["__other__", "*"], "labels": ["(other)", ""], "count": 30 }
  ]
}
```

`keys[i]` is the stable string the frontend passes straight back as `filter_<dim>` when the user
clicks a cell to drill (None → `__null__`). `labels[i]` is human-readable. Order of `keys`/`labels`
matches the requested `group_by` order.

### Decision 4: Top-N applies to the **first** group-by dimension (chosen)

With multiple group-by columns, a naive `ORDER BY count DESC LIMIT n` shreds the grid (you might
keep alice-in-Jan but drop alice-in-Feb). Instead:

1. Run a first pass grouping by **only the first group-by dimension**, `ORDER BY count DESC LIMIT
   limit`, to pick the **top-N values of dim 1** (default `limit=50`, clamped 1–500).
2. Run the full multi-dim `GROUP BY`, `WHERE dim1 IN (<the top-N values>)` — so every kept dim-1
   value is returned **fully cross-tabulated** across the remaining dims.
3. Fold everything outside the top-N dim-1 values into a single `__other__` row (`keys[0] =
   "__other__"`, count = `total − sum(kept)`), not further broken down.

This keeps the pivot grid clean (top-N users, each fully bucketed by month) and bounded. A
**global row backstop** (`MAX_PIVOT_ROWS = 5000`) guards against a pathological second dimension
with huge cardinality; if hit, the query is capped and the response sets `"truncated": true` and
`log()`s server-side — **no silent truncation** (a bare row cap that hid dropped data would read as
"complete" when it wasn't). Single-dimension pivots behave exactly like today's breakdown.

### Decision 5: Dimension/filter whitelist served to the frontend — kill the duplication (chosen)

Add `GET /admin/stats/schema` returning, per entity, the available dimensions and filters with
their labels, whether each dimension is temporal, and each filter's value type (for the value
picker). The frontend renders its group-by / filter builders **from this response** instead of the
hardcoded `DIMENSIONS`/`DIM_LABELS` mirror (`StatsAdminPanel.jsx:31-42, 57, 118, 132`). The
backend whitelist becomes the single source of truth. (Schema is static per deploy → fetched once,
`staleTime: Infinity`.)

```jsonc
GET /admin/stats/schema
{
  "entities": {
    "processes": {
      "label": "Processes",
      "dimensions": [
        { "key": "user", "label": "User", "temporal": false },
        { "key": "project", "label": "Project", "temporal": false },
        { "key": "type", "label": "Type", "temporal": false },
        { "key": "environment", "label": "Environment", "temporal": false },
        { "key": "t_day", "label": "Day", "temporal": true },
        { "key": "t_week", "label": "Week", "temporal": true },
        { "key": "t_month", "label": "Month", "temporal": true }
      ],
      "filters": [
        { "key": "user", "label": "User", "type": "user" },
        { "key": "project", "label": "Project", "type": "project" },
        { "key": "type", "label": "Type", "type": "string" },
        { "key": "environment", "label": "Environment", "type": "environment" },
        { "key": "state", "label": "State", "type": "state" }   // only where applicable
      ]
    },
    // projects, versions, environments, users …
  }
}
```

### Decision 6: Window switch stays as a coarse convenience filter (chosen)

`window ∈ {all, year, month}` remains a top-level pre-filter on the creation timestamp (it is a
different affordance from a `t_*` grouping dimension — "restrict to this month" vs "break down by
month"). No change to `_window_start`.

### Decision 7: Chart picks bars vs lines from the x dimension (chosen)

The chart (secondary) plots **group-by dim 1 on x** and **dim 2 as series** (further dims are
aggregated out of the chart but remain in the table). If dim 1 is temporal (`temporal[0]`), it is a
**line** chart (ordered buckets); otherwise **bars**. This is the one place the existing
`StatChart` bars/lines split is reused — extended so bars also support a series split (grouped or
stacked; **grouped** chosen for readability). When `group_by` is empty, the chart is hidden and only
the grand total shows.

---

## Backend design

### `stats.py` changes

- **Extend `_DIMENSIONS`** for every entity with `t_day`/`t_week`/`t_month` entries. Represent a
  temporal dim as a sentinel so `_bucket_expr` is applied lazily against that entity's
  `_CREATED_AT` at query time (the column differs per entity), e.g. store
  `("__temporal__", "day", False)` and special-case it when building the select.
- **New `_pivot_columns(entity, group_by: list[str])`** — validates each dim against the entity
  whitelist, rejects >1 temporal dim, returns the ordered list of `(sql_expr, label_kind,
  needs_join)`.
- **New route `GET /admin/stats/pivot`**:
  - Params: `entity` (required), `group_by: list[str] = Query([])` (repeated param, ordered),
    `window="all"`, the same `filter_*` params, `limit=Query(50, ge=1, le=500)`.
  - Empty `group_by` → return just `{entity, group_by: [], total}` (grand total).
  - Compute `total` via existing `_count`.
  - **Top-N dim-1 pass** (Decision 4) → set of kept dim-1 raw values.
  - **Full pass**: `select(*group_exprs, func.count())`, join if any dim/filter needs it,
    `_apply_window_filters`, `WHERE dim1 IN kept` (unless dim1 is `__other__`-free), `GROUP BY
    *group_exprs`, backstop `LIMIT MAX_PIVOT_ROWS+1` to detect truncation.
  - Resolve labels per dimension via `_resolve_labels` (batch per label-kind across that column's
    keys), build `rows` with `keys`/`labels`, append the `__other__` fold row, set `temporal` and
    `truncated`.
  - Reuse `_serialize_key`/`_label_for`; add the `"bucket"` label-kind (identity label, identity
    key).
- **Remove** `stats_breakdown` and `stats_timeseries` routes and their now-unused helpers
  (`MAX_SERIES`, timeseries-only code). Keep `summary`.

No new SQL constructs beyond a multi-column `GROUP BY` and an `IN` subfilter — both indexed-friendly
and dialect-portable. Bucket portability (SQLite dev / Postgres prod) is already handled by
`_bucket_expr`.

### `GET /admin/stats/schema`

Builds the Decision-5 payload by walking `_DIMENSIONS`/`_FILTERS` + a small label/type map. Static,
cheap, `require_admin`.

---

## Frontend design

### API + hooks

- `api.js`: replace `getAdminStatsBreakdown`/`getAdminStatsTimeseries` with
  `getAdminStatsPivot(params)` and add `getAdminStatsSchema()`. (`group_by` sent as a repeated query
  param — axios `paramsSerializer` with `arrayFormat: 'repeat'`, or pass an `URLSearchParams`.)
- `useAuthQueries.js`: replace the breakdown/timeseries hooks with `useAdminStatsPivot(params)`
  (`keepPreviousData: true`) and `useAdminStatsSchema()` (`staleTime: Infinity`). Keep
  `useAdminStatsSummary`.

### `StatsAdminPanel.jsx` — rebuilt around the schema + pivot

- **Window switch** and **summary cards**: unchanged; clicking a card seeds `entity` and clears
  group-by/filters.
- **Group-by builder**: an ordered row of removable chips + an "＋ Group by" dropdown listing the
  entity's dimensions from the schema (temporal ones grouped under "Time"). Order = nesting / chart
  axis order. Reorder via up/down or drag (simple ← / → buttons acceptable for v1). Enforce the
  single-temporal-dim rule client-side too (disable the other `t_*` once one is chosen).
- **Filter builder**: chips of `dim = value` + an "＋ Filter" control (pick dim, then a value
  picker keyed by the schema `type` — `state`/`admin` → enum select; `user`/`project`/`environment`
  → the existing selector components / a fetched option list; `string`/`type` → text or a distinct
  list). Clicking a pivot **cell/row** adds that combination as filters (drill) — additive, not the
  old auto-advance.
- **Pivot table (primary)**: render `rows` grouped by the group-by tuple. For ≤2 dims, a grid
  (dim1 rows × dim2 columns) with row/column totals; for ≥3 dims, indented nested rows (dim1 →
  dim2 → …) with subtotals, or a flat multi-column table with a totals row — **grid for 1–2 dims,
  nested-indent for 3+** (chosen). `(other)`/`(unknown)` rendered as labelled buckets, not drillable
  (`__other__`) / drillable-to-null (`(unknown)`).
- **Chart (secondary)**: `StatChart` fed the pivoted dim1×dim2 data; bars vs lines from
  `temporal[0]` (Decision 7). Hidden when no group-by.
- **URL state**: `entity`, `window`, repeated `g=<dim>` for the ordered group-by, repeated
  `f=<dim>:<value>` for filters (reuse the existing `parsePath` encoding). Reload-safe / shareable,
  merged not clobbered (same `useSearchParams` helper already in the file).
- **Delete** the hardcoded `DIMENSIONS`/`DIM_LABELS`/filter-dim arrays — all now come from
  `useAdminStatsSchema()`.

### `StatChart.jsx` — overlay fix + series-aware bars

- **Overlay fix**: wrap the Plot container in a `position: relative; overflow: hidden` box with the
  explicit height, exactly like `PlotView` (`index.jsx:320`) — the Plot's own `ref` div stays
  `width:100%; height:100%` inside the positioned parent. This is the whole fix for "overlays
  everything".
- **Series-aware bars**: extend `buildBars` to accept an optional set of series (grouped bars: for
  category i, one bar per series offset within the slot) reusing the `stat_series` turbo colour
  column already built for lines. Lines path largely unchanged. Keep the ordinal-axis + external
  label-lookup pattern (gladly axes are numeric-only). Click → `onDrill(keys)` now reports the full
  dim1(/dim2) key tuple for the clicked bar.

---

## Implementation steps

1. **Backend `pivot`** — extend `_DIMENSIONS` with `t_day/t_week/t_month`; add `_pivot_columns`,
   the `"bucket"` label-kind, top-N-dim-1 + full-pass query, `__other__` fold, `truncated` +
   `MAX_PIVOT_ROWS` backstop with `log()`. Add `GET /admin/stats/schema`. Remove `breakdown` /
   `timeseries` routes + dead helpers. Keep `summary`.
2. **Frontend data layer** — `getAdminStatsPivot` + `getAdminStatsSchema` in `api.js`;
   `useAdminStatsPivot` + `useAdminStatsSchema` in `useAuthQueries.js`; drop the old two hooks.
3. **`StatChart`** — positioned wrapper (overlay fix); series-aware grouped bars; tuple-key drill.
4. **`StatsAdminPanel`** — schema-driven group-by + filter builders, pivot table (grid ≤2 dims /
   nested ≥3), secondary chart, URL state (`g=`/`f=`), delete hardcoded whitelists.
5. **Manual verification** (below).

No migration, no model changes.

---

## Verification

- **Admin guard**: `/admin/stats/pivot` and `/admin/stats/schema` return 401/403 without an admin
  token; work with one.
- **Single dim == old breakdown**: `group_by=[user]` matches a hand-run `GROUP BY created_by` and
  the previous breakdown numbers; `(unknown)` and `(other)` behave as before.
- **Cross-tab**: `group_by=[user, t_month]` on processes returns, for each top-N user, one row per
  month; row counts sum to that user's windowed total and the grand total; the grid renders users ×
  months with correct margins.
- **Free combination**: `group_by=[type, user]` and `group_by=[t_week]` and `group_by=[project,
  type, user]` (3 dims) all return correctly and render (grid for 2, nested for 3).
- **Single-temporal rule**: `group_by=[t_day, t_month]` is rejected 400; the UI disables the second
  time dim.
- **Filters compose**: `filter_type=fft&filter_state=completed` with `group_by=[user]` narrows both
  the table and the chart; clicking a cell adds the corresponding filter(s) and re-queries.
- **Top-N + truncation**: with `limit` small, only top-N dim-1 values are kept (fully
  cross-tabulated), the rest fold into `(other)`; a synthetic high-cardinality second dim trips
  `truncated: true` and logs — never silently drops rows.
- **Chart**: temporal dim-1 → lines, categorical dim-1 → grouped bars; **the chart stays inside its
  box and does not overlay the page** (the core reported bug); tick labels show names/buckets, not
  ordinals; clicking drills.
- **Schema-driven UI**: no dimension/filter list is hardcoded in the frontend; adding a dimension
  to `_DIMENSIONS` alone makes it appear in the builders.
- **Portability**: bucket keys identical on dev SQLite and prod Postgres.
- **Regression**: summary cards unchanged; other admin tabs and `/admin/:tab` routing unaffected;
  URL round-trips a pivot on reload.

---

## Open questions

- [ ] Grouped vs stacked bars for the 2-dim categorical chart (plan: **grouped**). Stacked reads
      totals better; grouped compares series better.
- [ ] Filter value pickers for high-cardinality dims (user/project): reuse the existing selector
      components, fetch a distinct-value list, or free-text id entry? (Plan leans on existing
      selectors where they exist, else a fetched option list.)
- [ ] Pivot table for 3+ dims: nested-indent (chosen) vs a flat "one column per dim" table with a
      totals row — confirm the nested form is what you want before building it.
- [ ] Keep `limit` default at 50 top-N dim-1 values, or expose a "show all / top-N" control?

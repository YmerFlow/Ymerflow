# Admin Stats — drilldown-table redesign

## Context

The current admin **Stats** tab (`frontend/src/StatsAdminPanel.jsx`) renders a grid of
headline **cards** plus an abstract **group-by / filter builder** (badges, dropdowns, move
left/right chevrons). The user finds it confusing and non-functional — clicking a card
"shows nothing / 0". The request: kill the cards and the builder, and make the **table itself
the interface** — click a column heading to change the breakdown, click a value/cell to filter
and drill deeper — with a **plot that follows the current view**.

An interactive mockup was built and agreed at
`docs/plans/done/admin-stats-drilldown-redesign-mockup.html` — it is the visual/behavioural
reference for this rewrite (open it in a browser).

**Key finding: this is a frontend-only change.** The backend `/admin/stats/pivot` endpoint
(`backend/routers/stats.py`) already does free N-dimensional GROUP BY + filters + time window and
returns `{total, rows:[{keys,labels,count}], temporal, truncated}`. `StatChart.jsx` is already a
reusable gladly wrapper (`kind` bars|lines, `xLabels`, `xKeys`, `series`, `onDrill(xKey,seriesKey)`)
that supports single bars, grouped bars and multi-line. **No backend or StatChart changes are
needed.**

## Agreed design decisions

- **Top-level "count" categories (entity toggle):** Processes, Process versions, Projects, Users.
  **Environments dropped as a top entity** (thin — only breaks down by user) but **kept as a
  breakdown/filter dimension** of processes (already in the backend schema; no backend change).
- **Drill = auto-advance along a hierarchy:** clicking a value adds the filter AND switches the
  breakdown to the next dimension. "Next" walks a per-entity **`DRILL_ORDER`** forward from the
  current dimension (e.g. processes: `environment → type → project → user`, because types belong to
  environments), not just the next unused schema dim. Dims not listed in `DRILL_ORDER` are appended
  in schema order; temporal dims are never part of the auto-advance chain. The default landing
  breakdown is the first dimension in that order.
- **Cross-tab kept:** an optional second dimension ("split into columns by") renders a grid whose
  cells filter both dims at once; the plot becomes stacked/grouped bars. Group-by is capped at
  **2 dimensions** (row + optional column) — deeper exploration happens via filters, not more
  group-by levels.
- **Layout:** big filtered total → breakdown dropdowns → plot → drilldown table (plot above table).

## Scope

Rewrite **`frontend/src/StatsAdminPanel.jsx`** only. Reuse `StatChart.jsx` unchanged and the
existing hooks in `frontend/src/datamodel/useAuthQueries.js`. AdminPage wiring
(`AdminPage.jsx:183` `title:'Stats', render: () => <StatsAdminPanel/>`) is untouched.

## Implementation

### 1. Remove
- The `CARDS` grid and its `useAdminStatsSummary` usage (drop the `summary` query entirely — the
  headline number now comes from the pivot response's `total`). Leave the backend `summary`
  endpoint in place, just unused.
- The badge-based group-by **builder** (add/remove/move chevrons) and the separate filter builder
  form row.
- The 3+-dimension nested-outline table path (`buildNodes` / `flattenNodes`) — no longer reachable
  with a 2-dim cap.

### 2. State (keep URL-driven, reuse existing helpers)
Keep all state in the query string so views stay shareable/reload-safe (existing pattern):
- `entity` — one of `projects | processes | versions | users`.
- `window` — `all | year | month`.
- `g` (repeated, ordered, max 2) — `[rowDim]` or `[rowDim, colDim]`.
- `f=dim:value` (repeated) — drill filters. Reuse existing `parseFilters` / `filtersToParams`
  and the `keyStr` NULL sentinel helper (empty value = `(unknown)` bucket).
- Pivot fetched via existing `useAdminStatsPivot({entity, group_by:g, window, filter_*, limit:50})`;
  dimension/filter whitelist via existing `useAdminStatsSchema`. Nothing hardcoded — dimension
  lists come from the schema, plus the three temporal dims already flagged `temporal:true`.

### 3. UI structure (mirror `stats-mockup.html`)
- **Entity toggle** — segmented `ButtonGroup` (4 entities). Switching resets `g` and `f`, sets
  `rowDim` to the entity's first schema dimension.
- **Window toggle** — All time / This year / This month (as today).
- **Filter breadcrumb** — removable chips, one per active `f`, plus "clear all". Empty state:
  "Filters: none — showing all <entity>".
- **Headline total** — `pivot.total` big; "<entity> (filtered)" when filters active.
- **Breakdown controls** — "Break down by [rowDim ▾]" and "split into columns by [colDim ▾ | none]"
  dropdowns; options come from schema dims minus any dim already fixed by a filter, minus the
  other selected dim. Temporal dims in a "Time" optgroup; at most one temporal dim total
  (backend enforces this too).
- **Plot** (`StatChart`) — `kind='lines'` when `rowDim` is temporal, else `'bars'`; single series
  when no `colDim`, multi-series (grouped bars / stacked) when `colDim` set. `onDrill(xKey,
  seriesKey)` → `drill([rowDim→xKey, colDim→seriesKey])`. Reuse existing `buildChartData` /
  `orderedCategories` reshaping (already correct for 1–2 dims) and `statSeriesColor` for the legend.
- **Drilldown table** — the primary surface:
  - **Left heading** shows `rowDim` label with a `▾` and is **clickable to cycle** to the next
    available breakdown dimension (in addition to the dropdown).
  - **One dimension:** ranked list (count desc, `(other)` fold last), mini-bar per row; row label
    and count clickable → `drill([rowDim→key])`.
  - **Two dimensions:** grid (reuse existing `PivotGrid` logic) — clickable **column headings**
    (`drill([colDim→colKey])`), clickable **row labels** (`drill([rowDim→rowKey])`), clickable
    **cells** (`drill` both). Row/column margins + grand total in `tfoot`.
  - `(other)` rows and `*`/`__other__` keys are never drillable (existing `drill` already guards).

### 4. Drill / auto-advance logic
`drill(pairs)`:
1. For each `{dim,value}`: replace any existing filter on that dim, append the new one (reuse
   the existing additive `addFilters`).
2. **Auto-advance:** if `rowDim` is now among filtered dims, set `rowDim` to the first schema
   dimension not filtered and not equal to `colDim`; if `colDim` is now filtered, clear it.
3. Write URL (`g`, `f`) — existing `setGroupBy` / `setFilters` writers (merge, never clobber the
   `:tab` segment).

## Files
- `frontend/src/StatsAdminPanel.jsx` — rewrite (the whole change).
- Reused unchanged: `frontend/src/StatChart.jsx`, `frontend/src/datamodel/useAuthQueries.js`
  (`useAdminStatsSchema`, `useAdminStatsPivot`), `backend/routers/stats.py`.
- `docs/plans/done/admin-stats-drilldown-redesign-mockup.html` — the agreed interactive mockup,
  kept alongside this plan as the behavioural reference.

## Verification
Frontend auto-reloads (do **not** start servers). As an **admin** user:
1. Open Admin → **Stats**. Confirm no cards; entity toggle shows the 4 categories.
2. Default view (Processes / break down by Environment — top of `DRILL_ORDER`): table lists
   environments with counts + bars; headline total equals the `tfoot` total and the
   `(other)`-inclusive sum.
3. Click an environment value → it becomes a filter chip and the breakdown auto-advances to **Type**
   (next in the hierarchy); total drops accordingly. Repeat to drill several levels; remove a chip
   and confirm it recomputes.
4. Set "split into columns by" = Environment → cross-tab grid renders; click a **column heading**,
   a **row label**, and a **cell** — each adds the expected filter(s). Plot shows stacked/grouped
   bars with a matching legend.
5. Break down by **Month** → plot switches to a line; clicking a point drills to that bucket.
6. Switch entity to Users → only `admin` + time dims offered; Environments absent from the entity
   toggle but still selectable as a dimension under Processes/Versions.
7. Copy the URL, reload → identical view (URL-driven state intact).
8. Sanity-check the network tab: each interaction issues one
   `GET /admin/stats/pivot?entity=…&group_by=…&filter_…` and numbers are internally consistent.

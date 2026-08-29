# GUI Usage Tracking — Navigation views (aggregate, non-per-user)

## Goal

Track **what parts of the app people actually visit**, as aggregate stats (not per individual
user). Today we only have entity-row facts (processes/versions created). We want to know which
navigation coordinates people land on and dwell — the user-visible URL combination of
**workspace → project → process → version → part → sounding**.

The reporting half already exists: the admin **Stats** pivot dashboard
(`backend/routers/stats.py` + `frontend/src/StatsAdminPanel.jsx`, see
`docs/plans/done/admin-stats-pivot-redesign.md`) does free N-dimensional `GROUP BY` over a
server-side whitelist of entities, with temporal buckets, top-N folding and label resolution. The
only missing half is a **source of navigation events**. This plan adds exactly that and plugs it
into the existing pivot as one new entity — no new reporting UI.

**Non-goal / explicit privacy stance:** this is aggregate usage, *not* per-user analytics. We store
**no user id and no session id**. That is a deliberate choice: it makes the data aggregate by
construction (sidesteps any GDPR/individual-tracking question) at the cost of not being able to do
per-user funnels or path reconstruction. See Open Questions.

---

## Design decisions (settled with operator)

### Decision 1: Raw event rows, one per dwelled navigation (chosen)

Store **one row per navigation** — the six coordinates plus a server timestamp — rather than
pre-aggregated `(tuple, day) → count` counters.

Rationale: the existing pivot counts *rows* with `func.count()` and every entity carries a real
`created_at` that drives both the window filter and the `t_day/t_week/t_month` temporal buckets. A
raw-event table therefore plugs into the pivot with **zero aggregation changes** — navigation
becomes just another `_ENTITY_MODEL` entity and time-bucketing works for free. The counter
alternative would require `SUM(count)` special-casing threaded through three places in the pivot and
would bake day-granularity in at write time. The debounced-dwell capture (Decision 3) keeps row
volume modest, which removes the main reason to pre-aggregate. Unbounded growth is handled by a
future retention/rollup policy (Open Questions) — deferred, not designed-in now.

### Decision 2: Store IDs, resolve to names at read time (chosen)

workspace / project / process coordinates are stored as their raw **IDs** (strings); version /
sounding / workspace_version as **integers**; part as its **string** (`"all"` normalised to a
value, see Decision 5). Names are resolved at *read* time by the pivot's existing `_resolve_labels`
(project already; workspace/process added). A resource deleted after the visit leaves the historical
row intact (the table has **no foreign keys / cascade** — a view is a fact that must survive the
resource) and simply renders as its raw id via `_label_for`'s existing `f"({kind} {raw})"` fallback.
No denormalised name snapshot, no table bloat.

### Decision 3: One capture chokepoint, debounced-dwell (chosen)

All navigation state is derived from `location.pathname` in exactly one place —
`parseUrlParams(location.pathname)` in `ProcessProvider` (`frontend/src/ProcessContext.jsx`). A
single `useEffect` keyed on the parsed params captures **every** navigation: the `navigate()`
setters, `AppBootstrap` landings, browser back/forward, and pasted URLs. It is **debounced ~700ms**
so a coordinate is only recorded once the URL has *stayed put* — scrubbing through soundings/parts
or fast drill-down does not flood the table with transient states. Bare `/app` (no coordinate set)
is not recorded.

### Decision 4: Full tuple including sounding (chosen)

Store all six coordinates (+ workspace_version). Because a row only exists for an actually-dwelled
coordinate, cardinality tracks real usage, not the cross-product. "Do people drill all the way to a
sounding?" is answerable, and any coarser question ("just per project") is a read-time aggregation.
"Depth" (deepest non-null coordinate) is derivable at read time and need not be stored.

### Decision 5: Coordinate normalisation matches the URL builder (chosen)

To keep the stored tuple identical to what the URL encodes (so counts don't split across
equivalent states):

- `part`: the app treats absent as `"all"` (`currentPart = urlParams.part || "all"`). Record it the
  same way the URL does — store `null` when part is absent/`"all"`.
- `sounding`: defaults to `0` when absent (`currentSounding = ... : 0`). Store the raw parsed value;
  absent stays `null` (distinct from an explicit `s/0`), matching `buildUrlPath` which omits absent.
- Only emit coordinates that are actually present per the nesting rule (a child is null if its
  parent is null), so the stored row is always a well-formed prefix of the hierarchy.

### Decision 7: Client batches events; ≤ 1 REST submission per 10s (chosen)

Capture (dwell) and transmission (flush) are decoupled. Recorded events accumulate in a client-side
queue and are sent as an **array** in a single POST, throttled to **at most one submission every
10 seconds** (leading flush if the window has elapsed, else one trailing flush). A `pagehide` /
tab-hidden flush bypasses the throttle so trailing events aren't lost. This keeps network chatter
negligible without losing events, and matches the endpoint's `{ "views": [...] }` batch shape. See
Frontend design → Emit.

### Decision 6: Ingest endpoint is optional-auth, records no identity (chosen)

Public workspaces and read-only publications are viewable **without login**, and we want those views
counted too. The ingest endpoint therefore does **not require authentication** and records no user
regardless of whether a token is present. Trade-off: an unauthenticated write endpoint is a mild
count-inflation vector; mitigated by bounded validation (batch-size cap, coordinate type/length
checks) and the fact that it only feeds an admin-only aggregate. See Open Questions.

---

## Backend design

### New model — `backend/models/nav_view.py`

```python
class NavView(Base):
    __tablename__ = "nav_views"

    id = Column(Integer, primary_key=True, autoincrement=True)   # high-volume → int PK, not UUID
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)  # window + t_* buckets

    workspace         = Column(String(255), nullable=True)  # id/slug (e.g. "default")
    workspace_version = Column(Integer,     nullable=True)
    project           = Column(String(255), nullable=True)  # project id
    process           = Column(String(255), nullable=True)  # process id
    version           = Column(Integer,     nullable=True)
    part              = Column(String(255), nullable=True)  # null == "all"
    sounding          = Column(Integer,     nullable=True)
```

- **No `user_id`, no FKs, no cascade** (Decisions 1, 2, 6). Index on `created_at` for the window
  filter/bucketing. (A composite index can be added later if a specific dimension query proves slow —
  not up front.)
- Register in `backend/models/__init__.py` (import + `__all__`), matching the existing per-file
  pattern.

### Migration — `backend/alembic/versions/`

`create_table("nav_views", ...)` + the `created_at` index. **Generate the revision id from real
entropy** (`python3 -c "import uuid; print(uuid.uuid4().hex[:12])"`) and verify uniqueness with
`grep -rn "revision = '<id>'" --include=*.py .` across all migration dirs — never invent one
(CLAUDE.md rule 9). No UUID literals needed (int PK).

### Ingest endpoint — `POST /nav/view` (new small router, or into an existing public router)

- **Optional-auth** (Decision 6): no `require_*` dependency; records no identity.
- Body: a small batch to coalesce client flushes —
  `{"views": [{"workspace","workspace_version","project","process","version","part","sounding"}, ...]}`.
- Server-stamps `created_at = datetime.utcnow()` (ignore any client clock — bucket granularity is
  day+, server time is sufficient and untrusted-clock-proof).
- **Bounded validation**: cap `len(views)` (e.g. ≤ 50, drop overflow), enforce string-length caps and
  integer coercion on each coordinate, skip malformed rows. Do **not** swallow — a malformed *request
  shape* is a 400; individual unparseable coordinates are normalised to null.
- Insert the rows (`add_all`), commit. No expensive work (CLAUDE.md Best Practice 7).

### Pivot integration — `backend/routers/stats.py`

Add navigation as one whitelisted entity; the `func.count()` machinery counts rows = number of
views. Concretely:

- `_ENTITY_MODEL["navigation"] = NavView`; `_CREATED_AT["navigation"] = NavView.created_at`;
  `_ENTITY_LABELS["navigation"] = "Navigation views"`.
- `_DIMENSIONS["navigation"]`: `workspace` (kind `"workspace"`), `project` (kind `"project"`, reuses
  existing resolver), `process` (kind `"process"`), `version`/`sounding`/`part`/`workspace_version`
  (kind `"raw"`). All `needs_process_join=False` (self-contained table).
- **Extend `_resolve_labels`** with two new kinds:
  - `"process"` → `select(Process.id, Process.name)`.
  - `"workspace"` → resolve the workspace id to its name (via `Workspace`; confirm the name column
    during implementation). Deleted → falls back to `(workspace <id>)` automatically.
  - `project` reuses the existing branch.
- **Extend `_label_for`** so the new id-kinds route through the lookup (add `"process"`,
  `"workspace"` to the `kind in (...)` id-branch); `"raw"` covers version/sounding/part.
- `_FILTERS["navigation"]`: the same coordinates, so clicking a cell drills (e.g. pick a workspace →
  break down by project). version/sounding/workspace_version are integer columns → **extend
  `_coerce_filter`** to int-coerce those filter names (string compare against an Integer column is
  not portable to Postgres). part/workspace/process/project stay string equality; `__null__` selects
  the absent bucket (already handled).
- **Endpoint signature + `_collect_filters`**: add discrete params
  `filter_workspace / filter_process / filter_version / filter_part / filter_sounding`
  (reuse `filter_project`), matching the existing `filter_*` convention. *(Minor wart: this is the
  5th–9th discrete filter param. If it grows further, generalise to a repeated `filter=<dim>:<value>`
  param — noted, not done now.)*
- `_DIM_LABELS` / `_FILTER_TYPES`: add `workspace`, `process`, `version`, `sounding`, `part`,
  `workspace_version` with sensible labels and value-picker types (`workspace`/`process` behave like
  id-selectors; `version`/`sounding`/`workspace_version` = number; `part` = string).
- **Optional**: add a `("navigation", NavView, NavView.created_at, None)` headline card to
  `stats_summary` ({all, year, month} view counts).

No new SQL constructs — the existing multi-column `GROUP BY` + top-N + `__other__` fold + temporal
bucketing all apply unchanged.

---

## Frontend design

### Capture — `frontend/src/ProcessContext.jsx`

A debounced effect inside `ProcessProvider`, keyed on the already-parsed `urlParams`:

```js
useEffect(() => {
  const { workspace, workspaceVersion, project, process, version, part, sounding } = urlParams;
  if (!workspace && !project && !process) return;   // bare /app → skip
  const t = setTimeout(() => {
    recordNavView({ workspace, workspace_version: workspaceVersion, project,
                    process, version, part, sounding });   // part=null when "all" (Decision 5)
  }, 700);                                            // dwell debounce (Decision 3)
  return () => clearTimeout(t);                       // scrubbing clears before it fires
}, [urlParams]);
```

`urlParams` is memoised on `location.pathname`, so the effect re-arms on every navigation and the
cleanup cancels transient states — only a *dwelled* coordinate is recorded.

### Emit — `frontend/src/datamodel/navTracking.js` (small module) + `api.js`

Two independent timers (do not conflate them):

- **Dwell debounce (700ms, Decision 3)** decides *what becomes an event* — the effect above only
  calls `recordNavView(coords)` after the URL has stayed put.
- **Flush throttle (≤ 1 submission / 10s, Decision 7)** decides *how often we hit the network* —
  each POST carries an **array** of all events queued since the last flush.

Behaviour of `recordNavView(coords)`:

- Push `coords` onto an in-memory queue (the queue is the batch; no per-event request).
- **Leading-then-throttled flush**: if ≥ 10s have elapsed since the last submission, flush now;
  otherwise schedule a single trailing flush for the remainder of the window. Never more than one
  submission per 10s regardless of how many events queued (with dwell at 700ms that's ≲ 14 events
  per batch in the worst case, typically 1–2).
- **Always flush on `pagehide` / `visibilitychange → hidden`** (unconditionally, bypassing the
  throttle) so a trailing batch isn't lost when the tab closes/navigates away.
- **Empty-queue guard (invariant): never hit the network with an empty array.** Every flush path —
  the leading flush, the trailing throttle-timer flush, and the `pagehide`/tab-hidden flush — first
  checks the queue and returns early (no `sendBeacon`, no `post`) if there is nothing to send. A
  submission only ever fires for ≥ 1 queued event.
- Each flush posts the whole array and clears the queue. Prefer
  `navigator.sendBeacon(ABSOLUTE_API + '/nav/view', blob)` for reliability across unload; fall back
  to `apiClient.post('/nav/view', { views })`. `sendBeacon` sends no auth header — fine, the endpoint
  is optional-auth and stores no identity (Decision 6). The request body is exactly the endpoint's
  `{ "views": [...] }` batch shape.
- Fire-and-forget: a failed submission must never surface to the user or block navigation. On a
  failed non-beacon flush the queued events may be dropped (acceptable for aggregate stats) rather
  than retried indefinitely.

### Read — no new UI

`docs/plans/done/admin-stats-pivot-redesign.md` already landed the **schema-driven** builders: the
frontend renders its group-by / filter controls from `GET /admin/stats/schema`. Adding the
`navigation` entity + its dimensions/filters to the backend whitelist makes it appear in the existing
pivot explorer automatically. Labels/keys come from the backend, so `StatChart` needs no change. The
only possible read-side touch is value-picker components for the new filter types
(`workspace`/`process` selectors) — verify during implementation; text/number entry is an acceptable
v1 fallback.

---

## Implementation steps

1. **Model + migration** — `backend/models/nav_view.py` (`NavView`), register in
   `models/__init__.py`; Alembic migration creating `nav_views` + `created_at` index
   (real-entropy revision id, verified unique).
2. **Ingest endpoint** — `POST /nav/view` optional-auth batch insert with bounded validation;
   register the router in `backend/main.py`.
3. **Pivot integration** — extend `_ENTITY_MODEL/_CREATED_AT/_DIMENSIONS/_FILTERS/_DIM_LABELS/`
   `_FILTER_TYPES/_ENTITY_LABELS`, `_resolve_labels` (+`process`,`workspace` kinds), `_label_for`,
   `_coerce_filter` (int coords), and the `stats_pivot` signature + `_collect_filters` with the new
   `filter_*` params; optional summary card.
4. **Frontend emit** — `navTracking.js` (queue + beacon/axios flush) and `recordNavView` wired into
   the debounced effect in `ProcessProvider`.
5. **Manual verification** (below).

No changes to existing entities; the reporting UI is reused as-is.

---

## Verification

- **Capture chokepoint**: navigating workspace → project → process → version → part → sounding, using
  back/forward, and pasting a deep URL each produce exactly one `nav_views` row after the dwell
  delay; rapidly scrubbing soundings produces **one** row (the landing), not one per step; bare
  `/app` produces none.
- **Normalisation**: `part` absent/`"all"` stored as null; a real part stored verbatim; nesting
  prefix always well-formed (no child without parent).
- **No identity stored**: rows have no user/session column; an anonymous publication view is recorded
  the same as an authenticated one (Decision 6).
- **Pivot — single dim**: `entity=navigation&group_by=project` counts views per project, resolving
  ids to names; a deleted project shows `(project <id>)` not a crash.
- **Pivot — cross-tab + time**: `group_by=[workspace, t_month]` and `group_by=[project, process]`
  render as grid/nested with correct margins summing to the grand total; `group_by=[t_week]` gives a
  view time series.
- **Depth question**: `group_by=[process]` filtered vs `group_by=[sounding]` answers "how far do
  people drill" from the same table.
- **Filters/drill**: clicking a workspace cell adds `filter_workspace` and re-breaks-down by project;
  integer coords (`filter_version`, `filter_sounding`) coerce and match on both SQLite (dev) and
  Postgres (prod).
- **Batch/throttle**: several quick navigations within a 10s window arrive as **one** POST with a
  multi-element `views` array; no more than one submission fires per 10s; closing the tab flushes the
  trailing batch (verify a `nav_views` row lands for the last coordinate viewed before close). With
  an **empty queue, no request is made at all** — no throttle-timer POST and no pagehide POST fire
  when there's nothing to send.
- **Ingest robustness**: oversized batch is capped, malformed coordinates normalise to null, a bad
  request shape is a 400 (not swallowed); a failed beacon never affects the UI.
- **Portability**: bucket keys identical on SQLite and Postgres (reuses `_bucket_expr`).
- **Regression**: existing entities/summary/other admin tabs unaffected; navigation just appears as a
  new pickable entity in the schema-driven builder.

---

## Open questions

- [ ] **Retention / rollup.** Raw rows grow with usage (dwell-debounced, so modest). Policy options:
      periodic `DELETE` beyond N days; or a nightly fold of old rows into a pre-aggregated
      `(tuple, day) → count` companion table for long-term trends. Out of scope here — decide before
      it matters in prod.
- [ ] **Ingest abuse.** Unauthenticated writes can inflate counts (Decision 6). Accept as low-stakes,
      or add light protection (per-IP rate limit / require auth and forgo anonymous publication
      views)?
- [ ] **workspace_version / version dimensions.** Stored and exposed as dimensions for completeness;
      confirm they're wanted in the builder or whether they only ever matter as filters.
- [ ] **Sessionless is deliberate.** Confirm we never want per-session path reconstruction / funnels
      (which would require a non-identifying session token — a different privacy posture).
- [ ] **`part` value space.** Confirm `part` is low-enough cardinality to be a useful dimension (vs
      only ever a filter).

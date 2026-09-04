import React from 'react';
import { Card, Table, Button, ButtonGroup, Form, Alert } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { useAdminStatsSchema, useAdminStatsPivot } from './datamodel/useAuthQueries';
import StatChart, { statSeriesColor } from './StatChart';

// Admin stats dashboard — drilldown-table explorer
// (docs/plans/done/admin-stats-drilldown-redesign.md, mirroring …-mockup.html). No cards, no
// group-by builder: the *table* is the interface. Click a column heading to change the breakdown,
// click a value / cell to filter and drill deeper; a plot follows the current view. All state
// (entity, window, breakdown, filters) lives in the URL query string so a view is reload-safe and
// shareable; the :tab path segment is left untouched (merge-not-clobber). Every dimension / filter
// list is served by GET /admin/stats/schema — nothing about the dimensions is hardcoded here.

// Top-level "count" entities are derived at runtime from the /schema whitelist (see the component)
// so any entity the backend exposes appears automatically — e.g. navigation. ENTITY_PREFERRED fixes
// the display order of the entities we already curate; anything else the schema lists is appended
// after these in schema order. ENTITY_EXCLUDE drops environments as a *top-level* entity (thin —
// only breaks down by user) though it stays a breakdown/filter dimension of processes/versions.
const ENTITY_PREFERRED = ['processes', 'versions', 'projects', 'users', 'navigation'];
const ENTITY_EXCLUDE = new Set(['environments']);

const WINDOWS = [
  { key: 'all', label: 'All time' },
  { key: 'year', label: 'This year' },
  { key: 'month', label: 'This month' },
];

// Logical drilldown hierarchy per entity (Decision 2). After drilling one dimension the breakdown
// auto-advances by walking FORWARD from the current dimension in this order (processes:
// environment → type → project → user, because types belong to environments). Non-temporal schema
// dims not listed here are appended in schema order; temporal dims are never part of the chain.
const DRILL_ORDER = {
  processes: ['environment', 'type', 'project', 'user'],
  versions: ['type', 'state', 'project', 'user'],
  projects: ['user'],
  users: ['admin'],
  // Navigation views drill from the broadest context (which workspace) down to the exact thing
  // being looked at (which sounding). See backend/models/nav_view.py for the coordinate columns.
  navigation: ['workspace', 'workspace_version', 'project', 'process', 'version', 'part', 'sounding'],
};

// ── URL <-> state helpers ──────────────────────────────────────────────────────────────────

// Filters are repeated ?f=dim:value. An empty value is the NULL / (unknown) bucket sentinel.
function parseFilters(searchParams) {
  return searchParams.getAll('f').map(entry => {
    const idx = entry.indexOf(':');
    if (idx < 0) return { dim: entry, value: '' };
    return { dim: entry.slice(0, idx), value: entry.slice(idx + 1) };
  });
}

function filtersToParams(filters) {
  const out = {};
  for (const { dim, value } of filters) {
    out[`filter_${dim}`] = value === '' ? '__null__' : value;
  }
  return out;
}

// Stable string form of a group key (backend serialises NULL as JSON null → '' filter value).
const keyStr = k => (k === null || k === undefined ? '__null__' : String(k));

// The non-temporal breakdown order for an entity: DRILL_ORDER first, then any remaining
// non-temporal schema dims in schema order. Used for the default landing dim and auto-advance.
function orderedDims(entity, dimDefs) {
  const nonTemporal = dimDefs.filter(d => !d.temporal).map(d => d.key);
  const pref = (DRILL_ORDER[entity] || []).filter(k => nonTemporal.includes(k));
  return [...pref, ...nonTemporal.filter(k => !pref.includes(k))];
}

// Next breakdown dim: walk FORWARD (wrapping) from `current` through the drill order, skipping
// dims already fixed by a filter and the column dim.
function nextRowDim(current, usedSet, avoidCol, entity, dimDefs) {
  const order = orderedDims(entity, dimDefs);
  const start = order.indexOf(current);
  const rot = start < 0 ? order : [...order.slice(start + 1), ...order.slice(0, start + 1)];
  return rot.find(d => !usedSet.has(d) && d !== avoidCol) || current;
}

// ── Pivot reshaping (backend returns a flat list of {keys, labels, count}) ───────────────────

// Ordered dim-1 categories for the chart. Temporal dims sort chronologically by label; categorical
// dims by descending total.
function orderedCategories(normalRows, isTemporal1) {
  const cat = new Map();
  for (const r of normalRows) {
    const kk = keyStr(r.keys[0]);
    if (!cat.has(kk)) cat.set(kk, { key: r.keys[0], label: r.labels[0], total: 0 });
    cat.get(kk).total += r.count;
  }
  const cats = [...cat.values()];
  cats.sort((a, b) => (isTemporal1 ? (String(a.label) < String(b.label) ? -1 : 1) : b.total - a.total));
  return cats;
}

// Chart data: dim1 on x, optional dim2 as series. null for no group-by.
function buildChartData(pivot) {
  const gb = pivot?.group_by || [];
  if (gb.length === 0) return null;
  const temporal = pivot?.temporal || [];
  const rows = pivot?.rows || [];
  const isTemporal1 = temporal.includes(gb[0]);
  const otherRow = rows.find(r => r.keys[0] === '__other__');
  const normal = rows.filter(r => r.keys[0] !== '__other__');

  const cats = orderedCategories(normal, isTemporal1);
  // (other) shows as a trailing bar only in the single-dim categorical case (no dim2 split).
  if (otherRow && gb.length === 1 && !isTemporal1) {
    cats.push({ key: '__other__', label: '(other)', total: otherRow.count });
  }
  const catIndex = new Map(cats.map((c, i) => [keyStr(c.key), i]));

  if (gb.length === 1) {
    return {
      xLabels: cats.map(c => c.label),
      xKeys: cats.map(c => c.key),
      series: [{ key: null, label: 'count', values: cats.map(c => c.total) }],
    };
  }

  const ser = new Map();
  for (const r of normal) {
    const ci = catIndex.get(keyStr(r.keys[0]));
    if (ci == null) continue;
    const sk = keyStr(r.keys[1]);
    if (!ser.has(sk)) {
      ser.set(sk, { key: r.keys[1], label: r.labels[1], total: 0, values: new Array(cats.length).fill(0) });
    }
    const s = ser.get(sk);
    s.values[ci] += r.count;
    s.total += r.count;
  }
  const series = [...ser.values()].sort((a, b) => b.total - a.total);
  return { xLabels: cats.map(c => c.label), xKeys: cats.map(c => c.key), series };
}

// Reshape backend rows into the drilldown table's row list (+ optional column list) with margins.
function reshapePivot(pivot, colDim, isTemporalRow, isTemporalCol) {
  const rows = pivot?.rows || [];
  const otherRow = rows.find(r => r.keys[0] === '__other__');
  const normal = rows.filter(r => r.keys[0] !== '__other__');

  const rowMap = new Map();
  const colMap = new Map();
  for (const r of normal) {
    const rk = keyStr(r.keys[0]);
    if (!rowMap.has(rk)) rowMap.set(rk, { key: r.keys[0], label: r.labels[0], total: 0, cols: new Map() });
    const R = rowMap.get(rk);
    R.total += r.count;
    if (colDim) {
      const ck = keyStr(r.keys[1]);
      if (!colMap.has(ck)) colMap.set(ck, { key: r.keys[1], label: r.labels[1], total: 0 });
      colMap.get(ck).total += r.count;
      R.cols.set(ck, (R.cols.get(ck) || 0) + r.count);
    }
  }
  const rowList = [...rowMap.values()].sort(
    (a, b) => (isTemporalRow ? (String(a.label) < String(b.label) ? -1 : 1) : b.total - a.total));
  const colList = [...colMap.values()].sort(
    (a, b) => (isTemporalCol ? (String(a.label) < String(b.label) ? -1 : 1) : b.total - a.total));
  return {
    rows: rowList,
    cols: colList,
    other: otherRow ? { total: otherRow.count } : null,
    total: pivot?.total ?? 0,
  };
}

// ── Component ────────────────────────────────────────────────────────────────────────────────

export default function StatsAdminPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: schema } = useAdminStatsSchema();

  const window = searchParams.get('window') || 'all';

  // Entity toggle list = curated order first, then any other schema entity (minus the excluded
  // ones) in schema order. Empty until /schema loads; the entity falls back to processes then.
  const schemaEntities = schema?.entities ? Object.keys(schema.entities) : [];
  const entityOrder = [
    ...ENTITY_PREFERRED.filter(e => schemaEntities.includes(e)),
    ...schemaEntities.filter(e => !ENTITY_PREFERRED.includes(e) && !ENTITY_EXCLUDE.has(e)),
  ];
  const requestedEntity = searchParams.get('entity');
  const entity = entityOrder.includes(requestedEntity)
    ? requestedEntity
    : (entityOrder.includes('processes') ? 'processes' : (entityOrder[0] || 'processes'));

  const entitySchema = schema?.entities?.[entity];
  const dimDefs = entitySchema?.dimensions || [];
  const filterDefs = entitySchema?.filters || [];
  const validDimKeys = new Set(dimDefs.map(d => d.key));
  const filterableDims = new Set(filterDefs.map(f => f.key));
  const dimLabel = k => dimDefs.find(d => d.key === k)?.label || k;
  const isTemporalDim = k => !!dimDefs.find(d => d.key === k)?.temporal;
  const entityLabel = entitySchema?.label || entity;
  const entityUnit = entityLabel.toLowerCase();

  const filters = parseFilters(searchParams).filter(f => filterableDims.has(f.dim));
  const usedDims = new Set(filters.map(f => f.dim));

  // Breakdown from ?g (ordered, max 2), falling back to the entity's first hierarchy dim. Never
  // break down by a dim already fixed by a filter.
  const groupBy = searchParams.getAll('g').filter(d => validDimKeys.has(d) && !usedDims.has(d));
  const defaultRow = orderedDims(entity, dimDefs).find(d => !usedDims.has(d))
    || dimDefs.map(d => d.key).find(d => !usedDims.has(d)) || '';
  let rowDim = groupBy[0] || defaultRow;
  let colDim = groupBy[1] && groupBy[1] !== rowDim ? groupBy[1] : '';

  const isTemporalRow = isTemporalDim(rowDim);
  const isTemporalCol = isTemporalDim(colDim);

  const groupParam = [rowDim, colDim].filter(Boolean);
  const pivotParams = { entity, group_by: groupParam, window, ...filtersToParams(filters), limit: 50 };
  const { data: pivot, isFetching } = useAdminStatsPivot(pivotParams);

  // ── URL writers (merge, never clobber the :tab segment or unrelated keys) ───────────────────
  const mutate = (fn) => setSearchParams(prev => { const next = new URLSearchParams(prev); fn(next); return next; }, { replace: true });
  const writeGroupBy = (next, row, col) => {
    next.delete('g');
    if (row) next.append('g', row);
    if (col && col !== row) next.append('g', col);
  };
  const writeFilters = (next, arr) => {
    next.delete('f');
    for (const { dim, value } of arr) next.append('f', `${dim}:${value}`);
  };

  const setWindow = (w) => mutate(next => { if (w === 'all') next.delete('window'); else next.set('window', w); });
  const setEntity = (e) => mutate(next => { next.set('entity', e); next.delete('g'); next.delete('f'); });
  const setBreakdown = (row, col) => mutate(next => writeGroupBy(next, row, col));
  const removeFilter = (i) => mutate(next => writeFilters(next, filters.filter((_, idx) => idx !== i)));
  const clearFilters = () => mutate(next => next.delete('f'));

  // Cycle the row breakdown along the hierarchy (heading click).
  const cycleRowDim = () => {
    const avail = orderedDims(entity, dimDefs).filter(d => !usedDims.has(d) && d !== colDim);
    if (avail.length < 2) return;
    const i = avail.indexOf(rowDim);
    setBreakdown(avail[(i + 1) % avail.length], colDim);
  };

  // Drill: apply one or more {dim, value} filters, then auto-advance the breakdown. Aborts wholly
  // on an (other) / aggregated key — those are never drillable.
  const drill = (pairs) => {
    const clean = [];
    for (const { dim, value } of pairs) {
      if (!dim) continue;
      if (value === '__other__' || value === '*') return;
      if (!filterableDims.has(dim)) continue;
      clean.push({ dim, value: value === null || value === undefined ? '' : String(value) });
    }
    if (!clean.length) return;
    const map = new Map(filters.map(f => [f.dim, f.value]));
    for (const { dim, value } of clean) map.set(dim, value);
    const newFilters = [...map.entries()].map(([dim, value]) => ({ dim, value }));
    const nowUsed = new Set(newFilters.map(f => f.dim));
    let newRow = rowDim;
    let newCol = colDim;
    if (newCol && nowUsed.has(newCol)) newCol = '';
    if (nowUsed.has(newRow)) newRow = nextRowDim(newRow, nowUsed, newCol, entity, dimDefs);
    mutate(next => { writeGroupBy(next, newRow, newCol); writeFilters(next, newFilters); });
  };

  const chart = buildChartData(pivot);
  const table = reshapePivot(pivot, colDim, isTemporalRow, isTemporalCol);
  const total = pivot?.total ?? 0;

  // Dropdown options: schema dims minus any fixed by a filter and minus the other selected dim.
  const rowOptions = dimDefs.filter(d => !usedDims.has(d.key) && d.key !== colDim);
  const colOptions = dimDefs.filter(d => !usedDims.has(d.key) && d.key !== rowDim);
  const renderDimOptions = (opts, blockTemporal) => {
    const plain = opts.filter(d => !d.temporal);
    const temporal = opts.filter(d => d.temporal);
    return (
      <>
        {plain.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        {temporal.length > 0 && (
          <optgroup label="Time">
            {temporal.map(d => (
              <option key={d.key} value={d.key} disabled={blockTemporal}>{d.label}</option>
            ))}
          </optgroup>
        )}
      </>
    );
  };

  const chipValue = (f) => {
    if (f.value === '') return '(unknown)';
    if (f.dim === 'admin') return f.value === 'true' ? 'Admins' : 'Non-admins';
    return f.value;
  };

  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <Card.Title className="mb-0">Deployment Statistics</Card.Title>
          <ButtonGroup size="sm">
            {WINDOWS.map(w => (
              <Button key={w.key} variant={window === w.key ? 'primary' : 'outline-primary'} onClick={() => setWindow(w.key)}>
                {w.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>

        {/* Entity toggle */}
        <div className="d-flex align-items-center flex-wrap gap-2 mb-3">
          <span className="text-muted small text-uppercase">Entity</span>
          <ButtonGroup size="sm">
            {entityOrder.map(e => (
              <Button key={e} variant={entity === e ? 'primary' : 'outline-primary'} onClick={() => setEntity(e)}>
                {schema?.entities?.[e]?.label || e}
              </Button>
            ))}
          </ButtonGroup>
        </div>

        {/* Filter breadcrumb */}
        <div className="d-flex align-items-center flex-wrap gap-2 mb-3">
          <span className="text-muted small text-uppercase">Filters</span>
          {filters.length === 0 && (
            <span className="text-muted small fst-italic">none — showing all {entityUnit}</span>
          )}
          {filters.map((f, i) => (
            <span key={i} className="badge rounded-pill text-bg-light border d-inline-flex align-items-center">
              {dimLabel(f.dim)} = <b className="ms-1">{chipValue(f)}</b>
              <span role="button" className="ms-2 text-danger" title="Remove filter" onClick={() => removeFilter(i)}>×</span>
            </span>
          ))}
          {filters.length > 0 && (
            <span role="button" className="small text-muted text-decoration-underline ms-1" onClick={clearFilters}>
              clear all
            </span>
          )}
        </div>

        {/* Headline total + breakdown controls */}
        <div className="d-flex align-items-baseline gap-2 mb-2">
          <span className="fs-2 fw-bold">{total.toLocaleString()}</span>
          <span className="text-muted">{entityUnit}{filters.length ? ' (filtered)' : ''}</span>
          {isFetching && <span className="text-muted small ms-2">updating…</span>}
        </div>

        <div className="d-flex align-items-center flex-wrap gap-2 mb-3">
          <span className="text-muted small">Break down by</span>
          <Form.Select size="sm" style={{ width: 'auto' }} value={rowDim}
            onChange={e => setBreakdown(e.target.value, colDim === e.target.value ? '' : colDim)}>
            {renderDimOptions(rowOptions, isTemporalCol)}
          </Form.Select>
          <span className="text-muted small ms-2">split into columns by</span>
          <Form.Select size="sm" style={{ width: 'auto' }} value={colDim}
            onChange={e => setBreakdown(rowDim, e.target.value)}>
            <option value="">— none —</option>
            {renderDimOptions(colOptions, isTemporalRow)}
          </Form.Select>
        </div>

        {pivot?.truncated && (
          <Alert variant="warning" className="py-2 small">
            Result capped at 5,000 rows — the second dimension has very high cardinality, so some
            combinations were dropped. Narrow with a filter or a coarser dimension.
          </Alert>
        )}

        {/* Plot follows the current view */}
        {chart && chart.xLabels.length > 0 && (
          <>
            <StatChart
              kind={isTemporalRow ? 'lines' : 'bars'}
              xLabels={chart.xLabels}
              xKeys={chart.xKeys}
              series={chart.series}
              onDrill={(xKey, seriesKey) => {
                const pairs = [{ dim: rowDim, value: xKey }];
                if (colDim && seriesKey !== undefined) pairs.push({ dim: colDim, value: seriesKey });
                drill(pairs);
              }}
              height={240}
            />
            {chart.series.length > 1 && (
              <div className="d-flex flex-wrap gap-3 mt-2 mb-3 small">
                {chart.series.map((s, i) => (
                  <span key={i} className="d-inline-flex align-items-center">
                    <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: statSeriesColor(i, chart.series.length), marginRight: 4 }} />
                    {s.label}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {/* Drilldown table — the primary surface */}
        <DrilldownTable
          table={table}
          rowDim={rowDim}
          colDim={colDim}
          dimLabel={dimLabel}
          onCycleRow={cycleRowDim}
          onDrill={drill}
          isFetching={isFetching}
        />
      </Card.Body>
    </Card>
  );
}

// ── Drilldown table: ranked list (1 dim) or cross-tab grid (2 dims) ───────────────────────────

function DrilldownTable({ table, rowDim, colDim, dimLabel, onCycleRow, onDrill, isFetching }) {
  const style = { opacity: isFetching ? 0.6 : 1 };
  const { rows, cols, other, total } = table;
  const leadHead = (
    <th role="button" className="text-primary" style={{ cursor: 'pointer' }}
      title="Click to change the breakdown dimension" onClick={onCycleRow}>
      {dimLabel(rowDim)} ▾
    </th>
  );

  // Two dimensions — cross-tab grid.
  if (colDim) {
    return (
      <div style={{ overflowX: 'auto' }}>
        <Table size="sm" bordered hover style={{ ...style, minWidth: 'auto' }}>
          <thead>
            <tr>
              {leadHead}
              {cols.map(c => (
                <th key={keyStr(c.key)} role={c.key !== '__other__' && c.key !== '*' ? 'button' : undefined}
                  className="text-end" style={{ cursor: 'pointer' }} title={`Filter to ${c.label}`}
                  onClick={() => onDrill([{ dim: colDim, value: c.key }])}>
                  {c.label}
                </th>
              ))}
              <th className="text-end">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={keyStr(r.key)}>
                <td role="button" style={{ cursor: 'pointer' }} onClick={() => onDrill([{ dim: rowDim, value: r.key }])}>
                  {r.label}
                </td>
                {cols.map(c => {
                  const v = r.cols.get(keyStr(c.key)) || 0;
                  return v ? (
                    <td key={keyStr(c.key)} role="button" className="text-end" style={{ cursor: 'pointer' }}
                      onClick={() => onDrill([{ dim: rowDim, value: r.key }, { dim: colDim, value: c.key }])}>
                      {v.toLocaleString()}
                    </td>
                  ) : (
                    <td key={keyStr(c.key)} className="text-end text-muted">·</td>
                  );
                })}
                <td className="text-end fw-semibold">{r.total.toLocaleString()}</td>
              </tr>
            ))}
            {other && (
              <tr className="text-muted fst-italic">
                <td>(other)</td>
                <td className="text-end" colSpan={cols.length}></td>
                <td className="text-end fw-semibold">{other.total.toLocaleString()}</td>
              </tr>
            )}
            {rows.length === 0 && <tr><td colSpan={cols.length + 2} className="text-muted">No data.</td></tr>}
          </tbody>
          <tfoot>
            <tr className="fw-bold">
              <td>Total</td>
              {cols.map(c => <td key={keyStr(c.key)} className="text-end">{c.total.toLocaleString()}</td>)}
              <td className="text-end">{total.toLocaleString()}</td>
            </tr>
          </tfoot>
        </Table>
      </div>
    );
  }

  // One dimension — ranked list with a mini-bar per row.
  const maxTotal = Math.max(...rows.map(r => r.total), 1);
  return (
    <Table size="sm" hover style={style}>
      <thead>
        <tr>{leadHead}<th className="text-end">Count</th><th style={{ width: 90 }}></th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={keyStr(r.key)}>
            <td role="button" style={{ cursor: 'pointer' }} onClick={() => onDrill([{ dim: rowDim, value: r.key }])}>
              {r.label}
            </td>
            <td role="button" className="text-end" style={{ cursor: 'pointer' }} onClick={() => onDrill([{ dim: rowDim, value: r.key }])}>
              {r.total.toLocaleString()}
            </td>
            <td>
              <span style={{ display: 'inline-block', width: 70, height: 8, background: '#eef1f4', borderRadius: 4, overflow: 'hidden', verticalAlign: 'middle' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.round(100 * r.total / maxTotal)}%`, background: statSeriesColor(0, 1) }} />
              </span>
            </td>
          </tr>
        ))}
        {other && (
          <tr className="text-muted fst-italic">
            <td>(other)</td>
            <td className="text-end">{other.total.toLocaleString()}</td>
            <td></td>
          </tr>
        )}
        {rows.length === 0 && <tr><td colSpan={3} className="text-muted">No data.</td></tr>}
      </tbody>
      <tfoot>
        <tr className="fw-bold"><td>Total</td><td className="text-end">{total.toLocaleString()}</td><td></td></tr>
      </tfoot>
    </Table>
  );
}

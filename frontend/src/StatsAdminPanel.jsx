import React, { useState } from 'react';
import { Card, Row, Col, Table, Button, ButtonGroup, Form, Badge, Alert } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { useAdminStatsSummary, useAdminStatsSchema, useAdminStatsPivot } from './datamodel/useAuthQueries';
import StatChart, { statSeriesColor } from './StatChart';

// Admin stats dashboard — OLAP-style pivot explorer (docs/plans/admin-stats-pivot-redesign.md).
// All state (entity, window, ordered group-by, filters) lives in the URL query string so a pivot
// view is reload-safe and shareable; the :tab path segment is left untouched (merge-not-clobber).
// Every dimension / filter list is served by GET /admin/stats/schema — nothing is hardcoded here.

const WINDOWS = [
  { key: 'all', label: 'All time' },
  { key: 'year', label: 'This year' },
  { key: 'month', label: 'This month' },
];

// Cards, in display order. `pivot` entities support the pivot explorer; process_types is a
// distinct-count metric only (no per-row breakdown, not in the schema).
const CARDS = [
  { entity: 'projects', title: 'Projects', pivot: true },
  { entity: 'processes', title: 'Processes', pivot: true },
  { entity: 'versions', title: 'Process versions', pivot: true },
  { entity: 'environments', title: 'Environments', pivot: true },
  { entity: 'users', title: 'Users', pivot: true },
  { entity: 'process_types', title: 'Process types', pivot: false },
];

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

// ── Pivot reshaping (backend returns a flat list of {keys, labels, count}) ───────────────────

// Ordered dim-1 categories for the chart/grid. Temporal dims sort chronologically by label;
// categorical dims by descending total.
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

// Chart data: dim1 on x, dim2 as series (dims >=3 summed out). null for no group-by.
function buildChartData(pivot) {
  const gb = pivot?.group_by || [];
  if (gb.length === 0) return null;
  const temporal = pivot?.temporal || [];
  const rows = pivot?.rows || [];
  const isTemporal1 = temporal.includes(gb[0]);
  const otherRow = rows.find(r => r.keys[0] === '__other__');
  const normal = rows.filter(r => r.keys[0] !== '__other__');

  const cats = orderedCategories(normal, isTemporal1);
  // (other) shows as a trailing bar only in the single-dim categorical case (it has no dim2 split).
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

// Nested outline for 3+ dims: group by keys[level] recursively, subtotal per node.
function buildNodes(rows, gb, temporal, level) {
  const groups = new Map();
  for (const r of rows) {
    const kk = keyStr(r.keys[level]);
    if (!groups.has(kk)) groups.set(kk, { key: r.keys[level], label: r.labels[level], count: 0, rows: [] });
    const g = groups.get(kk);
    g.count += r.count;
    g.rows.push(r);
  }
  const isTemp = temporal.includes(gb[level]);
  const nodes = [...groups.values()];
  nodes.sort((a, b) => (isTemp ? (String(a.label) < String(b.label) ? -1 : 1) : b.count - a.count));
  const last = level === gb.length - 1;
  for (const n of nodes) {
    if (!last) n.children = buildNodes(n.rows, gb, temporal, level + 1);
    delete n.rows;
  }
  return nodes;
}

function flattenNodes(nodes, level, acc) {
  for (const n of nodes) {
    acc.push({ level, key: n.key, label: n.label, count: n.count, isLeaf: !n.children });
    if (n.children) flattenNodes(n.children, level + 1, acc);
  }
  return acc;
}

// ── Component ────────────────────────────────────────────────────────────────────────────────

export default function StatsAdminPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const window = searchParams.get('window') || 'all';
  const entity = searchParams.get('entity') || '';

  const { data: summary, isLoading: summaryLoading } = useAdminStatsSummary();
  const { data: schema } = useAdminStatsSchema();
  const entitySchema = schema?.entities?.[entity];

  const dimDefs = entitySchema?.dimensions || [];
  const filterDefs = entitySchema?.filters || [];
  const validDimKeys = new Set(dimDefs.map(d => d.key));
  const filterableDims = new Set(filterDefs.map(f => f.key));
  const dimLabel = k => dimDefs.find(d => d.key === k)?.label || k;
  const isTemporalDim = k => !!dimDefs.find(d => d.key === k)?.temporal;

  // group-by is repeated ?g=dim (ordered); drop any stale for the current entity.
  const groupBy = searchParams.getAll('g').filter(d => validDimKeys.has(d));
  const filters = parseFilters(searchParams);

  const filterParams = filtersToParams(filters);
  const pivotParams = { entity, group_by: groupBy, window, ...filterParams, limit: 50 };
  const { data: pivot, isFetching } = useAdminStatsPivot(entity ? pivotParams : { entity: '' });

  // ── URL writers (merge, never clobber the :tab segment or unrelated keys) ───────────────────
  const mutate = (fn) => setSearchParams(prev => { const next = new URLSearchParams(prev); fn(next); return next; }, { replace: true });
  const setScalar = (key, val) => mutate(next => { if (!val) next.delete(key); else next.set(key, String(val)); });
  const setGroupBy = (arr) => mutate(next => { next.delete('g'); for (const d of arr) next.append('g', d); });
  const setFilters = (arr) => mutate(next => { next.delete('f'); for (const { dim, value } of arr) next.append('f', `${dim}:${value}`); });

  const selectCard = (card) => {
    if (!card.pivot) return;
    mutate(next => { next.set('entity', card.entity); next.delete('g'); next.delete('f'); });
  };

  // ── Group-by builder ops ────────────────────────────────────────────────────────────────
  const hasTemporal = groupBy.some(isTemporalDim);
  const addableDims = dimDefs.filter(d => !groupBy.includes(d.key) && !(d.temporal && hasTemporal));
  const addDim = (d) => d && setGroupBy([...groupBy, d]);
  const removeDim = (i) => setGroupBy(groupBy.filter((_, idx) => idx !== i));
  const moveDim = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= groupBy.length) return;
    const arr = [...groupBy];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setGroupBy(arr);
  };

  // ── Filter builder ops ──────────────────────────────────────────────────────────────────
  const addFilters = (pairs) => {
    // Additive drill: replace any existing filter on the same dim, ignore non-filterable /
    // (other) / (all) keys.
    const map = new Map(filters.map(f => [f.dim, f.value]));
    for (const { dim, value } of pairs) {
      if (!filterableDims.has(dim)) continue;
      map.set(dim, value);
    }
    setFilters([...map.entries()].map(([dim, value]) => ({ dim, value })));
  };
  const removeFilter = (i) => setFilters(filters.filter((_, idx) => idx !== i));

  // Drill from a table cell / row / chart bar: keys is an ordered array of group-key values.
  const drill = (keys) => {
    const pairs = [];
    keys.forEach((k, i) => {
      if (k === '__other__' || k === '*') return;             // (other) / aggregated — not drillable
      pairs.push({ dim: groupBy[i], value: k === null ? '' : String(k) });
    });
    if (pairs.length) addFilters(pairs);
  };

  // ── Render ────────────────────────────────────────────────────────────────────────────────
  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center flex-wrap mb-3">
          <Card.Title className="mb-0">Deployment Statistics</Card.Title>
          <ButtonGroup size="sm">
            {WINDOWS.map(w => (
              <Button key={w.key} variant={window === w.key ? 'primary' : 'outline-primary'} onClick={() => setScalar('window', w.key)}>
                {w.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>

        {/* Headline cards */}
        {summaryLoading ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <Row className="g-3 mb-4">
            {CARDS.map(card => {
              const cell = summary?.[card.entity] || { all: 0, year: 0, month: 0 };
              const active = entity === card.entity;
              return (
                <Col key={card.entity} xs={6} md={4} lg={2}>
                  <Card
                    className={`h-100 ${active ? 'border-primary' : ''}`}
                    role={card.pivot ? 'button' : undefined}
                    onClick={() => selectCard(card)}
                    style={{ cursor: card.pivot ? 'pointer' : 'default' }}
                  >
                    <Card.Body className="text-center p-2">
                      <div className="text-muted small text-uppercase">{card.title}</div>
                      <div className="fs-3 fw-bold">{cell[window]?.toLocaleString?.() ?? cell[window]}</div>
                      <div className="small text-muted">all {cell.all} · yr {cell.year} · mo {cell.month}</div>
                    </Card.Body>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}

        {!entity && <p className="text-muted">Select a card above to pivot it by any combination of dimensions.</p>}

        {entity && (
          <PivotExplorer
            entity={entity}
            entityTitle={CARDS.find(c => c.entity === entity)?.title || entity}
            dimDefs={dimDefs}
            addableDims={addableDims}
            groupBy={groupBy}
            filters={filters}
            filterDefs={filterDefs}
            pivot={pivot}
            isFetching={isFetching}
            dimLabel={dimLabel}
            onAddDim={addDim}
            onRemoveDim={removeDim}
            onMoveDim={moveDim}
            onAddFilter={(dim, value) => addFilters([{ dim, value }])}
            onRemoveFilter={removeFilter}
            onDrill={drill}
          />
        )}
      </Card.Body>
    </Card>
  );
}

// ── Pivot explorer (builders + table + chart) ─────────────────────────────────────────────────

function PivotExplorer({
  entity, entityTitle, dimDefs, addableDims, groupBy, filters, filterDefs, pivot, isFetching,
  dimLabel, onAddDim, onRemoveDim, onMoveDim, onAddFilter, onRemoveFilter, onDrill,
}) {
  const [addDimSel, setAddDimSel] = useState('');
  const [fltDim, setFltDim] = useState('');
  const [fltVal, setFltVal] = useState('');

  const activeFltDim = fltDim && filterDefs.some(f => f.key === fltDim) ? fltDim : (filterDefs[0]?.key || '');
  const activeFltType = filterDefs.find(f => f.key === activeFltDim)?.type;

  const nonTemporal = dimDefs.filter(d => !d.temporal);
  const temporalDims = dimDefs.filter(d => d.temporal);
  const addableSet = new Set(addableDims.map(d => d.key));

  const submitFilter = () => {
    if (!activeFltDim) return;
    let value = fltVal;
    if (activeFltType === 'admin' && value === '') value = 'true';
    onAddFilter(activeFltDim, value);
    setFltVal('');
  };

  const chart = buildChartData(pivot);
  const truncated = pivot?.truncated;

  return (
    <>
      {/* Group-by builder */}
      <div className="d-flex align-items-center flex-wrap gap-2 mb-2">
        <span className="text-muted small">Group by</span>
        {groupBy.length === 0 && <span className="text-muted small fst-italic">nothing (grand total)</span>}
        {groupBy.map((d, i) => (
          <Badge key={i} bg="primary" className="d-inline-flex align-items-center">
            {dimLabel(d)}
            <span role="button" className="ms-2" title="Move left" onClick={() => onMoveDim(i, -1)} style={{ opacity: i === 0 ? 0.3 : 1 }}>‹</span>
            <span role="button" className="ms-1" title="Move right" onClick={() => onMoveDim(i, 1)} style={{ opacity: i === groupBy.length - 1 ? 0.3 : 1 }}>›</span>
            <span role="button" className="ms-2" title="Remove" onClick={() => onRemoveDim(i)}>×</span>
          </Badge>
        ))}
        {addableDims.length > 0 && (
          <Form.Select
            size="sm"
            style={{ width: 'auto' }}
            value={addDimSel}
            onChange={e => { onAddDim(e.target.value); setAddDimSel(''); }}
          >
            <option value="">＋ Group by…</option>
            {nonTemporal.filter(d => addableSet.has(d.key)).map(d => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
            {temporalDims.length > 0 && (
              <optgroup label="Time">
                {temporalDims.map(d => (
                  <option key={d.key} value={d.key} disabled={!addableSet.has(d.key)}>{d.label}</option>
                ))}
              </optgroup>
            )}
          </Form.Select>
        )}
        {isFetching && <span className="text-muted small">updating…</span>}
      </div>

      {/* Filter builder */}
      <div className="d-flex align-items-center flex-wrap gap-2 mb-3">
        <span className="text-muted small">Filters</span>
        <Badge bg="secondary">{entityTitle}</Badge>
        {filters.map((f, i) => (
          <Badge key={i} bg="light" text="dark" className="border d-inline-flex align-items-center">
            {dimLabel(f.dim)} = {f.value === '' ? '(unknown)' : f.value}
            <span role="button" className="ms-2 text-danger" title="Remove filter" onClick={() => onRemoveFilter(i)}>×</span>
          </Badge>
        ))}
        {filterDefs.length > 0 && (
          <div className="d-inline-flex align-items-center gap-1">
            <Form.Select size="sm" style={{ width: 'auto' }} value={activeFltDim} onChange={e => setFltDim(e.target.value)}>
              {filterDefs.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </Form.Select>
            {activeFltType === 'admin' ? (
              <Form.Select size="sm" style={{ width: 'auto' }} value={fltVal || 'true'} onChange={e => setFltVal(e.target.value)}>
                <option value="true">Admins</option>
                <option value="false">Non-admins</option>
              </Form.Select>
            ) : (
              <Form.Control
                size="sm"
                style={{ width: '11rem' }}
                placeholder="value (empty = unknown)"
                value={fltVal}
                onChange={e => setFltVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitFilter(); }}
              />
            )}
            <Button size="sm" variant="outline-secondary" onClick={submitFilter}>＋ Filter</Button>
          </div>
        )}
      </div>

      {truncated && (
        <Alert variant="warning" className="py-2 small">
          Result capped at {(5000).toLocaleString()} rows — the second dimension has very high
          cardinality, so some combinations were dropped. Narrow with a filter or a coarser dimension.
        </Alert>
      )}

      {/* Chart (secondary) */}
      {chart && chart.xLabels.length > 0 && (
        <>
          <StatChart
            kind={pivot?.temporal?.includes(groupBy[0]) ? 'lines' : 'bars'}
            xLabels={chart.xLabels}
            xKeys={chart.xKeys}
            series={chart.series}
            onDrill={(xKey) => onDrill([xKey])}
            height={260}
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

      {/* Pivot table (primary) */}
      <PivotTable pivot={pivot} groupBy={groupBy} dimLabel={dimLabel} onDrill={onDrill} isFetching={isFetching} />
    </>
  );
}

// ── Pivot table: grand total (0 dims) / list (1) / grid (2) / nested outline (3+) ──────────────

function PivotTable({ pivot, groupBy, dimLabel, onDrill, isFetching }) {
  const style = { opacity: isFetching ? 0.6 : 1 };
  const rows = pivot?.rows || [];
  const total = pivot?.total ?? 0;
  const temporal = pivot?.temporal || [];
  const ndims = groupBy.length;

  if (ndims === 0) {
    return (
      <div className="mt-2">
        <span className="text-muted me-2">Grand total</span>
        <span className="fs-3 fw-bold">{total.toLocaleString()}</span>
      </div>
    );
  }

  // 1 dim — flat list ordered by count desc, (other) last.
  if (ndims === 1) {
    const normal = rows.filter(r => r.keys[0] !== '__other__').sort((a, b) => b.count - a.count);
    const other = rows.find(r => r.keys[0] === '__other__');
    const ordered = other ? [...normal, other] : normal;
    return (
      <Table size="sm" hover style={style}>
        <thead><tr><th>{dimLabel(groupBy[0])}</th><th className="text-end">Count</th></tr></thead>
        <tbody>
          {ordered.map((r, i) => {
            const canDrill = r.keys[0] !== '__other__';
            return (
              <tr key={i} role={canDrill ? 'button' : undefined} style={{ cursor: canDrill ? 'pointer' : 'default' }}
                  onClick={canDrill ? () => onDrill([r.keys[0]]) : undefined}>
                <td>{r.labels[0]}</td>
                <td className="text-end">{r.count.toLocaleString()}</td>
              </tr>
            );
          })}
          {ordered.length === 0 && <tr><td colSpan={2} className="text-muted">No data.</td></tr>}
        </tbody>
        <tfoot><tr className="fw-bold"><td>Total</td><td className="text-end">{total.toLocaleString()}</td></tr></tfoot>
      </Table>
    );
  }

  // 2 dims — grid (dim1 rows × dim2 cols) with margins.
  if (ndims === 2) return <PivotGrid rows={rows} groupBy={groupBy} temporal={temporal} dimLabel={dimLabel} onDrill={onDrill} total={total} style={style} />;

  // 3+ dims — nested outline with subtotals.
  const nodes = buildNodes(rows.filter(r => r.keys[0] !== '__other__'), groupBy, temporal, 0);
  const flat = flattenNodes(nodes, 0, []);
  const other = rows.find(r => r.keys[0] === '__other__');
  return (
    <Table size="sm" hover style={style}>
      <thead><tr><th>{groupBy.map(dimLabel).join(' › ')}</th><th className="text-end">Count</th></tr></thead>
      <tbody>
        {flat.map((n, i) => (
          <tr key={i} className={n.isLeaf ? '' : 'fw-semibold'}>
            <td style={{ paddingLeft: `${0.5 + n.level * 1.5}rem` }}>{n.label}</td>
            <td className="text-end">{n.count.toLocaleString()}</td>
          </tr>
        ))}
        {other && <tr className="text-muted"><td style={{ paddingLeft: '0.5rem' }}>(other)</td><td className="text-end">{other.count.toLocaleString()}</td></tr>}
        {flat.length === 0 && <tr><td colSpan={2} className="text-muted">No data.</td></tr>}
      </tbody>
      <tfoot><tr className="fw-bold"><td>Total</td><td className="text-end">{total.toLocaleString()}</td></tr></tfoot>
    </Table>
  );
}

function PivotGrid({ rows, groupBy, temporal, dimLabel, onDrill, total, style }) {
  const isTemporal1 = temporal.includes(groupBy[0]);
  const isTemporal2 = temporal.includes(groupBy[1]);
  const normal = rows.filter(r => r.keys[0] !== '__other__');
  const other = rows.find(r => r.keys[0] === '__other__');

  const rowCats = orderedCategories(normal, isTemporal1);
  // dim2 columns
  const colMap = new Map();
  for (const r of normal) {
    const ck = keyStr(r.keys[1]);
    if (!colMap.has(ck)) colMap.set(ck, { key: r.keys[1], label: r.labels[1], total: 0 });
    colMap.get(ck).total += r.count;
  }
  const cols = [...colMap.values()].sort((a, b) => (isTemporal2 ? (String(a.label) < String(b.label) ? -1 : 1) : b.total - a.total));
  const colIndex = new Map(cols.map((c, i) => [keyStr(c.key), i]));
  const rowIndex = new Map(rowCats.map((c, i) => [keyStr(c.key), i]));

  const matrix = rowCats.map(() => new Array(cols.length).fill(0));
  const colTotals = new Array(cols.length).fill(0);
  for (const r of normal) {
    const ri = rowIndex.get(keyStr(r.keys[0]));
    const ci = colIndex.get(keyStr(r.keys[1]));
    if (ri == null || ci == null) continue;
    matrix[ri][ci] += r.count;
    colTotals[ci] += r.count;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <Table size="sm" bordered hover style={{ ...style, minWidth: 'auto' }}>
        <thead>
          <tr>
            <th>{dimLabel(groupBy[0])} ＼ {dimLabel(groupBy[1])}</th>
            {cols.map((c, i) => <th key={i} className="text-end">{c.label}</th>)}
            <th className="text-end">Total</th>
          </tr>
        </thead>
        <tbody>
          {rowCats.map((rc, ri) => (
            <tr key={ri}>
              <td role="button" style={{ cursor: 'pointer' }} onClick={() => onDrill([rc.key])}>{rc.label}</td>
              {cols.map((c, ci) => (
                <td
                  key={ci}
                  className="text-end"
                  role={matrix[ri][ci] > 0 ? 'button' : undefined}
                  style={{ cursor: matrix[ri][ci] > 0 ? 'pointer' : 'default' }}
                  onClick={matrix[ri][ci] > 0 ? () => onDrill([rc.key, c.key]) : undefined}
                >
                  {matrix[ri][ci] ? matrix[ri][ci].toLocaleString() : ''}
                </td>
              ))}
              <td className="text-end fw-semibold">{rowCats[ri].total.toLocaleString()}</td>
            </tr>
          ))}
          {other && (
            <tr className="text-muted">
              <td>(other)</td>
              <td className="text-end" colSpan={cols.length}></td>
              <td className="text-end fw-semibold">{other.count.toLocaleString()}</td>
            </tr>
          )}
          {rowCats.length === 0 && <tr><td colSpan={cols.length + 2} className="text-muted">No data.</td></tr>}
        </tbody>
        <tfoot>
          <tr className="fw-bold">
            <td>Total</td>
            {colTotals.map((t, i) => <td key={i} className="text-end">{t.toLocaleString()}</td>)}
            <td className="text-end">{total.toLocaleString()}</td>
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

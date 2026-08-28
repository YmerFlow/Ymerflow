import React from 'react';
import { Card, Row, Col, Table, Button, ButtonGroup, Form, Badge } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { useAdminStatsSummary, useAdminStatsBreakdown, useAdminStatsTimeseries } from './datamodel/useAuthQueries';
import StatChart, { statSeriesColor } from './StatChart';

// Admin stats dashboard (docs/plans/admin-stats-dashboard.md). All pivot/time state lives in the
// URL query string so a drilled view is reload-safe and shareable; the :tab path segment is left
// untouched (same merge-not-clobber helper as the paged-users admin tab).

const WINDOWS = [
  { key: 'all', label: 'All time' },
  { key: 'year', label: 'This year' },
  { key: 'month', label: 'This month' },
];

const GRANULARITIES = ['day', 'week', 'month'];

// Cards, in display order. `pivot` entities support drill-down; process_types is a distinct-count
// metric only (no per-row breakdown).
const CARDS = [
  { entity: 'projects', title: 'Projects', pivot: true },
  { entity: 'processes', title: 'Processes', pivot: true },
  { entity: 'versions', title: 'Process versions', pivot: true },
  { entity: 'environments', title: 'Environments', pivot: true },
  { entity: 'users', title: 'Users', pivot: true },
  { entity: 'process_types', title: 'Process types', pivot: false },
];

// Ordered drill dimensions per entity — MUST mirror backend _DIMENSIONS in routers/stats.py.
const DIMENSIONS = {
  projects: ['user'],
  processes: ['user', 'project', 'type', 'environment'],
  versions: ['user', 'state', 'type', 'project'],
  environments: ['user'],
  users: ['admin'],
};

const DIM_LABELS = {
  user: 'User', project: 'Project', type: 'Type', state: 'State',
  environment: 'Environment', admin: 'Admin',
};

// Encode/decode the ordered filter path as repeated ?f=dim:value query params.
function parsePath(searchParams) {
  return searchParams.getAll('f').map(entry => {
    const idx = entry.indexOf(':');
    if (idx < 0) return { dim: entry, value: '' };
    return { dim: entry.slice(0, idx), value: entry.slice(idx + 1) };
  });
}

// The backend accepts filter_<dim> for these dims; turn the path into query params.
function pathToFilters(path) {
  const out = {};
  for (const { dim, value } of path) {
    if (['user', 'project', 'type', 'state', 'environment'].includes(dim)) {
      out[`filter_${dim}`] = value === '' ? '__null__' : value;
    }
  }
  return out;
}

export default function StatsAdminPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const window = searchParams.get('window') || 'all';
  const entity = searchParams.get('entity') || '';
  const granularity = searchParams.get('gran') || 'month';
  const seriesBy = searchParams.get('series') || '';
  const path = parsePath(searchParams);

  // Merge patches into the query string without clobbering the :tab path segment or unrelated keys.
  const update = (patch, { resetPath } = {}) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k); else next.set(k, String(v));
    }
    if (resetPath) next.delete('f');
    return next;
  }, { replace: true });

  const setPath = (newPath, patch = {}) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.delete('f');
    for (const { dim, value } of newPath) next.append('f', `${dim}:${value}`);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k); else next.set(k, String(v));
    }
    return next;
  }, { replace: true });

  const usedDims = new Set(path.map(p => p.dim));
  const availableDims = (DIMENSIONS[entity] || []).filter(d => !usedDims.has(d));
  // Current group-by: explicit in URL if still valid, else the first unused dimension.
  const groupByParam = searchParams.get('group_by') || '';
  const groupBy = availableDims.includes(groupByParam) ? groupByParam : (availableDims[0] || '');

  const { data: summary, isLoading: summaryLoading } = useAdminStatsSummary();

  const filters = pathToFilters(path);
  const breakdownParams = { entity, group_by: groupBy, window, ...filters, limit: 50 };
  const { data: breakdown, isFetching: breakdownFetching } = useAdminStatsBreakdown(
    entity && groupBy ? breakdownParams : { entity: '', group_by: '' }
  );
  const tsParams = { entity, granularity, window, ...(seriesBy ? { series_by: seriesBy } : {}), ...filters };
  const { data: timeseries, isFetching: tsFetching } = useAdminStatsTimeseries(
    entity ? tsParams : { entity: '' }
  );

  // ── Handlers ────────────────────────────────────────────────────────────────────────────
  const selectCard = (card) => {
    if (!card.pivot) return;
    update({ entity: card.entity, group_by: '', series: '' }, { resetPath: true });
  };

  const drill = (row) => {
    if (!groupBy || row.key === '__other__') return;              // (other) is not drillable
    if (!['user', 'project', 'type', 'state', 'environment'].includes(groupBy)) return;
    const newPath = [...path, { dim: groupBy, value: row.key == null ? '' : row.key }];
    const nextDims = (DIMENSIONS[entity] || []).filter(d => !new Set(newPath.map(p => p.dim)).has(d));
    setPath(newPath, { group_by: nextDims[0] || '' });
  };

  const popTo = (level) => {          // remove path level `level` and everything after it
    const newPath = path.slice(0, level);
    const nextDims = (DIMENSIONS[entity] || []).filter(d => !new Set(newPath.map(p => p.dim)).has(d));
    setPath(newPath, { group_by: nextDims[0] || '' });
  };

  // ── Render ─────────────────────────────────────────────────────────────────────────────
  const rows = breakdown?.rows || [];
  const drillable = ['user', 'project', 'type', 'state', 'environment'].includes(groupBy);
  const categories = rows.map(r => r.key);   // ordinal → key, for StatChart drill clicks

  const tsSeries = timeseries?.series || [];
  const tsBuckets = timeseries?.buckets || [];

  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center flex-wrap mb-3">
          <Card.Title className="mb-0">Deployment Statistics</Card.Title>
          <ButtonGroup size="sm">
            {WINDOWS.map(w => (
              <Button
                key={w.key}
                variant={window === w.key ? 'primary' : 'outline-primary'}
                onClick={() => update({ window: w.key })}
              >
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
                      <div className="small text-muted">
                        all {cell.all} · yr {cell.year} · mo {cell.month}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}

        {!entity && <p className="text-muted">Select a card above to break it down and chart it over time.</p>}

        {entity && (
          <>
            {/* Breadcrumb / drill path */}
            <div className="d-flex align-items-center flex-wrap gap-2 mb-2">
              <Badge bg="secondary">{CARDS.find(c => c.entity === entity)?.title || entity}</Badge>
              {path.map((p, i) => (
                <span key={i} className="d-inline-flex align-items-center">
                  <span className="text-muted mx-1">›</span>
                  <Badge bg="light" text="dark" className="border">
                    {DIM_LABELS[p.dim] || p.dim} = {p.value === '' ? '(unknown)' : p.value}
                    <span
                      role="button"
                      className="ms-2 text-danger"
                      onClick={() => popTo(i)}
                      title="Remove this filter"
                    >×</span>
                  </Badge>
                </span>
              ))}
            </div>

            {/* Breakdown */}
            <Row className="mb-4">
              <Col lg={7}>
                {availableDims.length > 0 ? (
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <span className="text-muted small">Group by</span>
                    <Form.Select
                      size="sm"
                      style={{ width: 'auto' }}
                      value={groupBy}
                      onChange={e => update({ group_by: e.target.value })}
                    >
                      {availableDims.map(d => (
                        <option key={d} value={d}>{DIM_LABELS[d] || d}</option>
                      ))}
                    </Form.Select>
                    {breakdownFetching && <span className="text-muted small">updating…</span>}
                  </div>
                ) : (
                  <p className="text-muted small">No further dimension to break down by (leaf).</p>
                )}

                {groupBy && rows.length > 0 && (
                  <StatChart
                    kind="bars"
                    values={rows.map(r => r.count)}
                    categories={categories}
                    onDrill={drillable ? (key => drill({ key })) : undefined}
                    height={240}
                  />
                )}
              </Col>
              <Col lg={5}>
                {groupBy && (
                  <Table size="sm" hover style={{ opacity: breakdownFetching ? 0.6 : 1 }}>
                    <thead>
                      <tr>
                        <th>{DIM_LABELS[groupBy] || groupBy}</th>
                        <th className="text-end">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const canDrill = drillable && r.key !== '__other__';
                        return (
                          <tr
                            key={i}
                            role={canDrill ? 'button' : undefined}
                            style={{ cursor: canDrill ? 'pointer' : 'default' }}
                            onClick={canDrill ? () => drill(r) : undefined}
                          >
                            <td>{r.label}</td>
                            <td className="text-end">{r.count.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                      {rows.length === 0 && (
                        <tr><td colSpan={2} className="text-muted">No data.</td></tr>
                      )}
                    </tbody>
                    {breakdown?.total != null && (
                      <tfoot>
                        <tr className="fw-bold">
                          <td>Total</td>
                          <td className="text-end">{breakdown.total.toLocaleString()}</td>
                        </tr>
                      </tfoot>
                    )}
                  </Table>
                )}
              </Col>
            </Row>

            {/* Time series */}
            <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
              <strong className="me-2">Over time</strong>
              <ButtonGroup size="sm">
                {GRANULARITIES.map(g => (
                  <Button
                    key={g}
                    variant={granularity === g ? 'secondary' : 'outline-secondary'}
                    onClick={() => update({ gran: g })}
                  >
                    {g}
                  </Button>
                ))}
              </ButtonGroup>
              <span className="text-muted small ms-2">split by</span>
              <Form.Select
                size="sm"
                style={{ width: 'auto' }}
                value={seriesBy}
                onChange={e => update({ series: e.target.value })}
              >
                <option value="">(none)</option>
                {(DIMENSIONS[entity] || []).map(d => (
                  <option key={d} value={d}>{DIM_LABELS[d] || d}</option>
                ))}
              </Form.Select>
              {tsFetching && <span className="text-muted small">updating…</span>}
            </div>

            {tsBuckets.length > 0 ? (
              <>
                <StatChart kind="lines" bucketCount={tsBuckets.length} series={tsSeries} height={260} />
                <div className="d-flex flex-wrap gap-3 mt-2 small">
                  {tsSeries.length > 1 && tsSeries.map((s, i) => (
                    <span key={i} className="d-inline-flex align-items-center">
                      <span style={{
                        display: 'inline-block', width: 12, height: 12, borderRadius: 2,
                        background: statSeriesColor(i, tsSeries.length), marginRight: 4,
                      }} />
                      {s.label}
                    </span>
                  ))}
                </div>
                <div className="text-muted small mt-1">
                  Buckets ({granularity}): {tsBuckets[0]} … {tsBuckets[tsBuckets.length - 1]}
                </div>
              </>
            ) : (
              <p className="text-muted small">No time-series data for this selection.</p>
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
}

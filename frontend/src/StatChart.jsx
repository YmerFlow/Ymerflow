import React, { useEffect, useRef } from 'react';
import { Plot, DataGroup, registerAxisQuantityKind } from 'gladly-plot';

// The admin stats dashboard's gladly wrapper (docs/plans/admin-stats-pivot-redesign.md, StatChart
// section). gladly axes are numeric/continuous and its tick labels are numeric-only, so both
// categorical breakdowns and date buckets are passed as ordinals 0..n-1 with a separate label
// lookup rendered by the caller. This component draws the secondary chart of the pivot — the
// first group-by dim on x (bars if categorical, lines if temporal) and an optional second dim as
// a series split (grouped bars / multi-line) — and reports drill clicks back as key tuples.

// Quantity kinds for the stat axes. Registered once at module load, mirroring
// widgets/PlotView/quantityKinds.js. stat_series carries a turbo colorscale so multi-series line
// charts get distinct per-series colours (via a constant vData column per series).
let _registered = false;
function ensureQuantityKinds() {
  if (_registered) return;
  _registered = true;
  registerAxisQuantityKind('stat_ordinal', { label: '', scale: 'linear' });
  registerAxisQuantityKind('stat_count', { label: 'Count', scale: 'linear' });
  registerAxisQuantityKind('stat_series', { label: 'Series', scale: 'linear', colorscale: 'turbo' });
}

const MARGIN = { top: 16, right: 16, bottom: 28, left: 56 };
const BAR_COLOR = '#3380cc';

// Turbo colormap (Anton Mikhailov's polynomial fit) — the JS twin of gladly's built-in "turbo"
// colorscale, so the StatsAdminPanel legend swatches match the on-canvas series colours. Series i
// of n is coloured by t = i/(n-1).
function turbo(t) {
  t = Math.max(0, Math.min(1, t));
  const clamp = v => Math.max(0, Math.min(255, Math.round(255 * v)));
  const r = 0.13572138 + 4.61539260 * t - 42.66032258 * t ** 2 + 132.13108234 * t ** 3 - 152.94239396 * t ** 4 + 59.28637943 * t ** 5;
  const g = 0.09140261 + 2.19418839 * t + 4.84296658 * t ** 2 - 14.18503333 * t ** 3 + 4.27729857 * t ** 4 + 2.82956604 * t ** 5;
  const b = 0.10667330 + 12.64194608 * t - 60.58204836 * t ** 2 + 110.36276771 * t ** 3 - 89.90310912 * t ** 4 + 27.34824973 * t ** 5;
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

// Colour StatsAdminPanel / this chart uses for series i of n — kept in sync with the turbo mapping.
export function statSeriesColor(i, n) {
  return turbo(n <= 1 ? 0.5 : i / (n - 1));
}

function ordinals(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

function globalMaxOf(series) {
  let m = 0;
  for (const s of series) for (const v of s.values) m = Math.max(m, v);
  return m;
}

// Build the gladly {data, config} for a bar breakdown. `series` is one-or-more series aligned to
// the n x categories. A single series → one bars layer (one bar per category). Multiple series →
// grouped bars: BarsLayer derives bar width as xDomainSpan / pointCount, so each series-layer is
// padded to n*m points (non-owned slots given zero-height bars) which forces width 1/m; the m
// bars for category i sit side-by-side within the unit slot, coloured per series.
function buildBars(n, series) {
  const m = series.length;
  const maxCount = globalMaxOf(series);
  const yDomain = [0, maxCount > 0 ? maxCount * 1.1 : 1];
  const cols = {};
  const qks = {};
  const domains = { x: [-0.5, n - 0.5], count: yDomain };
  const layers = [];

  if (m <= 1) {
    cols.x = ordinals(n);
    cols.count = Float32Array.from(series[0]?.values ?? []);
    qks.x = 'stat_ordinal';
    qks.count = 'stat_count';
    layers.push({ bars: { xData: 'stats.x', yData: 'stats.count', color: BAR_COLOR } });
  } else {
    // Grouped bars: each series-layer carries all n*m slot positions, only its own non-zero.
    for (let j = 0; j < m; j++) {
      const xs = new Float32Array(n * m);
      const counts = new Float32Array(n * m);
      let idx = 0;
      for (let i = 0; i < n; i++) {
        for (let jj = 0; jj < m; jj++) {
          xs[idx] = i + (jj - (m - 1) / 2) / m;
          counts[idx] = jj === j ? (series[j].values[i] ?? 0) : 0;
          idx++;
        }
      }
      cols[`x${j}`] = xs;
      cols[`c${j}`] = counts;
      qks[`x${j}`] = 'stat_ordinal';
      qks[`c${j}`] = 'stat_count';
      domains[`x${j}`] = [-0.5, n - 0.5];
      domains[`c${j}`] = yDomain;
      layers.push({ bars: { xData: `stats.x${j}`, yData: `stats.c${j}`, color: statSeriesColor(j, m) } });
    }
  }

  const data = new DataGroup({ stats: { data: cols, quantity_kinds: qks, domains } });
  return { data, config: { layers } };
}

// Build the gladly {data, config} for a multi-series line chart: x = bucket ordinal, one line
// layer per series. Each series carries a constant colour column (value = series index) whose
// stat_series quantity kind maps through the turbo colorscale to a distinct colour.
function buildLines(n, series) {
  const m = Math.max(series.length, 1);
  const globalMax = globalMaxOf(series);
  const yDomain = [0, globalMax > 0 ? globalMax * 1.1 : 1];

  const cols = { x: ordinals(n) };
  const qks = { x: 'stat_ordinal' };
  const domains = { x: [-0.5, n - 0.5], count: yDomain };

  const layers = [];
  series.forEach((s, i) => {
    cols[`s${i}`] = Float32Array.from(s.values);
    qks[`s${i}`] = 'stat_count';
    domains[`s${i}`] = yDomain;
    const layer = { xData: 'stats.x', yData: `stats.s${i}`, lineWidth: 2 };
    if (series.length > 1) {
      cols[`c${i}`] = new Float32Array(n).fill(i);
      qks[`c${i}`] = 'stat_series';
      domains[`c${i}`] = [0, m - 1];
      layer.vData = `stats.c${i}`;
    }
    layers.push({ lines: layer });
  });

  const data = new DataGroup({ stats: { data: cols, quantity_kinds: qks, domains } });
  return { data, config: { layers } };
}

export default function StatChart({ kind, xLabels, xKeys, series, onDrill, height = 260 }) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);
  const onDrillRef = useRef(onDrill);
  const xKeysRef = useRef(xKeys);
  const seriesRef = useRef(series);
  useEffect(() => { onDrillRef.current = onDrill; }, [onDrill]);
  useEffect(() => { xKeysRef.current = xKeys; }, [xKeys]);
  useEffect(() => { seriesRef.current = series; }, [series]);

  // Create / destroy the Plot once.
  useEffect(() => {
    ensureQuantityKinds();
    const container = containerRef.current;
    if (!container) return;
    const plot = new Plot(container, { margin: MARGIN });
    plotRef.current = plot;

    // Drill on click: resolve the clicked x back to the category ordinal → dim1 key, and (grouped
    // bars only) the sub-slot offset → dim2 series key.
    const clickHandle = plot.on('click', (e, coords) => {
      const cb = onDrillRef.current;
      const keys = xKeysRef.current;
      const ser = seriesRef.current || [];
      if (!cb || !keys) return;
      const o = coords?.stat_ordinal;
      if (o == null || Number.isNaN(o)) return;
      const i = Math.round(o);
      if (i < 0 || i >= keys.length) return;
      let seriesKey = null;
      if (ser.length > 1) {
        const m = ser.length;
        let j = Math.round((o - i) * m + (m - 1) / 2);
        j = Math.max(0, Math.min(m - 1, j));
        seriesKey = ser[j]?.key ?? null;
      }
      cb(keys[i], seriesKey);
    });

    return () => {
      clickHandle.remove();
      plot.destroy();
      plotRef.current = null;
    };
  }, []);

  // Rebuild data/config whenever inputs change.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const n = xLabels?.length || 0;
    const ser = series || [];
    if (!n || ser.length === 0) {
      plot.update({ data: new DataGroup({}), config: { layers: [] } });
      return;
    }
    const built = kind === 'lines' ? buildLines(n, ser) : buildBars(n, ser);
    plot.update(built).catch(err => console.warn('StatChart update failed:', err));
  }, [kind, xLabels, series]);

  // Positioned + clipped wrapper: gladly appends absolutely-positioned canvas/axis layers, so
  // without a `position: relative; overflow: hidden` containing block they escape and paint over
  // the rest of the page (the core reported bug). Mirrors widgets/PlotView/index.jsx:320.
  return (
    <div style={{ position: 'relative', overflow: 'hidden', width: '100%', height: `${height}px` }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', cursor: onDrill ? 'pointer' : 'default' }}
      />
    </div>
  );
}

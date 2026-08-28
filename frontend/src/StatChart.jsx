import React, { useEffect, useRef } from 'react';
import { Plot, DataGroup, registerAxisQuantityKind } from 'gladly-plot';

// The admin stats dashboard's gladly wrapper (docs/plans/admin-stats-dashboard.md Frontend
// Design). gladly axes are numeric/continuous and its tick labels are numeric-only, so both
// categorical breakdowns and date buckets are passed as ordinals 0..n-1 with a separate label
// lookup rendered by the caller (the breakdown table / the timeseries legend). This component
// only draws the geometry and reports drill clicks back as ordinals.

// Quantity kinds for the three stat axes. Registered once at module load, mirroring
// widgets/PlotView/quantityKinds.js. stat_series carries a colorscale so multi-series line
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
// colorscale, so the StatsAdminPanel legend swatches match the on-canvas line colours. Multi-series
// line charts colour series i by the value i over the domain [0, n-1] (see buildLines), i.e. t = i/(n-1).
function turbo(t) {
  t = Math.max(0, Math.min(1, t));
  const clamp = v => Math.max(0, Math.min(255, Math.round(255 * v)));
  const r = 0.13572138 + 4.61539260 * t - 42.66032258 * t ** 2 + 132.13108234 * t ** 3 - 152.94239396 * t ** 4 + 59.28637943 * t ** 5;
  const g = 0.09140261 + 2.19418839 * t + 4.84296658 * t ** 2 - 14.18503333 * t ** 3 + 4.27729857 * t ** 4 + 2.82956604 * t ** 5;
  const b = 0.10667330 + 12.64194608 * t - 60.58204836 * t ** 2 + 110.36276771 * t ** 3 - 89.90310912 * t ** 4 + 27.34824973 * t ** 5;
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

// Colour StatsAdminPanel uses for series i of n — kept in sync with the chart's turbo mapping.
export function statSeriesColor(i, n) {
  return turbo(n <= 1 ? 0.5 : i / (n - 1));
}

function ordinals(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

// Build the gladly {data, config} for a bar breakdown: one bar per category, x = ordinal.
function buildBars(values) {
  const n = values.length;
  const maxCount = values.reduce((m, v) => Math.max(m, v), 0);
  const data = new DataGroup({
    stats: {
      data: { x: ordinals(n), count: Float32Array.from(values) },
      quantity_kinds: { x: 'stat_ordinal', count: 'stat_count' },
      // Explicit domains: bars derive their width from the x-domain span, and the y-domain
      // sets the height scale — without these gladly falls back to [0,1] and bars vanish.
      domains: { x: [-0.5, n - 0.5], count: [0, maxCount > 0 ? maxCount * 1.1 : 1] },
    },
  });
  const config = {
    layers: [{ bars: { xData: 'stats.x', yData: 'stats.count', color: BAR_COLOR } }],
  };
  return { data, config };
}

// Build the gladly {data, config} for a multi-series line chart: x = bucket ordinal, one line
// layer per series. Each series carries a constant colour column (value = series index) whose
// stat_series quantity kind maps through the turbo colorscale to a distinct colour.
function buildLines(bucketCount, series) {
  const n = Math.max(series.length, 1);
  let globalMax = 0;
  for (const s of series) for (const c of s.counts) globalMax = Math.max(globalMax, c);

  const cols = { x: ordinals(bucketCount) };
  const qks = { x: 'stat_ordinal' };
  const domains = { x: [-0.5, bucketCount - 0.5], count: [0, globalMax > 0 ? globalMax * 1.1 : 1] };

  const layers = [];
  series.forEach((s, i) => {
    cols[`s${i}`] = Float32Array.from(s.counts);
    qks[`s${i}`] = 'stat_count';
    domains[`s${i}`] = [0, globalMax > 0 ? globalMax * 1.1 : 1];
    const layer = { xData: 'stats.x', yData: `stats.s${i}`, lineWidth: 2 };
    if (series.length > 1) {
      // Constant colour column → distinct colour per series via the stat_series colorscale.
      const cCol = new Float32Array(bucketCount).fill(i);
      cols[`c${i}`] = cCol;
      qks[`c${i}`] = 'stat_series';
      domains[`c${i}`] = [0, n - 1];
      layer.vData = `stats.c${i}`;
    }
    layers.push({ lines: layer });
  });

  const data = new DataGroup({
    stats: { data: cols, quantity_kinds: qks, domains },
  });
  return { data, config: { layers } };
}

export default function StatChart({ kind, values, series, bucketCount, categories, onDrill, height = 260 }) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);
  const onDrillRef = useRef(onDrill);
  const categoriesRef = useRef(categories);
  useEffect(() => { onDrillRef.current = onDrill; }, [onDrill]);
  useEffect(() => { categoriesRef.current = categories; }, [categories]);

  // Create / destroy the Plot once.
  useEffect(() => {
    ensureQuantityKinds();
    const container = containerRef.current;
    if (!container) return;
    const plot = new Plot(container, { margin: MARGIN });
    plotRef.current = plot;

    // Drill on click: resolve the clicked x back to the nearest category ordinal → key.
    const clickHandle = plot.on('click', (e, coords) => {
      const cb = onDrillRef.current;
      const cats = categoriesRef.current;
      if (!cb || !cats) return;
      const ord = Math.round(coords?.stat_ordinal ?? NaN);
      if (Number.isNaN(ord) || ord < 0 || ord >= cats.length) return;
      cb(cats[ord]);
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
    let built;
    if (kind === 'bars') {
      if (!values || values.length === 0) { plot.update({ data: new DataGroup({}), config: { layers: [] } }); return; }
      built = buildBars(values);
    } else {
      if (!series || series.length === 0 || !bucketCount) { plot.update({ data: new DataGroup({}), config: { layers: [] } }); return; }
      built = buildLines(bucketCount, series);
    }
    plot.update(built).catch(err => console.warn('StatChart update failed:', err));
  }, [kind, values, series, bucketCount]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: `${height}px`, cursor: onDrill ? 'pointer' : 'default' }}
    />
  );
}

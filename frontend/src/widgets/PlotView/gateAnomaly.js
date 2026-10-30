// The GateAnomalyPlot layer's numbers: each gate against its own running median along
// the line, in decades, log10(value) - log10(median of that gate's in-use values within
// ±halfWidth meters along xdist). Kept free of gladly so it can be unit-tested.

// A sounding whose window holds fewer in-use values than this fraction of the window's
// soundings gets no median, and shows grey. The drawing sheets did the same with pandas'
// rolling min_periods.
export const MIN_IN_USE_FRACTION = 0.25;

// Runs of soundings with non-decreasing xdist. libaarhusxyz restarts xdist at 0 on
// every line, so a part holding several lines splits into one run per line.
export function lineRuns(x) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= x.length; i++) {
    if (i === x.length || x[i] < x[i - 1]) {
      runs.push([start, i]);
      start = i;
    }
  }
  return runs;
}

function lowerBound(sorted, size, v) {
  let lo = 0, hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Running median of `values` over the soundings within ±halfWidth [m] of each one along
// x [m], line by line. NaN values are left out of the window but still count as window
// soundings for MIN_IN_USE_FRACTION. Returns a Float64Array, NaN where there is no median.
// The window is kept sorted as it slides, so each step costs one insert and one removal.
export function runningMedian(x, values, halfWidth) {
  const n = x.length;
  const median = new Float64Array(n).fill(NaN);
  const sorted = new Float64Array(n);
  for (const [start, end] of lineRuns(x)) {
    let size = 0, lo = start, hi = start;
    for (let i = start; i < end; i++) {
      for (; hi < end && x[hi] <= x[i] + halfWidth; hi++) {
        const v = values[hi];
        if (Number.isNaN(v)) continue;
        const p = lowerBound(sorted, size, v);
        sorted.copyWithin(p + 1, p, size);
        sorted[p] = v;
        size++;
      }
      for (; x[lo] < x[i] - halfWidth; lo++) {
        const v = values[lo];
        if (Number.isNaN(v)) continue;
        const p = lowerBound(sorted, size, v);
        sorted.copyWithin(p, p + 1, size);
        size--;
      }
      if (size === 0 || size < MIN_IN_USE_FRACTION * (hi - lo)) continue;
      median[i] = size % 2 ? sorted[(size - 1) / 2] : (sorted[size / 2 - 1] + sorted[size / 2]) / 2;
    }
  }
  return median;
}

// ── Transmitter height ───────────────────────────────────────────────────────
// Height changes slower than the window are absorbed by the running median; fast ones,
// such as climbs over powerlines, show as columns. Height enters a 1D forward response only
// through a factor e^(-2·λ·h), so to first order log amplitude is linear in height in
// meters, and one slope per gate removes it (see docs/plans/done/gate-anomaly-altitude.md).

// Transmitter height columns, in libaarhusxyz's alt_column order; matched in any case.
export const HEIGHT_COLUMNS = ['tx_altitude', 'alt', 'TxAltitude', 'tx_alt'];

// The transmitter height column among `flightlines`: `override` when given, else the first
// of HEIGHT_COLUMNS in any capitalization. Null when there is none.
export function findHeightColumn(flightlines, override) {
  if (override) return override in flightlines ? override : null;
  const columns = Object.keys(flightlines);
  for (const name of HEIGHT_COLUMNS) {
    const hit = columns.find(c => c.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// The height anomaly [m]: transmitter height above ground [m] minus its running median
// over ±halfWidth [m] along x, line by line. Heights that are not positive count as
// missing; their soundings get NaN.
export function heightAnomaly(x, height, halfWidth) {
  const n = x.length;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(height[i]);
    h[i] = Number.isFinite(v) && v > 0 ? v : NaN;
  }
  const median = runningMedian(x, h, halfWidth);
  const eta = new Float64Array(n);
  for (let i = 0; i < n; i++) eta[i] = h[i] - median[i];
  return eta;
}

// One gate's anomaly [decades] with the height term removed. Per line, the least-squares
// slope b [decades/m] of the anomaly on the height anomaly `eta` [m], through the origin
// since both are median-centered, over in-use cells where both are finite; then
// anomaly - b·eta for every cell. A line whose height does not vary gets b = 0; a cell
// without a height anomaly gets NaN. Returns { column, slopes } with one slope per line.
export function heightCorrectedColumn(x, anomaly, eta, inUse) {
  const column = new Float32Array(anomaly.length);
  const slopes = [];
  for (const [start, end] of lineRuns(x)) {
    let sxy = 0, sxx = 0;
    for (let i = start; i < end; i++) {
      if (inUse && Number(inUse[i]) === 0) continue;
      if (!Number.isFinite(anomaly[i]) || !Number.isFinite(eta[i])) continue;
      sxy += anomaly[i] * eta[i];
      sxx += eta[i] * eta[i];
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    slopes.push(b);
    for (let i = start; i < end; i++) column[i] = anomaly[i] - b * eta[i];
  }
  return { column, slopes };
}

// One gate's column of the section [decades]: log10(value) minus the running median of
// log10 of the gate's in-use values. Every positive value gets a number, in use or not,
// so a cell that is manually re-enabled can be colored; the layer greys what is not in
// use. NaN where the value is not positive or there is no median.
// `gate` and `inUse` are the dataset's Gate_<channel> and InUse_<channel> columns for this
// gate (InUse may be missing: all in use); x is xdist [m].
export function gateAnomalyColumn(x, gate, inUse, halfWidth) {
  const n = x.length;
  const logValue = new Float64Array(n);
  const logInUse = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(gate[i]);
    logValue[i] = Number.isFinite(v) && v > 0 ? Math.log10(v) : NaN;
    logInUse[i] = inUse && Number(inUse[i]) === 0 ? NaN : logValue[i];
  }
  const median = runningMedian(x, logInUse, halfWidth);
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) diff[i] = logValue[i] - median[i];
  return diff;
}

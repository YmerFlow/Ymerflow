import { describe, expect, it } from 'vitest';
import { findHeightColumn, gateAnomalyColumn, heightAnomaly, heightCorrectedColumn, lineRuns, runningMedian } from './gateAnomaly';

// A synthetic part with two lines (xdist restarts at 0 on the second), one gate.
const x = [0, 2.5, 5, 8, 10, 12.5, 15, 17, 20, 23, 25, 27.5, 30, 33, 35, 37.5, 40, 43, 45, 48,
  0, 3, 6, 9, 12, 15, 18, 21];
const v = [100, 110, 90, 105, 400, 420, 95, 100, 98, 102, 97, 101, 99, -5, 96, 94, 300, 93, 92, 91,
  50, 52, 48, 51, NaN, 49, 47, 46];
const culled = [4, 5, 16, 22, 23, 24, 25];
const inUse = v.map((_, i) => (culled.includes(i) ? 0 : 1));

// Brute force with numpy, per sounding i of each line (rows), window ±6 m:
//   win = rows[abs(x[rows] - x[i]) <= 6]; use = win[in_use & (v > 0)][win]
//   diff[i] = log10(v[i]) - median(log10(v[use]))   (NaN if use.size < 0.25 * win.size)
const NUMPY_DIFF = [0.0, 0.030798, -0.0563521, 0.0, 0.6243364, 0.6232493, -0.0135025, 0.004387, 0.0,
  0.0086002, -0.0088635, 0.0043431, 0.0044317, NaN, 0.0, 0.0, 0.5063159, 0.0023476, 0.0, -0.0047464,
  -0.0085167, 0.0085167, -0.0262454, NaN, NaN, 0.0227682, 0.00467, -0.00467];

describe('gateAnomalyColumn', () => {
  it('matches the numpy reference, with culled soundings left out of the median', () => {
    const diff = gateAnomalyColumn(Float32Array.from(x), Float32Array.from(v), Float32Array.from(inUse), 6);
    NUMPY_DIFF.forEach((expected, i) => {
      if (Number.isNaN(expected)) expect(diff[i]).toBeNaN();
      else expect(diff[i]).toBeCloseTo(expected, 5);
    });
  });

  it('gives a culled cell a value against the in-use cells around it', () => {
    // Within 6 m of x = 10 m the in-use values are 90, 105 and 95; 400 and 420 are culled.
    const diff = gateAnomalyColumn(x, v, inUse, 6);
    expect(diff[4]).toBeCloseTo(Math.log10(400 / 95), 5);
  });

  it('treats a missing InUse column as all in use', () => {
    const diff = gateAnomalyColumn([0, 1, 2], [10, 1000, 10], null, 5);
    expect(diff[0]).toBeCloseTo(0, 6);
    expect(diff[1]).toBeCloseTo(2, 6);
  });
});

describe('runningMedian', () => {
  it('agrees with a brute-force median on a long, irregular line', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 3000, half = 40;
    const xs = new Float64Array(n), vals = new Float64Array(n);
    for (let i = 1; i < n; i++) xs[i] = xs[i - 1] + 1 + 4 * rand();
    for (let i = 0; i < n; i++) vals[i] = rand() < 0.2 ? NaN : Math.round(rand() * 50) / 10;

    const got = runningMedian(xs, vals, half);
    for (let i = 0; i < n; i++) {
      const win = [], use = [];
      for (let j = 0; j < n; j++) {
        if (Math.abs(xs[j] - xs[i]) > half) continue;
        win.push(j);
        if (!Number.isNaN(vals[j])) use.push(vals[j]);
      }
      use.sort((a, b) => a - b);
      const m = use.length;
      const expected = m === 0 || m < 0.25 * win.length ? NaN
        : m % 2 ? use[(m - 1) / 2] : (use[m / 2 - 1] + use[m / 2]) / 2;
      if (Number.isNaN(expected)) expect(got[i]).toBeNaN();
      else expect(got[i]).toBeCloseTo(expected, 12);
    }
  });
});

describe('lineRuns', () => {
  it('splits where xdist restarts', () => {
    expect(lineRuns([0, 1, 2, 0, 5, 5, 1])).toEqual([[0, 3], [3, 6], [6, 7]]);
    expect(lineRuns([])).toEqual([]);
  });
});

describe('height correction', () => {
  // Two lines (xdist restarts): a climb to 60 m on the first, constant 30 m on the second.
  // Each gate's log10 value falls by a known slope per meter of height, plus a small wobble:
  //   log10 v = 2 - 0.3 g + b_g (h - 30) + 0.01 sin(i),   b = [-0.02, -0.005] decades/m
  // The top of the climb is culled in gate 0. Window ±20 m.
  const hx = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 0, 5, 10, 15, 20, 25];
  const h = [30, 30, 31, 30, 45, 60, 45, 31, 30, 29, 30, 30, 30, 30, 30, 30, 30, 30];
  const TRUE = [-0.02, -0.005];
  const value = (g) => h.map((hi, i) => 10 ** (2 - 0.3 * g + TRUE[g] * (hi - 30) + 0.01 * Math.sin(i)));
  const inUse = [h.map((_, i) => (i === 5 ? 0 : 1)), h.map(() => 1)];

  // numpy, with brute-force running medians as in the test above:
  //   eta = h - running_median(h);  a = log10 v - running_median(log10 v over in-use)
  //   per line: m = in-use & finite;  b = sum(a[m] * eta[m]) / sum(eta[m]**2)  (0 if no variation)
  //   corrected = a - b * eta
  const NUMPY_ETA = [0, -0.5, 0, -1, 14, 29, 14, 1, -0.5, -1, 0, 0, 0, 0, 0, 0, 0, 0];
  const NUMPY = [
    { slopes: [-0.0212852, 0], corrected: [0.0, -0.0022279, -0.0054535, -0.008967, -0.0041211, 0.0124308,
      0.0033729, 0.0155752, 0.0092509, 0.010556, 0.0022798, -0.0045597, -0.0095674, 0.0035404, 0.0092448,
      0.0058416, -0.0035404, -0.0138156] },
    { slopes: [-0.0056443, 0], corrected: [-0.0014112, 0.004887, 0.004093, -0.0049387, -0.0049597, 0.0025242,
      -0.0001858, 0.0126543, 0.0147915, 0.0089171, -0.003505, -0.0115698, -0.0095674, 0.0035404, 0.0092448,
      0.0058416, -0.0035404, -0.0138156] },
  ];

  it('detrends the height with the running median', () => {
    const eta = heightAnomaly(hx, h, 20);
    NUMPY_ETA.forEach((e, i) => expect(eta[i]).toBeCloseTo(e, 9));
  });

  it('matches the numpy least-squares slopes and corrected anomalies, with culled cells left out', () => {
    const eta = heightAnomaly(hx, h, 20);
    [0, 1].forEach((g) => {
      const a = gateAnomalyColumn(hx, value(g), inUse[g], 20);
      const { column, slopes } = heightCorrectedColumn(hx, a, eta, inUse[g]);
      NUMPY[g].slopes.forEach((b, k) => expect(slopes[k]).toBeCloseTo(b, 6));
      NUMPY[g].corrected.forEach((c, i) => expect(column[i]).toBeCloseTo(c, 5));
    });
  });

  it('recovers the slopes used to make the data, and gives a line at constant height none', () => {
    const eta = heightAnomaly(hx, h, 20);
    const slopes = [0, 1].map(g => heightCorrectedColumn(hx, gateAnomalyColumn(hx, value(g), inUse[g], 20), eta, inUse[g]).slopes);
    // Within 0.0015 decades/m; the wobble biases the fit a little.
    expect(Math.abs(slopes[0][0] - TRUE[0])).toBeLessThan(0.0015);
    expect(Math.abs(slopes[1][0] - TRUE[1])).toBeLessThan(0.0015);
    expect(slopes[0][1]).toBe(0);
  });

  it('leaves a cell without a height without a corrected value', () => {
    const gap = h.slice(); gap[8] = 0;
    const eta = heightAnomaly(hx, gap, 20);
    const { column } = heightCorrectedColumn(hx, gateAnomalyColumn(hx, value(1), inUse[1], 20), eta, inUse[1]);
    expect(column[8]).toBeNaN();
    expect(column[7]).not.toBeNaN();
  });
});

describe('findHeightColumn', () => {
  it('finds the first of libaarhusxyz\'s height columns, in any capitalization', () => {
    expect(findHeightColumn({ xdist: [], TXALTITUDE: [] })).toBe('TXALTITUDE');
    expect(findHeightColumn({ TxAltitude: [], Alt: [] })).toBe('Alt');
    expect(findHeightColumn({ xdist: [], radar: [] })).toBe(null);
  });

  it('uses altitude_column as given, or nothing if the dataset lacks it', () => {
    expect(findHeightColumn({ radar: [], TxAltitude: [] }, 'radar')).toBe('radar');
    expect(findHeightColumn({ TxAltitude: [] }, 'radar')).toBe(null);
  });
});

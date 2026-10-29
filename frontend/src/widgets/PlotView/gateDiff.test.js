import { describe, expect, it } from 'vitest';
import { gateDiffColumn, lineRuns, runningMedian } from './gateDiff';

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

describe('gateDiffColumn', () => {
  it('matches the numpy reference, with culled soundings left out of the median', () => {
    const diff = gateDiffColumn(Float32Array.from(x), Float32Array.from(v), Float32Array.from(inUse), 6);
    NUMPY_DIFF.forEach((expected, i) => {
      if (Number.isNaN(expected)) expect(diff[i]).toBeNaN();
      else expect(diff[i]).toBeCloseTo(expected, 5);
    });
  });

  it('gives a culled cell a value against the in-use cells around it', () => {
    // Within 6 m of x = 10 m the in-use values are 90, 105 and 95; 400 and 420 are culled.
    const diff = gateDiffColumn(x, v, inUse, 6);
    expect(diff[4]).toBeCloseTo(Math.log10(400 / 95), 5);
  });

  it('treats a missing InUse column as all in use', () => {
    const diff = gateDiffColumn([0, 1, 2], [10, 1000, 10], null, 5);
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

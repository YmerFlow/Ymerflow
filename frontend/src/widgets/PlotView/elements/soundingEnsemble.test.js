import { describe, expect, it } from 'vitest';
import {
  ensembleAlpha, ensembleXdist, ensembleXdistDomain, ENSEMBLE_SATURATION_TARGET,
} from './soundingEnsemble.js';

describe('ensembleAlpha', () => {
  // K overlapping lines reach the saturation target T: 1 − (1 − a)^K = T.
  const accumulated = (a, K) => 1 - Math.pow(1 - a, K);

  it('makes exactly saturationCount overlapping lines reach the saturation target', () => {
    const K = 25;
    expect(accumulated(ensembleAlpha(K), K)).toBeCloseTo(ENSEMBLE_SATURATION_TARGET, 6);
  });

  it('is N-independent: a lower count saturates faster (more opaque per line)', () => {
    expect(ensembleAlpha(10)).toBeGreaterThan(ensembleAlpha(100));
  });

  it('clamps into (0, 1] and tolerates a degenerate count', () => {
    expect(ensembleAlpha(1)).toBeLessThanOrEqual(1);
    expect(ensembleAlpha(0)).toBeGreaterThan(0);       // bad count → default
  });
});

describe('ensembleXdist', () => {
  it('reads one xdist per sounding', () => {
    const fl = { xdist: Float32Array.from([0, 10, 20, 30]) };
    expect(Array.from(ensembleXdist(fl, 4))).toEqual([0, 10, 20, 30]);
  });

  it('falls back to the sounding index when there is no xdist', () => {
    expect(Array.from(ensembleXdist({}, 3))).toEqual([0, 1, 2]);
    expect(Array.from(ensembleXdist(null, 2))).toEqual([0, 1]);
  });
});

describe('ensembleXdistDomain', () => {
  it('is the [min, max] of the finite xdist values', () => {
    expect(ensembleXdistDomain(Float32Array.from([30, 10, 20]))).toEqual([10, 30]);
  });
  it('degrades to [0, 1] when nothing is finite', () => {
    expect(ensembleXdistDomain(Float32Array.from([NaN, NaN]))).toEqual([0, 1]);
  });
});

import { describe, expect, it } from 'vitest';
import { currentSoundingFrom, matchSounding, soundingIndex } from './soundingMatch';

// Raw data on two lines flown on different days, so the same gtime (seconds of day) occurs on
// both. Line is int64 on disk and decodes to a BigInt64Array.
const RAW = {
  Line:  BigInt64Array.from([1060n, 1060n, 1060n, 1060n, 1060n, 1070n, 1070n, 1070n, 1070n, 1070n]),
  gtime: Float64Array.from([100.0, 100.1, 100.2, 100.3, 100.4, 100.0, 100.1, 100.2, 100.3, 100.4]),
};
// Averaged data keeps one raw row per stack: 1060 at 100.2; 1070 at 100.1 and 100.4. Its line
// column is a float here, to check BigInt and float line numbers still compare equal.
const AVG = {
  Line:  Float64Array.from([1060, 1070, 1070]),
  gtime: Float64Array.from([100.2, 100.1, 100.4]),
};

describe('matchSounding', () => {
  it('matches on the same line, not on a gtime that repeats on another line', () => {
    // Raw row 7 is line 1070 at 100.2. Averaged row 0 has that exact gtime but is on line 1060.
    expect(matchSounding(RAW, 7, AVG)).toBe(1);
    // And back: averaged row 0 (1060, 100.2) is raw row 2, not raw row 7 (1070, 100.2).
    expect(matchSounding(AVG, 0, RAW)).toBe(2);
  });

  it('takes the nearest gtime on the line', () => {
    expect(matchSounding(RAW, 8, AVG)).toBe(2);   // 1070 at 100.3: 100.4 is nearer than 100.1
    expect(matchSounding(RAW, 4, AVG)).toBe(0);   // 1060 at 100.4: the line's only stack
  });

  it('is null when the line is not in the other dataset, or a column is missing', () => {
    const onlyLine1060 = { Line: [1060], gtime: [100.2] };
    expect(matchSounding(RAW, 7, onlyLine1060)).toBeNull();
    expect(matchSounding(RAW, 7, { Line: AVG.Line })).toBeNull();
    expect(matchSounding({ gtime: RAW.gtime }, 7, AVG)).toBeNull();
    expect(matchSounding(RAW, null, AVG)).toBeNull();
    expect(matchSounding(RAW, 10, AVG)).toBeNull();
  });
});

// Plot data as PlotView builds it: the current dataset's row, and the averaged data's line 1070
// pinned by path.
const AVG_1070 = { Line: Float64Array.from([1070, 1070]), gtime: Float64Array.from([100.1, 100.4]) };
const RAW_DATA = {
  _currentSounding: 7,
  _currentFlightlines: RAW,
  current: { data: { flightlines: RAW } },
  averaged: { 2: { 'data@1070': { flightlines: AVG_1070 } } },
};

describe('soundingIndex / currentSoundingFrom', () => {
  it('uses the selected row for current datasets', () => {
    expect(soundingIndex(RAW_DATA, 'current.data')).toBe(7);
    expect(currentSoundingFrom(RAW_DATA, 'current.data', 3)).toBe(3);
  });

  it('matches pinned datasets by line and gtime, both ways', () => {
    expect(soundingIndex(RAW_DATA, 'averaged.2.data@1070')).toBe(0);            // 1070 at 100.2 → 100.1
    expect(currentSoundingFrom(RAW_DATA, 'averaged.2.data@1070', 1)).toBe(9);   // 1070 at 100.4
  });

  it('is null for a pinned dataset with no matching sounding', () => {
    expect(soundingIndex({ ...RAW_DATA, _currentSounding: 2 }, 'averaged.2.data@1070')).toBeNull();
  });
});

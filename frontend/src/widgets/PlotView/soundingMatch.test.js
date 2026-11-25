import { describe, expect, it } from 'vitest';
import { nearestSoundingByXdist, selectSoundingOnClick, soundingParam } from './soundingMatch';

describe('soundingParam', () => {
  it('reads the selected row index from a layer parameters object', () => {
    expect(soundingParam({ currentSounding: 7 })).toBe(7);
    expect(soundingParam({ currentSounding: 0 })).toBe(0);
  });

  it('returns null when unset', () => {
    expect(soundingParam({ currentSounding: null })).toBeNull();
    expect(soundingParam({})).toBeNull();
    expect(soundingParam(undefined)).toBeNull();
  });
});

describe('nearestSoundingByXdist', () => {
  const xdist = Float64Array.from([0, 10, 20, 30, 40]);

  it('finds the nearest row by distance along line', () => {
    expect(nearestSoundingByXdist(xdist, 22)).toBe(2);
    expect(nearestSoundingByXdist(xdist, 100)).toBe(4);
    expect(nearestSoundingByXdist(xdist, -5)).toBe(0);
  });

  it('is null for empty or invalid input', () => {
    expect(nearestSoundingByXdist(null, 10)).toBeNull();
    expect(nearestSoundingByXdist(xdist, NaN)).toBeNull();
    expect(nearestSoundingByXdist(xdist, undefined)).toBeNull();
  });
});

describe('selectSoundingOnClick', () => {
  it('sets the current sounding to the picked row index', () => {
    let set = null;
    const plot = { _rawData: { _setCurrentSounding: v => { set = v; } } };
    selectSoundingOnClick({ dataIndex: 42 }, {}, plot);
    expect(set).toBe(42);
  });

  it('does nothing when the pick resolved no row', () => {
    let called = false;
    const plot = { _rawData: { _setCurrentSounding: () => { called = true; } } };
    selectSoundingOnClick({ dataIndex: null }, {}, plot);
    selectSoundingOnClick(null, {}, plot);
    expect(called).toBe(false);
  });
});

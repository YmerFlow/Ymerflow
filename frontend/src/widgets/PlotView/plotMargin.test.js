import { describe, expect, it, vi } from 'vitest';

// Only the axis names matter here; the real module needs WebGL.
vi.mock('gladly-plot', () => ({
  AXIS_GEOMETRY: { xaxis_bottom: {}, xaxis_top: {}, yaxis_left: {}, yaxis_right: {}, xaxis_bottom_back: {} },
}));
import { drawnAxes, plotMargin, sameMargin } from './plotMargin.js';

describe('plotMargin', () => {
  it('keeps axis room only on the sides that have an axis', () => {
    expect(plotMargin(['xaxis_bottom', 'yaxis_left'])).toEqual({ top: 12, right: 24, bottom: 48, left: 80 });
  });

  it('assumes a bottom and a left axis before the first render', () => {
    expect(plotMargin(null)).toEqual(plotMargin(['xaxis_bottom', 'yaxis_left']));
  });

  it('makes room for a right-hand or top axis when one is drawn', () => {
    expect(plotMargin(['xaxis_top', 'xaxis_bottom', 'yaxis_left', 'yaxis_right']))
      .toEqual({ top: 48, right: 80, bottom: 48, left: 80 });
  });

  it('keeps room on every side for a 3D plot', () => {
    expect(plotMargin(['xaxis_bottom', 'xaxis_bottom_back'])).toEqual({ top: 50, right: 80, bottom: 60, left: 80 });
  });

  it('lets layoutConfig.margin replace single sides', () => {
    expect(plotMargin(['xaxis_bottom', 'yaxis_left'], { left: 50, top: 0 }))
      .toEqual({ top: 0, right: 24, bottom: 48, left: 50 });
  });

  it('ignores override values that are not usable pixel counts', () => {
    const fallback = plotMargin(null);
    expect(plotMargin(null, { left: -5, top: '20', bottom: null, right: NaN, middle: 10 })).toEqual(fallback);
    expect(plotMargin(null, {})).toEqual(fallback);
  });
});

describe('drawnAxes', () => {
  it('lists the axes that have a scale', () => {
    const scales = { xaxis_bottom: {}, yaxis_right: {} };
    const plot = { axisRegistry: { getScale: name => scales[name] ?? null } };
    expect(drawnAxes(plot)).toEqual(['xaxis_bottom', 'yaxis_right']);
  });

  it('leaves out an axis hidden with visible: false', () => {
    const scales = { xaxis_bottom: {}, yaxis_left: {} };
    const plot = {
      axisRegistry: { getScale: name => scales[name] ?? null },
      currentConfig: { axes: { xaxis_bottom: { visible: false } } },
    };
    expect(drawnAxes(plot)).toEqual(['yaxis_left']);
  });

  it('is null before the plot has rendered', () => {
    expect(drawnAxes({ axisRegistry: null })).toBeNull();
  });
});

describe('sameMargin', () => {
  it('compares every side', () => {
    const m = { top: 12, right: 24, bottom: 48, left: 80 };
    expect(sameMargin(m, { ...m })).toBe(true);
    expect(sameMargin(m, { ...m, right: 80 })).toBe(false);
  });
});

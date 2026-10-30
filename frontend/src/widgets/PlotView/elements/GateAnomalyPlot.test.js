import { describe, expect, it, vi } from 'vitest';
import { gateAnomalyColumn, heightAnomaly, heightCorrectedColumn } from '../gateAnomaly';

// The layer is built without WebGL: gladly's LayerType only keeps the layer's config.
vi.mock('gladly-plot', () => {
  const registeredLayerTypes = {};
  return {
    AXIS_GEOMETRY: { xaxis_bottom: { dir: 'x' }, yaxis_left: { dir: 'y' } },
    LayerType: class { constructor(config) { Object.assign(this, config); } },
    registerLayerType: (name, layerType) => { registeredLayerTypes[name] = layerType; },
    registeredLayerTypes,
  };
});
import { registeredLayerTypes } from 'gladly-plot';
import './GateAnomalyPlot.js';

describe('GateAnomalyPlot altitude_correction', () => {
  // One line, one gate, a climb that lowers the signal by 0.02 decades per meter.
  const x = Float32Array.from({ length: 40 }, (_, i) => i * 5);
  const h = Float32Array.from(x, (_, i) => (i >= 18 && i <= 21 ? 60 : 30));
  const v = Float32Array.from(h, (hi, i) => 10 ** (2 - 0.02 * (hi - 30) + 0.01 * Math.sin(i)));
  const inUse = new Float32Array(x.length).fill(1);

  // The cell colors the layer draws for a fresh copy of the dataset (no cache carry-over).
  function draw(params, flightlineExtras = { TxAltitude: h }) {
    const raw = {
      flightlines: { xdist: x, ...flightlineExtras },
      layer_data: { Gate_Ch01: new Map([[0, v]]), InUse_Ch01: new Map([[0, inUse]]) },
    };
    const data = { current: { processed_data: raw } };
    const layers = registeredLayerTypes.GateAnomalyPlot.createLayer(
      null, { dataset: 'current.processed_data', channel: 'Ch01', window_m: 50, ...params }, data, { _rawData: data });
    return layers[0]?.attributes.diff ?? null;
  }

  const uncorrected = gateAnomalyColumn(x, v, inUse, 50);
  const corrected = heightCorrectedColumn(x, uncorrected, heightAnomaly(x, h, 50), inUse).column;

  it('leaves the anomaly unchanged when off, even with a height column present', () => {
    const drawn = draw({ altitude_correction: false });
    uncorrected.forEach((a, i) => expect(drawn[i]).toBeCloseTo(a, 6));
    expect(Array.from(draw({}))).toEqual(Array.from(drawn));
  });

  it('draws the corrected anomaly when on, which removes the climb', () => {
    const drawn = draw({ altitude_correction: true });
    corrected.forEach((c, i) => expect(drawn[i]).toBeCloseTo(c, 6));
    expect(Math.abs(uncorrected[19])).toBeGreaterThan(0.5);
    expect(Math.abs(drawn[19])).toBeLessThan(0.05);
  });

  it('draws nothing, and says why, when on without a height column', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(draw({ altitude_correction: true }, { radar: h })).toBe(null);
    expect(draw({ altitude_correction: true, altitude_column: 'zb' })).toBe(null);
    expect(error.mock.calls.length).toBe(2);
    error.mockRestore();
  });

  it('uses altitude_column when given', () => {
    const drawn = draw({ altitude_correction: true, altitude_column: 'radar' }, { radar: h });
    corrected.forEach((c, i) => expect(drawn[i]).toBeCloseTo(c, 6));
  });
});

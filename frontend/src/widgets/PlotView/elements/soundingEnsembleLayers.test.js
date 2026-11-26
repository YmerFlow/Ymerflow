import { describe, expect, it, vi } from 'vitest';

// The layers are built without WebGL: the mocked LayerType only keeps the layer's config, and
// createLayer returns the raw sublayer configs (not gladly Layer instances). ArrayColumn is a
// thin carrier of the flat data + shape.
//
// NOTE: SoundingResistivityPlot is no longer covered here. It now bakes its staircase geometry on
// the GPU inside createLayer (a real regl / WebGL context), so its layer structure can't be built
// headless — it is validated via the Playwright render run instead (see
// docs/plans/done/sounding-ensemble-perf-rethink.md). SoundingPlot is unchanged and still builds
// its geometry on the CPU, so it stays unit-tested.
vi.mock('gladly-plot', () => {
  const registeredLayerTypes = {};
  class ArrayColumn { constructor(data, opts) { this.data = data; this.shape = opts?.shape; } }
  return {
    AXIS_GEOMETRY: { xaxis_bottom: { dir: 'x' }, yaxis_left: { dir: 'y' } },
    ArrayColumn,
    LayerType: class { constructor(config) { Object.assign(this, config); } },
    registerLayerType: (name, layerType) => { registeredLayerTypes[name] = layerType; },
    registeredLayerTypes,
  };
});
import { registeredLayerTypes } from 'gladly-plot';
import './SoundingPlot.js';

const build = (name, params, raw) =>
  registeredLayerTypes[name].createLayer(null, params, { current: raw }, { _rawData: { current: raw } });

describe('SoundingPlot ensemble + current', () => {
  const raw = {
    flightlines: { xdist: Float32Array.from([0, 10, 20]) },
    layer_data: { Gate_Ch01: new Map([[0, [1, 2, 3]], [1, [4, 5, 6]]]) },
    gate_times: () => [[1e-5], [2e-5]],
  };
  const layers = build('SoundingPlot', { dataset: 'current', channel: 'Ch01' }, raw);

  it('returns the ensemble decay curve, then the current lines + points', () => {
    expect(layers.length).toBe(3);
    expect(layers.map(l => l.uniforms.u_ensemble())).toEqual([1, 0, 0]);
    expect(layers.map(l => l.primitive)).toEqual(['lines', 'lines', 'points']);
  });

  it('draws the ensemble as one non-instanced gate-pair buffer per sounding', () => {
    const ens = layers[0];
    expect(ens.instanceCount).toBeUndefined();
    // nSeg = nGates−1 = 1 → 2 verts/sounding × 3 soundings.
    expect(ens.vertexCount).toBe(6);
    expect(Array.from(ens.attributes.soundingIdx)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(Array.from(ens.attributes.fval)).toEqual([0, 0, 10, 10, 20, 20]);
    expect(ens.domains.xdist_m).toEqual([0, 20]);
  });
});

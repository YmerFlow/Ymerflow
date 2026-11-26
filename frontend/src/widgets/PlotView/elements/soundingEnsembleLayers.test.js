import { describe, expect, it, vi } from 'vitest';

// The layers are built without WebGL: the mocked LayerType only keeps the layer's config, and
// createLayer returns the raw sublayer configs (not gladly Layer instances). ArrayColumn is a
// thin carrier of the flat data + shape.
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
import './SoundingResistivityPlot.js';
import './SoundingPlot.js';

const build = (name, params, raw) =>
  registeredLayerTypes[name].createLayer(null, params, { current: raw }, { _rawData: { current: raw } });

describe('SoundingResistivityPlot ensemble + current', () => {
  // 2 layers, 3 soundings; xdist 0/10/20, flat topo 100.
  const raw = {
    flightlines: { xdist: Float32Array.from([0, 10, 20]), topo: Float32Array.from([100, 100, 100]) },
    layer_data: {
      rho:     new Map([[0, [10, 20, 30]], [1, [40, 50, 60]]]),
      dep_top: new Map([[0, [0, 0, 0]],    [1, [5, 5, 5]]]),
      dep_bot: new Map([[0, [5, 5, 5]],    [1, [15, 15, 15]]]),
    },
  };
  const layers = build('SoundingResistivityPlot', { dataset: 'current' }, raw);

  it('returns the ensemble then the current sounding (current on top)', () => {
    expect(layers.length).toBe(2);
    expect(layers[0].uniforms.u_ensemble()).toBe(1);   // ensemble first
    expect(layers[1].uniforms.u_ensemble()).toBe(0);   // current on top
  });

  it('draws the ensemble as one non-instanced buffer of the topology per sounding', () => {
    // nVert = buildTopology(2): 2·2 verticals + (2−1)·2 connectors = 6; concatenated over 3 soundings.
    expect(layers[0].instanceCount).toBeUndefined();
    expect(layers[0].vertexCount).toBe(18);
    expect(layers[1].vertexCount).toBe(6);             // current sounding: one copy of the topology
  });

  it('tags each ensemble vertex with its sounding / topo / xdist (per-vertex, no divisor)', () => {
    expect(layers[0].attributeDivisors).toBeUndefined();
    expect(Array.from(layers[0].attributes.soundingIdx))
      .toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(Array.from(layers[0].attributes.topo)).toEqual(new Array(18).fill(100));
    expect(Array.from(layers[0].attributes.fval))
      .toEqual([0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20]);
    expect(layers[0].domains.xdist_m).toEqual([0, 20]);
    // Current sounding ignores these per-vertex attrs (uses u_topo / u_currentSounding, unfiltered).
    expect(layers[1].attributes.soundingIdx.length).toBe(6);
  });

  it('shares the nD data tables between both sublayers and sets a blend', () => {
    expect(layers[0].attributes.rho).toBe(layers[1].attributes.rho);
    expect(layers[0].blend).toBeTruthy();
  });
});

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

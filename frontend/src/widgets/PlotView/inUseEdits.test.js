import { describe, expect, it, vi } from 'vitest';
import { buildDiffColumns, inUseDiffReducer } from '../../datamodel/inUseDiffs';
import { cellEditEntries, segmentEditEntries, soundingState } from './inUseEdits';

// The layers are built without WebGL: gladly's LayerType only keeps the layer's config.
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
import './elements/ChannelPlot.js';
import './elements/GateDiffSection.js';

// A single-line part: 5 soundings that are rows 100-104 of the whole dataset. apply_idx is
// int64 on disk and decodes to a BigInt64Array.
const N = 5;
const GATES = [0, 1, 2];
const applyIdx = BigInt64Array.from([100n, 101n, 102n, 103n, 104n]);

describe('cellEditEntries', () => {
  it('maps cell t * nSoundings + i to sounding i of gate t, through apply_idx as a Number', () => {
    const mask = new Float32Array(N * GATES.length);
    mask[1 * N + 2] = 1;   // gate 1, sounding 2
    mask[2 * N + 4] = 1;   // gate 2, sounding 4
    expect(cellEditEntries(mask, N, GATES, applyIdx)).toEqual([
      { soundingIndex: 102, gateIndex: 1 },
      { soundingIndex: 104, gateIndex: 2 },
    ]);
  });

  it('uses the local index where there is no apply_idx', () => {
    const mask = new Float32Array(N * GATES.length);
    mask[3] = 1;
    expect(cellEditEntries(mask, N, GATES, undefined)).toEqual([{ soundingIndex: 3, gateIndex: 0 }]);
  });

  it('is null for a mask of another shape', () => {
    expect(cellEditEntries(new Float32Array(2 * (N - 1)), N, GATES, applyIdx)).toBe(null);
  });
});

describe('segmentEditEntries', () => {
  it('maps a selected vertex to its sounding, once per sounding and gate', () => {
    const tiles = GATES.map(() => new Float32Array(2 * (N - 1)));
    tiles[0][3] = 1;   // end of segment 1→2: sounding 2
    tiles[0][4] = 1;   // start of segment 2→3: sounding 2 again
    expect(segmentEditEntries(tiles, GATES, applyIdx)).toEqual([{ soundingIndex: 102, gateIndex: 0 }]);
  });
});

describe('soundingState', () => {
  const inuse = new Float32Array([1, 0, 1]);
  const diff = new Map([[0, new Map([[100, 0], [101, 1]])]]);
  it('lets a pending edit win over the dataset flag', () => {
    expect(soundingState(0, 100, 0, inuse, diff)).toBe(3);
    expect(soundingState(1, 101, 0, inuse, diff)).toBe(1);
  });
  it('falls back to the dataset flag', () => {
    expect(soundingState(1, 999, 0, inuse, diff)).toBe(2);
    expect(soundingState(2, 102, 1, inuse, diff)).toBe(0);
    expect(soundingState(2, 102, 1, null, null)).toBe(0);
  });
});

describe('editing in either pane', () => {
  const PATH = 'current.processed_data';
  const raw = {
    flightlines: { xdist: Float32Array.from([0, 10, 20, 30, 40]), apply_idx: applyIdx },
    layer_data: {
      Gate_Ch01: new Map(GATES.map(g => [g, Float32Array.from([100, 90, 80, 70, 60].map(v => v / 10 ** g))])),
      InUse_Ch01: new Map(GATES.map(g => [g, new Float32Array(N).fill(1)])),
    },
  };
  const params = { dataset: PATH, channel: 'Ch01', inUseMode: true };

  // What each pane draws, built as PlotView builds it: the store's diffs injected into the data.
  function draw(type, diffs) {
    const data = { current: { processed_data: raw }, _inMemoryDiffs: diffs };
    return registeredLayerTypes[type].createLayer(null, params, data, { _rawData: data })[0].attributes.inuse_state;
  }
  const lasso = (state, entries) =>
    inUseDiffReducer(state, { type: 'APPLY_EDIT', datasetName: PATH, channel: 'Ch01', entries, value: 0 });

  it('shows a section edit in ChannelPlot, a ChannelPlot edit in the section, and saves both in one diff', () => {
    let state = { diffs: {}, history: {} };

    // Disable gate 1, sounding 2 by lassoing its cell in the section.
    const cellMask = new Float32Array(N * GATES.length);
    cellMask[1 * N + 2] = 1;
    state = lasso(state, cellEditEntries(cellMask, N, GATES, applyIdx));

    // ChannelPlot draws gate 1's segments 1→2 and 2→3, vertices 2..5, as manually disabled.
    const channelPlot = draw('ChannelPlot', state.diffs)[1];
    expect(Array.from(channelPlot)).toEqual([0, 0, 3, 3, 3, 3, 0, 0]);

    // Disable gate 2, sounding 4 by lassoing the end of ChannelPlot's segment 3→4.
    const tiles = GATES.map(() => new Float32Array(2 * (N - 1)));
    tiles[2][7] = 1;
    state = lasso(state, segmentEditEntries(tiles, GATES, applyIdx));

    // The section draws both cells as manually disabled, and no others.
    const section = draw('GateDiffSection', state.diffs);
    const disabled = [];
    section.forEach((s, c) => { if (s === 3) disabled.push(c); });
    expect(disabled).toEqual([1 * N + 2, 2 * N + 4]);

    // Both edits are under one dataset path, so Save writes one diff holding both.
    expect(Object.keys(state.diffs)).toEqual([PATH]);
    const { applyIdx: rows, layerData } = buildDiffColumns(state.diffs[PATH]);
    expect(rows).toEqual([102, 104]);
    expect(Array.from(layerData.InUse_Ch01.get(1))).toEqual([0, NaN]);
    expect(Array.from(layerData.InUse_Ch01.get(2))).toEqual([NaN, 0]);
  });
});

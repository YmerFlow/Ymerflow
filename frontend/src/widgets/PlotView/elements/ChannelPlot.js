import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';
import { resolveDataPath, getFrom, getKeys, toFloat32Array } from '../colorUtils.js';
import { globalSoundingIndex, soundingState } from '../inUseEdits.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// inuse_state encoding (see inUseEdits.js):
//   0 = auto-enabled  (normal gate color)
//   1 = manually-enabled  (green tint)
//   2 = auto-disabled  (grey, like legacy bad_color)
//   3 = manually-disabled  (red tint)
// Segment state = max(s0, s1) so "worst" endpoint determines segment color.

registerLayerType('ChannelPlot', new LayerType({
  name: 'ChannelPlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'xdist_m',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'dbdt_abs_pT',
    colorAxisQuantityKinds: { '': 'gate_index' },
  }),

  vert: `#version 300 es
    precision mediump float;
    in float x;
    in float y;
    in float gate_index;
    in float inuse_state;
    out float vGateIndex;
    out float vInuseState;
    void main() {
      // y == NaN means this segment had an invalid (NaN/zero/inf) endpoint.
      if (y != y) {
        gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
        return;
      }
      gl_Position = plot_pos(vec2(x, y));
      vGateIndex = gate_index;
      vInuseState = inuse_state;
    }
  `,

  frag: `#version 300 es
    precision mediump float;
    uniform vec4 bad_color;
    in float vGateIndex;
    in float vInuseState;
    void main() {
      if (vInuseState > 2.5) {
        fragColor = gladly_apply_color(vec4(0.85, 0.1, 0.1, 1.0));
      } else if (vInuseState > 1.5) {
        fragColor = gladly_apply_color(bad_color);
      } else if (vInuseState > 0.5) {
        fragColor = gladly_apply_color(vec4(0.1, 0.8, 0.1, 1.0));
      } else {
        fragColor = map_color_(vGateIndex);
      }
    }
  `,

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset: { type: 'string', 'x-format': 'datasetPath' },
      channel: { type: 'string', enum: ['Ch01', 'Ch02'], default: 'Ch01' },
      inUseMode: {
        type: 'boolean',
        default: false,
        description: 'Show four-state InUse overlay (auto/manual × enabled/disabled)',
      },
      selection: {
        type: 'string',
        default: 'inuse_brush',
        description: 'Brush selection channel name for inUseMode edits; empty string disables selection',
      },
      bad_color: {
        type: 'array',
        items: { type: 'number' },
        minItems: 4,
        maxItems: 4,
        default: [0.7, 0.7, 0.7, 1.0],
        description: 'RGBA color for auto-disabled (not-in-use) segments',
      },
      xAxis: { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis: { type: 'string', enum: Y_AXES, default: 'yaxis_left' },
    },
    required: ['dataset', 'channel'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    const xdistRaw = flightlines.xdist;
    if (!xdistRaw) return [];

    const channel   = parameters.channel || 'Ch01';
    const yDataDict = layer_data[`Gate_${channel}`];
    if (!yDataDict) return [];

    const inuseDict   = layer_data[`InUse_${channel}`];
    const badColor    = parameters.bad_color ?? [0.7, 0.7, 0.7, 1.0];
    const inUseMode   = !!parameters.inUseMode;

    // In inUseMode, read the per-dataset per-channel diff from the injected _inMemoryDiffs.
    // _inMemoryDiffs: { [datasetName]: { [channel]: Map<gateKey, Map<soundingIdx, 0|1>> } }
    const datasetName = parameters.dataset;
    const channelDiff = inUseMode
      ? (rawData?._inMemoryDiffs?.[datasetName]?.[channel] ?? null)
      : null;

    // Pending edits are keyed by global sounding index, inuseArr by part-local index.
    const applyIdx    = flightlines.apply_idx;
    const globalIdx   = (i) => globalSoundingIndex(applyIdx, i);

    const xdist       = toFloat32Array(xdistRaw);
    const N           = xdist.length;
    const nSegs       = N - 1;
    const gateIndices = getKeys(yDataDict).sort((a, b) => a - b);

    const allXs = [], allYs = [], allGateIdxs = [], allInuseStates = [];

    for (let t = 0; t < gateIndices.length; t++) {
      const gateKey  = gateIndices[t];
      const yArr     = getFrom(yDataDict, gateKey);
      const inuseArr = inuseDict ? getFrom(inuseDict, gateKey) : null;

      const xs         = new Float32Array(nSegs * 2);
      const ys         = new Float32Array(nSegs * 2);
      const gateIdx    = new Float32Array(nSegs * 2).fill(t);
      const inuseState = new Float32Array(nSegs * 2);

      for (let i = 0; i < nSegs; i++) {
        const abs0 = Math.abs(Number(yArr[i]));
        const abs1 = Math.abs(Number(yArr[i + 1]));
        const isInvalid = !isFinite(abs0) || abs0 <= 0 || !isFinite(abs1) || abs1 <= 0;

        const s0 = soundingState(i,     globalIdx(i),     gateKey, inuseArr, channelDiff);
        const s1 = soundingState(i + 1, globalIdx(i + 1), gateKey, inuseArr, channelDiff);
        const segState = Math.max(s0, s1);

        xs[i * 2]             = xdist[i];
        xs[i * 2 + 1]         = xdist[i + 1];
        ys[i * 2]             = isInvalid ? NaN : abs0;
        ys[i * 2 + 1]         = isInvalid ? NaN : abs1;
        inuseState[i * 2]     = segState;
        inuseState[i * 2 + 1] = segState;
      }

      allXs.push(xs);
      allYs.push(ys);
      allGateIdxs.push(gateIdx);
      allInuseStates.push(inuseState);
    }

    return [{
      attributes: { x: allXs, y: allYs, gate_index: allGateIdxs, inuse_state: allInuseStates },
      uniforms: { bad_color: badColor },
      domains: { gate_index: [0, gateIndices.length - 1] },
      primitive: 'lines',
      lineWidth: 1,
    }];
  },
}));

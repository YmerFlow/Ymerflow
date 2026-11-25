import { LayerType, registerLayerType, AXIS_GEOMETRY, ArrayColumn } from 'gladly-plot';
import { parseColor, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { currentSoundingSchema } from './soundingLineMarker.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// The decay curve (gate time vs |gate value|) of the selected sounding. ALL soundings are
// uploaded once as an nD column [nGates, nSoundings]; the shader indexes it by u_currentSounding,
// so moving the selection is a uniform update with no plot rebuild (the all-soundings data model
// also leaves a clean path to a future ensemble/heatmap mode — see the plan). Invalid / zero
// gates are uploaded as NaN and dropped offscreen in the shader (as ChannelPlot does), replacing
// the old CPU "split into contiguous finite segments".

// Current-mode vert: one vertex per gate position (the line is drawn as 'lines' pairs so a NaN
// gate hides only the two segments touching it, never a stray segment to the screen edge). The
// gate's value for the current sounding is sampled from the nD column vals[gate, sounding].
const VERT = `#version 300 es
  precision mediump float;
  in float x;            // gate time (abs), per vertex
  in float gateVertex;   // gate index, per vertex
  uniform float pointSize;
  uniform float u_currentSounding;
  uniform vec3 u_color;
  out vec3 vColor;
  // sample_vals(ivec2) is injected by createDrawCommand for the nD vals column.
  void main() {
    int cs = int(u_currentSounding);
    if (cs < 0) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    float v = sample_vals(ivec2(int(gateVertex), cs));
    if (v != v) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }   // NaN gate → offscreen
    gl_Position = plot_pos(vec2(x, v));
    gl_PointSize = pointSize;
    vColor = u_color;
  }
`;

// highp int so the nD-column shape uniform (ivec4 u_col_vals_shape) gladly injects into BOTH
// stages has matching precision (see SoundingResistivityPlot for the link-error detail).
const FRAG = `#version 300 es
  precision mediump float;
  precision highp int;
  in vec3 vColor;
  void main() { fragColor = gladly_apply_color(vec4(vColor, 1.0)); }
`;

registerLayerType('SoundingPlot', new LayerType({
  name: 'SoundingPlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'time_s',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'dbdt_abs_pT',
  }),

  vert: VERT,
  frag: FRAG,

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset: { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-data-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      channel: { type: 'string', enum: ['Ch01', 'Ch02'], default: 'Ch01'   },
      color:   { type: 'string',                         default: '#e41a1c' },
      xAxis:   { type: 'string', enum: X_AXES,           default: 'xaxis_bottom' },
      yAxis:   { type: 'string', enum: Y_AXES,           default: 'yaxis_left'   },
      currentSounding: currentSoundingSchema,
    },
    required: ['dataset', 'channel'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    const xdist = flightlines.xdist;
    if (!xdist || xdist.length === 0) return [];
    const nS = xdist.length;

    const channel       = parameters.channel || 'Ch01';
    const channelNumber = { Ch01: 1, Ch02: 2 }[channel];
    if (!channelNumber) return [];

    let gateTimeArray;
    try { gateTimeArray = dataset.gate_times(channelNumber); }
    catch (e) { return []; }

    const yDataDict = layer_data[`Gate_${channel}`];
    if (!yDataDict) return [];

    const gateIndices = getKeys(yDataDict).sort((a, b) => a - b);
    const nGates = Math.min(gateIndices.length, gateTimeArray.length);
    if (nGates === 0) return [];

    // Gate time per gate (x axis, abs).
    const gateX = new Float32Array(nGates);
    for (let g = 0; g < nGates; g++) gateX[g] = Math.abs(gateTimeArray[g][0]);

    // All soundings' gate values as an nD column, row-major gate-fastest: flat[sounding*nGates + gate].
    const vals = new Float32Array(nGates * nS);
    let yMin = Infinity, yMax = -Infinity;
    for (let g = 0; g < nGates; g++) {
      const gateData = getFrom(yDataDict, gateIndices[g]);
      for (let s = 0; s < nS; s++) {
        const absY = Math.abs(Number(gateData?.[s]));
        const v = (absY > 0 && isFinite(absY)) ? absY : NaN;
        vals[s * nGates + g] = v;
        if (Number.isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
      }
    }
    if (!isFinite(yMin)) return [];   // no finite value anywhere

    let xMin = Infinity, xMax = -Infinity;
    for (let g = 0; g < nGates; g++) {
      const v = gateX[g];
      if (Number.isFinite(v)) { if (v < xMin) xMin = v; if (v > xMax) xMax = v; }
    }

    const valsCol = new ArrayColumn(vals, { shape: [nGates, nS] });
    const rgb     = parseColor(parameters.color || '#e41a1c');
    const uCS     = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };
    const domains = { time_s: [xMin, xMax], dbdt_abs_pT: [yMin, yMax] };

    // Line segments as 'lines' pairs (gate g → gate g+1): a NaN endpoint hides only its segments.
    const nSeg = nGates - 1;
    const lineX = new Float32Array(nSeg * 2);
    const lineG = new Float32Array(nSeg * 2);
    for (let g = 0; g < nSeg; g++) {
      lineX[g * 2] = gateX[g];       lineX[g * 2 + 1] = gateX[g + 1];
      lineG[g * 2] = g;              lineG[g * 2 + 1] = g + 1;
    }

    // Dot markers: one vertex per gate.
    const dotG = new Float32Array(nGates);
    for (let g = 0; g < nGates; g++) dotG[g] = g;

    const results = [];
    if (nSeg > 0) {
      results.push({
        attributes: { x: lineX, gateVertex: lineG, vals: valsCol },
        uniforms: { pointSize: 1.0, u_currentSounding: uCS, u_color: rgb },
        domains, primitive: 'lines',
      });
    }
    results.push({
      attributes: { x: gateX, gateVertex: dotG, vals: valsCol },
      uniforms: { pointSize: 6.0, u_currentSounding: uCS, u_color: rgb },
      domains, primitive: 'points',
    });
    return results;
  },
}));

import { LayerType, registerLayerType, AXIS_GEOMETRY, ArrayColumn } from 'gladly-plot';
import { parseColor, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { currentSoundingSchema } from './soundingLineMarker.js';
import {
  saturationCountSchema, ensembleColorSchema, DEFAULT_ENSEMBLE_COLOR, DEFAULT_SATURATION_COUNT,
  ensembleAlpha, ensembleXdist, ensembleXdistDomain, ENSEMBLE_BLEND, ENSEMBLE_FILTER_SNIPPET,
} from './soundingEnsemble.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// The decay curve (gate time vs |gate value|). ALL soundings are uploaded once as an nD column
// [nGates, nSoundings]; the shader indexes it by a sounding index. Two roles are drawn every
// build (see the plan):
//  - an ENSEMBLE of all soundings as ONE non-instanced draw (translucent red, filtered by xdist):
//    the gate-pair line geometry is concatenated per sounding into one big vertex buffer, each
//    vertex carrying its own `soundingIdx` and `fval`. It is NOT instanced because on this GPU
//    stack source-over blending does not accumulate between instances of one instanced draw
//    (verified), so an instanced overlay stays uniformly faint — no heatmap; line primitives
//    within one ordinary draw DO accumulate.
//  - the CURRENT sounding on top (black, unfiltered), sounding = u_currentSounding, so moving the
//    selection is a uniform update with no plot rebuild.
// Invalid / zero gates are uploaded as NaN and dropped offscreen in the shader (as ChannelPlot
// does), replacing the old CPU "split into contiguous finite segments".

// One shader for both roles (gladly compiles a single program per layer type); u_ensemble picks
// the role per draw. The sublayers share the one compiled draw command, so per-sublayer values
// are passed as uniform props. One vertex per gate position (the line is 'lines' pairs so a NaN
// gate hides only the two segments touching it, never a stray segment to the screen edge).
const VERT = `#version 300 es
  precision mediump float;
  in float x;            // gate time (abs), per vertex
  in float gateVertex;   // gate index, per vertex
  in float soundingIdx;  // per-vertex: which sounding this vertex belongs to (ensemble)
  in float fval;         // per-vertex: that sounding's xdist (ensemble; the filtered quantity)
  uniform float pointSize;
  uniform float u_ensemble;
  uniform float u_currentSounding;
  uniform float u_alpha;
  uniform vec3 u_color;
  out vec4 vColor;
  // sample_vals(ivec2) + filter_(float) injected by createDrawCommand.
  void main() {
    bool ens = u_ensemble > 0.5;
    if (ens) { ${ENSEMBLE_FILTER_SNIPPET} }
    int cs = ens ? int(soundingIdx) : int(u_currentSounding);
    if (cs < 0) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    float v = sample_vals(ivec2(int(gateVertex), cs));
    if (v != v) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }   // NaN gate → offscreen
    gl_Position = plot_pos(vec2(x, v));
    gl_PointSize = pointSize;
    vColor = ens ? vec4(u_color, u_alpha) : vec4(u_color, 1.0);
  }
`;

// highp int so the nD-column shape uniform (ivec4 u_col_vals_shape) gladly injects into BOTH
// stages has matching precision (see SoundingResistivityPlot for the link-error detail).
const FRAG = `#version 300 es
  precision mediump float;
  precision highp int;
  in vec4 vColor;
  void main() { fragColor = gladly_apply_color(vColor); }
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

  // The ensemble overlay is culled by a filterbar on xdist; gladly injects the filter_() helper +
  // filter_range uniform. The current sounding never calls it, so it is unfiltered.
  filterAxisQuantityKinds: { '': 'xdist_m' },

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset: { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-data-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      channel: { type: 'string', enum: ['Ch01', 'Ch02'], default: 'Ch01'   },
      color:   { type: 'string',                         default: '#000000' },
      ensembleColor:      ensembleColorSchema,
      saturationCount:    saturationCountSchema,
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
    const curRgb  = parseColor(parameters.color || '#000000');
    const ensRgb  = parseColor(parameters.ensembleColor || DEFAULT_ENSEMBLE_COLOR);
    const alpha   = ensembleAlpha(parameters.saturationCount ?? DEFAULT_SATURATION_COUNT);
    const uCS     = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };
    const fval    = ensembleXdist(flightlines, nS);
    const domains = { time_s: [xMin, xMax], dbdt_abs_pT: [yMin, yMax], xdist_m: ensembleXdistDomain(fval) };

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

    // Ensemble: the gate-pair line geometry concatenated once per sounding into ONE big vertex
    // buffer (NOT instanced — see the shader comment; instanced draws don't blend-accumulate, so
    // they can't form the heatmap). Each vertex carries its sounding index and xdist.
    const bigN  = nS * nSeg * 2;
    const bigX  = new Float32Array(bigN);
    const bigG  = new Float32Array(bigN);
    const bigS  = new Float32Array(bigN);
    const bigF  = new Float32Array(bigN);
    for (let s = 0; s < nS; s++) {
      const base = s * nSeg * 2, fv = fval[s];
      for (let k = 0; k < nSeg * 2; k++) {
        bigX[base + k] = lineX[k];
        bigG[base + k] = lineG[k];
        bigS[base + k] = s;
        bigF[base + k] = fv;
      }
    }
    const dummyLine = new Float32Array(nSeg * 2);
    const dummyDot  = new Float32Array(nGates);

    // Sublayers share one compiled draw command (identical source), so every per-sublayer-varying
    // uniform MUST be a function (a regl prop passed per draw) — a static value would bake from the
    // first sublayer and be wrongly reused.
    const uniforms = (ensemble) => ({
      pointSize: () => 1.0,
      u_ensemble: () => (ensemble ? 1 : 0),
      u_currentSounding: uCS,
      u_alpha: () => alpha,
      u_color: () => (ensemble ? ensRgb : curRgb),
    });

    // Ensemble decay curve (one big 'lines' draw) first, then the current sounding on top. The
    // current keeps its points pass (gate markers) as before; gladly bakes one primitive per layer
    // type from the first sublayer, so the marker pass follows the 'lines' geometry — unchanged
    // from the pre-ensemble behaviour.
    const results = [];
    if (bigN > 0) results.push({
      attributes: { x: bigX, gateVertex: bigG, soundingIdx: bigS, fval: bigF, vals: valsCol },
      uniforms: uniforms(true), domains, primitive: 'lines', vertexCount: bigN, blend: ENSEMBLE_BLEND,
    });
    if (nSeg > 0) results.push({
      attributes: { x: lineX, gateVertex: lineG, soundingIdx: dummyLine, fval: dummyLine, vals: valsCol },
      uniforms: uniforms(false), domains, primitive: 'lines', vertexCount: nSeg * 2, blend: ENSEMBLE_BLEND,
    });
    results.push({
      attributes: { x: gateX, gateVertex: dotG, soundingIdx: dummyDot, fval: dummyDot, vals: valsCol },
      uniforms: uniforms(false), domains, primitive: 'points', vertexCount: nGates, blend: ENSEMBLE_BLEND,
    });
    return results;
  },
}));

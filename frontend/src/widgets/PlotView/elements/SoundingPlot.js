import { LayerType, registerLayerType, AXIS_GEOMETRY, ArrayColumn } from 'gladly-plot';
import { parseColor, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { currentSoundingSchema } from './soundingLineMarker.js';
import {
  saturationCountSchema, ensembleColorSchema, DEFAULT_ENSEMBLE_COLOR, DEFAULT_SATURATION_COUNT,
  ensembleAlpha, ensembleXdist, ensembleXdistDomain, ENSEMBLE_BLEND, ENSEMBLE_FILTER_SNIPPET,
} from './soundingEnsemble.js';
import { RenderedColumn, renderPackedColumn } from './soundingGeomColumn.js';

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
  // Map any non-finite (NaN/Inf) to a canonical NaN, so the raw uploaded gate values can be
  // abs'd + validity-culled here on the GPU (the CPU marshalling is a pure layout copy).
  float san(float x) { return (isnan(x) || isinf(x)) ? uintBitsToFloat(0x7fc00000u) : x; }
  // sample_vals(ivec2) + filter_(float) injected by createDrawCommand.
  void main() {
    bool ens = u_ensemble > 0.5;
    if (ens) { ${ENSEMBLE_FILTER_SNIPPET} }
    int cs = ens ? int(soundingIdx) : int(u_currentSounding);
    // Drop a vertex by giving it a NaN clip position: the GPU discards every primitive that
    // references it, so an invalid gate removes only the two line segments (and the point)
    // touching it — WITHOUT leaving a stray segment clipped to the viewport edge. The old
    // off-screen push (vec4(2,0,0,1)) did exactly that: for a 'lines' pair with one valid and
    // one invalid endpoint the GPU clipped the segment to the right edge, drawing a NaN-amplitude
    // gate as a line reaching to "infinite time". vColor is zeroed as a transparent fallback.
    float discardNaN = uintBitsToFloat(0x7fc00000u);
    if (cs < 0) { gl_Position = vec4(discardNaN); vColor = vec4(0.0); return; }
    // vals is a [nS, nGates] column (gate-major: flat = gate*nS + sounding), uploaded straight
    // from the per-gate source arrays with no CPU transpose. sampleColumnND computes
    // idx.x + shape.x*idx.y, so (sounding, gate) with shape (nS, nGates) hits gate*nS + sounding.
    float v = san(abs(sample_vals(ivec2(cs, int(gateVertex)))));
    if (v != v || v <= 0.0) { gl_Position = vec4(discardNaN); vColor = vec4(0.0); return; }   // NaN/≤0 gate → discard
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

// GPU bake body (mirrors SoundingResistivityPlot's GEOM_BODY): `float geomAt(int i)` for one output
// vertex of the ensemble. The gate-pair line topology (segment g: gate g → gate g+1) is expanded
// per sounding into a flat column of length bigN = nS·nSeg·2, selected by uWhich — x (0, gathered
// from the [nGates] gate-time column), gateVertex (1, the gate index), soundingIdx (2) and fval
// (3, gathered from the [nS] per-sounding xdist column). Pure index-math + gather; the only
// per-vertex computation (abs + validity) lives in the draw shader.
const GEOM_BODY = `
  float geomAt(int i) {
    int vps = i - (i / uNSeg2) * uNSeg2;   // vertex within the sounding
    int s   = i / uNSeg2;                  // sounding index
    if (uWhich == 3) return sampleColumn(fvalTex, float(s));                    // fval
    int g = vps / 2 + (vps - (vps / 2) * 2);                                    // gate index (pair topology)
    if (uWhich == 1) return float(g);                                           // gateVertex
    if (uWhich == 2) return float(s);                                           // soundingIdx
    return sampleColumn(gateXTex, float(g));                                    // x (uWhich 0)
  }`;

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

  createLayer: async function(regl, parameters, data, plot) {
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

    // All soundings' RAW gate values as a [nS, nGates] nD column, gate-major: flat[gate*nS +
    // sounding]. The source Gate_Ch* is ALREADY per-gate arrays over soundings, so each gate's
    // column drops in with a single native typed-array copy — NO per-sounding JS loop (the draw
    // shader samples it transposed via ivec2(sounding, gate); see the VERT note). abs + validity
    // culling stay in the shader (san + v <= 0.0). The loop below is over gates only (tens), not
    // the model.
    const vals = new Float32Array(nGates * nS);
    for (let g = 0; g < nGates; g++) {
      const gateData = getFrom(yDataDict, gateIndices[g]);
      if (!gateData) continue;   // missing gate → leaves 0, culled by the shader's v <= 0.0
      vals.set(gateData.length === nS ? gateData
             : (gateData.subarray ? gateData.subarray(0, nS) : Array.prototype.slice.call(gateData, 0, nS)),
             g * nS);
    }

    const valsCol = new ArrayColumn(vals, { shape: [nS, nGates] });
    const curRgb  = parseColor(parameters.color || '#000000');
    const ensRgb  = parseColor(parameters.ensembleColor || DEFAULT_ENSEMBLE_COLOR);
    const alpha   = ensembleAlpha(parameters.saturationCount ?? DEFAULT_SATURATION_COUNT);
    const uCS     = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };
    const fval    = ensembleXdist(flightlines, nS);

    // Axis ranges are only the INITIAL view (the operator zooms from there), so they are fixed log
    // windows rather than model scans. The uploaded `vals` are the raw layer_data numbers (no unit
    // conversion — the dbdt_abs_pT label is nominal), native magnitudes ~1e-12…1e-6.
    // See docs/plans/sounding-ensemble-gpu-columns.md.
    const domains = {
      time_s:      [1e-7, 1e-1],
      dbdt_abs_pT: [1e-12, 1e-6],
      xdist_m:     ensembleXdistDomain(fval),
    };

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

    // Ensemble: the gate-pair line geometry expanded once per sounding into ONE big vertex buffer
    // (NOT instanced — see the shader comment; instanced draws don't blend-accumulate, so they
    // can't form the heatmap). The four per-vertex columns (x, gateVertex, soundingIdx, fval) are
    // baked on the GPU via renderPackedColumn over a shared (gate-vertex, sounding) index map,
    // mirroring SoundingResistivityPlot — no CPU model-sized walk. Each vertex carries its sounding
    // index and that sounding's xdist (the filtered quantity).
    const nSeg2 = nSeg * 2;
    const bigN  = nS * nSeg2;
    let bigXCol, bigGCol, bigSCol, bigFCol;
    if (bigN > 0) {
      const samplers = {
        gateXTex: new ArrayColumn(gateX).toTexture(regl)[0],   // [nGates] abs gate time
        fvalTex:  new ArrayColumn(fval).toTexture(regl)[0],    // [nS] per-sounding xdist
      };
      const bakeColumn = (which) => new RenderedColumn(
        (rg) => renderPackedColumn(rg, bigN, samplers, { uNSeg2: nSeg2, uWhich: which }, GEOM_BODY)
      ).createColumn(regl, {}, plot);
      bigXCol = await bakeColumn(0);
      bigGCol = await bakeColumn(1);
      bigSCol = await bakeColumn(2);
      bigFCol = await bakeColumn(3);
    }
    const dummyLine = new Float32Array(nSeg * 2);
    const dummyDot  = new Float32Array(nGates);

    // gladly caches a compiled program per (vert+frag) source: the ensemble (column-sourced
    // attributes) and the current/dot sublayers (buffer-sourced, identical source to each other)
    // compile to two programs. Within each shared program every per-sublayer-varying uniform MUST
    // be a function (a regl prop passed per draw) — a static value would bake from the first
    // sublayer and be wrongly reused.
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
      attributes: { x: bigXCol, gateVertex: bigGCol, soundingIdx: bigSCol, fval: bigFCol, vals: valsCol },
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

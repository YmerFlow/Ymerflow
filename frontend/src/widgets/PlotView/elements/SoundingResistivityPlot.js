import { LayerType, registerLayerType, AXIS_GEOMETRY, ArrayColumn } from 'gladly-plot';
import { parseColor, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { currentSoundingSchema } from './soundingLineMarker.js';
import {
  saturationCountSchema, ensembleColorSchema, DEFAULT_ENSEMBLE_COLOR, DEFAULT_SATURATION_COUNT,
  ensembleAlpha, ensembleXdist, ensembleXdistDomain, ENSEMBLE_BLEND, ENSEMBLE_FILTER_SNIPPET,
} from './soundingEnsemble.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// 1D resistivity-depth staircase (resistivity on a log x, elevation = topo − depth on y). ALL
// soundings' rho/dep_top/dep_bot are uploaded once as nD columns [nLayers, nSoundings]; the
// staircase is reconstructed ENTIRELY in the vertex shader. Two sublayers are drawn every build:
//  - an ENSEMBLE of all soundings as one non-instanced draw (translucent red, filtered by xdist):
//    the fixed topology is concatenated per sounding into one big vertex buffer, each vertex
//    tagged with its sounding index (see soundingEnsemble.js and the shader comment for why this
//    is NOT instanced — overlapping translucent lines must blend-accumulate to form the heatmap);
//  - the CURRENT sounding on top (black, 1px, unfiltered), indexing the tables by the
//    u_currentSounding uniform — so moving the selection is a uniform update with no plot rebuild
//    and no CPU-side geometry work (see the plan), undisturbed by the ensemble.
// Topology is fixed: per layer one vertical dep_top→dep_bot segment, plus a connector to the next
// layer; a non-finite layer's own vertical/connector degenerate offscreen, so the staircase shows
// a gap (not a bridge) around it. The ensemble reuses this exact topology, repeated per sounding.

// Fixed topology built once per rebuild. Each vertex carries only (layerIdx, isBot); the shader
// samples rho/dep at (layerIdx, u_currentSounding). Verticals: (L, top)→(L, bot). Connectors:
// (L, bot)→(L+1, top) — horizontal when layers are contiguous, degenerate when either is NaN.
function buildTopology(nLayers) {
  const nVert = nLayers * 2 + Math.max(0, nLayers - 1) * 2;
  const layerIdx = new Float32Array(nVert);
  const isBot    = new Float32Array(nVert);
  let k = 0;
  const push = (L, b) => { layerIdx[k] = L; isBot[k] = b; k++; };
  for (let L = 0; L < nLayers; L++) { push(L, 0); push(L, 1); }                  // verticals
  for (let L = 0; L < nLayers - 1; L++) { push(L, 1); push(L + 1, 0); }          // connectors
  return { layerIdx, isBot };
}

// The halfspace (deepest finite layer with a non-finite dep_bot) is extended by
// max(1.5·prevThickness, 50) via a backward scan for the previous finite layer, reproducing the
// old CPU extension. Shared by both the current and the ensemble vert.
const DEP_BOT_EFF_GLSL = `
  float depBotEff(int L, int cs) {
    float dbot = sample_dep_bot(ivec2(L, cs));
    if (dbot == dbot) return dbot;                       // finite
    float dtopL = sample_dep_top(ivec2(L, cs));
    for (int k = 1; k < 256; k++) {
      int P = L - k;
      if (P < 0) break;
      float pb = sample_dep_bot(ivec2(P, cs));
      float pt = sample_dep_top(ivec2(P, cs));
      if (pb == pb && pt == pt) return dtopL + max(1.5 * (pb - pt), 50.0);
    }
    return dtopL + 50.0;
  }
`;

// Both the ensemble and the current sounding are drawn by this ONE shader (gladly compiles a
// single program per layer type) as two sublayers that differ only in values, so they share the
// compiled draw command cleanly. u_ensemble picks the role per draw:
//  - ensemble (u_ensemble=1): ONE non-instanced draw over every sounding — the fixed topology is
//    concatenated per sounding into one big vertex buffer, each vertex carrying its own
//    `soundingIdx`, `topo` and `fval`. It is NOT instanced: on this GPU stack source-over blending
//    does NOT accumulate between instances of one instanced draw (verified — overlapping instances
//    read the pre-draw framebuffer, so every line stays equally faint and no heatmap forms),
//    whereas separate line primitives within one ordinary draw DO accumulate. Translucent u_color
//    at u_alpha; the flat vColor is the one spot a later v_selection dim slots into.
//  - current  (u_ensemble=0): the one selected sounding — sounding = the u_currentSounding uniform
//    (the fast path — moving the selection is a uniform update, no rebuild); elevation from the
//    u_topo uniform; unfiltered; opaque u_color. Drawn after the ensemble, so it reads on top.
const VERT = `#version 300 es
  precision mediump float;
  in float layerIdx;
  in float isBot;
  in float soundingIdx;   // per-vertex: which sounding this vertex belongs to (ensemble)
  in float topo;          // per-vertex: that sounding's topography (ensemble; elevation = topo − depth)
  in float fval;          // per-vertex: that sounding's xdist (ensemble; the filtered quantity)
  uniform float u_ensemble;
  uniform float u_currentSounding;
  uniform float u_topo;
  uniform float u_alpha;
  uniform vec3 u_color;
  out vec4 vColor;
  // sample_rho / sample_dep_top / sample_dep_bot(ivec2) + filter_(float) injected.
  ${DEP_BOT_EFF_GLSL}
  void main() {
    bool ens = u_ensemble > 0.5;
    if (ens) { ${ENSEMBLE_FILTER_SNIPPET} }
    int cs = ens ? int(soundingIdx) : int(u_currentSounding);
    if (cs < 0) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    int L = int(layerIdx);
    float rho = sample_rho(ivec2(L, cs));
    float dtop = sample_dep_top(ivec2(L, cs));
    if (!(rho == rho) || rho <= 0.0 || !(dtop == dtop)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    float dep = isBot > 0.5 ? depBotEff(L, cs) : dtop;
    float tp = ens ? topo : u_topo;
    gl_Position = plot_pos(vec2(rho, tp - dep));
    vColor = ens ? vec4(u_color, u_alpha) : vec4(u_color, 1.0);
  }
`;

// highp int so the nD-column shape uniforms (ivec4 u_col_*_shape) gladly injects into BOTH
// stages have matching precision (vertex int defaults to highp; without this the program fails
// to link with "Precisions of uniform differ between VERTEX and FRAGMENT shaders").
const FRAG = `#version 300 es
  precision mediump float;
  precision highp int;
  in vec4 vColor;
  void main() { fragColor = gladly_apply_color(vColor); }
`;

registerLayerType('SoundingResistivityPlot', new LayerType({
  name: 'SoundingResistivityPlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'resistivity',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'elevation_m',
  }),

  vert: VERT,
  frag: FRAG,

  // The ensemble overlay is culled by a filterbar on xdist (distance along line); gladly injects
  // the filter_() helper + filter_range uniform. The current sounding never calls it, so it is
  // unfiltered (see soundingEnsemble.js).
  filterAxisQuantityKinds: { '': 'xdist_m' },

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset:     { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-model-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      topo_column: { type: 'string', default: 'topo' },
      color: {
        type: 'string',
        default: '#000000',
        description: 'Current-sounding line color (hex or named color)',
      },
      ensembleColor:      ensembleColorSchema,
      saturationCount:    saturationCountSchema,
      xAxis: { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis: { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
      currentSounding: currentSoundingSchema,
    },
    required: ['dataset'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!layer_data) return [];

    const rhoDict    = layer_data.rho ?? layer_data.resistivity ?? layer_data.rho_i;
    const depTopDict = layer_data.dep_top;
    const depBotDict = layer_data.dep_bot;
    if (!rhoDict || !depTopDict || !depBotDict) return [];

    const layerIndices = getKeys(rhoDict).map(k => parseInt(k)).sort((a, b) => a - b);
    const nLayers = layerIndices.length;
    if (nLayers === 0) return [];

    const nS = flightlines?.xdist?.length
      ?? getFrom(rhoDict, layerIndices[0])?.length
      ?? 0;
    if (!nS) return [];

    // Topo per sounding (elevation = topo − depth); the current sounding's value feeds u_topo.
    const topoColName = [parameters.topo_column, 'Topography', 'topo', 'elevation']
      .find(col => col && flightlines?.[col] !== undefined);
    const topoArr = topoColName ? flightlines[topoColName] : null;

    // All soundings' tables, row-major layer-fastest: flat[sounding*nLayers + layer]. Non-finite
    // (NaN/Inf) → NaN so the shader's `== self` test handles both.
    const san = (v) => (Number.isFinite(v) ? v : NaN);
    const rhoFlat = new Float32Array(nLayers * nS);
    const topFlat = new Float32Array(nLayers * nS);
    const botFlat = new Float32Array(nLayers * nS);
    for (let L = 0; L < nLayers; L++) {
      const rhoArr = getFrom(rhoDict,    layerIndices[L]);
      const topArr = getFrom(depTopDict, layerIndices[L]);
      const botArr = getFrom(depBotDict, layerIndices[L]);
      for (let s = 0; s < nS; s++) {
        rhoFlat[s * nLayers + L] = san(Number(rhoArr?.[s]));
        topFlat[s * nLayers + L] = san(Number(topArr?.[s]));
        botFlat[s * nLayers + L] = san(Number(botArr?.[s]));
      }
    }

    // Domain over all soundings (so the view is stable across selections, not re-fit per click).
    // Resistivity uses a robust 1–99 percentile window: inversion models carry a few physically
    // meaningless extremes (e.g. 1e-19, 1e22 Ωm in unconstrained layers) that would otherwise
    // collapse the log axis and hide every real staircase. Elevation is bounded, so full range.
    const rhoVals = [];
    let yMin = Infinity, yMax = -Infinity;
    for (let s = 0; s < nS; s++) {
      const topo = topoArr ? Number(topoArr[s]) : 0;
      for (let L = 0; L < nLayers; L++) {
        const r = rhoFlat[s * nLayers + L];
        const dt = topFlat[s * nLayers + L];
        let db = botFlat[s * nLayers + L];
        if (Number.isFinite(r) && r > 0) rhoVals.push(r);
        if (Number.isFinite(dt)) { const y = topo - dt; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
        if (!Number.isFinite(db) && Number.isFinite(dt)) db = dt + 50;
        if (Number.isFinite(db)) { const y = topo - db; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
      }
    }
    if (rhoVals.length === 0) return [];   // nothing finite to draw
    rhoVals.sort((a, b) => a - b);
    const pct = (p) => rhoVals[Math.min(rhoVals.length - 1, Math.max(0, Math.floor(p * (rhoVals.length - 1))))];
    let rMin = pct(0.01), rMax = pct(0.99);
    if (!(rMax > rMin)) { rMin = rhoVals[0]; rMax = rhoVals[rhoVals.length - 1]; if (!(rMax > rMin)) rMax = rMin * 10; }
    if (!isFinite(yMin)) { yMin = 0; yMax = 100; }

    const { layerIdx, isBot } = buildTopology(nLayers);
    const nVert  = layerIdx.length;
    const curRgb = parseColor(parameters.color || '#000000');
    const ensRgb = parseColor(parameters.ensembleColor || DEFAULT_ENSEMBLE_COLOR);
    const alpha  = ensembleAlpha(parameters.saturationCount ?? DEFAULT_SATURATION_COUNT);
    const uCS   = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };
    const uTopo = () => {
      const cs = parameters.currentSounding;
      return (topoArr && cs != null && cs >= 0 && cs < nS) ? Number(topoArr[cs]) : 0;
    };

    // Per-sounding topo (ensemble; the current sounding uses the u_topo uniform instead) and
    // xdist (the filtered quantity).
    const topoPerS = new Float32Array(nS);
    if (topoArr) for (let s = 0; s < nS; s++) topoPerS[s] = Number(topoArr[s]) || 0;
    const fval = ensembleXdist(flightlines, nS);

    // One nD table per quantity, shared by both sublayers (built once, re-rendered not rebuilt).
    const rhoCol = new ArrayColumn(rhoFlat, { shape: [nLayers, nS] });
    const topCol = new ArrayColumn(topFlat, { shape: [nLayers, nS] });
    const botCol = new ArrayColumn(botFlat, { shape: [nLayers, nS] });
    const domains = { resistivity: [rMin, rMax], elevation_m: [yMin, yMax], xdist_m: ensembleXdistDomain(fval) };

    // Ensemble geometry: the fixed topology concatenated once per sounding into ONE big vertex
    // buffer (NOT instanced — see the shader comment: instanced draws don't blend-accumulate, so
    // they can't form the heatmap). Each vertex carries its sounding index / topo / xdist.
    const N = nS * nVert;
    const bigLayerIdx = new Float32Array(N);
    const bigIsBot    = new Float32Array(N);
    const bigSdx      = new Float32Array(N);
    const bigTopo     = new Float32Array(N);
    const bigFval     = new Float32Array(N);
    for (let s = 0; s < nS; s++) {
      const base = s * nVert, tp = topoPerS[s], fv = fval[s];
      for (let v = 0; v < nVert; v++) {
        bigLayerIdx[base + v] = layerIdx[v];
        bigIsBot[base + v]    = isBot[v];
        bigSdx[base + v]      = s;
        bigTopo[base + v]     = tp;
        bigFval[base + v]     = fv;
      }
    }
    const dummy = new Float32Array(nVert);   // current sounding ignores these per-vertex attrs

    // Two sublayers sharing the one compiled program (same attributes/uniforms, so the draw
    // command is reused): the ensemble (all soundings, one big draw), then the current on top.
    const sublayer = (ensemble) => ({
      attributes: {
        layerIdx:    ensemble ? bigLayerIdx : layerIdx,
        isBot:       ensemble ? bigIsBot    : isBot,
        soundingIdx: ensemble ? bigSdx      : dummy,
        topo:        ensemble ? bigTopo     : dummy,
        fval:        ensemble ? bigFval     : dummy,
        rho: rhoCol, dep_top: topCol, dep_bot: botCol,
      },
      // Both sublayers share one compiled draw command (identical source), so every per-sublayer
      // uniform MUST be a function (a regl prop passed per draw) — a static value would be baked
      // from the first sublayer and wrongly reused for the second.
      uniforms: {
        u_ensemble: () => (ensemble ? 1 : 0),
        u_currentSounding: uCS, u_topo: uTopo,
        u_alpha: () => alpha,
        u_color: () => (ensemble ? ensRgb : curRgb),
      },
      domains,
      primitive: 'lines',
      vertexCount: ensemble ? N : nVert,
      blend: ENSEMBLE_BLEND,
    });

    return [sublayer(true), sublayer(false)];
  },
}));

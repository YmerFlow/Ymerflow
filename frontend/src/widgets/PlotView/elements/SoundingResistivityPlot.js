import { LayerType, registerLayerType, AXIS_GEOMETRY, ArrayColumn } from 'gladly-plot';
import { parseColor, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { currentSoundingSchema } from './soundingLineMarker.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// 1D resistivity-depth staircase of the currently selected sounding (resistivity on a log x,
// elevation = topo − depth on y). ALL soundings' rho/dep_top/dep_bot are uploaded once as nD
// columns [nLayers, nSoundings]; the staircase is reconstructed ENTIRELY in the vertex shader,
// indexing those tables by u_currentSounding — so moving the selection is a uniform update with
// no plot rebuild and no CPU-side geometry work (see the plan). Topology is fixed: per layer one
// vertical dep_top→dep_bot segment, plus a connector to the next layer; a non-finite layer's own
// vertical/connector degenerate offscreen, so the staircase shows a gap (not a bridge) around it.

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

// Vertex shader: reconstruct the staircase from the nD tables. The halfspace (deepest finite
// layer with a non-finite dep_bot) is extended by max(1.5·prevThickness, 50) via a backward scan
// for the previous finite layer, reproducing the old CPU extension.
const VERT = `#version 300 es
  precision mediump float;
  in float layerIdx;
  in float isBot;
  uniform float u_currentSounding;
  uniform float u_topo;
  uniform vec3 u_color;
  out vec3 vColor;
  // sample_rho / sample_dep_top / sample_dep_bot(ivec2) injected by createDrawCommand.

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

  void main() {
    int cs = int(u_currentSounding);
    if (cs < 0) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    int L = int(layerIdx);
    float rho = sample_rho(ivec2(L, cs));
    float dtop = sample_dep_top(ivec2(L, cs));
    if (!(rho == rho) || rho <= 0.0 || !(dtop == dtop)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    float dep = isBot > 0.5 ? depBotEff(L, cs) : dtop;
    gl_Position = plot_pos(vec2(rho, u_topo - dep));
    vColor = u_color;
  }
`;

// highp int so the nD-column shape uniforms (ivec4 u_col_*_shape) gladly injects into BOTH
// stages have matching precision (vertex int defaults to highp; without this the program fails
// to link with "Precisions of uniform differ between VERTEX and FRAGMENT shaders").
const FRAG = `#version 300 es
  precision mediump float;
  precision highp int;
  in vec3 vColor;
  void main() { fragColor = gladly_apply_color(vec4(vColor, 1.0)); }
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

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset:     { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-model-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      topo_column: { type: 'string', default: 'topo' },
      color: {
        type: 'string',
        default: '#333333',
        description: 'Line color (hex or named color)',
      },
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
    const rgb = parseColor(parameters.color || '#333333');
    const uCS   = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };
    const uTopo = () => {
      const cs = parameters.currentSounding;
      return (topoArr && cs != null && cs >= 0 && cs < nS) ? Number(topoArr[cs]) : 0;
    };

    return [{
      attributes: {
        layerIdx, isBot,
        rho:     new ArrayColumn(rhoFlat, { shape: [nLayers, nS] }),
        dep_top: new ArrayColumn(topFlat, { shape: [nLayers, nS] }),
        dep_bot: new ArrayColumn(botFlat, { shape: [nLayers, nS] }),
      },
      uniforms: { u_currentSounding: uCS, u_topo: uTopo, u_color: rgb },
      domains:  { resistivity: [rMin, rMax], elevation_m: [yMin, yMax] },
      primitive: 'lines',
    }];
  },
}));

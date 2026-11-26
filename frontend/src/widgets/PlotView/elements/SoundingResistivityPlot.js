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

// 1D resistivity-depth staircase (resistivity on a log x, elevation = topo − depth on y). The
// staircase geometry is STATIC once built, so it is baked ONCE per rebuild on the GPU into two
// flat columns — resistivity_x and elevation_y, each nVert·nS long — instead of being
// reconstructed in the vertex shader every frame (the old ~500 ms current-sounding cost; see
// docs/plans/done/sounding-ensemble-perf-rethink.md). The per-frame vertex shader then only
// projects those columns and applies the cheap offscreen culls. Two sublayers are drawn:
//  - the ENSEMBLE of all soundings as one non-instanced 'lines' draw (translucent red, culled by
//    an xdist filterbar) — overlapping translucent segments blend-accumulate into the heatmap;
//  - the CURRENT sounding on top (opaque black), culled to sounding == u_currentSounding, so
//    moving the selection is a uniform update with no rebuild and no CPU geometry work.
// Topology is fixed per sounding: one vertical dep_top→dep_bot per layer plus a connector to the
// next; a non-finite layer projects offscreen so the staircase shows a gap (not a bridge).

// Fixed per-sounding topology (nVert vertices). Each vertex carries (layerIdx, isBot); the GPU
// bake gathers rho/dep at (layerIdx, sounding). Verticals (L,top)→(L,bot) first, then connectors
// (L,bot)→(L+1,top) — the same order the bake's index map assumes.
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

// GPU bake body: `float geomAt(int i)` for one output vertex i. Derives (v, sounding) from i via
// the shared index map, gathers (layerIdx, isBot) from the uploaded topology, and emits one of
// three columns by uWhich: resistivity_x (0, the sanitised rho gather — NaN/≤0 is culled in the
// draw shader), elevation_y (1, topo − depth), or the per-vertex xdist/fval (2, a per-sounding
// gather feeding the ensemble filter). Raw rho/dep are uploaded untouched; `san` maps any
// non-finite (NaN/Inf) to a canonical NaN here on the GPU, so the CPU marshalling copy does zero
// processing. The halfspace (last layer) is the only non-finite dep_bot, so its "previous finite
// layer" is always exactly L−1 — one neighbour read, no scan loop.
const GEOM_BODY = `
  float san(float x) { return (isnan(x) || isinf(x)) ? uintBitsToFloat(0x7fc00000u) : x; }
  float geomAt(int i) {
    int v = i - (i / uNVert) * uNVert;          // vertex within the sounding
    int s = i / uNVert;                         // sounding index
    if (uWhich == 2) return sampleColumn(xdistTex, float(s));   // fval (per-sounding xdist)
    int L = int(sampleColumn(layerIdxTex, float(v)) + 0.5);
    float isBot = sampleColumn(isBotTex, float(v));
    int cell = L + uNLayers * s;                // rho/dep table index (layer-fastest)
    float rho = san(sampleColumn(rhoTex, float(cell)));
    if (uWhich == 0) return rho;                // resistivity_x
    float dtop = san(sampleColumn(depTopTex, float(cell)));
    float dep = dtop;
    if (isBot > 0.5) {
      float dbot = san(sampleColumn(depBotTex, float(cell)));
      if (dbot == dbot) {
        dep = dbot;
      } else if (L > 0) {
        float pb = san(sampleColumn(depBotTex, float((L - 1) + uNLayers * s)));
        float pt = san(sampleColumn(depTopTex, float((L - 1) + uNLayers * s)));
        dep = dtop + max(1.5 * (pb - pt), 50.0);
      } else {
        dep = dtop + 50.0;
      }
    }
    return san(sampleColumn(topoTex, float(s))) - dep;   // elevation_y
  }`;

// One shader for both sublayers (gladly compiles a single program per layer type); u_ensemble
// picks the role per draw, so every per-sublayer-varying uniform is a regl prop. resistivity_x /
// elevation_y are the precomputed 1D columns (gladly injects their sampleColumn fetch); fval is
// the per-vertex xdist buffer the ensemble filter reads. a_pickId, plot_pos and filter_ are
// injected by createDrawCommand.
const VERT = `#version 300 es
  precision mediump float;
  in float resistivity_x;   // GPU-precomputed x (data space); NaN/≤0 → culled
  in float elevation_y;     // GPU-precomputed y (data space)
  in float fval;            // GPU-precomputed per-vertex xdist (the filtered quantity)
  uniform float u_ensemble;
  uniform float u_currentSounding;
  uniform float u_nVert;
  uniform float u_alpha;
  uniform vec3 u_color;
  out vec4 vColor;
  void main() {
    bool ens = u_ensemble > 0.5;
    if (ens) {
      ${ENSEMBLE_FILTER_SNIPPET}
    } else {
      float sd = floor(a_pickId / u_nVert);
      if (u_currentSounding < 0.0 || sd != u_currentSounding) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
    }
    if (resistivity_x != resistivity_x || resistivity_x <= 0.0 || elevation_y != elevation_y) {
      gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return;
    }
    gl_Position = plot_pos(vec2(resistivity_x, elevation_y));
    vColor = ens ? vec4(u_color, u_alpha) : vec4(u_color, 1.0);
  }
`;

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

  createLayer: async function(regl, parameters, data, plot) {
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

    // Topo per sounding (elevation = topo − depth).
    const topoColName = [parameters.topo_column, 'Topography', 'topo', 'elevation']
      .find(col => col && flightlines?.[col] !== undefined);
    const topoArr = topoColName ? flightlines[topoColName] : null;

    // Marshal the per-layer tables to the GPU — ONE walk each, no processing: row-major
    // layer-fastest flat[sounding*nLayers + layer]. Validity (NaN/Inf → NaN) is done in the bake
    // shader (`san`), not here, so this copy is pure layout.
    const rhoFlat = new Float32Array(nLayers * nS);
    const topFlat = new Float32Array(nLayers * nS);
    const botFlat = new Float32Array(nLayers * nS);
    for (let L = 0; L < nLayers; L++) {
      const rhoArr = getFrom(rhoDict,    layerIndices[L]);
      const topArr = getFrom(depTopDict, layerIndices[L]);
      const botArr = getFrom(depBotDict, layerIndices[L]);
      for (let s = 0; s < nS; s++) {
        rhoFlat[s * nLayers + L] = Number(rhoArr?.[s]);
        topFlat[s * nLayers + L] = Number(topArr?.[s]);
        botFlat[s * nLayers + L] = Number(botArr?.[s]);
      }
    }

    // Per-sounding topo (elevation = topo − depth): ONE walk, used both to upload topo for the bake
    // AND to set the initial elevation view — its min/max fall out of this same pass, not a second
    // walk over the model.
    const topoPerS = new Float32Array(nS);
    let minTopo = Infinity, maxTopo = -Infinity;
    for (let s = 0; s < nS; s++) {
      const t = topoArr ? (Number(topoArr[s]) || 0) : 0;
      topoPerS[s] = t;
      if (t < minTopo) minTopo = t;
      if (t > maxTopo) maxTopo = t;
    }
    if (!isFinite(minTopo)) { minTopo = 0; maxTopo = 0; }

    // Per-sounding xdist (the filtered quantity) — uploaded to the bake and used for the filter
    // axis range; never expanded per vertex on the CPU (the bake gathers it, uWhich 2).
    const fvalPerS = ensembleXdist(flightlines, nS);

    // Axis ranges are only the INITIAL view (the operator zooms from there), so they are NOT
    // derived by scanning the model. Resistivity is a fixed log window: inversion models carry
    // physically meaningless 1e±19/1e22 Ωm extremes that a data-driven min/max would collapse the
    // log axis around. Elevation hangs a fixed depth span below the topography.
    const DEPTH_SPAN = 600;   // m shown below the lowest topography by default
    const domains = {
      resistivity: [1, 5000],
      elevation_m: [minTopo - DEPTH_SPAN, maxTopo],
      xdist_m: ensembleXdistDomain(fvalPerS),
    };

    const { layerIdx, isBot } = buildTopology(nLayers);
    const nVert = layerIdx.length;
    const N = nVert * nS;

    // Upload the per-layer tables + topology + xdist as packed input textures, then bake the three
    // flat columns on the GPU (once): resistivity_x, elevation_y and fval share one (vertex,
    // sounding) index map, so they are the same length and ordering — each consumed as a per-vertex
    // attribute.
    const samplers = {
      rhoTex:      new ArrayColumn(rhoFlat).toTexture(regl)[0],
      depTopTex:   new ArrayColumn(topFlat).toTexture(regl)[0],
      depBotTex:   new ArrayColumn(botFlat).toTexture(regl)[0],
      topoTex:     new ArrayColumn(topoPerS).toTexture(regl)[0],
      xdistTex:    new ArrayColumn(fvalPerS).toTexture(regl)[0],
      layerIdxTex: new ArrayColumn(layerIdx).toTexture(regl)[0],
      isBotTex:    new ArrayColumn(isBot).toTexture(regl)[0],
    };
    const bakeColumn = (which) => new RenderedColumn(
      (rg) => renderPackedColumn(rg, N, samplers, { uNVert: nVert, uNLayers: nLayers, uWhich: which }, GEOM_BODY)
    ).createColumn(regl, {}, plot);
    const resistivityX = await bakeColumn(0);
    const elevationY   = await bakeColumn(1);
    const fvalCol      = await bakeColumn(2);

    const curRgb = parseColor(parameters.color || '#000000');
    const ensRgb = parseColor(parameters.ensembleColor || DEFAULT_ENSEMBLE_COLOR);
    const alpha  = ensembleAlpha(parameters.saturationCount ?? DEFAULT_SATURATION_COUNT);
    const uCS    = () => { const cs = parameters.currentSounding; return (cs != null && cs >= 0 && cs < nS) ? cs : -1; };

    // Two sublayers sharing the one compiled program over the SAME precomputed columns: the
    // translucent ensemble (all vertices, xdist-culled), then the opaque current sounding on top
    // (same vertices, culled to sounding == u_currentSounding). Both iterate all N vertices; the
    // current draw adds no overdraw, only a vertex-only cull pass.
    const sublayer = (ens) => ({
      attributes: { resistivity_x: resistivityX, elevation_y: elevationY, fval: fvalCol },
      uniforms: {
        u_ensemble: () => (ens ? 1 : 0),
        u_currentSounding: uCS,
        u_nVert: () => nVert,
        u_alpha: () => alpha,
        u_color: () => (ens ? ensRgb : curRgb),
      },
      domains,
      primitive: 'lines',
      vertexCount: N,
      blend: ENSEMBLE_BLEND,
    });

    return [sublayer(true), sublayer(false)];
  },
}));

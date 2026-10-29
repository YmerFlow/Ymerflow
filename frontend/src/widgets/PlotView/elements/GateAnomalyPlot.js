import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';
import { resolveDataPath, getFrom, getKeys, toFloat32Array } from '../colorUtils.js';
import { gateAnomalyColumn } from '../gateAnomaly.js';
import { globalSoundingIndex, soundingState } from '../inUseEdits.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// Per-vertex unit-quad corners for instanced cell rendering (two CCW triangles)
const QUAD_CX = new Float32Array([0, 1, 1, 0, 1, 0]);
const QUAD_CY = new Float32Array([0, 0, 1, 0, 1, 1]);

// A gate-by-distance section of one channel: x is xdist, y the gate (1-based, early at
// the top), and each cell is colored by the gate's value against its own running median
// along the line (see gateAnomaly.js), brown below and green above, clipped at
// ±range_decades. Cells are laid out gate by gate (cell t * nSoundings + i), the order
// cellEditEntries() in inUseEdits.js maps a lasso back through.

// The section's numbers depend only on the data, the in-use mask and the window, not on
// pending edits, so they are kept between the re-renders every edit causes.
const sectionCache = new WeakMap();   // Gate_<channel> column map → { inuseDict, windowM, cells }

function buildCells(xdist, yDataDict, inuseDict, windowM) {
  const gateKeys = getKeys(yDataDict).sort((a, b) => a - b);
  const nS = xdist.length;
  const nCells = nS * gateKeys.length;

  // Cell edges halfway to the neighboring soundings, on the same line.
  const left = new Float32Array(nS), right = new Float32Array(nS);
  for (let i = 0; i < nS; i++) {
    const hasPrev = i > 0 && xdist[i - 1] <= xdist[i];
    const hasNext = i < nS - 1 && xdist[i + 1] >= xdist[i];
    const halfPrev = hasPrev ? (xdist[i] - xdist[i - 1]) / 2 : null;
    const halfNext = hasNext ? (xdist[i + 1] - xdist[i]) / 2 : null;
    left[i]  = xdist[i] - (halfPrev ?? halfNext ?? 0.5);
    right[i] = xdist[i] + (halfNext ?? halfPrev ?? 0.5);
  }

  const x0 = new Float32Array(nCells), x1 = new Float32Array(nCells), gate = new Float32Array(nCells);
  const diff = new Float32Array(nCells), hasDiff = new Float32Array(nCells);
  gateKeys.forEach((gateKey, t) => {
    const column = gateAnomalyColumn(xdist, getFrom(yDataDict, gateKey), inuseDict ? getFrom(inuseDict, gateKey) : null, windowM);
    for (let i = 0; i < nS; i++) {
      const c = t * nS + i;
      x0[c] = left[i];
      x1[c] = right[i];
      gate[c] = Number(gateKey) + 1;
      if (Number.isFinite(column[i])) { diff[c] = column[i]; hasDiff[c] = 1; }
    }
  });

  let xMin = Infinity, xMax = -Infinity;
  for (let i = 0; i < nS; i++) {
    if (left[i] < xMin) xMin = left[i];
    if (right[i] > xMax) xMax = right[i];
  }
  const gateMin = Number(gateKeys[0]) + 1, gateMax = Number(gateKeys[gateKeys.length - 1]) + 1;
  // Reversed, so early gates are at the top.
  const domains = { xdist_m: [xMin, xMax], gate_number: [gateMax + 0.5, gateMin - 0.5] };
  return { gateKeys, nS, x0, x1, gate, diff, hasDiff, domains };
}

function cachedCells(xdist, yDataDict, inuseDict, windowM) {
  const hit = sectionCache.get(yDataDict);
  if (hit && hit.inuseDict === inuseDict && hit.windowM === windowM && hit.cells.nS === xdist.length) return hit.cells;
  const cells = buildCells(xdist, yDataDict, inuseDict, windowM);
  sectionCache.set(yDataDict, { inuseDict, windowM, cells });
  return cells;
}

registerLayerType('GateAnomalyPlot', new LayerType({
  name: 'GateAnomalyPlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'xdist_m',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'gate_number',
  }),

  vert: `#version 300 es
    precision mediump float;
    in float cx, cy;
    in float x0, x1, gate, diff, has_diff, inuse_state;
    out float vDiff;
    out float vHasDiff;
    out float vInuseState;
    void main() {
      // gladly's lasso captures one position per cell (u_mode 1); give it the cell center,
      // so a cell is selected when its center is inside the lasso.
      float u = u_mode > 0.5 ? 0.5 : cx;
      float v = u_mode > 0.5 ? 0.5 : cy;
      gl_Position = plot_pos(vec2(mix(x0, x1, u), gate - 0.5 + v));
      vDiff = diff;
      vHasDiff = has_diff;
      vInuseState = inuse_state;
    }
  `,

  // inuse_state as in inUseEdits.js. Manually enabled is blue rather than ChannelPlot's
  // green, which would read as data on this color scale; no reds in the scale, so manually
  // disabled stays red.
  frag: `#version 300 es
    precision mediump float;
    uniform float range_decades;
    uniform vec4 bad_color;
    in float vDiff;
    in float vHasDiff;
    in float vInuseState;
    // matplotlib's BrBG, as on the drawing sheets: brown below the median, white at it,
    // green above.
    const vec3 BRBG[11] = vec3[11](
      vec3(0.329, 0.188, 0.020), vec3(0.549, 0.318, 0.039), vec3(0.749, 0.506, 0.176),
      vec3(0.875, 0.761, 0.490), vec3(0.965, 0.910, 0.765), vec3(0.961, 0.961, 0.961),
      vec3(0.780, 0.918, 0.898), vec3(0.502, 0.804, 0.757), vec3(0.208, 0.592, 0.561),
      vec3(0.004, 0.400, 0.369), vec3(0.000, 0.235, 0.188));
    vec3 brbg(float t) {
      float p = clamp(t, 0.0, 1.0) * 10.0;
      int i = int(min(floor(p), 9.0));
      return mix(BRBG[i], BRBG[i + 1], p - float(i));
    }
    void main() {
      vec3 base = vHasDiff > 0.5 ? brbg(0.5 + 0.5 * vDiff / range_decades) : bad_color.rgb;
      vec3 color;
      if (vInuseState > 2.5)      color = mix(base, vec3(0.85, 0.1, 0.1), 0.7);
      else if (vInuseState > 1.5) color = bad_color.rgb;
      else if (vInuseState > 0.5) color = mix(base, vec3(0.15, 0.35, 0.95), 0.55);
      else                        color = base;
      fragColor = gladly_apply_color(vec4(color, 1.0));
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
        description: 'Show four-state InUse overlay and edit with the InUse Editor',
      },
      selection: {
        type: 'string',
        default: 'inuse_brush',
        description: 'Brush selection channel name for inUseMode edits; empty string disables selection',
      },
      window_m: {
        type: 'number',
        default: 500,
        exclusiveMinimum: 0,
        description: 'Running median half-width along the line [m]: each sounding is compared with the in-use soundings within ± this distance',
      },
      range_decades: {
        type: 'number',
        default: 0.5,
        exclusiveMinimum: 0,
        description: 'Color range [decades]: ±0.5 is ×0.3 to ×3 the median; values beyond are clipped',
      },
      bad_color: {
        type: 'array',
        items: { type: 'number' },
        minItems: 4,
        maxItems: 4,
        default: [0.82, 0.82, 0.82, 1.0],
        description: 'RGBA color for cells not in use or without a value',
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
    if (!flightlines?.xdist?.length || !layer_data) return [];

    const channel   = parameters.channel || 'Ch01';
    const yDataDict = layer_data[`Gate_${channel}`];
    if (!yDataDict || getKeys(yDataDict).length === 0) return [];
    const inuseDict = layer_data[`InUse_${channel}`];

    const windowM = parameters.window_m ?? 500;
    const cells = cachedCells(toFloat32Array(flightlines.xdist), yDataDict, inuseDict, windowM);
    const { gateKeys, nS } = cells;

    // Pending edits: _inMemoryDiffs[datasetPath][channel], as for ChannelPlot.
    const channelDiff = parameters.inUseMode
      ? (rawData?._inMemoryDiffs?.[parameters.dataset]?.[channel] ?? null)
      : null;
    const applyIdx = flightlines.apply_idx;
    const inuseState = new Float32Array(nS * gateKeys.length);
    gateKeys.forEach((gateKey, t) => {
      const inuseArr = inuseDict ? getFrom(inuseDict, gateKey) : null;
      for (let i = 0; i < nS; i++) {
        inuseState[t * nS + i] = soundingState(i, globalSoundingIndex(applyIdx, i), gateKey, inuseArr, channelDiff);
      }
    });

    return [{
      attributes: {
        cx: QUAD_CX, cy: QUAD_CY,
        x0: cells.x0, x1: cells.x1, gate: cells.gate,
        diff: cells.diff, has_diff: cells.hasDiff, inuse_state: inuseState,
      },
      attributeDivisors: { x0: 1, x1: 1, gate: 1, diff: 1, has_diff: 1, inuse_state: 1 },
      uniforms: {
        range_decades: parameters.range_decades ?? 0.5,
        bad_color: parameters.bad_color ?? [0.82, 0.82, 0.82, 1.0],
      },
      domains: cells.domains,
      primitive: 'triangles',
      vertexCount: 6,
      instanceCount: nS * gateKeys.length,
    }];
  },
}));

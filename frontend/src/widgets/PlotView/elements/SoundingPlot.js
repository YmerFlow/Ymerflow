import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';
import { parseColor, fillColorArrays, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { soundingIndex } from '../soundingMatch.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

registerLayerType('SoundingPlot', new LayerType({
  name: 'SoundingPlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'time_s',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'dbdt_abs_pT',
  }),

  vert: `#version 300 es
    precision mediump float;
    in float x, y, r, g, b;
    uniform float pointSize;
    out vec3 vColor;
    void main() {
      if (y != y) {
        gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
        return;
      }
      gl_Position = plot_pos(vec2(x, y));
      gl_PointSize = pointSize;
      vColor = vec3(r, g, b);
    }
  `,

  frag: `#version 300 es
    precision mediump float;
    in vec3 vColor;
    void main() { fragColor = gladly_apply_color(vec4(vColor, 1.0)); }
  `,

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset: { type: 'string', 'x-format': 'datasetPath' },
      channel: { type: 'string', enum: ['Ch01', 'Ch02'], default: 'Ch01'   },
      color:   { type: 'string',                         default: '#e41a1c' },
      xAxis:   { type: 'string', enum: X_AXES,           default: 'xaxis_bottom' },
      yAxis:   { type: 'string', enum: Y_AXES,           default: 'yaxis_left'   },
    },
    required: ['dataset', 'channel'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData         = plot?._rawData ?? data;
    const currentSounding = soundingIndex(rawData, parameters.dataset);
    if (currentSounding === undefined || currentSounding === null) return [];

    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    const xdist = flightlines.xdist;
    if (!xdist || currentSounding < 0 || currentSounding >= xdist.length) return [];

    const channel       = parameters.channel || 'Ch01';
    const channelNumber = { Ch01: 1, Ch02: 2 }[channel];
    if (!channelNumber) return [];

    let gateTimeArray;
    try { gateTimeArray = dataset.gate_times(channelNumber); }
    catch (e) { return []; }

    const yDataDict = layer_data[`Gate_${channel}`];
    if (!yDataDict) return [];

    const gateIndices = getKeys(yDataDict).sort((a, b) => a - b);
    const xVals = [], yVals = [];

    gateIndices.forEach((gateIdx, idx) => {
      const gateData = getFrom(yDataDict, gateIdx);
      if (!gateData || currentSounding >= gateData.length || idx >= gateTimeArray.length) return;
      const absY = Math.abs(Number(gateData[currentSounding]));
      yVals.push((absY > 0 && isFinite(absY)) ? absY : NaN);
      xVals.push(Math.abs(gateTimeArray[idx][0]));
    });

    if (xVals.length === 0 || yVals.every(v => !isFinite(v))) return [];

    const rgb = parseColor(parameters.color || '#e41a1c');
    const result = [];

    // Split into contiguous finite segments
    let segStart = null;
    for (let i = 0; i <= xVals.length; i++) {
      const valid = i < xVals.length && isFinite(yVals[i]);
      if (valid && segStart === null) {
        segStart = i;
      } else if (!valid && segStart !== null) {
        const len = i - segStart;
        if (len >= 2) {
          const segX = new Float32Array(xVals.slice(segStart, i));
          const segY = new Float32Array(yVals.slice(segStart, i));
          const { r, g, b } = fillColorArrays(len, rgb);
          result.push({ attributes: { x: segX, y: segY, r, g, b }, uniforms: { pointSize: 1.0 }, primitive: 'line strip' });
        }
        segStart = null;
      }
    }

    // Dot markers for all valid points
    const validX = xVals.filter((_, i) => isFinite(yVals[i]));
    const validY = yVals.filter(v => isFinite(v));
    if (validX.length > 0) {
      const { r, g, b } = fillColorArrays(validX.length, rgb);
      result.push({ attributes: { x: new Float32Array(validX), y: new Float32Array(validY), r, g, b }, uniforms: { pointSize: 6.0 }, primitive: 'points' });
    }

    return result;
  },
}));

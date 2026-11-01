import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';
import { parseColor, fillColorArrays, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { soundingIndex } from '../soundingMatch.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

registerLayerType('SoundingMarker', new LayerType({
  name: 'SoundingMarker',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'xdist_m',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'dbdt_abs_pT',
  }),

  vert: `#version 300 es
    precision mediump float;
    in float x, y, r, g, b;
    out vec3 vColor;
    void main() {
      gl_Position = plot_pos(vec2(x, y));
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
      color:   { type: 'string', default: '#ff0000' },
      xAxis:   { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis:   { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
    },
    required: ['dataset'],
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

    const xPos = Number(xdist[currentSounding]);
    const rgb  = parseColor(parameters.color || '#ff0000');

    // Scan layer_data to compute the y range for a full-height line
    let minY = Infinity, maxY = -Infinity;
    for (const colKey of getKeys(layer_data)) {
      const dataDict = getFrom(layer_data, colKey);
      if (dataDict && typeof dataDict === 'object') {
        for (const gateKey of getKeys(dataDict)) {
          const arr = getFrom(dataDict, gateKey);
          if (arr && (Array.isArray(arr) || ArrayBuffer.isView(arr))) {
            for (let i = 0; i < arr.length; i++) {
              const v = Math.abs(Number(arr[i]));
              if (v > 0 && isFinite(v)) { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
            }
          }
        }
      }
    }
    if (!isFinite(minY) || !isFinite(maxY)) { minY = 0.1; maxY = 1000; }

    const logMin = Math.log10(minY), logMax = Math.log10(maxY), span = logMax - logMin;
    minY = Math.pow(10, logMin - span * 0.1);
    maxY = Math.pow(10, logMax + span * 0.1);

    const { r, g, b } = fillColorArrays(2, rgb);
    return [{
      attributes: { x: new Float32Array([xPos, xPos]), y: new Float32Array([minY, maxY]), r, g, b },
      uniforms:   {},
      primitive:  'line strip',
    }];
  },
}));

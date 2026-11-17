import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';
import { parseColor, fillColorArrays, toFloat32Array, resolveDataPath } from '../colorUtils.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

const COLUMN_COLORS = ['blue', 'red', 'green', 'purple', 'orange', 'brown'];

registerLayerType('MagLinePlot', new LayerType({
  name: 'MagLinePlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'index',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'mag_nT',
  }),

  vert: `#version 300 es
    precision mediump float;
    in float x, y, r, g, b;
    uniform float pointSize;
    out vec3 vColor;
    void main() {
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
      dataset: { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': ['application/x-magdata-msgpack'] },
      columns: { type: 'array', items: { type: 'string' }, default: ['magcom', 'diurnal'] },
      xcolumn: { type: 'string', default: 'fidcount' },
      mode:    { type: 'string', enum: ['lines', 'markers', 'lines+markers'], default: 'lines' },
      xAxis:   { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis:   { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
    },
    required: ['dataset'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData = plot?._rawData ?? data;
    const dataset = resolveDataPath(rawData, parameters.dataset);
    if (!dataset?.data) return [];

    const magData = dataset.data;
    const xRaw   = magData[parameters.xcolumn || 'fidcount'];
    if (!xRaw) return [];

    const n       = xRaw.length;
    const x       = toFloat32Array(xRaw);
    const columns = parameters.columns || ['magcom', 'diurnal'];
    const mode    = parameters.mode || 'lines';
    const results = [];

    columns.forEach((column, idx) => {
      let yValues;
      if (column === 'residual') {
        const magcom  = magData.magcom;
        const diurnal = magData.diurnal;
        if (!magcom || !diurnal) return;
        yValues = new Float32Array(n);
        for (let i = 0; i < n; i++) yValues[i] = Number(magcom[i]) - Number(diurnal[i]);
      } else {
        const raw = magData[column];
        if (!raw) return;
        yValues = toFloat32Array(raw);
      }

      const rgb = parseColor(COLUMN_COLORS[idx % COLUMN_COLORS.length]);
      const { r, g, b } = fillColorArrays(n, rgb);
      const attribs = { x, y: yValues, r, g, b };

      if (mode.includes('lines'))   results.push({ attributes: attribs, uniforms: { pointSize: 1.0 }, primitive: 'line strip' });
      if (mode.includes('markers')) results.push({ attributes: attribs, uniforms: { pointSize: 3.0 }, primitive: 'points'     });
    });

    return results;
  },
}));

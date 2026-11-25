import { LayerType, registerLayerType, AXIS_GEOMETRY, resolveQuantityKind } from 'gladly-plot';
import { parseColor, fillColorArrays, toFloat32Array, resolveDataPath } from '../colorUtils.js';
import { selectSoundingOnClick } from '../soundingMatch.js';
import { markerXYUniforms, currentSoundingSchema, showCurrentSoundingSchema } from './soundingLineMarker.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');

// Preferred columns in priority order, with the QK we fall back to when the data
// isn't resolvable yet (axis still needs *a* QK at resolveAxisConfig time).
function pickColumns(parameters, data) {
  const dataset = parameters.dataset;
  const tryCol = (explicit, prefs) => {
    if (explicit) return explicit;
    for (const c of prefs) {
      if (dataset && resolveQuantityKind(`${dataset}.${c}`, data) != null) return c;
    }
    return prefs[0];                     // nothing resolved yet — default
  };
  const xCol = tryCol(parameters.x_column, ['x_web', 'lon']);
  const yCol = tryCol(parameters.y_column, ['y_web', 'lat']);
  const xQK  = (dataset && resolveQuantityKind(`${dataset}.${xCol}`, data)) || 'epsg_3857_x';
  const yQK  = (dataset && resolveQuantityKind(`${dataset}.${yCol}`, data)) || 'epsg_3857_y';
  return { xCol, yCol, xQK, yQK };
}

// Finite [min, max] extent of a numeric array, skipping NaN/Inf; null if none finite.
function finiteExtent(arr) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : null;
}

const RGB_VERT = `#version 300 es
  precision mediump float;
  in float x, y, r, g, b, isMarker;
  uniform float pointSize;
  uniform float u_markerX, u_markerY, u_markerVisible;
  out vec3 vColor;
  out float vMarker;
  void main() {
    vMarker = isMarker;
    vColor = vec3(r, g, b);
    // The always-present current-sounding marker is an extra point at (u_markerX, u_markerY),
    // drawn larger (and red, in the frag). Offscreen when hidden.
    if (isMarker > 0.5) {
      if (u_markerVisible < 0.5) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
      gl_Position = plot_pos(vec2(u_markerX, u_markerY));
      gl_PointSize = pointSize + 8.0;
      return;
    }
    gl_Position = plot_pos(vec2(x, y));
    gl_PointSize = pointSize;
  }
`;

const RGB_FRAG = `#version 300 es
  precision mediump float;
  in vec3 vColor;
  in float vMarker;
  void main() {
    if (vMarker > 0.5) { fragColor = gladly_apply_color(vec4(1.0, 0.0, 0.0, 1.0)); return; }
    fragColor = gladly_apply_color(vec4(vColor, 1.0));
  }
`;

const flightlinePlot = new LayerType({
  name: 'FlightlinePlot',

  getAxisConfig: (parameters, data) => {
    const { xQK, yQK } = pickColumns(parameters, data);
    return {
      xAxis: parameters.xAxis ?? 'xaxis_bottom',
      xAxisQuantityKind: xQK,
      yAxis: parameters.yAxis ?? 'yaxis_left',
      yAxisQuantityKind: yQK,
    };
  },

  vert: RGB_VERT,
  frag: RGB_FRAG,

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset:  { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-msgpack'], ['application/x-aarhusxyz-model-msgpack'], ['application/x-aarhusxyz-data-msgpack']] },
      x_column: { type: 'string', default: 'x_web' },
      y_column: { type: 'string', default: 'y_web' },
      mode:     { type: 'string', enum: ['lines', 'markers', 'lines+markers'], default: 'markers' },
      color:    { type: 'string', default: 'blue' },
      xAxis:    { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis:    { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
      showCurrentSounding: showCurrentSoundingSchema,
      currentSounding: currentSoundingSchema,
    },
    required: ['dataset'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    if (!flightlines) return [];

    const { xCol, yCol, xQK, yQK } = pickColumns(parameters, rawData);
    const xRaw = flightlines[xCol];
    const yRaw = flightlines[yCol];
    if (!xRaw || !yRaw) return [];

    const n   = xRaw.length;
    const x   = toFloat32Array(xRaw);
    const y   = toFloat32Array(yRaw);
    const rgb = parseColor(parameters.color || 'blue');
    const { r, g, b } = fillColorArrays(n, rgb);

    const noMarker = new Float32Array(n);                 // 0 for every data point
    const attribs  = { x, y, r, g, b, isMarker: noMarker };
    const mode     = parameters.mode || 'markers';
    const results  = [];
    // Position/visibility of the marker point come from these uniforms (fast path); both passes
    // bind them (the shader declares them unconditionally).
    const markerUniforms = markerXYUniforms(parameters, x, y);

    const xDom = finiteExtent(x);
    const yDom = finiteExtent(y);
    const domains = {};
    if (xDom) domains[xQK] = xDom;
    if (yDom) domains[yQK] = yDom;

    // The always-present current-sounding marker is an extra highlighted point, appended to the
    // points pass only (a line pass would draw a stray segment to it); its position is supplied
    // by u_markerX/u_markerY, so the appended point here is a placeholder.
    const grow = (arr, v) => { const o = new Float32Array(arr.length + 1); o.set(arr); o[arr.length] = v; return o; };
    const pointAttribs = { x: grow(x, 0), y: grow(y, 0), r: grow(r, 0), g: grow(g, 0), b: grow(b, 0), isMarker: grow(noMarker, 1) };

    if (mode.includes('markers')) results.push({ attributes: pointAttribs, uniforms: { pointSize: 3.0, ...markerUniforms }, primitive: 'points',     domains });
    if (mode.includes('lines'))   results.push({ attributes: attribs,      uniforms: { pointSize: 1.0, ...markerUniforms }, primitive: 'line strip', domains });
    return results;
  },
});

// A click selects the sounding under the cursor. FlightlinePlot draws one GPU vertex per
// sounding (points and/or a line strip), so the picked vertex index IS this dataset's row:
// the identity pickInfo (the default) makes result.dataIndex that row, and the shared
// onClick translates it to the current dataset's sounding and selects it. PlotView holds
// no FlightlinePlot-specific logic.
flightlinePlot.onClick = selectSoundingOnClick;

registerLayerType('FlightlinePlot', flightlinePlot);

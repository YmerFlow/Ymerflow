import { LayerType, registerLayerType, AXIS_GEOMETRY, crsToQkX, crsToQkY } from 'gladly-plot';
import { fillColorArrays, toFloat32Array, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { soundingIndex, selectSoundingOnClick, soundingFromPickX, soundingFromPickId } from '../soundingMatch.js';
import { MARKER_HALF_WIDTH, markerSounding, appendMarkerInstance, showCurrentSoundingSchema } from './soundingLineMarker.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');
const Z_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'z');

// Per-vertex unit-quad corners for instanced rect rendering (two CCW triangles)
const QUAD_CX = new Float32Array([0, 1, 1, 0, 1, 0]);
const QUAD_CY = new Float32Array([0, 0, 1, 0, 1, 1]);

// Half-width (clip-space / NDC units) of the 3D curtain's black top/bottom outline ribbon.
// WebGL can't widen a line primitive, so the outline is a thin screen-space quad instead; this
// is ~1px on a typical viewport (same technique as MARKER_HALF_WIDTH, but a thinner line).
const OUTLINE_HALF_WIDTH = 0.0015;

// Per-instance attribute keys the 3D curtain grows when appending outline edge segments.
const CURTAIN3D_INSTANCED = [
  'gx', 'gz', 'gxPrev', 'gzPrev', 'gxNext', 'gzNext',
  'top', 'bot', 'resistivity', 'isMarker', 'isOutline', 'soundingId',
];

const concatF32 = (a, b) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

const SHARED_FRAG = `#version 300 es
  precision highp float;
  in float vVal;
  in float vMarker;
  void main() {
    if (vMarker > 0.5) { fragColor = gladly_apply_color(vec4(1.0, 0.0, 0.0, 1.0)); return; }
    fragColor = map_color_resistivity(vVal);
  }
`;

// 3D curtain fragment shader: adds a black outline branch (vOutline) on top of SHARED_FRAG's
// marker/resistivity paths, so the folded top/bottom edges are visible even at uniform resistivity.
const FRAG_3D = `#version 300 es
  precision highp float;
  in float vVal;
  in float vMarker;
  in float vOutline;
  void main() {
    if (vOutline > 0.5) { fragColor = gladly_apply_color(vec4(0.0, 0.0, 0.0, 1.0)); return; }
    if (vMarker > 0.5) { fragColor = gladly_apply_color(vec4(1.0, 0.0, 0.0, 1.0)); return; }
    fragColor = map_color_resistivity(vVal);
  }
`;

// ─── ResistivityCurtainBase ───────────────────────────────────────────────────

class ResistivityCurtainBase extends LayerType {
  constructor(config) {
    super({
      yAxisQuantityKind: 'elevation_m',
      colorAxisQuantityKinds: { '_resistivity': 'resistivity' },
      frag: SHARED_FRAG,
      ...config,
    });
  }

  // Prototype-level delegates — gladly resolves these via prototype chain because
  // we do NOT pass getAxisConfig/schema/createLayer to super(), so LayerType never
  // sets instance-level _getAxisConfig/_schema/_createLayer that would shadow them.
  _getAxisConfig(p, d) { return this._buildAxisConfig(p, d); }
  _schema(d)           { return this._buildSchema(d); }
  _createLayer(r, p, d, plot) { return this._buildLayer(r, p, d, plot); }

  _findTopoCol(flightlines, parameters) {
    return [parameters.topo_column, 'Topography', 'topo', 'elevation']
      .find(col => col && flightlines[col] !== undefined);
  }

  _buildFlightlineBoundaries(flightlines, nS) {
    // Returns Uint8Array where [i]=1 means sounding i is the first of a new flightline
    const lineId = flightlines.line_id ?? flightlines.LINE ?? flightlines.Line ?? flightlines.linenumber;
    const mask = new Uint8Array(nS);
    mask[0] = 1;
    if (lineId) {
      for (let i = 1; i < nS; i++) if (lineId[i] !== lineId[i - 1]) mask[i] = 1;
    } else {
      const xd = flightlines.xdist;
      if (xd) for (let i = 1; i < nS; i++) if (xd[i] <= xd[i - 1]) mask[i] = 1;
    }
    return mask;
  }

  _buildNeighborArr(arr, nS, boundaries) {
    const prev = new Float32Array(nS);
    const next = new Float32Array(nS);
    for (let i = 0; i < nS; i++) {
      const atStart = i === 0 || (boundaries && boundaries[i]);
      const atEnd   = i === nS - 1 || (boundaries && boundaries[i + 1]);
      prev[i] = atStart ? (nS > 1 && !atEnd   ? 2 * arr[i] - arr[i + 1] : arr[i]) : arr[i - 1];
      next[i] = atEnd   ? (nS > 1 && !atStart ? 2 * arr[i] - arr[i - 1] : arr[i]) : arr[i + 1];
    }
    return { prev, next };
  }

  _extractCells(flightlines, layer_data, parameters) {
    const nS = flightlines.xdist?.length;
    if (!nS) return null;

    const resKey = ['rho', 'resistivity', 'rho_i'].find(k => layer_data[k] !== undefined);
    const resistivity = resKey ? layer_data[resKey] : undefined;
    const dep_top = layer_data.dep_top;
    const dep_bot = layer_data.dep_bot;
    if (!resistivity || !dep_top || !dep_bot) return null;

    const layerIndices = getKeys(resistivity).sort((a, b) => parseInt(a) - parseInt(b));
    if (layerIndices.length === 0) return null;

    const topo = (() => {
      const col = this._findTopoCol(flightlines, parameters);
      return col ? flightlines[col] : null;
    })();

    const soundingIdxs = [], topVals = [], botVals = [], colVals = [];
    let resMin = Infinity, resMax = -Infinity;

    for (const j of layerIndices) {
      const resArr = getFrom(resistivity, j);
      const topArr = getFrom(dep_top, j);
      const botArr = getFrom(dep_bot, j);
      if (!resArr || !topArr || !botArr) continue;

      for (let i = 0; i < nS; i++) {
        const res = Number(resArr[i]);
        if (!isFinite(res) || res <= 0) continue;
        const t       = topo ? Number(topo[i]) : 0;
        const topElev = t - Number(topArr[i]);
        let   botElev = t - Number(botArr[i]);
        if (!isFinite(topElev)) continue;
        if (!isFinite(botElev)) botElev = topElev - 100;

        soundingIdxs.push(i);
        topVals.push(topElev);
        botVals.push(botElev);
        colVals.push(res);
        if (res < resMin) resMin = res;
        if (res > resMax) resMax = res;
      }
    }

    if (soundingIdxs.length === 0) return null;
    return { nS, soundingIdxs, topVals, botVals, colVals, resMin, resMax };
  }

  _commonSchemaProperties(data) {
    return {
      dataset:     { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-model-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      topo_column: { type: 'string', default: 'topo' },
      cmin:        { type: 'number', default: 1    },
      cmax:        { type: 'number', default: 1000 },
      yAxis:       { type: 'string', enum: Y_AXES, default: 'yaxis_left' },
      showCurrentSounding: showCurrentSoundingSchema,
    };
  }
}

// ─── ResistivityCurtain2D ─────────────────────────────────────────────────────

class ResistivityCurtain2D extends ResistivityCurtainBase {
  constructor() {
    super({
      name: 'ResistivityCurtain',
      vert: `#version 300 es
        precision highp float;
        in float cx, cy;
        in float x, xPrev, xNext, top, bot;
        in float resistivity;
        in float isMarker;
        out float vVal;
        out float vMarker;
        void main() {
          vMarker = isMarker;
          if (isMarker > 0.5) {
            // Current-sounding marker: a thin vertical bar at x spanning the curtain's elevation
            // extent (top..bot). Positioned with the SAME plot_pos as the cells so it lands
            // exactly on the clicked sounding's column; width is a small clip-space offset.
            vVal = 1.0;
            vec4 p = plot_pos(vec2(x, cy > 0.5 ? top : bot));
            gl_Position = vec4(p.x + (cx - 0.5) * 2.0 * ${MARKER_HALF_WIDTH.toFixed(5)} * p.w, p.y, p.z, p.w);
            return;
          }
          vVal = resistivity;
          if (!color_filter_resistivity(resistivity)) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          float hl = (x - xPrev) / 2.0;
          float hr = (xNext - x) / 2.0;
          float xPos = cx > 0.5 ? x + hr : x - hl;
          float yPos = cy > 0.5 ? top : bot;
          gl_Position = plot_pos(vec2(xPos, yPos));
        }
      `,
    });
  }

  _buildAxisConfig(parameters) {
    return {
      xAxis: parameters.xAxis ?? 'xaxis_bottom',
      xAxisQuantityKind: 'xdist_m',
      yAxis: parameters.yAxis ?? 'yaxis_left',
    };
  }

  _buildSchema(data) {
    return {
      type: 'object',
      properties: {
        ...this._commonSchemaProperties(data),
        xAxis: { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      },
      required: ['dataset'],
    };
  }

  _buildLayer(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    const xdistRaw = flightlines.xdist;
    if (!xdistRaw || xdistRaw.length === 0) return [];

    const cells = this._extractCells(flightlines, layer_data, parameters);
    if (!cells) return [];

    const { nS, soundingIdxs, topVals, botVals, colVals, resMin, resMax } = cells;
    const n = soundingIdxs.length;

    const xdist = toFloat32Array(xdistRaw);
    const boundaries = this._buildFlightlineBoundaries(flightlines, nS);
    const { prev: xPrevFull, next: xNextFull } = this._buildNeighborArr(xdist, nS, boundaries);

    const x   = new Float32Array(soundingIdxs.map(i => xdist[i]));
    const xP  = new Float32Array(soundingIdxs.map(i => xPrevFull[i]));
    const xN  = new Float32Array(soundingIdxs.map(i => xNextFull[i]));
    const top = new Float32Array(topVals);
    const bot = new Float32Array(botVals);
    const col = new Float32Array(colVals);
    const isMarker = new Float32Array(n);                 // 0 for every cell

    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (isFinite(x[i]))   { xMin = Math.min(xMin, x[i]);   xMax = Math.max(xMax, x[i]);   }
      if (isFinite(top[i])) { yMin = Math.min(yMin, top[i]); yMax = Math.max(yMax, top[i]); }
      if (isFinite(bot[i])) { yMin = Math.min(yMin, bot[i]); yMax = Math.max(yMax, bot[i]); }
    }

    const attributes = { cx: QUAD_CX, cy: QUAD_CY, x, xPrev: xP, xNext: xN, top, bot, resistivity: col, isMarker };
    let instanceCount = n;
    const cs = markerSounding(parameters, rawData, xdistRaw);
    if (cs !== null) {
      instanceCount = appendMarkerInstance(attributes, instanceCount,
        { x: Number(xdistRaw[cs]), xPrev: 0, xNext: 0, top: yMax, bot: yMin, resistivity: 1, isMarker: 1 });
    }

    return [{
      attributes,
      attributeDivisors: { x: 1, xPrev: 1, xNext: 1, top: 1, bot: 1, resistivity: 1, isMarker: 1 },
      uniforms: {},
      domains: { xdist_m: [xMin, xMax], elevation_m: [yMin, yMax], resistivity: [resMin, resMax] },
      primitive: 'triangles',
      vertexCount: 6,
      instanceCount,
    }];
  }
}

// ─── ResistivityCurtain3D ─────────────────────────────────────────────────────

const GEO_X_COLS = {
  'EPSG:4326': ['lon', 'Lon', 'LON', 'Long'],
  'EPSG:3857': ['x_web'],
  projected:   ['UTMX', 'UTMx', 'utmx', 'X', 'x', 'Easting', 'easting'],
};
const GEO_Z_COLS = {
  'EPSG:4326': ['lat', 'Lat', 'LAT'],
  'EPSG:3857': ['y_web'],
  projected:   ['UTMY', 'UTMy', 'utmy', 'Y', 'y', 'Northing', 'northing'],
};

class ResistivityCurtain3D extends ResistivityCurtainBase {
  constructor() {
    super({
      name: 'ResistivityCurtain3D',
      frag: FRAG_3D,
      vert: `#version 300 es
        precision highp float;
        in float cx, cy;
        in float gx, gz, gxPrev, gzPrev, gxNext, gzNext;
        in float top, bot;
        in float resistivity;
        in float isMarker;
        in float isOutline;
        out float vVal;
        out float vMarker;
        out float vOutline;
        void main() {
          vMarker = isMarker;
          vOutline = isOutline;
          if (isOutline > 0.5) {
            // Black outline ribbon along a top/bottom edge segment: endpoint A=(gx,top,gz),
            // B=(gxNext,bot,gzNext). cx picks the endpoint; cy offsets perpendicular to the
            // segment's screen direction by a fixed NDC half-width, giving a ~1px line.
            vVal = 0.0;
            vec4 pa = plot_pos_3d(vec3(gx, top, gz));
            vec4 pb = plot_pos_3d(vec3(gxNext, bot, gzNext));
            vec2 na = pa.xy / pa.w;
            vec2 nb = pb.xy / pb.w;
            vec2 diff = nb - na;
            vec2 dir = length(diff) > 1e-6 ? normalize(diff) : vec2(1.0, 0.0);
            vec2 perp = vec2(-dir.y, dir.x) * ${OUTLINE_HALF_WIDTH.toFixed(5)};
            vec4 p = cx > 0.5 ? pb : pa;
            vec2 nn = (cx > 0.5 ? nb : na) + (cy > 0.5 ? perp : -perp);
            gl_Position = vec4(nn * p.w, p.z, p.w);
            return;
          }
          if (isMarker > 0.5) {
            // Current-sounding marker: a thin vertical ribbon at the sounding's geo position
            // (gx, gz), spanning the curtain's elevation extent (top..bot).
            vVal = 1.0;
            vec4 p = plot_pos_3d(vec3(gx, cy > 0.5 ? top : bot, gz));
            gl_Position = vec4(p.x + (cx - 0.5) * 2.0 * ${MARKER_HALF_WIDTH.toFixed(5)} * p.w, p.y, p.z, p.w);
            return;
          }
          vVal = resistivity;
          if (!color_filter_resistivity(resistivity)) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          float hl_x = (gx - gxPrev) / 2.0;
          float hl_z = (gz - gzPrev) / 2.0;
          float hr_x = (gxNext - gx) / 2.0;
          float hr_z = (gzNext - gz) / 2.0;
          float xPos = cx > 0.5 ? gx + hr_x : gx - hl_x;
          float zPos = cx > 0.5 ? gz + hr_z : gz - hl_z;
          float yPos = cy > 0.5 ? top : bot;
          gl_Position = plot_pos_3d(vec3(xPos, yPos, zPos));
        }
      `,
    });
  }

  // On geo axes a click has no xdist coordinate, so resolve the sounding straight from the GPU
  // pick: each cell carries its own flightlines row in soundingId, so the picked instance maps
  // directly to its sounding (the index can't be decoded arithmetically — invalid cells are
  // skipped when the instances are built).
  pickInfo(regl, parameters, data, plot, layer, primitive) {
    return { dataIndex: soundingFromPickId(layer, primitive) };
  }
  onClick(result, parameters, plot) { return selectSoundingOnClick(result, parameters, plot); }

  _resolveGeo(flightlines, crs, dataset) {
    const xCols = GEO_X_COLS[crs] ?? GEO_X_COLS.projected;
    const zCols = GEO_Z_COLS[crs] ?? GEO_Z_COLS.projected;
    const xCol  = xCols.find(c => flightlines[c] !== undefined);
    const zCol  = zCols.find(c => flightlines[c] !== undefined);
    const resolvedCrs = crs === 'projected' ? (dataset?._detectedCrs ?? null) : crs;
    return { xCol, zCol, resolvedCrs };
  }

  _buildAxisConfig(parameters, data) {
    const crs = parameters.crs ?? 'projected';
    let xAxisQk, zAxisQk;

    if (crs !== 'projected') {
      xAxisQk = crsToQkX(crs);
      zAxisQk = crsToQkY(crs);
    } else {
      const dsPath = parameters.dataset ?? '';
      for (const col of GEO_X_COLS.projected) {
        const qk = data?.getQuantityKind?.(`${dsPath}.${col}`);
        if (qk) { xAxisQk = qk; break; }
      }
      for (const col of GEO_Z_COLS.projected) {
        const qk = data?.getQuantityKind?.(`${dsPath}.${col}`);
        if (qk) { zAxisQk = qk; break; }
      }
    }

    return {
      xAxis: parameters.xAxis ?? 'xaxis_bottom',
      xAxisQuantityKind: xAxisQk,
      yAxis: parameters.yAxis ?? 'yaxis_left',
      zAxis: parameters.zAxis ?? 'zaxis_bottom_left',
      zAxisQuantityKind: zAxisQk,
    };
  }

  _buildSchema(data) {
    return {
      type: 'object',
      properties: {
        ...this._commonSchemaProperties(data),
        crs:   { type: 'string', enum: ['projected', 'EPSG:4326', 'EPSG:3857'], default: 'projected' },
        xAxis: { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
        zAxis: { type: 'string', enum: Z_AXES, default: 'zaxis_bottom_left' },
      },
      required: ['dataset'],
    };
  }

  _buildLayer(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    if (!flightlines.xdist || flightlines.xdist.length === 0) return [];

    const crs = parameters.crs ?? 'projected';
    const { xCol, zCol } = this._resolveGeo(flightlines, crs, dataset);
    if (!xCol || !zCol) return [];

    let xAxisQk, zAxisQk;
    if (crs !== 'projected') {
      xAxisQk = crsToQkX(crs);
      zAxisQk = crsToQkY(crs);
    } else {
      const dsPath = parameters.dataset ?? '';
      xAxisQk = data?.getQuantityKind?.(`${dsPath}.${xCol}`);
      zAxisQk = data?.getQuantityKind?.(`${dsPath}.${zCol}`);
    }
    if (!xAxisQk || !zAxisQk) return [];

    const cells = this._extractCells(flightlines, layer_data, parameters);
    if (!cells) return [];

    const { nS, soundingIdxs, topVals, botVals, colVals, resMin, resMax } = cells;
    const n = soundingIdxs.length;

    const gxFull = toFloat32Array(flightlines[xCol]);
    const gzFull = toFloat32Array(flightlines[zCol]);
    const boundaries = this._buildFlightlineBoundaries(flightlines, nS);
    const { prev: gxPrevFull, next: gxNextFull } = this._buildNeighborArr(gxFull, nS, boundaries);
    const { prev: gzPrevFull, next: gzNextFull } = this._buildNeighborArr(gzFull, nS, boundaries);

    const gx  = new Float32Array(soundingIdxs.map(i => gxFull[i]));
    const gz  = new Float32Array(soundingIdxs.map(i => gzFull[i]));
    const gxP = new Float32Array(soundingIdxs.map(i => gxPrevFull[i]));
    const gzP = new Float32Array(soundingIdxs.map(i => gzPrevFull[i]));
    const gxN = new Float32Array(soundingIdxs.map(i => gxNextFull[i]));
    const gzN = new Float32Array(soundingIdxs.map(i => gzNextFull[i]));
    const top = new Float32Array(topVals);
    const bot = new Float32Array(botVals);
    const col = new Float32Array(colVals);

    let gxMin = Infinity, gxMax = -Infinity;
    let gzMin = Infinity, gzMax = -Infinity;
    let yMin  = Infinity, yMax  = -Infinity;
    for (let i = 0; i < n; i++) {
      if (isFinite(gx[i]))  { gxMin = Math.min(gxMin, gx[i]);  gxMax = Math.max(gxMax, gx[i]);  }
      if (isFinite(gz[i]))  { gzMin = Math.min(gzMin, gz[i]);  gzMax = Math.max(gzMax, gz[i]);  }
      if (isFinite(top[i])) { yMin  = Math.min(yMin,  top[i]); yMax  = Math.max(yMax,  top[i]); }
      if (isFinite(bot[i])) { yMin  = Math.min(yMin,  bot[i]); yMax  = Math.max(yMax,  bot[i]); }
    }

    const attributes = {
      cx: QUAD_CX, cy: QUAD_CY,
      gx, gz, gxPrev: gxP, gzPrev: gzP, gxNext: gxN, gzNext: gzN,
      top, bot, resistivity: col, isMarker: new Float32Array(n), isOutline: new Float32Array(n),
      soundingId: new Float32Array(soundingIdxs),   // flightlines row each cell belongs to
    };
    let instanceCount = n;

    // Black top/bottom edge outline (extra instances in this same draw, so the build/epoch race
    // can't drop it the way it drops a trailing layer — see soundingLineMarker.js).
    const outline = this._buildOutlineInstances(cells, gxFull, gzFull, boundaries);
    if (outline) {
      for (const k of CURTAIN3D_INSTANCED) attributes[k] = concatF32(attributes[k], outline[k]);
      instanceCount += outline.count;
    }

    const cs = markerSounding(parameters, rawData, flightlines.xdist);
    if (cs !== null && Number.isFinite(gxFull[cs]) && Number.isFinite(gzFull[cs])) {
      instanceCount = appendMarkerInstance(attributes, instanceCount, {
        gx: gxFull[cs], gz: gzFull[cs],
        gxPrev: gxFull[cs], gzPrev: gzFull[cs], gxNext: gxFull[cs], gzNext: gzFull[cs],
        top: yMax, bot: yMin, resistivity: 1, isMarker: 1, isOutline: 0, soundingId: cs,
      });
    }

    return [{
      attributes,
      attributeDivisors: {
        gx: 1, gz: 1, gxPrev: 1, gzPrev: 1, gxNext: 1, gzNext: 1,
        top: 1, bot: 1, resistivity: 1, isMarker: 1, isOutline: 1, soundingId: 1,
      },
      uniforms: {},
      domains: {
        [xAxisQk]:  [gxMin, gxMax],
        elevation_m: [yMin, yMax],
        [zAxisQk]:  [gzMin, gzMax],
        resistivity: [resMin, resMax],
      },
      primitive: 'triangles',
      vertexCount: 6,
      instanceCount,
    }];
  }

  // One outline instance per top/bottom edge segment between adjacent soundings in a flightline.
  // The top edge is the highest cell top; the bottom edge the lowest cell bottom, per sounding.
  // Segments are not drawn across flightline boundaries. Returns per-instance attribute arrays
  // (keyed like CURTAIN3D_INSTANCED) plus count, or null when there is nothing to outline.
  _buildOutlineInstances(cells, gxFull, gzFull, boundaries) {
    const { nS, soundingIdxs, topVals, botVals } = cells;
    const topEdge = new Float32Array(nS).fill(NaN);
    const botEdge = new Float32Array(nS).fill(NaN);
    for (let k = 0; k < soundingIdxs.length; k++) {
      const i = soundingIdxs[k];
      if (Number.isNaN(topEdge[i]) || topVals[k] > topEdge[i]) topEdge[i] = topVals[k];
      if (Number.isNaN(botEdge[i]) || botVals[k] < botEdge[i]) botEdge[i] = botVals[k];
    }

    const gx = [], gz = [], gxNext = [], gzNext = [], top = [], bot = [], sid = [];
    const addSeg = (i, j, edge) => {
      if (!Number.isFinite(edge[i]) || !Number.isFinite(edge[j])) return;
      if (!Number.isFinite(gxFull[i]) || !Number.isFinite(gxFull[j])) return;
      gx.push(gxFull[i]); gz.push(gzFull[i]);
      gxNext.push(gxFull[j]); gzNext.push(gzFull[j]);
      top.push(edge[i]); bot.push(edge[j]); sid.push(i);
    };
    for (let i = 0; i < nS - 1; i++) {
      if (boundaries[i + 1]) continue;   // don't bridge separate flightlines
      addSeg(i, i + 1, topEdge);
      addSeg(i, i + 1, botEdge);
    }

    const count = gx.length;
    if (count === 0) return null;
    const f = a => new Float32Array(a);
    return {
      count,
      gx: f(gx), gz: f(gz),
      gxPrev: f(gx), gzPrev: f(gz),   // unused by the outline branch; mirror gx/gz
      gxNext: f(gxNext), gzNext: f(gzNext),
      top: f(top), bot: f(bot),
      resistivity: new Float32Array(count),           // 0; outline branch skips the color filter
      isMarker: new Float32Array(count),              // 0
      isOutline: new Float32Array(count).fill(1),
      soundingId: f(sid),
    };
  }
}

// ─── Register curtain layer types ─────────────────────────────────────────────

registerLayerType('ResistivityCurtain',   new ResistivityCurtain2D());
registerLayerType('ResistivityCurtain3D', new ResistivityCurtain3D());

// ─── ResistivityCurtainLines ─ topo surface + sounding marker ────────────────
registerLayerType('ResistivityCurtainLines', new LayerType({
  name: 'ResistivityCurtainLines',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'xdist_m',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'elevation_m',
  }),

  vert: `#version 300 es
    precision highp float;
    in float x, y, r, g, b;
    out vec3 vColor;
    void main() {
      gl_Position = plot_pos(vec2(x, y));
      vColor = vec3(r, g, b);
    }
  `,

  frag: `#version 300 es
    precision highp float;
    in vec3 vColor;
    void main() { fragColor = gladly_apply_color(vec4(vColor, 1.0)); }
  `,

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset:     { type: 'string', 'x-format': 'datasetPath', 'x-target-mediatypes': [['application/x-aarhusxyz-model-msgpack'], ['application/x-aarhusxyz-msgpack']] },
      topo_column: { type: 'string', default: 'topo' },
      xAxis:       { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis:       { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
    },
    required: ['dataset'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData         = plot?._rawData ?? data;
    const currentSounding = soundingIndex(rawData, parameters.dataset);

    const dataset     = resolveDataPath(rawData, parameters.dataset);
    const flightlines = dataset?.flightlines;
    const layer_data  = dataset?.layer_data;
    if (!flightlines || !layer_data) return [];

    const xdistRaw = flightlines.xdist;
    if (!xdistRaw || xdistRaw.length === 0) return [];

    const nS    = xdistRaw.length;
    const xdist = toFloat32Array(xdistRaw);
    const results = [];

    // Topography line (black)
    const topoCol = [parameters.topo_column, 'Topography', 'topo', 'elevation']
      .find(col => col && flightlines[col] !== undefined);
    if (topoCol) {
      const topoY  = toFloat32Array(flightlines[topoCol]);
      const { r, g, b } = fillColorArrays(nS, [0, 0, 0]);
      results.push({ attributes: { x: xdist, y: topoY, r, g, b }, uniforms: {}, primitive: 'line strip' });
    }

    // Sounding marker (red vertical line)
    const cs = currentSounding;
    if (cs !== undefined && cs !== null && cs >= 0 && cs < nS) {
      const dep_top = layer_data.dep_top;
      const dep_bot = layer_data.dep_bot;
      const topo    = topoCol ? flightlines[topoCol] : null;

      let yMin = Infinity, yMax = -Infinity;
      if (dep_top && dep_bot) {
        for (const j of getKeys(dep_top)) {
          const topArr = getFrom(dep_top, j);
          const botArr = getFrom(dep_bot, j);
          if (!topArr || !botArr) continue;
          for (let i = 0; i < nS; i++) {
            const t   = topo ? Number(topo[i]) : 0;
            const top = t - Number(topArr[i]);
            const bot = t - Number(botArr[i]);
            if (isFinite(top)) { yMin = Math.min(yMin, top); yMax = Math.max(yMax, top); }
            if (isFinite(bot)) { yMin = Math.min(yMin, bot); yMax = Math.max(yMax, bot); }
          }
        }
      }
      if (!isFinite(yMin)) yMin = 0;
      if (!isFinite(yMax)) yMax = 100;

      const xPos = xdist[cs];
      const { r, g, b } = fillColorArrays(2, [1, 0, 0]);
      results.push({
        attributes: { x: new Float32Array([xPos, xPos]), y: new Float32Array([yMin, yMax]), r, g, b },
        uniforms:   {},
        primitive:  'line strip',
      });
    }

    return results;
  },

  // Topography / marker line strips drawn on xdist: resolve the sounding from the hit
  // vertex's own x (xdist) attribute — the nearest flightlines row.
  pickInfo(regl, parameters, data, plot, layer, primitive) {
    return { dataIndex: soundingFromPickX(parameters, plot, layer, primitive) };
  },
  onClick: selectSoundingOnClick,
}));

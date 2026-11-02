import { LayerType, registerLayerType, AXIS_GEOMETRY, crsToQkX, crsToQkY } from 'gladly-plot';
import { fillColorArrays, toFloat32Array, resolveDataPath, getFrom, getKeys } from '../colorUtils.js';
import { soundingIndex } from '../soundingMatch.js';

const X_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'x');
const Y_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'y');
const Z_AXES = Object.keys(AXIS_GEOMETRY).filter(a => AXIS_GEOMETRY[a].dir === 'z');

// Per-vertex unit-quad corners for instanced rect rendering (two CCW triangles)
const QUAD_CX = new Float32Array([0, 1, 1, 0, 1, 0]);
const QUAD_CY = new Float32Array([0, 0, 1, 0, 1, 1]);

const SHARED_FRAG = `#version 300 es
  precision mediump float;
  in float vVal;
  void main() {
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
      dataset:     { type: 'string', 'x-format': 'datasetPath' },
      topo_column: { type: 'string', default: 'topo' },
      cmin:        { type: 'number', default: 1    },
      cmax:        { type: 'number', default: 1000 },
      yAxis:       { type: 'string', enum: Y_AXES, default: 'yaxis_left' },
    };
  }
}

// ─── ResistivityCurtain2D ─────────────────────────────────────────────────────

class ResistivityCurtain2D extends ResistivityCurtainBase {
  constructor() {
    super({
      name: 'ResistivityCurtain',
      vert: `#version 300 es
        precision mediump float;
        in float cx, cy;
        in float x, xPrev, xNext, top, bot;
        in float resistivity;
        out float vVal;
        void main() {
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

    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (isFinite(x[i]))   { xMin = Math.min(xMin, x[i]);   xMax = Math.max(xMax, x[i]);   }
      if (isFinite(top[i])) { yMin = Math.min(yMin, top[i]); yMax = Math.max(yMax, top[i]); }
      if (isFinite(bot[i])) { yMin = Math.min(yMin, bot[i]); yMax = Math.max(yMax, bot[i]); }
    }

    return [{
      attributes: { cx: QUAD_CX, cy: QUAD_CY, x, xPrev: xP, xNext: xN, top, bot, resistivity: col },
      attributeDivisors: { x: 1, xPrev: 1, xNext: 1, top: 1, bot: 1, resistivity: 1 },
      uniforms: {},
      domains: { xdist_m: [xMin, xMax], elevation_m: [yMin, yMax], resistivity: [resMin, resMax] },
      primitive: 'triangles',
      vertexCount: 6,
      instanceCount: n,
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
      vert: `#version 300 es
        precision mediump float;
        in float cx, cy;
        in float gx, gz, gxPrev, gzPrev, gxNext, gzNext;
        in float top, bot;
        in float resistivity;
        out float vVal;
        void main() {
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

    return [{
      attributes: {
        cx: QUAD_CX, cy: QUAD_CY,
        gx, gz, gxPrev: gxP, gzPrev: gzP, gxNext: gxN, gzNext: gzN,
        top, bot, resistivity: col,
      },
      attributeDivisors: {
        gx: 1, gz: 1, gxPrev: 1, gzPrev: 1, gxNext: 1, gzNext: 1,
        top: 1, bot: 1, resistivity: 1,
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
      instanceCount: n,
    }];
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
      dataset:     { type: 'string', 'x-format': 'datasetPath' },
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
}));

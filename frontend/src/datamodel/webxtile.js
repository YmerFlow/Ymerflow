import { WebxtileLoader } from 'webxtile';
import { ArrayColumn } from 'gladly-plot';
import { Dataset, acquireFetchSlot, releaseFetchSlot } from './dataset';
import { cacheNamespace } from './cacheNamespace';
import { parseCrsCode, crsToQkX, crsToQkY, registerAxisQuantityKind } from 'gladly-plot';

const _CF_TO_QK = {
  electrical_resistivity: 'resistivity',
  depth_of_investigation:  'doi_m',
};
const _UNITS_TO_QK = { 'ohm m': 'resistivity' };
const _COL_TO_QK   = {
  resistivity:  'resistivity',
  rho:          'resistivity',
  rho_i:        'resistivity',
  doi_layer:    'doi_m',
  conductivity: 'conductivity_sm',
  z_top:        'elevation_m',
  z_bottom:     'elevation_m',
};

function _cfAttrsToQuantityKind(attrs) {
  const sn = attrs?.standard_name ?? '';
  if (_CF_TO_QK[sn]) return _CF_TO_QK[sn];
  const units = attrs?.units ?? '';
  if (_UNITS_TO_QK[units]) return _UNITS_TO_QK[units];
  if ((sn === 'altitude' || sn === 'height') && units === 'm') return 'elevation_m';
  if (sn === 'depth' && units === 'm') return 'depth_m';
  return null;
}

// How much the viewport bbox must change before triggering a new tile-load phase.
const BBOX_CHANGE_THRESHOLD = 0.02;

// ── WebxtileColumn ─────────────────────────────────────────────────────────────
// Wraps a column from the parent dataset's sub-tile array.
// refresh(plot) is called each frame by gladly so we can detect viewport changes.
class WebxtileColumn extends ArrayColumn {
  constructor(dataset, colName) {
    super(new Float32Array([0]), { domain: null, quantityKind: null });
    this._dataset     = dataset;
    this._colName     = colName;
    this._lastVersion = -1;
  }

  // Total meshgrid point count across all sub-tiles.
  get length() {
    if (!this._dataset._subTiles?.length) return 0;
    return this._dataset._subTiles.reduce(
      (sum, st) => sum + st.shape.reduce((a, b) => a * b, 1), 0
    );
  }

  get domain()          { return this._dataset.getDomain(this._colName) ?? null; }
  get quantityKind()    { return this._dataset.getQuantityKind(this._colName) ?? null; }
  get spatialDimIndex() { return this._dataset.spatialDimIndex(this._colName); }

  // Merged array across all sub-tiles (legacy / backward-compat path).
  get array() { return this._dataset._getRawArray(this._colName) ?? new Float32Array([0]); }

  get shape() { return [Math.max(this.length, 1)]; }

  // Per-sub-tile typed arrays: 1D coord arrays for spatial columns,
  // flat variable arrays for data variables.
  get subTileArrays() {
    return this._dataset._getSubTileArrays(this._colName);
  }

  _upload(regl) {
    if (this._ref) return this._ref;
    const subArrays = this._dataset._getSubTileArrays(this._colName);
    const textures = subArrays.map(arr => {
      const n       = Math.max(arr.length, 1);
      const nTexels = Math.ceil(n / 4);
      const w       = Math.min(nTexels, regl.limits.maxTextureSize);
      const h       = Math.ceil(nTexels / w);
      const texData = new Float32Array(w * h * 4);
      texData.set(arr);
      const tex = regl.texture({ data: texData, shape: [w, h], type: 'float', format: 'rgba' });
      tex._dataLength = arr.length;
      return tex;
    });
    if (!textures.length) {
      const tex = regl.texture({ data: new Float32Array(4), shape: [1, 1], type: 'float', format: 'rgba' });
      tex._dataLength = 0;
      textures.push(tex);
    }
    this._ref = { textures };
    return this._ref;
  }

  async refresh(plot) {
    this._dataset._plot = plot;
    this._dataset._onRefresh(plot);

    if (this._dataset._dataVersion !== this._lastVersion) {
      this._lastVersion = this._dataset._dataVersion;
      for (const t of this._ref?.textures ?? []) {
        try { t.destroy(); } catch (_) {}
      }
      this._ref = null;
      return true;
    }
    return false;
  }
}

// ── WebxtileDataset ────────────────────────────────────────────────────────────
export class WebxtileDataset extends Dataset {
  constructor(metadata) {
    super(metadata);
    this._subTiles       = null;   // array of sub-tile objects from subTiles()
    this._spatialDims    = null;
    this._crs            = null;
    this._zCrs           = null;
    this._varMeta        = null;
    this._rootBounds     = null;   // bounds of root tile, for LOD computation
    this._domainCache    = null;
    this._loader         = null;
    this._leafAbort      = null;
    this._colCache       = {};
    this._dataVersion    = 0;
    this._loadGeneration = 0;
    this._loadStarted    = false;
    this._initialLoadPromise = null;
    this._currentBBox    = null;
    this._lastRefreshMs  = 0;
    this._plot           = null;
  }

  // ── Public Data interface ────────────────────────────────────────────────────

  columns() {
    if (!this._subTiles?.length) return [];
    const first = this._subTiles[0];
    return [
      ...Object.keys(first.spatial_coords ?? {}),
      ...Object.keys(first.variables ?? {}),
    ];
  }

  getData(col) {
    if (!this._colCache[col]) {
      this._colCache[col] = new WebxtileColumn(this, col);
    }
    return this._colCache[col];
  }

  spatialDimIndex(col) {
    if (!this._spatialDims) return null;
    const idx = this._spatialDims.indexOf(col);
    return idx >= 0 ? idx : null;
  }

  getQuantityKind(col) {
    if (!this._spatialDims) return col;
    const [dim0, dim1, dim2] = this._spatialDims;
    if (this._crs) {
      const code = parseCrsCode(this._crs);
      if (code != null) {
        if (col === dim0) return crsToQkX(code);
        if (col === dim1) return crsToQkY(code);
      }
    }
    if (col === dim2) return 'elevation_m';
    return _cfAttrsToQuantityKind(this._varMeta?.[col]?.attrs) ?? _COL_TO_QK[col] ?? col;
  }

  getDomain(col) {
    if (!this._subTiles?.length) return undefined;
    if (!this._domainCache) this._domainCache = {};
    if (col in this._domainCache) return this._domainCache[col];
    let min = Infinity, max = -Infinity;
    for (const st of this._subTiles) {
      const arr = st.spatial_coords?.[col] ?? st.variables?.[col];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
    }
    this._domainCache[col] = Number.isFinite(min) ? [min, max] : undefined;
    return this._domainCache[col];
  }

  // Concatenation of per-sub-tile arrays for a column (1D for coords, flat for vars).
  // Used by WebxtileColumn.array and _upload for backward-compat / texture path.
  _getRawArray(col) {
    if (!this._subTiles?.length) return undefined;
    const parts = this._subTiles
      .map(st => st.spatial_coords?.[col] ?? st.variables?.[col])
      .filter(Boolean);
    if (!parts.length) return undefined;
    const total  = parts.reduce((s, a) => s + a.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const a of parts) { merged.set(a, offset); offset += a.length; }
    return merged;
  }

  // Per-sub-tile typed arrays (not merged). Used by WebxtileColumn.subTileArrays
  // and GridLayer for meshgrid expansion.
  _getSubTileArrays(col) {
    if (!this._subTiles?.length) return [];
    return this._subTiles
      .map(st => st.spatial_coords?.[col] ?? st.variables?.[col])
      .filter(Boolean);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  cancel() {
    this._loadGeneration++;
    this._loadStarted = false;
    this._initialLoadPromise = null;
    this._leafAbort?.abort();
    this._leafAbort = null;
  }

  async fetchData(partPath = "all") {
    if (!this._loadStarted) {
      this._loadStarted = true;
      this._initialLoadPromise = this._startLoading();
    }
    if (!this._subTiles?.length) {
      await this._initialLoadPromise;
    }
    return this;
  }

  async _startLoading() {
    try {
      const partMetadata = this._getPartMetadata('all');
      const url = partMetadata?.files?.[this.mimeType];
      if (!url) throw new Error('No webxtile URL found in dataset metadata');
      this._loader = new WebxtileLoader(url, {
        dbName:  `webxtile-${cacheNamespace()}-${this.id}`,
        acquire: acquireFetchSlot,
        release: releaseFetchSlot,
      });
      await this._loader.open();
    } catch (err) {
      console.error('WebxtileDataset: failed to open loader', err);
      return;
    }

    // Load root tile for a coarse overview and to record root bounds for LOD.
    const gen = ++this._loadGeneration;
    await this._loadAndUpdate(null, 0, gen);

    // Load detail for whatever viewport is already known.
    this._loadForBBox(this._currentBBox, gen);

    // Stream all leaf tiles into IDB in the background so future loadBBox
    // calls are served from cache rather than the network.
    this._startBackgroundStream();
  }

  // ── Viewport-change detection ────────────────────────────────────────────────

  _onRefresh(plot) {
    const now = performance.now();
    if (now - this._lastRefreshMs < 100) return;
    this._lastRefreshMs = now;

    if (!this._spatialDims || this._spatialDims.length < 2) return;

    const xQK = this.getQuantityKind(this._spatialDims[0]);
    const yQK = this.getQuantityKind(this._spatialDims[1]);
    const xDomain = plot.getAxisDomain(xQK);
    const yDomain = plot.getAxisDomain(yQK);
    if (!xDomain || !yDomain) return;

    const newBBox = [xDomain[0], yDomain[0], xDomain[1], yDomain[1]];
    if (this._bboxSimilar(newBBox, this._currentBBox)) return;

    this._currentBBox = newBBox;

    const gen = ++this._loadGeneration;
    this._loadForBBox(newBBox, gen);
  }

  _bboxSimilar(a, b) {
    if (!a || !b) return !a && !b;
    const dx = Math.abs(a[2] - a[0]);
    const dy = Math.abs(a[3] - a[1]);
    if (dx === 0 || dy === 0) return false;
    return (
      Math.abs(a[0] - b[0]) / dx < BBOX_CHANGE_THRESHOLD &&
      Math.abs(a[2] - b[2]) / dx < BBOX_CHANGE_THRESHOLD &&
      Math.abs(a[1] - b[1]) / dy < BBOX_CHANGE_THRESHOLD &&
      Math.abs(a[3] - b[3]) / dy < BBOX_CHANGE_THRESHOLD
    );
  }

  // ── Background leaf streaming ─────────────────────────────────────────────────

  async _startBackgroundStream() {
    if (!this._loader) return;
    this._leafAbort?.abort();
    this._leafAbort = new AbortController();
    const { signal } = this._leafAbort;
    try {
      for await (const _ of this._loader.streamLeaves({ signal }));
    } catch (err) {
      if (!signal.aborted) console.error('WebxtileDataset: background stream failed', err);
    }
  }

  // ── Tile loading ─────────────────────────────────────────────────────────────

  async _loadForBBox(bbox, generation) {
    if (!this._loader || !bbox) return;
    await this._loadAndUpdate(bbox, this._computeTargetLevel(), generation);
  }

  async _loadAndUpdate(bbox, level, generation) {
    if (!this._loader) return;
    try {
      const result = await this._loader.loadBBox(bbox, level);
      if (this._loadGeneration !== generation) return;

      this._crs         = result.crs;
      this._zCrs        = result.zCrs;
      this._spatialDims = result.spatialDims;
      this._varMeta     = result.varMeta;
      if (!this._rootBounds && result.tiles.length > 0) {
        this._rootBounds = result.tiles[0].bounds;
      }

      if (this._crs) {
        const code = parseCrsCode(this._crs);
        if (code != null) {
          registerAxisQuantityKind(`epsg_${code}_x`, { label: `EPSG:${code} X`, scale: 'linear' });
          registerAxisQuantityKind(`epsg_${code}_y`, { label: `EPSG:${code} Y`, scale: 'linear' });
        }
      }

      this._subTiles    = [...result.subTiles()];
      this._domainCache = {};
      this._dataVersion++;
      this._plot?.scheduleRender();
    } catch (err) {
      console.error('WebxtileDataset: tile load failed', bbox, level, err);
    }
  }

  // ── LOD ───────────────────────────────────────────────────────────────────────

  _computeTargetLevel() {
    if (!this._currentBBox || !this._rootBounds) return 0;
    const b     = this._rootBounds; // [x0, y0, z0, x1, y1, z1]
    const rootW = Math.abs(b[3] - b[0]);
    const rootH = Math.abs(b[4] - b[1]);
    if (rootW === 0 || rootH === 0) return 0;
    const [vx0, vy0, vx1, vy1] = this._currentBBox;
    const fraction = Math.min(
      Math.abs(vx1 - vx0) / rootW,
      Math.abs(vy1 - vy0) / rootH,
    );
    if (fraction <= 0) return 10;
    return Math.min(10, Math.ceil(Math.log2(1 / fraction)));
  }
}

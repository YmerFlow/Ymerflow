import axios from 'axios';
import { XYZ } from './libaarhusxyz';
import { MagData } from './magdata';
import { getDataset } from './api';
import { Data, DataGroup, registerAxisQuantityKind, parseCrsCode, crsToQkX, crsToQkY } from 'gladly-plot';
// NOTE: WebxtileDataset is intentionally NOT imported here. webxtile.js imports Dataset from this
// module (subclass → base), so a static import back the other way creates a circular dependency
// that scrambles class-evaluation order under the bundler ("Class extends undefined"). Non-core
// dataset types are resolved lazily through the plugin registry instead (see createDatasetInstance).
import { getDatasetClass } from './datasetRegistry';

// ── Shared fetch semaphore ────────────────────────────────────────────────────
// All dataset types (XYZ, Mag, JSON, webxtile, …) share this pool so the total
// number of concurrent network requests stays within browser limits.
const MAX_CONCURRENT_FETCHES = 16;
let _concurrentFetches = 0;
const _fetchWaiters = [];

export function acquireFetchSlot() {
  return new Promise(resolve => {
    if (_concurrentFetches < MAX_CONCURRENT_FETCHES) {
      _concurrentFetches++;
      resolve();
    } else {
      _fetchWaiters.push(resolve);
    }
  });
}

export function releaseFetchSlot() {
  if (_fetchWaiters.length > 0) {
    _fetchWaiters.shift()();
  } else {
    _concurrentFetches--;
  }
}

const DB_NAME = "YmerFlowCache";
const DB_VERSION = 1;

// ── Quantity kind registrations ──────────────────────────────────────────────
// Physical/scalar quantity kinds (CRS-independent).
// Geographic/projected coordinate QKs are auto-registered by gladly's
// ensureCrsDefined() using EPSG-based names (epsg_CODE_x / epsg_CODE_y).
[
  ['elevation_m',     { label: 'Elevation (m)',              scale: 'linear' }],
  ['altitude_m',      { label: 'Altitude (m)',               scale: 'linear' }],
  ['height_m',        { label: 'Height (m)',                 scale: 'linear' }],
  ['xdist_m',         { label: 'Distance (m)',               scale: 'linear' }],
  ['depth_m',         { label: 'Depth (m)',                  scale: 'linear' }],
  ['doi_m',           { label: 'Depth of Investigation (m)', scale: 'linear' }],
  ['line_id',         { label: 'Line ID',                    scale: 'linear' }],
  ['index',           { label: 'Index',                      scale: 'linear' }],
  ['mag_nT',          { label: 'Magnetic Field (nT)',        scale: 'linear', colorscale: 'RdBu' }],
  ['conductivity_sm', { label: 'Conductivity (S/m)',         scale: 'log',    colorscale: 'viridis' }],
  ['time_s',          { label: 'Time (s)',                   scale: 'log' }],
  ['dbdt_abs_pT',     { label: '|dB/dt| (pT)',              scale: 'log' }],
  ['resistivity',     { label: 'Resistivity (Ωm)',           scale: 'log',    colorscale: 'turbo' }],
].forEach(([name, def]) => registerAxisQuantityKind(name, def));

// ── CRS quantity kind registration ───────────────────────────────────────────
// Pre-registers epsg_CODE_x / epsg_CODE_y with a generic label so gladly axes
// share correctly even when no tile layer is present.  When a tile layer IS
// present its internal ensureCrsDefined() will update the label via projnames.
function _registerCrsQk(crs) {
  const code = parseCrsCode(crs);
  if (code == null) return;
  registerAxisQuantityKind(`epsg_${code}_x`, { label: `EPSG:${code} X`, scale: 'linear' });
  registerAxisQuantityKind(`epsg_${code}_y`, { label: `EPSG:${code} Y`, scale: 'linear' });
}

// Pre-register the well-known geographic CRS at module load time.
_registerCrsQk(4326);
_registerCrsQk(3857);

// ── Column → quantity kind lookup tables ─────────────────────────────────────
//
// Geographic columns are always EPSG:4326 (x = longitude, y = latitude).
// Web-Mercator columns are always EPSG:3857.
// Projected columns (easting/northing in a local UTM etc.) use the EPSG code
// stored in the dataset's own metadata — resolved at runtime in getQuantityKind.

// XYZ columns with a fixed, CRS-independent quantity kind
const XYZ_STATIC_QK = {
  // Geographic (EPSG:4326) — gladly convention: x = lon, y = lat
  lat: 'epsg_4326_y', Lat: 'epsg_4326_y', LAT: 'epsg_4326_y',
  lon: 'epsg_4326_x', Lon: 'epsg_4326_x', LON: 'epsg_4326_x', Long: 'epsg_4326_x',
  // Web Mercator (EPSG:3857) — added by libaarhusxyz normalizer
  x_web: 'epsg_3857_x',
  y_web: 'epsg_3857_y',
  // Elevation / terrain
  elevation: 'elevation_m', Elevation: 'elevation_m',
  elev: 'elevation_m',      Elev: 'elevation_m',
  DEM: 'elevation_m',       Topo: 'elevation_m', topo: 'elevation_m',
  Topography: 'elevation_m', topography: 'elevation_m',
  // Flight altitude
  alt: 'altitude_m', Alt: 'altitude_m',
  altitude: 'altitude_m',   Altitude: 'altitude_m',
  GPS_Altitude: 'altitude_m', GPS_altitude: 'altitude_m',
  HeightROI: 'altitude_m',  RadarAltitude: 'altitude_m',
  // Along-line distance
  xdist: 'xdist_m', fdist: 'xdist_m', Dist: 'xdist_m', dist: 'xdist_m',
  // Line / fiducial
  Line: 'line_id', line: 'line_id', linenumber: 'line_id',
  Fiducial: 'index', fiducial: 'index', fid: 'index', Fid: 'index',
  // Depth of investigation
  DOI: 'doi_m', doi: 'doi_m',
};

// XYZ columns whose QK depends on the dataset's projected CRS
const XYZ_PROJECTED_X_COLS = new Set(['UTMX', 'UTMx', 'utmx', 'X', 'x', 'Easting', 'easting']);
const XYZ_PROJECTED_Y_COLS = new Set(['UTMY', 'UTMy', 'utmy', 'Y', 'y', 'Northing', 'northing']);

// MagData columns with a fixed quantity kind
const MAG_STATIC_QK = {
  elevation: 'elevation_m', elev: 'elevation_m',
  alt: 'altitude_m',        altitude: 'altitude_m',
  magcom: 'mag_nT', mag: 'mag_nT', magnetic_total: 'mag_nT', diurnal: 'mag_nT',
  fidcount: 'index',
  line: 'line_id',
};

// MagData columns whose QK depends on the dataset's CRS (stored in meta.crs)
const MAG_PROJECTED_X_COLS = new Set(['easting']);
const MAG_PROJECTED_Y_COLS = new Set(['northing']);

// ── Helper: convert any typed array to Float32Array ───────────────────────────
function toFloat32Array(arr) {
  if (arr instanceof Float32Array) return arr;
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) result[i] = Number(arr[i]);
  return result;
}

// IndexedDB initialization
let db = null;

async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Create object stores
      if (!database.objectStoreNames.contains('datasets')) {
        database.createObjectStore('datasets');
      }
      if (!database.objectStoreNames.contains('data')) {
        database.createObjectStore('data');
      }
      if (!database.objectStoreNames.contains('geography')) {
        database.createObjectStore('geography');
      }
    };
  });
}

// Cache utilities with LRU eviction
async function getFromCache(storeName, key) {
  try {
    const database = await initDB();
    const transaction = database.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const result = getRequest.result;
        if (result) {
          // Update lastAccessed timestamp
          result.lastAccessed = Date.now();
          store.put(result, key);
          resolve(result);
        } else {
          resolve(null);
        }
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  } catch (error) {
    console.error('Cache read error:', error);
    return null;
  }
}

async function putInCache(storeName, key, value) {
  try {
    const database = await initDB();
    await putInCacheWithRetry(database, storeName, key, value);
  } catch (error) {
    console.error('Cache write error:', error);
  }
}

async function putInCacheWithRetry(database, storeName, key, value, retries = 3) {
  const cacheEntry = {
    ...value,
    lastAccessed: Date.now(),
    size: estimateSize(value)
  };

  try {
    const transaction = database.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const putRequest = store.put(cacheEntry, key);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    });
  } catch (error) {
    if (error.name === 'QuotaExceededError' && retries > 0) {
      // Evict oldest entry and retry
      await evictOldest(database);
      return putInCacheWithRetry(database, storeName, key, value, retries - 1);
    }
    throw error;
  }
}

async function evictOldest(database) {
  const stores = ['datasets', 'data', 'geography'];
  const entries = [];

  // Collect all entries with their timestamps
  for (const storeName of stores) {
    const transaction = database.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);

    await new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          entries.push({
            storeName,
            key: cursor.key,
            lastAccessed: cursor.value.lastAccessed || 0
          });
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  if (entries.length === 0) return;

  // Sort by lastAccessed (oldest first)
  entries.sort((a, b) => a.lastAccessed - b.lastAccessed);

  // Delete oldest entry
  const oldest = entries[0];
  const transaction = database.transaction([oldest.storeName], 'readwrite');
  const store = transaction.objectStore(oldest.storeName);

  return new Promise((resolve, reject) => {
    const deleteRequest = store.delete(oldest.key);
    deleteRequest.onsuccess = () => {
      console.log(`Evicted cache entry: ${oldest.storeName}/${oldest.key}`);
      resolve();
    };
    deleteRequest.onerror = () => reject(deleteRequest.error);
  });
}

function estimateSize(obj) {
  // Rough estimate of object size in bytes
  try {
    return JSON.stringify(obj, (key, value) => {
      // Convert BigInt to string for size estimation
      return typeof value === 'bigint' ? value.toString() : value;
    }).length;
  } catch (error) {
    // If stringify fails for any reason, return a default estimate
    console.warn('Could not estimate size:', error);
    return 1000; // Default estimate
  }
}

// Base Dataset class
export class Dataset {
  constructor(metadata) {
    this.metadata = metadata;
    this.id = metadata.id;
    this.mimeType = metadata.mime_type;
    this.parts = metadata.parts || {};

    // In-memory cache (fallback if IndexedDB fails)
    this._geographyCache = {};
  }

  cancel() {}

  async _fetch(url) {
    await acquireFetchSlot();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return res;
    } finally {
      releaseFetchSlot();
    }
  }

  getParts() {
    const partPaths = [];

    // Check if new format (has "files" and "parts" keys) or old format
    const isNewFormat = this.parts.files !== undefined && this.parts.parts !== undefined;
    const partsToTraverse = isNewFormat ? this.parts.parts : this.parts;

    const traverse = (obj, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}/${key}` : key;
        partPaths.push(path);

        if (value.parts) {
          traverse(value.parts, path);
        }
      }
    };

    traverse(partsToTraverse);
    return partPaths;
  }

  _getPartMetadata(partPath) {
    if (partPath === "all" || partPath === "") {
      // Root level - return metadata.parts which has the files
      return this.metadata.parts;
    }

    // Check if new format or old format
    const isNewFormat = this.metadata.parts.files !== undefined && this.metadata.parts.parts !== undefined;
    const partsDict = isNewFormat ? this.metadata.parts.parts : this.metadata.parts;

    // Navigate nested parts structure
    const segments = partPath.split('/');
    let current = partsDict;

    for (const segment of segments) {
      if (!current || !current[segment]) {
        return null;
      }
      current = current[segment];
    }

    return current;
  }

  async getGeography(partPath = "all") {
    const cacheKey = `${this.id}-${partPath}`;

    // Check IndexedDB cache
    const cached = await getFromCache('geography', cacheKey);
    if (cached && cached.geography) {
      return cached.geography;
    }

    // Check in-memory cache
    if (this._geographyCache[cacheKey]) {
      return this._geographyCache[cacheKey];
    }

    // Try to extract from "all" if we have it cached
    if (partPath !== "all") {
      const allCached = await getFromCache('geography', `${this.id}-all`);
      if (allCached && allCached.geography) {
        const extracted = this._extractPartGeography(allCached.geography, partPath);
        if (extracted) {
          this._geographyCache[cacheKey] = extracted;
          await putInCache('geography', cacheKey, { geography: extracted });
          return extracted;
        }
      }
    }

    // Try to merge parts into "all" if all parts are cached
    if (partPath === "all") {
      const partPaths = this.getParts();
      const partGeographies = [];
      let allPartsAvailable = true;

      for (const path of partPaths) {
        const partCached = await getFromCache('geography', `${this.id}-${path}`);
        if (partCached && partCached.geography) {
          partGeographies.push({ path, geography: partCached.geography });
        } else {
          allPartsAvailable = false;
          break;
        }
      }

      if (allPartsAvailable && partGeographies.length > 0) {
        const merged = this._mergePartGeographies(partGeographies);
        this._geographyCache[cacheKey] = merged;
        await putInCache('geography', cacheKey, { geography: merged });
        return merged;
      }
    }

    // Fetch from API
    const geography = await this._fetchGeography(partPath);
    this._geographyCache[cacheKey] = geography;
    await putInCache('geography', cacheKey, { geography });
    return geography;
  }

  async _fetchGeography(partPath) {
    const partMetadata = this._getPartMetadata(partPath);

    if (!partMetadata || !partMetadata.files) {
      console.error(`No metadata found for part: ${partPath}`);
      return null;
    }

    const url = partMetadata.files['application/geo+json'];
    if (!url) {
      console.error(`No application/geo+json file found for part: ${partPath}`);
      return null;
    }

    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch geography from ${url}:`, error);
      return null;
    }
  }

  _extractPartGeography(allGeography, partPath) {
    if (!allGeography || !allGeography.features) return null;

    const features = allGeography.features.filter(
      feature => feature.properties && feature.properties.part === partPath
    );

    if (features.length === 0) return null;

    return {
      type: "FeatureCollection",
      features
    };
  }

  _mergePartGeographies(partGeographies) {
    const allFeatures = [];

    for (const { path, geography } of partGeographies) {
      if (geography && geography.features) {
        geography.features.forEach(feature => {
          const newFeature = { ...feature };
          if (!newFeature.properties) {
            newFeature.properties = {};
          }
          newFeature.properties.part = path;
          allFeatures.push(newFeature);
        });
      }
    }

    return {
      type: "FeatureCollection",
      features: allFeatures
    };
  }

  // ── Gladly Data interface (base stubs) ────────────────────────────────────
  columns() { return []; }
  getData(col) { return undefined; }
  getQuantityKind(col) { return undefined; }
  getDomain(col) { return undefined; }
}

// JsonDataset subclass for application/json
export class JsonDataset extends Dataset {
  constructor(metadata) {
    super(metadata);
    this._dataCache = {};
    this._cachedData = null;
  }

  async fetchData(partPath = "all") {
    const cacheKey = `${this.id}-${partPath}`;

    // Check IndexedDB cache
    const cached = await getFromCache('data', cacheKey);
    if (cached && cached.data) {
      this._cachedData = cached.data;
      return cached.data;
    }

    // Check in-memory cache
    if (this._dataCache[cacheKey]) {
      this._cachedData = this._dataCache[cacheKey];
      return this._dataCache[cacheKey];
    }

    // Try to extract from "all" if we have it cached
    if (partPath !== "all") {
      const allCached = await getFromCache('data', `${this.id}-all`);
      if (allCached && allCached.data) {
        const extracted = this._extractPartData(allCached.data, partPath);
        if (extracted) {
          this._dataCache[cacheKey] = extracted;
          this._cachedData = extracted;
          await putInCache('data', cacheKey, { data: extracted });
          return extracted;
        }
      }
    }

    // Try to merge parts into "all" if all parts are cached
    if (partPath === "all") {
      const partPaths = this.getParts();
      const partDatasets = [];
      let allPartsAvailable = true;

      for (const path of partPaths) {
        const partCached = await getFromCache('data', `${this.id}-${path}`);
        if (partCached && partCached.data) {
          partDatasets.push({ path, data: partCached.data });
        } else {
          allPartsAvailable = false;
          break;
        }
      }

      if (allPartsAvailable && partDatasets.length > 0) {
        const merged = this._mergePartData(partDatasets);
        this._dataCache[cacheKey] = merged;
        this._cachedData = merged;
        await putInCache('data', cacheKey, { data: merged });
        return merged;
      }
    }

    // Fetch from API
    const data = await this._fetchData(partPath);
    this._dataCache[cacheKey] = data;
    this._cachedData = data;
    await putInCache('data', cacheKey, { data });
    return data;
  }

  async _fetchData(partPath) {
    const partMetadata = this._getPartMetadata(partPath);

    if (!partMetadata || !partMetadata.files) {
      console.error(`No metadata found for part: ${partPath}`);
      return null;
    }

    const url = partMetadata.files[this.mimeType];
    if (!url) {
      console.error(`No ${this.mimeType} file found for part: ${partPath}`);
      return null;
    }

    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch data from ${url}:`, error);
      return null;
    }
  }

  _extractPartData(allData, partPath) {
    if (!allData || !allData.part) return null;

    const result = {};
    const indices = [];

    // Find indices where part matches
    allData.part.forEach((p, i) => {
      if (p === partPath) {
        indices.push(i);
      }
    });

    if (indices.length === 0) return null;

    // Extract data at those indices for all array fields
    for (const [key, value] of Object.entries(allData)) {
      if (key === 'part') continue;

      if (Array.isArray(value)) {
        result[key] = indices.map(i => value[i]);
      } else {
        result[key] = value; // Non-array fields (like units)
      }
    }

    return result;
  }

  _mergePartData(partDatasets) {
    const result = {};
    const partArray = [];

    // Collect all keys from all parts
    const allKeys = new Set();
    partDatasets.forEach(({ data }) => {
      Object.keys(data).forEach(key => allKeys.add(key));
    });

    // Merge arrays
    for (const key of allKeys) {
      const firstValue = partDatasets[0].data[key];

      if (Array.isArray(firstValue)) {
        result[key] = [];

        partDatasets.forEach(({ path, data }) => {
          if (data[key] && Array.isArray(data[key])) {
            result[key].push(...data[key]);

            // Build part array
            if (key === Object.keys(data).find(k => Array.isArray(data[k]))) {
              for (let i = 0; i < data[key].length; i++) {
                partArray.push(path);
              }
            }
          }
        });
      } else {
        // Non-array fields - use first value
        result[key] = firstValue;
      }
    }

    // Add part array
    result.part = partArray;

    return result;
  }

  // ── Gladly Data interface ─────────────────────────────────────────────────
  columns() {
    if (!this._cachedData) return [];
    return Object.keys(this._cachedData).filter(k => Array.isArray(this._cachedData[k]));
  }

  getData(col) {
    const arr = this._cachedData?.[col];
    if (!Array.isArray(arr)) return undefined;
    return new Float32Array(arr.map(Number));
  }

  getQuantityKind(col) {
    return undefined;
  }

  getDomain(col) {
    return undefined;
  }
}

// XyzDataset subclass for application/x-aarhusxyz-msgpack
export class XyzDataset extends Dataset {
  constructor(metadata) {
    super(metadata);
    this._dataCache = {};
    this._cachedData = null;
    this._detectedCrs = null;
  }

  _applyCachedData(xyzObj) {
    this._cachedData = xyzObj;
    // Detect CRS from model_info.projection (integer EPSG code set by libaarhusxyz normalizer)
    const proj = xyzObj.info?.projection;
    if (proj != null) {
      this._detectedCrs = proj;
      // Ensure gladly has quantity kinds registered for this CRS (also registers 4326 built-in)
      _registerCrsQk(proj);
    }
    // 4326 and 3857 are already pre-registered at module load (see above)
  }

  async fetchData(partPath = "all") {
    const cacheKey = `${this.id}-${partPath}`;

    // Check IndexedDB cache
    const cached = await getFromCache('data', cacheKey);
    if (cached && cached.binary) {
      // Reconstruct XYZ object from cached binary msgpack
      const xyzObj = new XYZ(cached.binary);
      this._applyCachedData(xyzObj);
      return xyzObj;
    }

    // Check in-memory cache
    if (this._dataCache[cacheKey]) {
      this._applyCachedData(this._dataCache[cacheKey]);
      return this._dataCache[cacheKey];
    }

    // Note: For XYZ datasets, we don't try to extract/merge from cache
    // because the XYZ object needs to be complete for proper structure

    // Fetch from API
    const { xyzObj, binary } = await this._fetchData(partPath);
    this._dataCache[cacheKey] = xyzObj;
    // Store the raw binary msgpack for caching (avoids BigInt serialization issues)
    await putInCache('data', cacheKey, { binary: binary });
    this._applyCachedData(xyzObj);
    return xyzObj;
  }

  async _fetchData(partPath) {
    const partMetadata = this._getPartMetadata(partPath);

    if (!partMetadata || !partMetadata.files) {
      console.error(`No metadata found for part: ${partPath}`);
      return null;
    }

    const url = partMetadata.files[this.mimeType];
    if (!url) {
      console.error(`No ${this.mimeType} file found for part: ${partPath}`);
      return null;
    }

    try {
      const response = await this._fetch(url);
      const binary = await response.arrayBuffer();

      // Create XYZ object from binary
      const xyzObj = new XYZ(binary);

      return { xyzObj, binary };
    } catch (error) {
      console.error(`Failed to fetch XYZ data from ${url}:`, error);
      return null;
    }
  }

  // ── Gladly Data interface — exposes .flightlines columns ─────────────────
  columns() {
    const fl = this._cachedData?.flightlines;
    if (!fl) return [];
    return Object.keys(fl).filter(k => ArrayBuffer.isView(fl[k]));
  }

  getData(col) {
    const arr = this._cachedData?.flightlines?.[col];
    if (!arr) return undefined;
    return toFloat32Array(arr);
  }

  getQuantityKind(col) {
    // Fixed QKs (geographic + scalar quantities)
    const staticQk = XYZ_STATIC_QK[col];
    if (staticQk) return staticQk;
    // Projected CRS columns — resolved against the dataset's own CRS
    if (this._detectedCrs != null) {
      if (XYZ_PROJECTED_X_COLS.has(col)) return crsToQkX(this._detectedCrs);
      if (XYZ_PROJECTED_Y_COLS.has(col)) return crsToQkY(this._detectedCrs);
    }
    return undefined;
  }

  getDomain(col) {
    return undefined;
  }
}

// MagDataset subclass for application/x-magdata-msgpack
export class MagDataset extends Dataset {
  constructor(metadata) {
    super(metadata);
    this._dataCache = {};
    this._cachedData = null;
    this._detectedCrs = null;
  }

  _applyCachedData(magDataObj) {
    this._cachedData = magDataObj;
    // Detect CRS from meta.crs (EPSG integer or "EPSG:XXXX" string)
    const crs = magDataObj.meta?.crs;
    if (crs != null) {
      this._detectedCrs = crs;
      _registerCrsQk(crs);
    }
  }

  async fetchData(partPath = "all") {
    const cacheKey = `${this.id}-${partPath}`;

    // Check IndexedDB cache
    const cached = await getFromCache('data', cacheKey);
    if (cached && cached.binary) {
      // Reconstruct MagData object from cached binary msgpack
      const magDataObj = new MagData(cached.binary);
      this._applyCachedData(magDataObj);
      return magDataObj;
    }

    // Check in-memory cache
    if (this._dataCache[cacheKey]) {
      this._applyCachedData(this._dataCache[cacheKey]);
      return this._dataCache[cacheKey];
    }

    // Note: Like XyzDataset, we don't try to extract/merge from cache
    // because the MagData object needs to be complete for proper structure

    // Fetch from API
    const { magDataObj, binary } = await this._fetchData(partPath);
    this._dataCache[cacheKey] = magDataObj;
    // Store the raw binary msgpack for caching
    await putInCache('data', cacheKey, { binary: binary });
    this._applyCachedData(magDataObj);
    return magDataObj;
  }

  async _fetchData(partPath) {
    const partMetadata = this._getPartMetadata(partPath);

    if (!partMetadata || !partMetadata.files) {
      console.error(`No metadata found for part: ${partPath}`);
      return null;
    }

    const url = partMetadata.files[this.mimeType];
    if (!url) {
      console.error(`No ${this.mimeType} file found for part: ${partPath}`);
      return null;
    }

    try {
      const response = await this._fetch(url);
      const binary = await response.arrayBuffer();

      // Create MagData object from binary
      const magDataObj = new MagData(binary);

      return { magDataObj, binary };
    } catch (error) {
      console.error(`Failed to fetch MagData from ${url}:`, error);
      return null;
    }
  }

  // ── Gladly Data interface — exposes .data columns ─────────────────────────
  columns() {
    const d = this._cachedData?.data;
    if (!d) return [];
    return Object.keys(d).filter(k => ArrayBuffer.isView(d[k]));
  }

  getData(col) {
    const arr = this._cachedData?.data?.[col];
    if (!arr) return undefined;
    return toFloat32Array(arr);
  }

  getQuantityKind(col) {
    // Fixed QKs (scalar quantities)
    const staticQk = MAG_STATIC_QK[col];
    if (staticQk) return staticQk;
    // Projected CRS columns — resolved against meta.crs
    if (this._detectedCrs != null) {
      if (MAG_PROJECTED_X_COLS.has(col)) return crsToQkX(this._detectedCrs);
      if (MAG_PROJECTED_Y_COLS.has(col)) return crsToQkY(this._detectedCrs);
    }
    return undefined;
  }

  getDomain(col) {
    return undefined;
  }
}

// Wraps a dict of {datasetName: Dataset} and exposes the gladly Data API.
// Column names are prefixed as "datasetName.columnName" (dot separator) so all
// datasets can share a single axis space in e.g. ScatterLayer. The dot separator
// matches DataGroup's own resolution convention.
export class DatasetCollectionAdapter {
  constructor(datasetObjects) {
    this._datasets = datasetObjects || {};
  }

  _parse(prefixedCol) {
    const dot = prefixedCol.indexOf('.');
    if (dot === -1) return [null, prefixedCol];
    return [prefixedCol.slice(0, dot), prefixedCol.slice(dot + 1)];
  }

  columns() {
    const cols = [];
    for (const [name, ds] of Object.entries(this._datasets)) {
      if (ds && typeof ds.columns === 'function') {
        for (const col of ds.columns()) cols.push(`${name}.${col}`);
      }
    }
    if (cols.length === 0) cols.push('No dataset');
    return cols;
  }

  // Returns a DataGroup with each dataset as a named child carrying columnar Data.
  // Plot._initialize() shallow-copies _children into a fresh DataGroup for built-in
  // layer types; custom layer types read plot._rawData directly.
  toDataGroup() {
    const raw = {};
    for (const [name, ds] of Object.entries(this._datasets)) {
      if (!ds || typeof ds.columns !== 'function') continue;
      const colData    = {};
      const qkData     = {};
      const domainData = {};
      for (const col of ds.columns()) {
        const arr = ds.getData ? ds.getData(col) : undefined;
        if (arr != null) {
          colData[col] = arr;
          const qk = ds.getQuantityKind ? ds.getQuantityKind(col) : undefined;
          if (qk != null) qkData[col] = qk;
          const domain = ds.getDomain ? ds.getDomain(col) : undefined;
          if (domain != null) domainData[col] = domain;
        }
      }
      raw[name] = { data: colData, quantity_kinds: qkData, domains: domainData };
    }
    return new DataGroup(raw);
  }

  getData(prefixedCol) {
    const [name, col] = this._parse(prefixedCol);
    const ds = this._datasets[name];
    if (!ds) return undefined;
    const result = ds.getData(col);
    if (result == null) return undefined;
    // Wrap raw Float32Array into a ColumnData instance (ArrayColumn) so the
    // framework can upload it as a GPU texture via col.resolve().
    if (result instanceof Float32Array) {
      const qk = ds.getQuantityKind(col);
      const domain = ds.getDomain(col);
      const raw = { data: { [col]: result } };
      if (qk != null) raw.quantity_kinds = { [col]: qk };
      if (domain != null) raw.domains = { [col]: domain };
      return Data.wrap(raw).getData(col);
    }
    return result;
  }

  getQuantityKind(prefixedCol) {
    const [name, col] = this._parse(prefixedCol);
    const qk = this._datasets[name]?.getQuantityKind(col);
    if (qk !== undefined) return qk;
    // No explicit mapping — use the unprefixed column name as the quantity kind
    // and ensure it is registered so gladly displays a proper label and so the
    // same column name from different datasets shares the same axis.
    if (col != null) registerAxisQuantityKind(col, { label: col, scale: 'linear' });
    return col;
  }

  getDomain(prefixedCol) {
    const [name, col] = this._parse(prefixedCol);
    return this._datasets[name]?.getDomain(col);
  }
}

// Factory function to load dataset
export async function loadDataset(id, projectId) {
  const cacheKey = id;

  // Check IndexedDB cache for metadata
  const cached = await getFromCache('datasets', cacheKey);
  if (cached && cached.metadata) {
    return createDatasetInstance(cached.metadata);
  }

  // Fetch metadata from API via the authenticated apiClient (not raw axios) — this endpoint
  // now requires real project membership or a read-only publication, so it needs the
  // Authorization header that only the configured apiClient carries.
  const metadata = await getDataset(id, projectId);

  // Cache metadata
  await putInCache('datasets', cacheKey, { metadata });

  return createDatasetInstance(metadata);
}

function createDatasetInstance(metadata) {
  const mimeType = metadata.mime_type;

  if (mimeType === 'application/json') {
    return new JsonDataset(metadata);
  }

  if (mimeType === 'application/x-aarhusxyz-msgpack') {
    return new XyzDataset(metadata);
  }

  if (mimeType === 'application/x-magdata-msgpack') {
    return new MagDataset(metadata);
  }

  // Non-core / plugin-contributed types (e.g. webxtile) come from the dataset registry,
  // which is built at startup after plugins load.
  const RegisteredCls = getDatasetClass(mimeType);
  if (RegisteredCls) {
    return new RegisteredCls(metadata);
  }

  // Default to base Dataset for unsupported types
  return new Dataset(metadata);
}

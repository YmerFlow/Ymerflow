const NAMED_COLORS = {
  black:  [0, 0, 0],
  white:  [1, 1, 1],
  red:    [1, 0, 0],
  green:  [0, 0.502, 0],
  blue:   [0, 0, 1],
  gray:   [0.502, 0.502, 0.502],
  grey:   [0.502, 0.502, 0.502],
  yellow: [1, 1, 0],
  orange: [1, 0.647, 0],
  purple: [0.502, 0, 0.502],
  brown:  [0.647, 0.165, 0.165],
};

export function parseColor(colorStr) {
  if (!colorStr) return [0, 0, 0];
  const s = colorStr.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
  }
  return [0, 0, 0];
}

export function fillColorArrays(length, rgb) {
  return {
    r: new Float32Array(length).fill(rgb[0]),
    g: new Float32Array(length).fill(rgb[1]),
    b: new Float32Array(length).fill(rgb[2]),
  };
}

// layer_data values are Maps with integer keys (see libaarhusxyz._ensureLayerDataMaps).
// These helpers abstract over both plain objects (string keys) and Maps (any key type).
export function getFrom(dict, key) {
  return dict && typeof dict.get === 'function' ? dict.get(key) : dict?.[key];
}
export function getKeys(dict) {
  return dict && typeof dict.keys === 'function'
    ? Array.from(dict.keys())
    : Object.keys(dict || {});
}


export function resolveDataPath(obj, path) {
  return path ? path.split('.').reduce((o, k) => o?.[k], obj) : undefined;
}

export function toFloat32Array(arr) {
  // Already the right type → no copy. Otherwise let the Float32Array constructor do the element
  // conversion natively (typed-array → typed-array is a memcpy+cast; array / array-like coerces
  // each element via ToNumber) — no per-element JS loop.
  if (arr instanceof Float32Array) return arr;
  return new Float32Array(arr);
}

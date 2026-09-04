// Shared construction of the "config dictionary" for a process/version, plus a
// flatten/diff pair used by ProcessInfo (single dump) and ProcessComparison (diff).

// Fields that aren't meaningful to show in the process config view.
const EXCLUDED_FIELDS = new Set(['versions', 'flow_x', 'flow_y']);

// Build the merged process + version config object (version fields override process
// fields), excluding non-meaningful keys.
export function buildProcessConfig(process, versionObj) {
  if (!process) return {};
  const config = Object.fromEntries(
    Object.entries(process).filter(([k]) => !EXCLUDED_FIELDS.has(k)));
  if (versionObj) {
    Object.assign(config, Object.fromEntries(
      Object.entries(versionObj).filter(([k]) => !EXCLUDED_FIELDS.has(k))));
  }
  return config;
}

// Flatten nested objects/arrays to { 'a.b.0.c': leafValue }.
// Leaves: null/number/string/boolean and empty {}/[].
export function flattenConfig(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') {
    out[prefix] = obj;
    return out;
  }
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj);
  if (entries.length === 0) {
    // Empty {} or [] is itself a leaf.
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    flattenConfig(v, path, out);
  }
  return out;
}

// Union of leaf keys; include a key only when JSON.stringify(a) !== JSON.stringify(b).
// Returns rows { path, a, b } sorted lexicographically by dot-path.
export function diffConfigs(cfgA, cfgB) {
  const fa = flattenConfig(cfgA), fb = flattenConfig(cfgB);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const rows = [];
  for (const path of [...keys].sort()) {
    if (JSON.stringify(fa[path]) !== JSON.stringify(fb[path])) {
      rows.push({ path, a: fa[path], b: fb[path] });
    }
  }
  return rows;
}

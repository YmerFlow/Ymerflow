// Layer-type filtering for a dataset dropped onto a plot. A dropped dataset
// becomes a new layer; the candidate layer types are filtered by (1) media-type
// compatibility of the layer's datasetPath field, and (2) conflict-avoidance
// against the axis slots the plot's current layers already occupy.
import { getRegisteredLayerTypes, getLayerType } from 'gladly-plot';
import { datasetMatchesMediatypes } from '../../jsoneditor/mediatypeMatch';

// The datasetPath field name + its media-type spec, or null if the layer has no
// datasetPath field (e.g. GridLayer, which uses column expressions) → not a drop
// candidate.
function datasetField(schema) {
  for (const [k, prop] of Object.entries(schema.properties || {}))
    if (prop['x-format'] === 'datasetPath') return { name: k, spec: prop['x-target-mediatypes'] };
  return null;
}

// The x/y/z axis slot → quantityKind pairs a resolved axis config occupies.
function axisPairs(cfg) {
  return [
    [cfg.xAxis, cfg.xAxisQuantityKind],
    [cfg.yAxis, cfg.yAxisQuantityKind],
    [cfg.zAxis, cfg.zAxisQuantityKind],
  ];
}

// slot → quantityKind already occupied by the plot's current layers.
function occupiedAxes(layers, data) {
  const map = {};
  for (const layer of layers || []) {
    const [name, params] = Object.entries(layer || {})[0] || [];
    if (!name) continue;
    let cfg;
    try { cfg = getLayerType(name).resolveAxisConfig(params || {}, data); } catch { continue; }
    for (const [slot, qk] of axisPairs(cfg))
      if (slot && qk != null) map[slot] = qk;
  }
  return map;
}

// Candidate layer types for a dropped dataset dict + the plot's current layers.
// Returns [{ name, field }] where `field` is the layer's datasetPath field name.
export function compatibleLayerTypes(datasetDict, layers, data) {
  const occupied = occupiedAxes(layers, data);
  const out = [];
  for (const name of getRegisteredLayerTypes()) {
    let lt;
    try { lt = getLayerType(name); } catch { continue; }
    let schema;
    try { schema = lt.schema(data); } catch { continue; }
    const field = datasetField(schema);
    if (!field) continue;                                             // no datasetPath field
    if (!datasetMatchesMediatypes(datasetDict, field.spec)) continue; // media gate
    // Conflict-avoidance: coarse check with minimal params (the dropped dataset
    // isn't loaded yet → column-driven QKs fall back to the layer's defaults).
    let cfg;
    try { cfg = lt.resolveAxisConfig({ [field.name]: '' }, data); } catch { cfg = {}; }
    const conflict = axisPairs(cfg).some(
      ([slot, qk]) => slot && qk != null && occupied[slot] != null && occupied[slot] !== qk,
    );
    if (conflict) continue;
    out.push({ name, field: field.name });
  }
  return out;
}

// Build a new layer object { Name: {defaults..., <datasetField>: path} }.
export function buildLayer({ name, field }, datasetPath, data) {
  const schema = getLayerType(name).schema(data);
  const params = {};
  for (const [k, prop] of Object.entries(schema.properties || {}))
    if (prop.default !== undefined) params[k] = prop.default;
  params[field] = datasetPath;
  return { [name]: params };
}

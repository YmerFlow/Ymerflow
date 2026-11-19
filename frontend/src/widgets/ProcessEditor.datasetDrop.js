import { datasetMatchesMediatypes } from '../jsoneditor/mediatypeMatch';

// The main dataset input of a process-type schema for a given dataset dict: the
// first property whose x-format is a dataset reference and whose
// x-target-mediatypes constraint the dict satisfies. Returns { name, format } or
// null when the type has no matching dataset input.
export function mainDatasetInput(schema, dict) {
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    if (prop['x-format'] !== 'dataset' && prop['x-format'] !== 'datasetPath') continue;
    if (datasetMatchesMediatypes(dict, prop['x-target-mediatypes'])) {
      return { name, format: prop['x-format'] };
    }
  }
  return null;
}

// Process types in the environment that can accept the dropped dataset as their
// main input: [{ type, field }] over the `types` map (name → { schema }).
export function compatibleProcessTypes(types, dict) {
  const out = [];
  for (const [type, entry] of Object.entries(types || {})) {
    const field = entry?.schema ? mainDatasetInput(entry.schema, dict) : null;
    if (field) out.push({ type, field });
  }
  return out;
}

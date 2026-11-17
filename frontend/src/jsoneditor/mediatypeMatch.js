// Shared matcher for `x-target-mediatypes` — a schema key (on process-param
// `x-format: "dataset"` fields and PlotView layer `x-format: "datasetPath"`
// fields) that constrains which datasets a picker offers, by the media types
// the referenced dataset's root part exposes.

// Root-part media types a dataset exposes. Works on both a raw dataset dict
// (search results, carrying `.parts`) and a Dataset instance (same `.parts`).
export function rootPartMediatypes(ds) {
  const parts = (ds && ds.parts) || {};
  if (parts.files) return Object.keys(parts.files);                 // new format
  if (parts[""] && parts[""].mime_type) return [parts[""].mime_type]; // old format
  return [];
}

// Normalize x-target-mediatypes to a list of AND-groups (OR between groups).
// A flat list of strings is a single AND group; a list of lists is OR-of-ANDs.
function normalizeGroups(spec) {
  if (!spec || spec.length === 0) return null;        // no constraint
  return Array.isArray(spec[0]) ? spec : [spec];      // flat → single group
}

// True if ds satisfies the constraint (any group fully matched). Absent/empty
// spec → always true (opt-in, backward compatible).
export function datasetMatchesMediatypes(ds, spec) {
  const groups = normalizeGroups(spec);
  if (!groups) return true;
  const available = new Set(rootPartMediatypes(ds));
  return groups.some(group => group.every(mt => available.has(mt)));
}

// Dataset-path segment encoding.
//
// Dataset references in plot layers are stored as dot-joined strings:
//   current.<dsName>[.<col…>]
//   <procName>.<version>.<dsName>[.<part>][.<col…>]
// (a fourth segment is a part when the dataset has a part of that name, else the
// start of the column; see widgets/PlotView/pinnedDatasets.js).
// Every consumer (ours and gladly's own Data._resolve) splits on '.' positionally,
// so a literal dot inside a procName/dsName/part segment (e.g. "ar 1.0") mis-segments
// the path. To keep the naive first-dot split always landing on a true segment boundary,
// we encode the dot OUT of each atomic name segment before joining.
//
// The substitution is deliberately lossy and NOT reversible — we never decode.
// Wherever a segment must be matched back to a real object, encode the candidate and
// compare in encoded space (e.g. processes.find(p => encodeSeg(p.name) === seg)).
//
// Only procName/dsName/part segments are encoded. Version numbers are dot-free integers,
// and the column tail is intentionally dot-nested (e.g. "grid.x") and must stay so.
export function encodeSeg(s) {
  return String(s).replaceAll('.', ',');
}

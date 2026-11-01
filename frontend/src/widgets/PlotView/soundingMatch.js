// Matching the selected sounding between the current dataset and a pinned one (see
// pinnedDatasets.js). Soundings are matched by line and gtime, never by row number: averaging
// and culling change the rows, and gtime (seconds of day) repeats across lines flown on
// different days.
import { resolveDataPath } from './colorUtils.js';

// Line-id column names in libaarhusxyz's order (XYZ.line_id_column), with case variants.
const LINE_COLUMNS = ['title', 'Line', 'line', 'line_id', 'line_no']
  .flatMap(n => [n, n.toLowerCase(), n.toUpperCase(), n[0].toUpperCase() + n.slice(1).toLowerCase()]);
const TIME_COLUMN = 'gtime';

// The name of the line-id column in flightlines (or a stats sidecar's flightlines), if any.
export const lineColumn = fl => LINE_COLUMNS.find(c => fl?.[c] !== undefined);

// Row of flightlines `to` that matches row `i` of flightlines `from`: the same line, nearest gtime.
// null when there is none, or when either side has no line or gtime column.
export function matchSounding(from, i, to) {
  const fromLine = lineColumn(from), toLine = lineColumn(to);
  if (i == null || !fromLine || !toLine || !from[TIME_COLUMN] || !to[TIME_COLUMN]) return null;
  if (i < 0 || i >= from[TIME_COLUMN].length) return null;
  // Compared as strings: int64 line numbers decode to BigInt, and a title column holds strings.
  const line = String(from[fromLine][i]);
  const t = Number(from[TIME_COLUMN][i]);
  let best = null, bestDt = Infinity;
  for (let j = 0; j < to[TIME_COLUMN].length; j++) {
    if (String(to[toLine][j]) !== line) continue;
    const dt = Math.abs(Number(to[TIME_COLUMN][j]) - t);
    if (dt < bestDt) { bestDt = dt; best = j; }
  }
  return best;
}

// The selected sounding as a row of the dataset at `datasetPath`: the selected row itself for
// current.* datasets, the row matched by line and gtime for pinned ones. Reads the plot data's
// _currentSounding and _currentFlightlines (the current dataset that row indexes).
export function soundingIndex(rawData, datasetPath) {
  const cs = rawData?._currentSounding;
  if (cs == null || !datasetPath || datasetPath.startsWith('current.')) return cs;
  return matchSounding(rawData._currentFlightlines, cs, resolveDataPath(rawData, datasetPath)?.flightlines);
}

// The reverse: row `i` of the dataset at `datasetPath` as a selected sounding of the current dataset.
export function currentSoundingFrom(rawData, datasetPath, i) {
  if (!datasetPath || datasetPath.startsWith('current.')) return i;
  return matchSounding(resolveDataPath(rawData, datasetPath)?.flightlines, i, rawData?._currentFlightlines);
}

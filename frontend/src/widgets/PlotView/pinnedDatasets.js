// Pinned datasets: a layer parameter "<procName>.<version>.<dsName>[@<part>][.<col…>]" names an
// output of another process version, as opposed to "current.<dsName>…", which is the active
// process's data for the part selected in the top bar.
//
// A pinned dataset's parts are not the current dataset's, so parts are never matched by name.
// By default a pinned path follows the selected line: the pinned dataset's part with the same
// Line value as the selected part is shown, found from the parts' statistics sidecars. With no
// such part the panel stays empty and says so. A path can instead name a fixed part,
// "<procName>.<version>.<dsName>@<part>", which stays put whatever is selected; the part rides
// inside the dataset segment, so the path resolves like any other dataset path. Soundings are
// matched by line and gtime (soundingMatch.js).
import { loadDataset } from '../../datamodel/dataset';
import { encodeSeg } from '../../datamodel/datasetPath';
import { lineColumn } from './soundingMatch.js';

const PART_SEP = '@';
// The line followed when every part is selected: the pinned dataset loads every part too.
export const ALL_LINES = 'all';

// The "<procName>.<version>.<dsName>[@<part>]" paths of the pinned datasets the layers reference.
function pinnedDatasetPaths(layers) {
  const paths = new Set();
  for (const layer of layers || []) {
    if (!layer || typeof layer !== 'object') continue;
    for (const params of Object.values(layer)) {
      if (!params || typeof params !== 'object') continue;
      for (const val of Object.values(params)) {
        if (typeof val !== 'string') continue;
        const segs = val.split('.');
        if (segs.length >= 3 && segs[0] !== 'current') paths.add(segs.slice(0, 3).join('.'));
      }
    }
  }
  return paths;
}

// The dataset id a pinned path names, and its encoded part segment (null when it follows the line).
function parsePinnedPath(dsPath, processes) {
  // dsPath segments are encoded — match back to real objects in encoded space.
  const [procNameSeg, verStr, dsSeg] = dsPath.split('.');
  const at = dsSeg.lastIndexOf(PART_SEP);
  const dsNameSeg = at < 0 ? dsSeg : dsSeg.slice(0, at);
  const partSeg = at < 0 ? null : dsSeg.slice(at + 1);
  const proc = (processes || []).find(p => encodeSeg(p.name) === procNameSeg);
  const ver = (proc?.versions || []).find(v => String(v.version) === verStr);
  const dsKey = Object.keys(ver?.outputs || {}).find(k => encodeSeg(k) === dsNameSeg);
  const dsId = dsKey != null ? ver.outputs[dsKey]?.split('/').pop() : undefined;
  return { dsId, partSeg };
}

// Whether any layer has a pinned path that follows the selected line.
export function followsLine(layers) {
  return [...pinnedDatasetPaths(layers)].some(p => !p.split('.')[2].includes(PART_SEP));
}

// The line pinned panels follow: { line: ALL_LINES } when every part is selected, else
// { line } with the selected part's Line value as a string, or { error } when that part has no
// line column or holds several lines. undefined while the selected part's data is not loaded.
export function selectedLine(currentPart, flightlines) {
  if (currentPart === ALL_LINES) return { line: ALL_LINES };
  if (!flightlines) return undefined;
  const col = lineColumn(flightlines);
  if (!col) return { error: 'The selected part has no line column, so pinned panels cannot follow it.' };
  const lines = new Set(Array.from(flightlines[col], String));
  if (lines.size !== 1) return { error: `The selected part holds ${lines.size} lines, so pinned panels cannot follow one line.` };
  return { line: [...lines][0] };
}

// Dataset id → promise of Map(part path → the part's Line value as a string, or null when its
// statistics have none or several). Outputs are immutable, so this is fetched once per dataset.
const partLinesCache = new Map();

function _partLines(dsId, dsObj) {
  if (!partLinesCache.has(dsId)) {
    const lines = Promise.all(dsObj.getParts().map(part => dsObj.fetchStats(part).then(stats => {
      const stat = stats?.flightlines?.[lineColumn(stats?.flightlines)];
      return [part, stat?.constant ? String(stat.value) : null];
    })));
    partLinesCache.set(dsId, lines.then(entries => new Map(entries)).catch(err => {
      partLinesCache.delete(dsId);
      throw err;
    }));
  }
  return partLinesCache.get(dsId);
}

// The part to load for a pinned path, or { message } when there is none to show.
async function _resolvePart(dsPath, dsId, dsObj, partSeg, line) {
  if (partSeg != null) {
    // A fixed part: part segments are encoded like names — match back in encoded space.
    const part = dsObj.getParts().find(p => encodeSeg(p) === partSeg);
    return part ?? { message: `${dsPath.split(PART_SEP)[0]} has no part "${partSeg}".` };
  }
  if (line === ALL_LINES) return ALL_LINES;
  const partLines = await _partLines(dsId, dsObj);
  for (const [part, partLine] of partLines) if (partLine === line) return part;
  return [...partLines.values()].some(v => v != null)
    ? { message: `${dsPath} has no part with Line ${line}.` }
    : { message: `${dsPath} has no part statistics to find Line ${line} by; name a part with @<part>.` };
}

// Key of one pinned path loaded for one followed line (fixed parts ignore the line).
export const pinnedDataKey = (dsPath, line) =>
  dsPath.includes(PART_SEP) ? dsPath : JSON.stringify([dsPath, line]);

// Load each pinned dataset the layers reference that `loaded` (a Map keyed by pinnedDataKey)
// does not hold yet: the fixed part its path names, or the part with Line `line` (see
// selectedLine; paths that follow the line wait while it is null). Each calls
// onLoaded(key, { dsPath, line, dsObj, rawData }), or with { dsPath, line, message } when
// there is no part to show; the returned promise settles once all have.
export function loadPinnedData(layers, processes, projectId, line, loaded, onLoaded) {
  const loads = [];
  for (const dsPath of pinnedDatasetPaths(layers)) {
    const { dsId, partSeg } = parsePinnedPath(dsPath, processes);
    if (!dsId || (partSeg == null && line == null)) continue;
    const key = pinnedDataKey(dsPath, line);
    if (loaded.has(key)) continue;
    const entryLine = partSeg == null ? line : undefined;
    loads.push(loadDataset(dsId, projectId)
      .then(async dsObj => {
        const part = await _resolvePart(dsPath, dsId, dsObj, partSeg, line);
        if (part.message) return onLoaded(key, { dsPath, line: entryLine, message: part.message });
        const rawData = await dsObj.fetchData(part);
        return onLoaded(key, { dsPath, line: entryLine, dsObj, rawData });
      })
      .catch(err => console.warn(`Failed to lazily load ${dsPath}:`, err)));
  }
  return Promise.all(loads);
}

// The loaded entries to show for followed line `line`: fixed parts, and followed paths loaded for it.
export function pinnedEntries(loaded, line) {
  return [...loaded.values()].filter(e => e.line === undefined || e.line === line);
}

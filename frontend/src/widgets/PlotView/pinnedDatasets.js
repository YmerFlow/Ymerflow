// Pinned datasets: a layer parameter "<procName>.<version>.<dsName>[@<part>][.<col…>]" names an
// output of another process version, as opposed to "current.<dsName>…", which follows the
// active process and the part selected in the top bar. A pinned path names its own part,
// because a pinned dataset's parts need not be the current dataset's; without one it loads
// every part. The part rides inside the dataset segment, so "<procName>.<version>.<dsName>@<part>"
// resolves like any other dataset path. The selected sounding is matched into a pinned dataset
// by line and gtime (soundingMatch.js).
import { loadDataset } from '../../datamodel/dataset';
import { encodeSeg } from '../../datamodel/datasetPath';

const PART_SEP = '@';

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

// The dataset id a pinned path names, and its encoded part segment (null for every part).
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

// Load each pinned dataset the layers reference that `loaded` (a Map keyed by dataset path)
// does not hold yet, for the part its path names. Each calls onLoaded(dsPath, { dsObj, rawData })
// as it arrives; the returned promise settles once all have.
export function loadPinnedData(layers, processes, projectId, loaded, onLoaded) {
  const loads = [];
  for (const dsPath of pinnedDatasetPaths(layers)) {
    if (loaded.has(dsPath)) continue;
    const { dsId, partSeg } = parsePinnedPath(dsPath, processes);
    if (!dsId) continue;
    loads.push(loadDataset(dsId, projectId)
      .then(dsObj => {
        // Part segments are encoded like names — match back in encoded space.
        const part = partSeg == null ? 'all' : dsObj.getParts().find(p => encodeSeg(p) === partSeg);
        if (part == null) throw new Error(`the dataset has no part "${partSeg}"`);
        return dsObj.fetchData(part).then(rawData => onLoaded(dsPath, { dsObj, rawData }));
      })
      .catch(err => console.warn(`Failed to lazily load ${dsPath}:`, err)));
  }
  return Promise.all(loads);
}

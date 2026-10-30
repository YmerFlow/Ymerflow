// Pinned datasets: a layer parameter "<procName>.<version>.<dsName>[.<col…>]" names an
// output of another process version, as opposed to "current.<dsName>…", which follows
// the active process. Both follow the part selected in the top bar, so a pinned panel
// shows the same line as the panels beside it.
import { loadDataset } from '../../datamodel/dataset';
import { encodeSeg } from '../../datamodel/datasetPath';

// The "<procName>.<version>.<dsName>" paths of the pinned datasets the layers reference.
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

// Id of the dataset a pinned path names, or undefined if its process version has no such output.
function pinnedDatasetId(dsPath, processes) {
  // dsPath segments are encoded — match back to real objects in encoded space.
  const [procNameSeg, verStr, dsNameSeg] = dsPath.split('.');
  const proc = (processes || []).find(p => encodeSeg(p.name) === procNameSeg);
  const ver = (proc?.versions || []).find(v => String(v.version) === verStr);
  const dsKey = Object.keys(ver?.outputs || {}).find(k => encodeSeg(k) === dsNameSeg);
  return dsKey != null ? ver.outputs[dsKey]?.split('/').pop() : undefined;
}

// Key of one pinned dataset loaded for one part ("all" or a part path).
export const pinnedDataKey = (dsPath, part) => JSON.stringify([dsPath, part]);

// Load, for `part`, each pinned dataset the layers reference that `loaded` (a Map keyed by
// pinnedDataKey) does not hold yet. Each calls onLoaded(key, { dsPath, part, dsObj, rawData })
// as it arrives; the returned promise settles once all have.
export function loadPinnedData(layers, processes, part, projectId, loaded, onLoaded) {
  const loads = [];
  for (const dsPath of pinnedDatasetPaths(layers)) {
    const key = pinnedDataKey(dsPath, part);
    if (loaded.has(key)) continue;
    const dsId = pinnedDatasetId(dsPath, processes);
    if (!dsId) continue;
    // loadDataset makes a new Dataset object per call, so each part keeps its own cached
    // data for gladly's column lookups.
    loads.push(loadDataset(dsId, projectId)
      .then(dsObj => dsObj.fetchData(part).then(rawData => onLoaded(key, { dsPath, part, dsObj, rawData })))
      .catch(err => console.warn(`Failed to lazily load ${dsPath} (part ${part}):`, err)));
  }
  return Promise.all(loads);
}

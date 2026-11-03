// Pinned datasets: a layer parameter "<procName>.<version>.<dsName>[.<part>][.<col…>]" names an
// output of another process version, as opposed to "current.<dsName>…", which is the active
// process's data for the part selected in the top bar.
//
// A part's name is its line's name, so by default a pinned path follows the selected line: it
// shows the pinned dataset's part with the selected part's name, or every part when "all" is
// selected. With no such part the panel stays empty and says so. A fourth segment that names
// one of the dataset's parts pins that part instead, whatever is selected; any other fourth
// segment is a column of the followed part. Soundings are matched by line and gtime
// (soundingMatch.js).
import { DataGroup } from 'gladly-plot';
import { loadDataset } from '../../datamodel/dataset';
import { encodeSeg } from '../../datamodel/datasetPath';

// The selected part that stands for every part: the pinned dataset loads every part too.
export const ALL_PARTS = 'all';

// "<procName>.<version>.<dsName>" of each pinned dataset the layers reference → the set of
// fourth segments its paths carry (null for a path that ends at the dataset).
function pinnedDatasetPaths(layers) {
  const paths = new Map();
  for (const layer of layers || []) {
    if (!layer || typeof layer !== 'object') continue;
    for (const params of Object.values(layer)) {
      if (!params || typeof params !== 'object') continue;
      for (const val of Object.values(params)) {
        if (typeof val !== 'string') continue;
        const segs = val.split('.');
        if (segs.length < 3 || segs[0] === 'current') continue;
        const dsPath = segs.slice(0, 3).join('.');
        if (!paths.has(dsPath)) paths.set(dsPath, new Set());
        paths.get(dsPath).add(segs[3] ?? null);
      }
    }
  }
  return paths;
}

// The id of the dataset a "<procName>.<version>.<dsName>" path names, if there is one.
function pinnedDatasetId(dsPath, processes) {
  // dsPath segments are encoded — match back to real objects in encoded space.
  const [procNameSeg, verStr, dsNameSeg] = dsPath.split('.');
  const proc = (processes || []).find(p => encodeSeg(p.name) === procNameSeg);
  const ver = (proc?.versions || []).find(v => String(v.version) === verStr);
  const dsKey = Object.keys(ver?.outputs || {}).find(k => encodeSeg(k) === dsNameSeg);
  return dsKey != null ? ver.outputs[dsKey]?.split('/').pop() : undefined;
}

// Load each pinned part the layers reference that `loaded` (a Map of entries) does not hold yet:
// every fixed part a path names, and the part named `selectedPart` for paths that follow the
// line. Each calls onLoaded(key, { path, part, dsObj, rawData }), where `path` is where the data
// sits in the plot data and `part` the selected part it follows (undefined for a fixed part), or
// onLoaded(key, { path, part, message }) when the dataset has no such part. The returned
// promise settles once all have.
export function loadPinnedData(layers, processes, projectId, selectedPart, loaded, onLoaded) {
  const loads = [];
  for (const [dsPath, fourthSegs] of pinnedDatasetPaths(layers)) {
    const dsId = pinnedDatasetId(dsPath, processes);
    if (!dsId) continue;
    loads.push(loadDataset(dsId, projectId).then(meta => {
      // Part names are encoded in paths like any other segment — match in encoded space.
      const parts = meta.getParts();
      const partSegs = new Set(parts.map(encodeSeg));
      const wanted = parts.filter(p => fourthSegs.has(encodeSeg(p)))
        .map(p => ({ key: `${dsPath}.${encodeSeg(p)}`, path: `${dsPath}.${encodeSeg(p)}`, name: p }));
      if ([...fourthSegs].some(s => !partSegs.has(s))) {
        const found = selectedPart === ALL_PARTS || parts.includes(selectedPart);
        wanted.push({ key: JSON.stringify([dsPath, selectedPart]), path: dsPath, part: selectedPart,
          name: found ? selectedPart : undefined });
      }
      return Promise.all(wanted.filter(w => !loaded.has(w.key)).map(async ({ key, path, part, name }) => {
        if (name === undefined) return onLoaded(key, { path, part, message: `${dsPath} has no part ${part}.` });
        // One Dataset object per part: it serves gladly the columns of the part it fetched last.
        const dsObj = await loadDataset(dsId, projectId);
        return onLoaded(key, { path, part, dsObj, rawData: await dsObj.fetchData(name) });
      }));
    }).catch(err => console.warn(`Failed to lazily load ${dsPath}:`, err)));
  }
  return Promise.all(loads);
}

// The loaded entries to show while `selectedPart` is selected: fixed parts, and followed parts loaded for it.
export function pinnedEntries(loaded, selectedPart) {
  return [...loaded.values()].filter(e => e.part === undefined || e.part === selectedPart);
}

// gladly's view of one pinned dataset: "<part>.<col>" reads that fixed part, any other column
// the followed part.
class PinnedGroup extends DataGroup {
  constructor() { super({}); this.followed = undefined; }
  columns() { return [...(this.followed?.columns() ?? []), ...super.columns()]; }
  getData(col) { return this._resolve(col) ? super.getData(col) : this.followed?.getData(col); }
  getQuantityKind(col) { return this._resolve(col) ? super.getQuantityKind(col) : this.followed?.getQuantityKind(col); }
  getDomain(col) { return this._resolve(col) ? super.getDomain(col) : this.followed?.getDomain?.(col); }
}

// Put the entries into the plot data at their paths: raw data as own properties, which custom
// layers read with resolveDataPath, and Dataset objects in the _children chain, which gladly's
// built-in layers read. A fixed part sits under its dataset, beside the followed part's data.
export function addPinnedData(dataForPlot, entries) {
  for (const { path, dsObj, rawData } of entries) {
    if (!dsObj) continue;   // no part to show: the panel says why
    const [procName, ver, dsName, partSeg] = path.split('.');
    const raws = ((dataForPlot[procName] ??= {})[ver] ??= {});
    const group = ((dataForPlot._children[procName] ??= new DataGroup({}))._children[ver] ??= new DataGroup({}));
    const node = (group._children[dsName] ??= new PinnedGroup());
    if (partSeg === undefined) {
      // Wrapped, so fixed parts can sit on the followed part without changing the loaded data.
      raws[dsName] = Object.assign(Object.create(rawData), raws[dsName]);
      node.followed = dsObj;
    } else {
      (raws[dsName] ??= {})[partSeg] = rawData;
      node._children[partSeg] = dsObj;
    }
  }
}

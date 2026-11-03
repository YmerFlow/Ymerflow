// Saved in-use edits live in one of two places (docs/plans/pipeline-edit-points.md):
// - on a pipeline's save point, a `save_intermediate_and_apply_diff` step whose args hold
//   the point's output dataset `name` and one `diff` URL. The editor loads that diff when
//   the point is plotted, and Save replaces it with the whole edited state;
// - in a process-level `diff` list (`apply_manual_edits`), one URL per save, replayed in
//   order. Each of those diffs holds only the edits of its own round.
import { encodeSeg } from './datasetPath';
import { resolveProcessRef } from './processRef';

// What a plot's edits belong to. Edits are stored under the plot layer's dataset
// path, "current.<dataset>" or "<process>.<version>.<dataset>" (segments encoded,
// see datasetPath.js). Returns { process, versionObj, datasetName } for the version
// whose output was edited, or null if the path no longer resolves.
export function resolveEditTarget(path, activeProcess, processes) {
  const parts = String(path ?? '').split('.');
  const isCurrent = parts[0] === 'current';
  const ref = isCurrent
    ? resolveProcessRef('current', activeProcess, processes)
    : resolveProcessRef(`${parts[0]}.${parts[1]}`, activeProcess, processes);
  const datasetSeg = isCurrent ? parts[1] : parts[2];
  if (!ref?.process || !ref.versionObj || datasetSeg == null) return null;
  const datasetName = Object.keys(ref.versionObj.outputs || {}).find(k => encodeSeg(k) === datasetSeg);
  if (datasetName == null) return null;
  return { process: ref.process, versionObj: ref.versionObj, datasetName };
}

// ── In-memory edits ──────────────────────────────────────────────────────────
// The store every in-use editing layer writes to and reads from (ProcessContext holds it):
// diffs:   { [datasetPath]: { [channel]: Map<gateIndex, Map<soundingIndex, 0|1>> } }
// history: { [datasetPath]: snapshot[] }  (per-dataset undo stack)
// dirty:   { [datasetPath]: boolean }     (changed since a save point's edit loaded; Save
//                                          writes only dirty paths)

function _deepCopyDatasetDiff(datasetDiff) {
  const result = {};
  for (const [channel, channelMap] of Object.entries(datasetDiff)) {
    const newMap = new Map();
    for (const [gateIdx, soundingMap] of channelMap.entries()) {
      newMap.set(gateIdx, new Map(soundingMap));
    }
    result[channel] = newMap;
  }
  return result;
}

// `over` laid on top of `base`: where both hold an edit for a gate and sounding, `over`
// wins. Neither input is modified.
function _mergeDatasetDiffs(base, over) {
  const result = _deepCopyDatasetDiff(base);
  for (const [channel, channelMap] of Object.entries(over)) {
    if (!result[channel]) result[channel] = new Map();
    for (const [gateIdx, soundingMap] of channelMap.entries()) {
      result[channel].set(gateIdx, new Map([...(result[channel].get(gateIdx) ?? []), ...soundingMap]));
    }
  }
  return result;
}

export function inUseDiffReducer(state, action) {
  switch (action.type) {
    case 'LOAD': {
      // A save point's saved edit, loaded into the editor. Loading is not a change: the path
      // is clean until the person edits it, and a clean path's edit is replaced by a newer
      // load (the path now names another version). On a dirty path the person lassoed
      // before the load finished; their edits are kept on top of the loaded one, in every
      // undo step, so Save still writes the whole edit for the point.
      const { datasetName, diff } = action;
      if (state.dirty[datasetName]) {
        return {
          ...state,
          diffs: { ...state.diffs, [datasetName]: _mergeDatasetDiffs(diff, state.diffs[datasetName] ?? {}) },
          history: {
            ...state.history,
            [datasetName]: (state.history[datasetName] ?? []).map(s => _mergeDatasetDiffs(diff, s)),
          },
        };
      }
      // Loaded paths go first: the InUse Editor's Undo acts on the last path in `diffs`,
      // which should stay the one the person edited.
      const { [datasetName]: _replaced, ...otherDiffs } = state.diffs; // eslint-disable-line no-unused-vars
      return {
        diffs: { [datasetName]: diff, ...otherDiffs },
        history: { ...state.history, [datasetName]: [] },
        dirty: { ...state.dirty, [datasetName]: false },
      };
    }
    case 'APPLY_EDIT': {
      const { datasetName, channel, entries, value } = action;
      const prevDatasetDiff = state.diffs[datasetName] ?? {};

      // Push snapshot before mutating
      const snapshot = _deepCopyDatasetDiff(prevDatasetDiff);
      const newHistory = {
        ...state.history,
        [datasetName]: [...(state.history[datasetName] ?? []), snapshot],
      };

      // Apply edits
      const newDatasetDiff = _deepCopyDatasetDiff(prevDatasetDiff);
      if (!newDatasetDiff[channel]) newDatasetDiff[channel] = new Map();
      const channelMap = newDatasetDiff[channel];

      for (const { soundingIndex, gateIndex } of entries) {
        if (!channelMap.has(gateIndex)) channelMap.set(gateIndex, new Map());
        const soundingMap = channelMap.get(gateIndex);
        if (value === undefined || value === null) {
          soundingMap.delete(soundingIndex);
        } else {
          soundingMap.set(soundingIndex, value);
        }
        if (soundingMap.size === 0) channelMap.delete(gateIndex);
      }

      return {
        diffs: { ...state.diffs, [datasetName]: newDatasetDiff },
        history: newHistory,
        dirty: { ...state.dirty, [datasetName]: true },
      };
    }
    case 'UNDO': {
      // Undo with nothing to undo changes nothing, so it leaves the path's flag alone.
      const { datasetName } = action;
      const history = state.history[datasetName] ?? [];
      if (history.length === 0) return state;
      const prevSnapshot = history[history.length - 1];
      return {
        diffs: { ...state.diffs, [datasetName]: prevSnapshot },
        history: { ...state.history, [datasetName]: history.slice(0, -1) },
        dirty: { ...state.dirty, [datasetName]: true },
      };
    }
    case 'CLEAR': {
      const { datasetName } = action;
      const { [datasetName]: _dropped, ...dirty } = state.dirty; // eslint-disable-line no-unused-vars
      return {
        diffs: { ...state.diffs, [datasetName]: {} },
        history: { ...state.history, [datasetName]: [] },
        dirty,
      };
    }
    case 'CLEAR_ALL':
      return { diffs: {}, history: {}, dirty: {} };
    default:
      return state;
  }
}

// A pipeline's save point for one dataset: the entry of `steps` whose args name that
// dataset and carry a `diff` field (a URL, or null when the point has no edit yet).
// `steps` is swaggerspect's multi=True list of single-key objects { "<step key>": args }.
// The key differs per library (emerald "Save intermediate results and apply manual edits",
// ymerflow "save_intermediate_and_apply_diff"), so the match is on the args, never the key.
// Returns { step, key, args }, or null when nothing matches or `steps` is not a list.
export function saveIntermediateStep(steps, datasetName) {
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const [key, args] = Object.entries(step ?? {})[0] ?? [];
    if (args && typeof args === 'object' && args.name === datasetName && 'diff' in args) {
      return { step, key, args };
    }
  }
  return null;
}

// The in-memory edit held in one saved diff, the inverse of buildDiffColumns: per
// InUse_<channel> layer, per gate column, each row that is not NaN becomes an edit of
// sounding apply_idx[row]. Returns { [channel]: Map<gateKey, Map<soundingIndex, 0|1>> }.
// Sounding indices are Numbers, as the lasso keys them (apply_idx may decode to BigInt);
// gates and channels with no edit are left out.
export function diffFromColumns(xyz) {
  const applyIdx = xyz.flightlines?.apply_idx ?? [];
  const datasetDiff = {};
  for (const [layer, gateMap] of Object.entries(xyz.layer_data ?? {})) {
    if (!layer.startsWith('InUse_')) continue;
    const channelMap = new Map();
    for (const [gateKey, col] of gateMap.entries()) {
      const soundingMap = new Map();
      for (let row = 0; row < col.length; row++) {
        const value = Number(col[row]);
        if (!Number.isNaN(value)) soundingMap.set(Number(applyIdx[row]), value);
      }
      if (soundingMap.size > 0) channelMap.set(gateKey, soundingMap);
    }
    if (channelMap.size > 0) datasetDiff[layer.slice('InUse_'.length)] = channelMap;
  }
  return datasetDiff;
}

// The parameters of the version a Save makes for one process, from all of its changed
// datasets. `edits` is [{ datasetName, diffUrl }]; diffUrl is a URL, or null for a save
// point whose edit the person emptied. A dataset with a save point gets that step's `diff`
// replaced, its other args and all other steps untouched. Any other dataset's URL is
// appended to the process-level `diff` list. The edited version's parameters are not
// modified.
export function editedParameters(editedVer, edits) {
  const params = { ...editedVer.parameters };
  for (const { datasetName, diffUrl } of edits) {
    const point = saveIntermediateStep(params.steps, datasetName);
    if (point) {
      params.steps = params.steps.map(s => s === point.step ? { [point.key]: { ...point.args, diff: diffUrl } } : s);
    } else {
      params.diff = appendDiff(params.diff, diffUrl);
    }
  }
  return params;
}

// The diffs of the version being built on, with the new round's URL added.
// `previous` is a list, a single URL (versions saved before diffs accumulated),
// or nothing. The input is not modified.
export function appendDiff(previous, url) {
  const earlier = Array.isArray(previous) ? previous : previous ? [previous] : [];
  return [...earlier, url];
}

// The createProcess request for the version a Save makes: the edited version re-run with
// this round's edits (`edits` as for editedParameters). It keeps the edited version's
// cluster, resources and deadline; left out, the server would use its defaults (first
// cluster, 1 CPU, 2 Gi, 1 h), and a large dataset re-run in 2 Gi runs out of memory.
// Fields the version does not have are left to those defaults; deadline_seconds may not
// be null, so it is then omitted.
export function editedVersionRequest(proc, editedVer, edits) {
  const request = {
    id: proc.id,
    name: proc.name,
    type: editedVer.type,
    environment: { id: editedVer.environment?.id },
    params: editedParameters(editedVer, edits),
    resource_requests: editedVer.resource_requests ?? null,
    cluster: editedVer.cluster?.id ? { id: editedVer.cluster.id } : null,
  };
  if (editedVer.deadline_seconds != null) request.deadline_seconds = editedVer.deadline_seconds;
  return request;
}

// Whether a Save on this output of `editedVer` would be replayed: the version has a save
// point for the dataset, or its process type's form declares a process-level `diff`.
// Edits saved anywhere else would create a version that re-runs without them.
// `processTypes` is an environment's process types, keyed by type name.
export function acceptsEdits(processTypes, editedVer, datasetName) {
  return saveIntermediateStep(editedVer?.parameters?.steps, datasetName) != null
    || Boolean(processTypes?.[editedVer?.type]?.schema?.properties?.diff);
}

// The columns of one saved diff: apply_idx, the sorted global sounding indices that carry
// an edit, and per channel one InUse column per gate holding the edit (1 or 0) or NaN.
// `datasetDiff` is { [channel]: Map<gateKey, Map<soundingIndex, 0|1>> }. Sounding indices
// are taken as Numbers: apply_idx is int64 on disk and decodes to BigInt, which cannot be
// sorted with (a, b) => a - b or stored in a Float32Array.
export function buildDiffColumns(datasetDiff) {
  const soundings = new Set();
  for (const channelMap of Object.values(datasetDiff)) {
    for (const soundingMap of channelMap.values()) {
      for (const si of soundingMap.keys()) soundings.add(Number(si));
    }
  }
  const applyIdx = [...soundings].sort((a, b) => a - b);
  const row = new Map(applyIdx.map((si, i) => [si, i]));

  const layerData = {};
  for (const [channel, channelMap] of Object.entries(datasetDiff)) {
    const gateMap = new Map();
    for (const [gateKey, soundingMap] of channelMap.entries()) {
      const col = new Float32Array(applyIdx.length).fill(NaN);
      for (const [si, val] of soundingMap.entries()) col[row.get(Number(si))] = val;
      gateMap.set(gateKey, col);
    }
    layerData[`InUse_${channel}`] = gateMap;
  }
  return { applyIdx, layerData };
}

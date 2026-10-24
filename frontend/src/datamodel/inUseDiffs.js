// Saved in-use edits accumulate: a process version's `diff` parameter is a list
// of diff URLs, one per save, replayed in order. Each diff holds only the edits
// of its own round, made on the output of the version before it.
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

// The diffs of the version being built on, with the new round's URL added.
// `previous` is a list, a single URL (versions saved before diffs accumulated),
// or nothing. The input is not modified.
export function appendDiff(previous, url) {
  const earlier = Array.isArray(previous) ? previous : previous ? [previous] : [];
  return [...earlier, url];
}

// Whether a process type replays saved edits: its form declares `diff`. Edits saved on
// the output of one that does not would create a version that re-runs without them.
// `processTypes` is an environment's process types, keyed by type name.
export function acceptsEdits(processTypes, typeName) {
  return Boolean(processTypes?.[typeName]?.schema?.properties?.diff);
}

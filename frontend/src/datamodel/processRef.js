// Resolve a process/version reference string to concrete objects.
//
// A process/version reference is the 2-segment analogue of the 3-segment dataset
// path used by PlotView:
//   - "current"              → the active process/version from ProcessContext.activeProcess
//   - "<procName>.<version>" → a specific process (matched by name) and numeric version
//
// Returns { processId, version, process, versionObj } or null when the reference
// cannot be resolved (no active process, or a stale/removed reference).
export function resolveProcessRef(value, activeProcess, processes) {
  let processId, version;
  if (!value || value === 'current') {
    if (!activeProcess) return null;
    ({ processId, version } = activeProcess);
  } else {
    const [procName, verStr] = value.split('.');
    const proc = (processes || []).find(p => p.name === procName);
    if (!proc) return null;
    processId = proc.id;
    version = parseInt(verStr, 10);
  }
  const process = (processes || []).find(p => p.id === processId);
  const versionObj = process?.versions?.find(v => v.version === version);
  return { processId, version, process, versionObj };
}

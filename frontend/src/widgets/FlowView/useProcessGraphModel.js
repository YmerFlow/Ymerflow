import { useContext, useState, useCallback, useMemo, useEffect } from "react";
import { ProcessContext } from '../../ProcessContext';
import { getProcessVersion } from '../../datamodel/api';
import { useProjectTags, useSearchDatasets } from '../../datamodel/useQueries';
import { buildMimeColorMap } from './mimeColors';

// ---- Pure helper functions (shared by both display modes) ----

export function isVersionVisible(visibleVersions, pid, ver) {
  if (visibleVersions === null) return true;
  return visibleVersions.get(pid)?.has(ver) ?? false;
}

// Returns Map<processId, Set<versionNumber>> of visible versions, or null (all visible).
export function computeVisibleVersions(processes, selectedFilterTagNames) {
  if (selectedFilterTagNames.size === 0) return null;

  const processById = new Map(processes.map(p => [p.id, p]));
  const visible = new Map();

  const markVisible = (pid, ver) => {
    if (!visible.has(pid)) visible.set(pid, new Set());
    visible.get(pid).add(ver);
  };

  // Seed: versions that have all filter tags (matched by name, not id — tag ids are
  // per-project so a filter persisted in a shared workspace only carries over by name)
  processes.forEach(process => {
    process.versions?.forEach(v => {
      const vTagNames = new Set((v.tags || []).map(t => t.name));
      if ([...selectedFilterTagNames].every(name => vTagNames.has(name))) {
        markVisible(process.id, v.version);
      }
    });
  });

  // BFS: expand to transitive dependencies
  const queue = [];
  visible.forEach((versions, pid) => versions.forEach(ver => queue.push({ pid, ver })));
  const visited = new Set();

  while (queue.length > 0) {
    const { pid, ver } = queue.shift();
    const key = `${pid}:${ver}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const proc = processById.get(pid);
    const verObj = proc?.versions?.find(v => v.version === ver);
    verObj?.dependencies?.forEach(dep => {
      const depKey = `${dep.source_process_id}:${dep.source_process_version}`;
      if (!visited.has(depKey)) {
        markVisible(dep.source_process_id, dep.source_process_version);
        queue.push({ pid: dep.source_process_id, ver: dep.source_process_version });
      }
    });
  }

  return visible;
}

// Two-sweep propagation from a touched (processId, version).
// Returns a partial selectedVersions map covering all reachable processes.
export function propagate(processes, startProcessId, startVersion, visibleVersions) {
  const result = { [startProcessId]: startVersion };
  const processById = new Map(processes.map(p => [p.id, p]));
  const upVisited = new Set();
  const downVisited = new Set([startProcessId]);

  // Upward DFS: follow dependency edges towards sources
  const upwardDFS = (pid, ver) => {
    if (upVisited.has(pid)) return;
    upVisited.add(pid);
    const proc = processById.get(pid);
    const verObj = proc?.versions?.find(v => v.version === ver);
    if (!verObj) return;
    verObj.dependencies?.forEach(dep => {
      if (isVersionVisible(visibleVersions, dep.source_process_id, dep.source_process_version)) {
        result[dep.source_process_id] = dep.source_process_version;
        upwardDFS(dep.source_process_id, dep.source_process_version);
      }
    });
  };

  upwardDFS(startProcessId, startVersion);

  // Downward DFS: follow reverse-dependency edges towards sinks
  const downwardDFS = (pid, ver) => {
    const downstream = processes
      .filter(p => !downVisited.has(p.id) && p.versions?.some(v =>
        isVersionVisible(visibleVersions, p.id, v.version) &&
        v.dependencies?.some(dep =>
          dep.source_process_id === pid && dep.source_process_version === ver
        )
      ))
      .sort((a, b) => a.id.localeCompare(b.id));

    downstream.forEach(p => {
      const candidates = (p.versions || [])
        .filter(v =>
          isVersionVisible(visibleVersions, p.id, v.version) &&
          v.dependencies?.some(dep =>
            dep.source_process_id === pid && dep.source_process_version === ver
          )
        )
        .sort((a, b) => b.version - a.version);

      if (candidates.length > 0) {
        const chosenVer = candidates[0].version;
        result[p.id] = chosenVer;
        downVisited.add(p.id);
        downwardDFS(p.id, chosenVer);
      }
    });
  };

  downwardDFS(startProcessId, startVersion);

  return result;
}

// Full initialisation: latest-visible-version baseline for all sinks, then activeProcess override.
export function initialise(processes, visibleVersions, activeProcess) {
  if (processes.length === 0) return {};

  const hasDownstream = new Set();
  processes.forEach(p => {
    p.versions?.forEach(v => {
      if (!isVersionVisible(visibleVersions, p.id, v.version)) return;
      v.dependencies?.forEach(dep => {
        if (isVersionVisible(visibleVersions, dep.source_process_id, dep.source_process_version)) {
          hasDownstream.add(dep.source_process_id);
        }
      });
    });
  });

  const visiblePids = visibleVersions === null
    ? new Set(processes.map(p => p.id))
    : new Set([...visibleVersions.keys()]);

  const sinks = processes
    .filter(p => visiblePids.has(p.id) && !hasDownstream.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  let result = {};

  sinks.forEach(sink => {
    const sinkVersions = visibleVersions === null
      ? (sink.versions || []).map(v => v.version)
      : [...(visibleVersions.get(sink.id) || [])];
    if (sinkVersions.length === 0) return;
    const latestVer = Math.max(...sinkVersions);
    Object.assign(result, propagate(processes, sink.id, latestVer, visibleVersions));
  });

  if (activeProcess && isVersionVisible(visibleVersions, activeProcess.processId, activeProcess.version)) {
    Object.assign(result, propagate(processes, activeProcess.processId, activeProcess.version, visibleVersions));
  }

  return result;
}

// ---- Shared derivation hook ----
//
// Owns the mode-independent derivation both FlowView display modes share: the
// version-selection propagation (so graph and tree stay in lock-step), tag-filter
// visibility, the upstream/downstream dependency maps + roots, and the per-dataset
// color map. The ReactFlow layout/render (graph) and the forest render (tree) each
// consume this, keeping a single source of truth for propagation.
export function useProcessGraphModel(selectedFilterTagNames) {
  const {
    processes, activeProcess, setActiveProcess, currentProject
  } = useContext(ProcessContext);

  const [selectedVersions, setSelectedVersions] = useState({});

  const { data: projectTags = [] } = useProjectTags(currentProject);

  // Color each process's output (dataset) boxes by their dataset's main mime type,
  // using a project-wide categorical palette. Mimes are sorted alphabetically before
  // color assignment (in buildMimeColorMap), so colors are stable across the project.
  const { data: allDatasets = [] } = useSearchDatasets('', true, currentProject);
  const datasetColorById = useMemo(() => {
    const mimeColor = buildMimeColorMap(allDatasets.map(d => d.mime_type));
    return new Map(allDatasets.map(d => [d.id, mimeColor.get(d.mime_type)]));
  }, [allDatasets]);

  const visibleVersions = useMemo(
    () => computeVisibleVersions(processes, selectedFilterTagNames),
    [processes, selectedFilterTagNames]
  );

  const visibleProcessIds = useMemo(() => {
    if (visibleVersions === null) return null;
    return new Set([...visibleVersions.keys()]);
  }, [visibleVersions]);

  // Re-initialise whenever processes load or the filter changes.
  // activeProcess is captured from closure (intentionally not in deps — its changes
  // are handled by the sync effect below).
  useEffect(() => {
    setSelectedVersions(initialise(processes, visibleVersions, activeProcess));
  }, [processes, visibleVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleVersionChange = useCallback((processId, newVersion) => {
    const propagated = propagate(processes, processId, newVersion, visibleVersions);
    setSelectedVersions(prev => ({ ...prev, ...propagated }));
    // Keep activeProcess.version in sync; both updates batch into the same render
    // so the sync effect below never sees a transient mismatch.
    if (activeProcess?.processId === processId) {
      setActiveProcess({ ...activeProcess, version: newVersion });
    }
  }, [processes, visibleVersions, activeProcess, setActiveProcess]);

  // When activeProcess is changed externally, propagate from the new version if visible.
  // Uses functional setSelectedVersions to avoid stale closure on selectedVersions.
  useEffect(() => {
    if (!activeProcess) return;
    if (!isVersionVisible(visibleVersions, activeProcess.processId, activeProcess.version)) return;
    setSelectedVersions(prev => {
      if (prev[activeProcess.processId] === activeProcess.version) return prev;
      return { ...prev, ...propagate(processes, activeProcess.processId, activeProcess.version, visibleVersions) };
    });
  }, [activeProcess, visibleVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Upstream map: for each process, the source processes its selected version depends on
  // (restricted to deps whose source's selected version matches). This is exactly what
  // graph mode's depth layout consumes, and its inverse (downstreamMap) drives the forest.
  const upstreamMap = useMemo(() => {
    const map = {};
    processes.forEach(p => {
      map[p.id] = [];
      const versionObj = getProcessVersion(p, selectedVersions[p.id]);
      versionObj?.dependencies?.forEach(dep => {
        if (selectedVersions[dep.source_process_id] === dep.source_process_version) {
          if (!map[p.id].includes(dep.source_process_id)) {
            map[p.id].push(dep.source_process_id);
          }
        }
      });
    });
    return map;
  }, [processes, selectedVersions]);

  // Downstream map: inverse of upstreamMap — for each process, the processes whose
  // selected version depends on it (its forest children).
  const downstreamMap = useMemo(() => {
    const map = {};
    processes.forEach(p => { map[p.id] = []; });
    processes.forEach(p => {
      (upstreamMap[p.id] || []).forEach(srcId => {
        if (map[srcId] && !map[srcId].includes(p.id)) map[srcId].push(p.id);
      });
    });
    return map;
  }, [processes, upstreamMap]);

  // Roots: processes whose selected version has no (selected) dependency.
  const roots = useMemo(
    () => processes.filter(p => (upstreamMap[p.id] || []).length === 0),
    [processes, upstreamMap]
  );

  const visibleVersionsForProcess = useCallback(
    (pid) => (visibleVersions === null ? null : (visibleVersions.get(pid) || new Set())),
    [visibleVersions]
  );

  return {
    processes,
    activeProcess,
    setActiveProcess,
    currentProject,
    projectTags,
    selectedVersions,
    visibleVersions,
    visibleProcessIds,
    visibleVersionsForProcess,
    handleVersionChange,
    upstreamMap,
    downstreamMap,
    roots,
    datasetColorById,
  };
}

import React, { useContext, useState, useCallback, useMemo, useRef } from "react";
import ReactFlow, { Background, useNodesState, useEdgesState, Position } from "reactflow";
import 'reactflow/dist/style.css';
import { ProcessContext } from '../../ProcessContext';
import { useEffect } from "react";
import { useRegisterMenu } from "../../flexout/MenuContext";
import { LayoutContext } from "../../flexout/LayoutContext";
import ProcessNode from './ProcessNode';
import TagFilterBar from './TagFilterBar';
import { getLatestVersion, getProcessVersion, updateProcessPosition } from '../../datamodel/api';
import { useProjectTags } from '../../datamodel/useQueries';
import { useIsMobile } from '../../hooks/useIsMobile';

// ---- Pure helper functions ----

function isVersionVisible(visibleVersions, pid, ver) {
  if (visibleVersions === null) return true;
  return visibleVersions.get(pid)?.has(ver) ?? false;
}

// Returns Map<processId, Set<versionNumber>> of visible versions, or null (all visible).
function computeVisibleVersions(processes, selectedFilterTagIds) {
  if (selectedFilterTagIds.size === 0) return null;

  const processById = new Map(processes.map(p => [p.id, p]));
  const visible = new Map();

  const markVisible = (pid, ver) => {
    if (!visible.has(pid)) visible.set(pid, new Set());
    visible.get(pid).add(ver);
  };

  // Seed: versions that have all filter tags
  processes.forEach(process => {
    process.versions?.forEach(v => {
      const vTagIds = new Set((v.tags || []).map(t => t.id));
      if ([...selectedFilterTagIds].every(id => vTagIds.has(id))) {
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
function propagate(processes, startProcessId, startVersion, visibleVersions) {
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
function initialise(processes, visibleVersions, activeProcess) {
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

// ---- Component ----

export default function FlowView({ parentUpdate, selectedFilterTagIds: savedFilterTagIds = [], ...nodeProps }) {
  const isMobile = useIsMobile();
  const {
    processes, setProcesses, activeProcess, setActiveProcess, startNewProcess, currentProject, isLoading
  } = useContext(ProcessContext);
  const { findWidgetPaths, activatePath } = useContext(LayoutContext);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedVersions, setSelectedVersions] = useState({});

  const selectedFilterTagIds = useMemo(() => new Set(savedFilterTagIds), [savedFilterTagIds]);

  const { data: projectTags = [] } = useProjectTags(currentProject);

  const userPositionedNodes = useRef({});
  const lastProcessStructure = useRef(null);
  const rfInstanceRef = useRef(null);
  const prevProcessCountRef = useRef(0);

  useEffect(() => {
    userPositionedNodes.current = {};
    lastProcessStructure.current = null;
    prevProcessCountRef.current = 0;
    setNodes([]);
    setEdges([]);
  }, [currentProject, setNodes, setEdges]);

  const nodeTypes = useMemo(() => ({ processNode: ProcessNode }), []);

  useRegisterMenu(["Process", "Create"], () => {
    startNewProcess();
    const paths = findWidgetPaths('ProcessEditor');
    if (paths.length > 0) activatePath(paths[0]);
  });

  const visibleVersions = useMemo(
    () => computeVisibleVersions(processes, selectedFilterTagIds),
    [processes, selectedFilterTagIds]
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

  const calculateDepths = useCallback(() => {
    const depths = {};
    const visited = new Set();

    const upstreamMap = {};
    processes.forEach(p => {
      upstreamMap[p.id] = [];
      const version = selectedVersions[p.id];
      const versionObj = getProcessVersion(p, version);
      if (versionObj?.dependencies) {
        versionObj.dependencies.forEach(dep => {
          if (selectedVersions[dep.source_process_id] === dep.source_process_version) {
            upstreamMap[p.id].push(dep.source_process_id);
          }
        });
      }
    });

    const calculateDepth = (processId) => {
      if (depths[processId] !== undefined) return depths[processId];
      if (visited.has(processId)) return 0;
      visited.add(processId);
      const upstream = upstreamMap[processId] || [];
      if (upstream.length === 0) {
        depths[processId] = 0;
      } else {
        const maxUpstreamDepth = Math.max(...upstream.map(id => calculateDepth(id)));
        depths[processId] = maxUpstreamDepth + 1;
      }
      return depths[processId];
    };

    processes.forEach(p => calculateDepth(p.id));
    return depths;
  }, [processes, selectedVersions]);

  const handleNodeClick = useCallback((processId, version) => {
    setActiveProcess({ processId, version });
  }, [setActiveProcess]);

  const getProcessStructure = useCallback(() => {
    return JSON.stringify(processes.map(p => ({
      id: p.id,
      versions: p.versions?.map(v => ({
        version: v.version,
        dependencies: v.dependencies
      }))
    })));
  }, [processes]);

  const handleNodesChangeWithTracking = useCallback((changes) => {
    changes.forEach(change => {
      if (change.type === 'position') {
        // React Flow provides `position` only on dragging:true events, not on drag-end.
        // Track it here so we have the final value when dragging:false fires.
        if (change.position) {
          userPositionedNodes.current[change.id] = change.position;
        }
        if (change.dragging === false) {
          const pos = userPositionedNodes.current[change.id];
          if (pos) {
            updateProcessPosition(change.id, pos.x, pos.y, currentProject);
          }
        }
      }
    });
    onNodesChange(changes);
  }, [onNodesChange, currentProject]);

  const handleToggleFilterTag = useCallback((tagId) => {
    const next = new Set(selectedFilterTagIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    parentUpdate?.('replace', nodeProps.id, { ...nodeProps, selectedFilterTagIds: [...next] });
  }, [selectedFilterTagIds, parentUpdate, nodeProps]);

  useEffect(() => {
    if (Object.keys(selectedVersions).length === 0) return;

    const currentStructure = getProcessStructure();
    const structureChanged = currentStructure !== lastProcessStructure.current;
    if (structureChanged) lastProcessStructure.current = currentStructure;

    const newProcessAdded = processes.length > prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    const depths = calculateDepths();
    const layerMap = {};
    processes.forEach(p => {
      const depth = depths[p.id] || 0;
      if (!layerMap[depth]) layerMap[depth] = [];
      layerMap[depth].push(p);
    });

    const horizontalSpacing = 300;
    const verticalSpacing = 150;

    // Per-layer max stored y, so auto-placed nodes don't overlap manually positioned ones.
    const layerMaxStoredY = {};
    processes.forEach(p => {
      if (p.flow_x != null && p.flow_y != null) {
        const depth = depths[p.id] || 0;
        if (layerMaxStoredY[depth] == null || p.flow_y > layerMaxStoredY[depth]) {
          layerMaxStoredY[depth] = p.flow_y;
        }
      }
    });

    const newNodes = processes.map((p) => {
      const depth = depths[p.id] || 0;
      const layer = layerMap[depth];
      const indexInLayer = layer.indexOf(p);

      let position = userPositionedNodes.current[p.id];
      if (!position && p.flow_x != null && p.flow_y != null) {
        position = { x: p.flow_x, y: p.flow_y };
      }
      if (!position) {
        const baseY = layerMaxStoredY[depth] != null
          ? layerMaxStoredY[depth] + verticalSpacing
          : indexInLayer * verticalSpacing + 50;
        position = { x: depth * horizontalSpacing + 50, y: baseY };
        // Track for subsequent nodes in the same layer so they don't overlap.
        layerMaxStoredY[depth] = position.y;
      }
      return {
        id: p.id,
        type: 'processNode',
        position,
        hidden: visibleProcessIds !== null && !visibleProcessIds.has(p.id),
        data: {
          process: p,
          selectedVersion: selectedVersions[p.id],
          onVersionChange: handleVersionChange,
          onClick: handleNodeClick,
          activeProcess,
          visibleVersionsForProcess: visibleVersions === null ? null : (visibleVersions.get(p.id) || new Set())
        }
      };
    });

    const newEdges = [];
    processes.forEach((p) => {
      const version = selectedVersions[p.id];
      const versionObj = getProcessVersion(p, version);
      if (versionObj?.dependencies && Array.isArray(versionObj.dependencies)) {
        versionObj.dependencies.forEach((dep, idx) => {
          if (selectedVersions[dep.source_process_id] === dep.source_process_version) {
            const hidden = visibleProcessIds !== null && (
              !visibleProcessIds.has(dep.source_process_id) || !visibleProcessIds.has(p.id)
            );
            newEdges.push({
              id: `${dep.source_process_id}-${p.id}-${idx}`,
              source: dep.source_process_id,
              sourceHandle: dep.source_dataset_name,
              target: p.id,
              targetHandle: dep.target_param_name,
              label: `${dep.source_dataset_name} → ${dep.target_param_name}`,
              type: 'default',
              animated: false,
              hidden,
              style: { stroke: '#555' },
              labelStyle: { fill: '#555', fontSize: 12 },
              labelBgStyle: { fill: '#fff' }
            });
          }
        });
      }
    });

    setNodes(newNodes);
    setEdges(newEdges);

    if (newProcessAdded && rfInstanceRef.current) {
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 300 }), 50);
    }
  }, [processes, visibleProcessIds, visibleVersions, selectedVersions, calculateDepths, handleVersionChange, handleNodeClick, activeProcess, setNodes, setEdges, getProcessStructure]);

  return (
    <div style={{ width: "100%", height: isMobile ? "70vh" : "100%", position: "relative", display: "flex", flexDirection: "column" }}>
      <TagFilterBar
        projectTags={projectTags}
        selectedTagIds={selectedFilterTagIds}
        onToggle={handleToggleFilterTag}
      />
      <div style={{ flex: 1, position: "relative" }}>
        {isLoading && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(255,255,255,0.7)", zIndex: 10, pointerEvents: "none"
          }}>
            Loading processes…
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChangeWithTracking}
          onEdgesChange={onEdgesChange}
          onInit={(instance) => { rfInstanceRef.current = instance; }}
          fitView
        >
          <Background />
        </ReactFlow>
      </div>
    </div>
  );
}

FlowView.title = "Processes overview";

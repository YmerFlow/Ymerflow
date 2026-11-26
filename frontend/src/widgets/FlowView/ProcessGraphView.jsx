import React, { useContext, useCallback, useMemo, useRef } from "react";
import ReactFlow, { Background, useNodesState, useEdgesState } from "reactflow";
import 'reactflow/dist/style.css';
import { ProcessContext } from '../../ProcessContext';
import { useEffect } from "react";
import ProcessNode from './ProcessNode';
import { getProcessVersion, updateProcessPosition } from '../../datamodel/api';

// Graph (ReactFlow) display mode for the Processes overview. This is the widget's
// historical body, now consuming the shared useProcessGraphModel for all version-selection
// and dependency derivation (one source of truth with tree mode). The layout/render is
// otherwise unchanged.
export default function ProcessGraphView({ model, filterKey }) {
  const {
    processes, activeProcess, setActiveProcess, currentProject, isLoading
  } = useContext(ProcessContext);
  const {
    selectedVersions, visibleVersions, visibleProcessIds, visibleVersionsForProcess,
    handleVersionChange, upstreamMap, datasetColorById
  } = model;

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const userPositionedNodes = useRef({});
  const lastProcessStructure = useRef(null);
  const rfInstanceRef = useRef(null);
  const prevProcessCountRef = useRef(0);
  const prevFilterKeyRef = useRef(null);

  useEffect(() => {
    userPositionedNodes.current = {};
    lastProcessStructure.current = null;
    prevProcessCountRef.current = 0;
    setNodes([]);
    setEdges([]);
  }, [currentProject, setNodes, setEdges]);

  const nodeTypes = useMemo(() => ({ processNode: ProcessNode }), []);

  // Depths from the shared upstreamMap: a process with no upstream is a root (depth 0).
  const calculateDepths = useCallback(() => {
    const depths = {};
    const visited = new Set();

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
  }, [processes, upstreamMap]);

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

  useEffect(() => {
    if (Object.keys(selectedVersions).length === 0) return;

    const currentStructure = getProcessStructure();
    const structureChanged = currentStructure !== lastProcessStructure.current;
    if (structureChanged) lastProcessStructure.current = currentStructure;

    const newProcessAdded = processes.length > prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    // Detect a change of the active tag filter so we can re-fit the view to
    // whatever is now visible (so the user never gets "lost" off-screen).
    const filterChanged = prevFilterKeyRef.current !== null && prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;

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
          visibleVersionsForProcess: visibleVersionsForProcess(p.id),
          datasetColorById
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

    if ((newProcessAdded || filterChanged) && rfInstanceRef.current) {
      // fitView only considers non-hidden nodes, so after a filter change this
      // frames exactly the currently visible processes. minZoom lets it zoom
      // out far enough to fit large graphs.
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 300, minZoom: 0.05 }), 50);
    }
  }, [processes, visibleProcessIds, visibleVersions, selectedVersions, filterKey, calculateDepths, handleVersionChange, handleNodeClick, activeProcess, setNodes, setEdges, getProcessStructure, datasetColorById, visibleVersionsForProcess]);

  return (
    <div style={{ flex: 1, position: "relative", height: "100%" }}>
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
        minZoom={0.05}
        fitView
      >
        <Background />
      </ReactFlow>
    </div>
  );
}

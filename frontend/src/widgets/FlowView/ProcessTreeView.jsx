import React, { useContext, useMemo, useState, useCallback, useRef } from 'react';
import { ProcessContext } from '../../ProcessContext';
import StateBadge from './StateBadge';
import ProcessInfoPopover from './ProcessInfoPopover';

const ACCENT = '#2269A7';

// One row + (when expanded) its subtree. Node identity is the tree PATH, not the
// process id — a process can appear in several places in the forest (the dependency
// DAG has diamonds), each a fresh subtree. `pathPids` guards against re-descending
// into an ancestor on the current path.
function TreeNode({ process, pathKey, pathPids, depth, ctx }) {
  const infoRef = useRef(null);
  const pid = process.id;
  const selectedVersion = ctx.selectedVersions[pid];
  const versionObj = process.versions?.find(v => v.version === selectedVersion);

  const children = (ctx.downstreamMap[pid] || [])
    .filter(childId => !pathPids.has(childId))
    .map(childId => ctx.processesById.get(childId))
    .filter(Boolean);
  const hasChildren = children.length > 0;

  const expanded = ctx.forcedSet.has(pathKey) || ctx.expandedSet.has(pathKey);
  const isActive = ctx.activeProcessId === pid;
  const popoverOpen = ctx.openPopoverKey === pathKey;

  const visibleVersionsForProcess = ctx.visibleVersionsForProcess(pid);

  return (
    <div>
      <div
        onClick={() => ctx.setActiveProcess({ processId: pid, version: selectedVersion })}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 4px',
          paddingLeft: depth * 18 + 4,
          cursor: 'pointer',
          position: 'relative',
          borderRadius: 3,
          background: isActive ? 'rgba(34, 105, 167, 0.12)' : undefined,
          borderLeft: isActive ? `3px solid ${ACCENT}` : '3px solid transparent',
        }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); if (hasChildren) ctx.toggleExpand(pathKey); }}
          style={{
            width: 14, display: 'inline-block', textAlign: 'center',
            cursor: hasChildren ? 'pointer' : 'default', color: '#888', userSelect: 'none',
          }}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : ''}
        </span>

        <span style={{ fontWeight: isActive ? 600 : 400 }}>{process.name}</span>

        <select
          value={selectedVersion ?? ''}
          onChange={(e) => { e.stopPropagation(); ctx.handleVersionChange(pid, parseInt(e.target.value)); }}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 'auto', minWidth: 54, fontSize: '0.8rem' }}
        >
          {(process.versions || [])
            .filter(v => visibleVersionsForProcess === null || visibleVersionsForProcess.has(v.version))
            .map(v => (
              <option key={v.version} value={v.version}>v{v.version}</option>
            ))}
        </select>

        <StateBadge state={versionObj?.state} empty />

        <button
          ref={infoRef}
          type="button"
          className="btn btn-sm btn-link p-0"
          title="Info"
          onClick={(e) => { e.stopPropagation(); ctx.setOpenPopoverKey(popoverOpen ? null : pathKey); }}
          style={{ lineHeight: 1, textDecoration: 'none' }}
        >
          ⓘ
        </button>

        {popoverOpen && (
          <ProcessInfoPopover
            process={process}
            versionObj={versionObj}
            selectedVersion={selectedVersion}
            processesById={ctx.processesById}
            datasetColorById={ctx.datasetColorById}
            currentProject={ctx.currentProject}
            triggerRef={infoRef}
            onClose={() => ctx.setOpenPopoverKey(null)}
          />
        )}
      </div>

      {expanded && hasChildren && children.map(child => (
        <TreeNode
          key={`${pathKey}/${child.id}`}
          process={child}
          pathKey={`${pathKey}/${child.id}`}
          pathPids={new Set([...pathPids, child.id])}
          depth={depth + 1}
          ctx={ctx}
        />
      ))}
    </div>
  );
}

// Forest (tree) display mode. Roots are processes whose selected version has no
// dependency; children are the downstream processes (whose selected version consumes
// one of this node's outputs). Expand state is ephemeral React state; the path from a
// root down to the active process is always force-expanded.
export default function ProcessTreeView({ model }) {
  const { isLoading } = useContext(ProcessContext);
  const {
    processes, activeProcess, setActiveProcess, currentProject,
    selectedVersions, visibleVersionsForProcess, handleVersionChange,
    downstreamMap, roots, datasetColorById,
  } = model;

  const [expandedSet, setExpandedSet] = useState(() => new Set());
  const [openPopoverKey, setOpenPopoverKey] = useState(null);

  const processesById = useMemo(() => new Map(processes.map(p => [p.id, p])), [processes]);

  const toggleExpand = useCallback((pathKey) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }, []);

  // Force-expand every prefix on a path from a root down to the active process, so the
  // active node is always revealed. Recomputed each render (not persisted).
  const forcedSet = useMemo(() => {
    const forced = new Set();
    const activeId = activeProcess?.processId;
    if (!activeId) return forced;

    const dfs = (pid, pathKey, pathPids, ancestorKeys) => {
      if (pid === activeId) {
        ancestorKeys.forEach(k => forced.add(k));
        return;
      }
      (downstreamMap[pid] || []).forEach(childId => {
        if (pathPids.has(childId)) return;
        const childKey = `${pathKey}/${childId}`;
        dfs(childId, childKey, new Set([...pathPids, childId]), [...ancestorKeys, pathKey]);
      });
    };

    roots.forEach(r => dfs(r.id, r.id, new Set([r.id]), []));
    return forced;
  }, [activeProcess, roots, downstreamMap]);

  const ctx = {
    processesById, downstreamMap, selectedVersions, visibleVersionsForProcess,
    handleVersionChange, datasetColorById, currentProject,
    activeProcessId: activeProcess?.processId,
    expandedSet, forcedSet, toggleExpand,
    openPopoverKey, setOpenPopoverKey, setActiveProcess,
  };

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'auto', padding: '6px 4px' }}>
      {isLoading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.7)', zIndex: 10, pointerEvents: 'none'
        }}>
          Loading processes…
        </div>
      )}
      {roots.length === 0 && !isLoading && (
        <div className="text-muted small" style={{ padding: 8 }}>No processes</div>
      )}
      {roots.map(root => (
        <TreeNode
          key={root.id}
          process={root}
          pathKey={root.id}
          pathPids={new Set([root.id])}
          depth={0}
          ctx={ctx}
        />
      ))}
    </div>
  );
}

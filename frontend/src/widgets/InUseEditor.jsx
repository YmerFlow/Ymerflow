import React, { useContext, useEffect, useMemo } from 'react';
import { ProcessContext } from '../ProcessContext';

export default function InUseEditor() {
  const {
    inMemoryDiffs,
    inUseAction,
    setInUseAction,
    undoLastEdit,
    saveAllDiffs,
    datasets,
  } = useContext(ProcessContext);

  // Global keyboard shortcuts: E/D/C for action mode, Ctrl+Z for undo.
  useEffect(() => {
    function handleKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        // Undo on the most recently edited dataset.
        const names = Object.keys(inMemoryDiffsRef.current);
        if (names.length > 0) undoLastEditRef.current(names[names.length - 1]);
        return;
      }
      if (e.ctrlKey) return;
      if (e.key === 'e' || e.key === 'E') setInUseActionRef.current('enable');
      if (e.key === 'd' || e.key === 'D') setInUseActionRef.current('disable');
      if (e.key === 'c' || e.key === 'C') setInUseActionRef.current('clear');
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable refs so the keydown closure never captures stale values.
  const inMemoryDiffsRef  = React.useRef(inMemoryDiffs);
  const undoLastEditRef   = React.useRef(undoLastEdit);
  const setInUseActionRef = React.useRef(setInUseAction);
  useEffect(() => { inMemoryDiffsRef.current  = inMemoryDiffs; },  [inMemoryDiffs]);
  useEffect(() => { undoLastEditRef.current   = undoLastEdit; },   [undoLastEdit]);
  useEffect(() => { setInUseActionRef.current = setInUseAction; }, [setInUseAction]);

  // Aggregate edit statistics across all datasets.
  const stats = useMemo(() => {
    let total = 0, enabled = 0, disabled = 0;
    for (const datasetDiff of Object.values(inMemoryDiffs)) {
      for (const channelMap of Object.values(datasetDiff)) {
        if (!(channelMap instanceof Map)) continue;
        for (const soundingMap of channelMap.values()) {
          if (!(soundingMap instanceof Map)) continue;
          for (const val of soundingMap.values()) {
            total++;
            if (val === 1) enabled++;
            else disabled++;
          }
        }
      }
    }
    const nDatasets = Object.values(inMemoryDiffs).filter(dd =>
      Object.values(dd).some(m => m instanceof Map && m.size > 0)
    ).length;
    return { total, enabled, disabled, nDatasets };
  }, [inMemoryDiffs]);

  const hasPendingEdits = stats.total > 0;

  function handleUndo() {
    const names = Object.keys(inMemoryDiffs);
    if (names.length > 0) undoLastEdit(names[names.length - 1]);
  }

  function handleSave() {
    saveAllDiffs(datasets);
  }

  const btnBase = { padding: '4px 12px', border: '1px solid #aaa', borderRadius: 4, cursor: 'pointer', fontSize: 13 };
  const activeBtn = { ...btnBase, background: '#2269A7', color: '#fff', borderColor: '#2269A7' };
  const inactiveBtn = { ...btnBase, background: '#f8f9fa', color: '#333' };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'sans-serif' }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>InUse Editor</div>

      {/* Edit statistics */}
      <div style={{ fontSize: 12, color: '#555', minHeight: 32 }}>
        {hasPendingEdits
          ? `${stats.total.toLocaleString()} gate-sounding pairs edited across ${stats.nDatasets} dataset${stats.nDatasets !== 1 ? 's' : ''} (↑ ${stats.enabled.toLocaleString()} enabled, ↓ ${stats.disabled.toLocaleString()} disabled)`
          : 'No pending edits. Shift+drag to select points.'}
      </div>

      {/* Action mode radio group */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={inUseAction === 'enable'  ? activeBtn : inactiveBtn} onClick={() => setInUseAction('enable')}>Enable (E)</button>
        <button style={inUseAction === 'disable' ? activeBtn : inactiveBtn} onClick={() => setInUseAction('disable')}>Disable (D)</button>
        <button style={inUseAction === 'clear'   ? activeBtn : inactiveBtn} onClick={() => setInUseAction('clear')}>Clear (C)</button>
      </div>

      {/* Undo + Save */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          style={{ ...inactiveBtn, opacity: hasPendingEdits ? 1 : 0.5 }}
          disabled={!hasPendingEdits}
          onClick={handleUndo}
        >
          Undo (Ctrl+Z)
        </button>
        <button
          style={{ ...btnBase, background: hasPendingEdits ? '#198754' : '#aaa', color: '#fff', borderColor: 'transparent', marginLeft: 'auto' }}
          disabled={!hasPendingEdits}
          onClick={handleSave}
        >
          Save
        </button>
      </div>

      {/* Instructions */}
      <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
        Enable <b>inUseMode</b> on a ChannelPlot layer, then shift+drag to select.
      </div>
    </div>
  );
}

InUseEditor.title = 'InUse Editor';

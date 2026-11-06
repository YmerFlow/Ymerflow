import React, { useContext, useEffect, useMemo } from 'react';
import { ProcessContext } from '../ProcessContext';
import { MessageContext } from '../MessageContext';

const HINT = 'Turn on inUseMode on a ChannelPlot or GateAnomalyPlot layer, then Shift+drag in it to select.';

export default function InUseEditor() {
  const {
    inMemoryDiffs,
    inMemoryDiffDirty,
    inUseAction,
    setInUseAction,
    undoLastEdit,
    saveAllDiffs,
  } = useContext(ProcessContext);
  const { addMessage } = useContext(MessageContext);

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
  // The row shows the short count; the full sentence is its tooltip.
  const statsShort = hasPendingEdits
    ? `${stats.total.toLocaleString()} edit${stats.total !== 1 ? 's' : ''} (↑ ${stats.enabled.toLocaleString()} ↓ ${stats.disabled.toLocaleString()})`
    : 'No pending edits';
  const statsLong = hasPendingEdits
    ? `${stats.total.toLocaleString()} gate-sounding pairs edited across ${stats.nDatasets} dataset${stats.nDatasets !== 1 ? 's' : ''} (↑ ${stats.enabled.toLocaleString()} enabled, ↓ ${stats.disabled.toLocaleString()} disabled)`
    : 'No pending edits';
  // Save writes only what changed since a save point's edit loaded, including an edit the
  // person emptied, so it follows the dirty flags rather than the edit count.
  const hasChanges = Object.values(inMemoryDiffDirty).some(Boolean);

  // Re-entry guard: a second Save while the first is still running re-uploads the same
  // edits and creates a duplicate version. The ref (set synchronously before the first
  // await) is what actually blocks the double-click; `saving` only drives button state.
  const savingRef = React.useRef(false);
  const [saving, setSaving] = React.useState(false);

  function handleUndo() {
    const names = Object.keys(inMemoryDiffs);
    if (names.length > 0) undoLastEdit(names[names.length - 1]);
  }

  // Anything saveAllDiffs does not handle itself must still reach the user: a failed
  // Save keeps the edits in the editor, and they exist nowhere else.
  async function handleSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveAllDiffs();
    } catch (e) {
      addMessage({ level: 'danger', message: `Save failed: ${e.message}. The edits are still in the editor.` });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const btnBase = { padding: '2px 8px', border: '1px solid #aaa', borderRadius: 4, cursor: 'pointer', fontSize: 13 };
  // The border shorthand throughout: mixing it with borderColor makes React warn on rerender.
  const activeBtn = { ...btnBase, background: '#2269A7', color: '#fff', border: '1px solid #2269A7' };
  const inactiveBtn = { ...btnBase, background: '#f8f9fa', color: '#333' };
  const helpMark = {
    width: 18, height: 18, lineHeight: '16px', textAlign: 'center', borderRadius: '50%',
    border: '1px solid #aaa', color: '#666', fontSize: 12, cursor: 'help', flex: 'none',
  };

  // One row that wraps in a narrow pane. The right padding keeps Save clear of the
  // corner chevron a compact pane draws over its widget.
  return (
    <div style={{ padding: '4px 24px 4px 6px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontFamily: 'sans-serif' }}>
      <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>InUse Editor</div>

      {/* Action mode radio group */}
      <button style={inUseAction === 'enable'  ? activeBtn : inactiveBtn} title="Enable (E)"  onClick={() => setInUseAction('enable')}>E</button>
      <button style={inUseAction === 'disable' ? activeBtn : inactiveBtn} title="Disable (D)" onClick={() => setInUseAction('disable')}>D</button>
      <button style={inUseAction === 'clear'   ? activeBtn : inactiveBtn} title="Clear (C)"   onClick={() => setInUseAction('clear')}>C</button>

      <button
        style={{ ...inactiveBtn, opacity: hasPendingEdits ? 1 : 0.5 }}
        title="Undo the last edit (Ctrl+Z)"
        disabled={!hasPendingEdits}
        onClick={handleUndo}
      >
        Ctrl+Z
      </button>

      {/* Edit statistics: the small basis lets the count give up width first, cut short
          with an ellipsis, and move to a second line only when less than 40 px is left. */}
      <div
        title={statsLong}
        style={{ flex: '1 1 40px', minWidth: 0, fontSize: 12, color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {statsShort}
      </div>

      {/* "?" and Save wrap together and stay at the right end of whichever line they are on. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <div style={helpMark} title={HINT}>?</div>
        <button
          style={{ ...btnBase, background: (hasChanges && !saving) ? '#198754' : '#aaa', color: '#fff', border: '1px solid transparent' }}
          disabled={!hasChanges || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

InUseEditor.title = 'InUse Editor';

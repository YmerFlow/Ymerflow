import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ProcessContext } from '../ProcessContext';
import { MessageContext } from '../MessageContext';
import { SHAPES } from './inUseShapes';

const HINT = 'Turn on inUseMode on a ChannelPlot or GateAnomalyPlot layer, then Shift+drag in it to select. '
  + 'Pick the shape with the buttons or the keys 1 to 7. Triangle: start at the apex. '
  + 'Polygon: Shift+click the corners, then right-click or press Enter. '
  + 'Ellipse: Shift+click the center, the end of one axis, then the width. '
  + 'Band: Shift+drag across, or Shift+click for a strip of the set width. Escape drops a shape in progress.';

// The action buttons, each with its key, which the label shows underlined.
const ACTIONS = [
  { action: 'enable',  label: 'Enable',  key: 'E' },
  { action: 'disable', label: 'Disable', key: 'D' },
  { action: 'clear',   label: 'Clear',   key: 'C' },
];

export default function InUseEditor() {
  const {
    inMemoryDiffs,
    inMemoryDiffDirty,
    inUseAction,
    setInUseAction,
    selectionShape,
    setSelectionShape,
    selectionBandWidth,
    setSelectionBandWidth,
    undoLastEdit,
    saveAllDiffs,
  } = useContext(ProcessContext);
  const { addMessage } = useContext(MessageContext);

  // Global keyboard shortcuts: E/D/C for action mode, 1 to 7 for the shape, Ctrl+Z for undo.
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
      const shape = SHAPES.find(s => s.key === e.key);
      if (shape) setSelectionShapeRef.current(shape.mode);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable refs so the keydown closure never captures stale values.
  const inMemoryDiffsRef     = React.useRef(inMemoryDiffs);
  const undoLastEditRef      = React.useRef(undoLastEdit);
  const setInUseActionRef    = React.useRef(setInUseAction);
  const setSelectionShapeRef = React.useRef(setSelectionShape);
  useEffect(() => { inMemoryDiffsRef.current     = inMemoryDiffs; },     [inMemoryDiffs]);
  useEffect(() => { undoLastEditRef.current      = undoLastEdit; },      [undoLastEdit]);
  useEffect(() => { setInUseActionRef.current    = setInUseAction; },    [setInUseAction]);
  useEffect(() => { setSelectionShapeRef.current = setSelectionShape; }, [setSelectionShape]);

  // A column in a pane taller than it is wide (a narrow side pane), one row otherwise. The
  // root fills the pane, so its size is the pane's and does not change with the layout.
  const rootRef = useRef(null);
  const [vertical, setVertical] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setVertical(height > width);
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  // The band width field keeps what is typed; only a positive number reaches the plots.
  const [bandWidthText, setBandWidthText] = useState(String(selectionBandWidth));
  const bandWidthValid = Number(bandWidthText) > 0;
  function handleBandWidth(text) {
    setBandWidthText(text);
    if (Number(text) > 0) setSelectionBandWidth(Number(text));
  }

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
  // A shape button: the key digit small in the top-left corner, the icon bottom-right.
  const shapeBtn = { position: 'relative', width: 30, height: 24, padding: 0, flex: 'none' };
  const shapeKey = { position: 'absolute', left: 3, top: 1, fontSize: 9, lineHeight: '9px', opacity: 0.75 };
  const shapeIcon = { position: 'absolute', right: 4, bottom: 3 };
  const helpMark = {
    width: 18, height: 18, lineHeight: '16px', textAlign: 'center', borderRadius: '50%',
    border: '1px solid #aaa', color: '#666', fontSize: 12, cursor: 'help', flex: 'none',
  };
  // Groups run along the row, or down the column with their items stacked.
  const group = vertical
    ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }
    : { display: 'contents' };

  // One row that wraps in a wide pane, one column in a narrow one. In the row, the right
  // padding keeps Save clear of the corner chevron a compact pane draws over its widget;
  // in the column, the title's own padding does.
  return (
    <div
      ref={rootRef}
      style={{
        height: '100%', boxSizing: 'border-box', fontFamily: 'sans-serif', display: 'flex', gap: 6,
        ...(vertical
          ? { flexDirection: 'column', alignItems: 'flex-start', padding: '4px 6px' }
          : { flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start', padding: '4px 24px 4px 6px' }),
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', paddingRight: vertical ? 18 : 0 }}>InUse Editor</div>

      {/* Action mode radio group */}
      <div style={group}>
        {ACTIONS.map(({ action, label, key }) => (
          <button
            key={action}
            style={inUseAction === action ? activeBtn : inactiveBtn}
            title={`${label} (${key})`}
            onClick={() => setInUseAction(action)}
          >
            <u>{label[0]}</u>{label.slice(1)}
          </button>
        ))}
      </div>

      <button
        style={{ ...inactiveBtn, opacity: hasPendingEdits ? 1 : 0.5 }}
        title="Undo the last edit (Ctrl+Z)"
        disabled={!hasPendingEdits}
        onClick={handleUndo}
      >
        Ctrl+Z
      </button>

      {/* Divider between the actions and the shapes. */}
      <div style={vertical
        ? { height: 1, alignSelf: 'stretch', background: '#aaa' }
        : { width: 1, height: 18, background: '#aaa', flex: 'none' }} />

      {/* Shape picker */}
      <div style={group}>
        {SHAPES.map(({ mode, name, key, gesture, icon }) => (
          <button
            key={mode}
            style={{ ...(selectionShape === mode ? activeBtn : inactiveBtn), ...shapeBtn }}
            title={`${name} (${key}): ${gesture}`}
            aria-label={`${name} (${key})`}
            aria-pressed={selectionShape === mode}
            onClick={() => setSelectionShape(mode)}
          >
            <span style={shapeKey}>{key}</span>
            <span style={shapeIcon}>{icon}</span>
          </button>
        ))}
      </div>

      {selectionShape === 'band' && (
        <label
          title="Band width along the line, for a Shift+click [m]"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#555', margin: 0 }}
        >
          <input
            type="number"
            min="0"
            step="any"
            value={bandWidthText}
            onChange={(e) => handleBandWidth(e.target.value)}
            style={{ width: 56, fontSize: 12, padding: '1px 3px', borderRadius: 3,
              border: `1px solid ${bandWidthValid ? '#aaa' : '#d00'}` }}
          />
          m
        </label>
      )}

      {/* Edit statistics. In the row, the small basis lets the count give up width first,
          cut short with an ellipsis, and move to a second line only when less than 40 px
          is left; in the column it wraps. */}
      <div
        title={statsLong}
        style={vertical
          ? { fontSize: 12, color: '#555' }
          : { flex: '1 1 40px', minWidth: 0, fontSize: 12, color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {statsShort}
      </div>

      {/* "?" and Save: together at the right end of whichever line they are on in the row,
          "?" above Save in the column. */}
      <div style={vertical
        ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
        : { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
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

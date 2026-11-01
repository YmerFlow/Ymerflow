import React from 'react';

// A multi-state toggle button over how headerMode.js resolves compactness.
//
// Non-root panes cycle through three states of `node.compact`:
//   inherit     (undefined) -> grey/inactive  fa-maximize
//   compact     (true)       -> blue           fa-minimize
//   non-compact (false)      -> blue           fa-maximize
//
// The root pane has nothing above it to inherit from, so it drops the inherit
// state and instead carries `node.globalCompact` (compact-all) — shown brown
// (btn-danger, same as the remove button) since it overrides every pane's own
// setting (see resolveGlobalCompact / isCompact). Its cycle is:
//   compact -> compact-all -> non-compact -> compact
// The global flag is meaningless on a non-root node, so it is only read when
// isRoot — otherwise a stale flag would wrongly surface the brown state there.
function CompactToggle({ node, isRoot, onUpdateFields }) {
  const state = isRoot
    ? (node.globalCompact ? 'all' : node.compact === true ? 'compact' : 'notcompact')
    : (node.compact === true ? 'compact' : node.compact === false ? 'notcompact' : 'inherit');

  const cycle = () => {
    if (isRoot) {
      // compact -> all -> non-compact -> compact (no inherit at the root)
      switch (state) {
        case 'compact': onUpdateFields({ globalCompact: true }); break;
        case 'all': onUpdateFields({ globalCompact: undefined, compact: false }); break;
        case 'notcompact':
        default: onUpdateFields({ compact: true, globalCompact: undefined });
      }
    } else {
      // inherit -> compact -> non-compact -> inherit
      switch (state) {
        case 'inherit': onUpdateFields({ compact: true }); break;
        case 'compact': onUpdateFields({ compact: false }); break;
        case 'notcompact':
        default: onUpdateFields({ compact: undefined });
      }
    }
  };

  const icon = (state === 'compact' || state === 'all') ? 'fa-minimize' : 'fa-maximize';
  const title = {
    inherit: 'Compact: inherit from parent',
    compact: 'Compact',
    notcompact: 'Not compact',
    all: 'Compact all panes',
  }[state];

  // Pick the Bootstrap button variant by the colour it renders in this theme
  // (styling.scss: $primary=brown, $secondary=blue, $danger=brick-brown):
  //   grey/inactive -> btn-light, blue -> btn-secondary, brown -> btn-danger.
  const variant = state === 'inherit' ? 'btn-light'
    : state === 'all' ? 'btn-danger'
    : 'btn-secondary';

  return (
    <button type="button" className={`btn btn-sm ${variant}`} onClick={cycle} title={title}>
      <i className={`fas ${icon}`}></i>
    </button>
  );
}

// Shared body for the pane/tab dropdown menu. Rendered inside a PaneMenuDropdown
// by both the full-header/compact-corner menu in Pane.jsx and the tab chevron
// menu in TabSet.jsx, so both stay in sync (actions, compact toggles, widget list).
//
// `titleRow` is an optional element rendered at the very top — used by the compact
// pane corner arrow, which has no header strip to rename from. `isRoot` controls
// whether the global "Compact all panes" checkbox is offered (only the root pane).
export default function PaneMenuContent({
  node,
  widgets,
  isRoot = false,
  hasConfig,
  onConfigure,
  onRemove,
  onChangeWidget,
  onUpdateFields,
  titleRow = null,
}) {
  return (
    <>
      {titleRow}
      <div className="pane-menu-actions">
        {hasConfig && (
          <button type="button" className="btn btn-sm btn-secondary" onClick={onConfigure}>
            <i className="fas fa-cog"></i>
          </button>
        )}
        <CompactToggle node={node} isRoot={isRoot} onUpdateFields={onUpdateFields} />
        <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>
          <i className="fas fa-times"></i>
        </button>
      </div>
      <div className="pane-menu-widget-list">
        {Object.entries(widgets).map(([name, widget]) => (
          <button
            type="button"
            key={name}
            className={node.widget === name ? 'active' : ''}
            onClick={() => onChangeWidget(name)}
          >
            {widget.title}
          </button>
        ))}
      </div>
    </>
  );
}

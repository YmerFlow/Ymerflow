import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

// Cursor-anchored portal picker, adapted from flexout's PaneMenuDropdown: same
// createPortal + mousedown-to-close, but positioned at a {x, y} point (the drop
// location) instead of an element's rect. Shown when a dataset drop has more than
// one candidate layer type, or exactly one when the pin is adjustable; the user picks
// which layer type to add and, for a current-process dataset, whether to pin it.
//
// The thumbtack header toggles between the pinned path (`<proc>.<ver>.<ds>`) and the
// unpinned `current.<ds>` path. When `pinnable` is false (dataset belongs to another
// process/version) the pin is forced on and greyed out. onPick(item, path) receives the
// chosen path.
export default function DatasetDropMenu({ x, y, items, pinnable, pinnedPath, currentPath, onPick, onClose }) {
  const dropdownRef = useRef(null);
  // A current-process dataset starts unpinned (follows current); another process is always pinned.
  const [pinned, setPinned] = useState(!pinnable);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      ref={dropdownRef}
      className="pane-menu-dropdown"
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 4px' }}>
        <i
          className="fas fa-thumbtack"
          title={pinnable
            ? (pinned ? 'Pinned to this process version (click to follow current)'
                      : 'Following current process (click to pin)')
            : 'Pinned: dataset belongs to another process'}
          style={{
            cursor: pinnable ? 'pointer' : 'not-allowed',
            opacity: pinned ? 1 : 0.4,
            transform: pinned ? 'none' : 'rotate(45deg)',
            color: pinnable ? undefined : '#adb5bd',
          }}
          onMouseDown={e => e.stopPropagation()}
          onClick={pinnable ? (e => { e.stopPropagation(); setPinned(p => !p); }) : undefined}
        />
      </div>
      <div className="pane-menu-widget-list">
        {items.map(item => (
          <button
            key={item.name}
            type="button"
            onClick={() => onPick(item, pinned ? pinnedPath : currentPath)}
          >
            {item.label || item.name}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

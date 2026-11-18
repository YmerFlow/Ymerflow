import { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

// Cursor-anchored portal picker, adapted from flexout's PaneMenuDropdown: same
// createPortal + mousedown-to-close, but positioned at a {x, y} point (the drop
// location) instead of an element's rect. Shown when a dataset drop has more than
// one candidate layer type; the user picks which to add.
export default function DatasetDropMenu({ x, y, items, onPick, onClose }) {
  const dropdownRef = useRef(null);

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
      <div className="pane-menu-widget-list">
        {items.map(item => (
          <button
            key={item.name}
            type="button"
            onClick={() => onPick(item)}
          >
            {item.label || item.name}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

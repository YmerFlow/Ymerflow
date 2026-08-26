import React, { useState, useRef } from "react";
import { sortMenuEntries } from "./MenuBar";

const DRAG_THRESHOLD = 24;  // px a vertical drag must travel to toggle the menu

// One node in the mobile accordion tree. Data-driven entries expand their
// children inline (indented one step); leaf entries fire their action; component
// entries render inline in the flow.
function MobileMenuNode({ label, node, depth, onNavigate }) {
  const [expanded, setExpanded] = useState(false);

  if (node.component) {
    const Component = node.component;
    return (
      <div className="mobile-menu-node" style={{ paddingLeft: `${0.75 + depth}rem` }}>
        <Component />
      </div>
    );
  }

  const hasChildren = Object.keys(node.__children).length > 0;

  if (!hasChildren) {
    return (
      <button
        type="button"
        className={`mobile-menu-node mobile-menu-item${node.active ? ' active' : ''}`}
        style={{ paddingLeft: `${0.75 + depth}rem` }}
        onClick={() => { node.action && node.action(); onNavigate && onNavigate(); }}
      >
        {label}
      </button>
    );
  }

  const sortedChildren = sortMenuEntries(Object.entries(node.__children));

  return (
    <>
      <button
        type="button"
        className="mobile-menu-node mobile-menu-item mobile-menu-toggle-row"
        style={{ paddingLeft: `${0.75 + depth}rem` }}
        onClick={() => setExpanded(v => !v)}
      >
        <span>{label}</span>
        <i className={`fas fa-chevron-${expanded ? 'up' : 'down'} ms-2`} />
      </button>
      {expanded && sortedChildren.map(([childLabel, childNode]) => (
        <MobileMenuNode
          key={childLabel}
          label={childLabel}
          node={childNode}
          depth={depth + 1}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

export default function MobileMenu({ leftItems, rightItems }) {
  const [open, setOpen] = useState(false);
  const dragStartY = useRef(null);
  const dragged = useRef(false);

  const onPointerDown = (e) => {
    dragStartY.current = e.clientY;
    dragged.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (dragStartY.current === null) return;
    const delta = e.clientY - dragStartY.current;
    if (delta > DRAG_THRESHOLD) {
      dragged.current = true;
      setOpen(true);
    } else if (delta < -DRAG_THRESHOLD) {
      dragged.current = true;
      setOpen(false);
    }
  };

  const onPointerUp = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // A tap that never crossed the drag threshold is a click → toggle.
    if (!dragged.current) setOpen(v => !v);
    dragStartY.current = null;
  };

  const allItems = [...leftItems, ...rightItems];

  return (
    <div className="mobile-menu-bar">
      <div
        className="mobile-menu-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="button"
        aria-label="Toggle menu"
        aria-expanded={open}
      >
        <span className="mobile-menu-grip" />
      </div>
      {open && (
        <div className="mobile-menu-panel">
          {allItems.map(([label, node]) => (
            <MobileMenuNode
              key={label}
              label={label}
              node={node}
              depth={0}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

import React, { useState, useRef } from "react";
import { sortMenuEntries } from "./MenuBar";

const CLICK_TOLERANCE = 4;       // px of movement below which a pointer gesture counts as a click
const OPEN_SNAP_FRACTION = 0.2;  // fraction of max height the drawer must be pulled past to snap open
const MAX_HEIGHT_FRACTION = 0.8; // drawer never grows past this fraction of the viewport height

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
  // `open` is the resting state; `dragPx` is the live panel height while a drag is in
  // progress (null when not dragging). The drawer overlays the page (it is absolutely
  // positioned, see .mobile-menu-drawer), so opening it never pushes the content down.
  const [open, setOpen] = useState(false);
  const [dragPx, setDragPx] = useState(null);
  const panelRef = useRef(null);

  const dragging = useRef(false);
  const moved = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const liveHeight = useRef(0);  // latest px height during a drag, read on release (avoids stale state)

  const maxHeightPx = () =>
    (typeof window !== "undefined" ? window.innerHeight : 600) * MAX_HEIGHT_FRACTION;

  // Height the panel currently rests at for the given open/closed state. scrollHeight is
  // the full content height even while the panel is clipped to 0, so this works when closed.
  const restingHeight = () => {
    if (!open || !panelRef.current) return 0;
    return Math.min(panelRef.current.scrollHeight, maxHeightPx());
  };

  const onPointerDown = (e) => {
    dragging.current = true;
    moved.current = false;
    dragStartY.current = e.clientY;
    dragStartHeight.current = restingHeight();
    liveHeight.current = dragStartHeight.current;
    setDragPx(dragStartHeight.current);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!dragging.current) return;
    const delta = e.clientY - dragStartY.current;
    if (Math.abs(delta) > CLICK_TOLERANCE) moved.current = true;
    // Drag down grows the drawer, drag up shrinks it; the handle rides the bottom edge.
    const h = Math.max(0, Math.min(dragStartHeight.current + delta, maxHeightPx()));
    liveHeight.current = h;
    setDragPx(h);
  };

  const onPointerUp = (e) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!moved.current) {
      // A tap that never crossed the click tolerance → toggle.
      setOpen(v => !v);
    } else {
      // A drag → snap open/closed based on how far it was pulled.
      const threshold = Math.min(60, maxHeightPx() * OPEN_SNAP_FRACTION);
      setOpen(liveHeight.current > threshold);
    }
    setDragPx(null);
  };

  const allItems = [...leftItems, ...rightItems];

  const panelStyle =
    dragPx != null
      ? { height: `${dragPx}px`, overflowY: "auto" }
      : open
        ? { maxHeight: `${maxHeightPx()}px`, overflowY: "auto" }
        : { height: 0, overflow: "hidden" };

  return (
    <div className="mobile-menu-bar">
      {/* Absolutely-positioned overlay: panel first, handle last so the handle sits at the
          bottom of the drawer and moves down as the panel grows. */}
      <div className="mobile-menu-drawer">
        <div className="mobile-menu-panel" ref={panelRef} style={panelStyle}>
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
        <div
          className="mobile-menu-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="button"
          aria-label="Toggle menu"
          aria-expanded={open}
        >
          <span className="mobile-menu-grip" />
        </div>
      </div>
    </div>
  );
}

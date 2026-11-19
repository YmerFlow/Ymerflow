import React, { useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

// A "?" icon that reveals the field/section description on hover. Used for scalar
// field labels (CustomFieldTemplate) and object/array headings (CustomTitleFieldTemplate).
//
// The tooltip is rendered in a portal to <body> with position:fixed so it escapes the
// scrollable modal's overflow:auto — otherwise an upward popup near the modal's scroll
// edge gets clipped by the dialog.
export default function HelpBubble({ text }) {
  const t = typeof text === 'string' ? text.trim() : '';
  const iconRef = useRef(null);
  const [coords, setCoords] = useState(null);

  const show = useCallback(() => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchor the tooltip's bottom-left near the icon's top-left; CSS lifts it above.
    setCoords({ left: Math.round(r.left), top: Math.round(r.top) });
  }, []);
  const hide = useCallback(() => setCoords(null), []);

  if (!t) return null;

  return (
    <span
      className="field-description-icon"
      ref={iconRef}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <i className="fa fa-question-circle" aria-label="Help" />
      {coords &&
        createPortal(
          <span
            className="field-description-tooltip"
            role="tooltip"
            style={{ left: coords.left, top: coords.top }}
          >
            {t}
          </span>,
          document.body,
        )}
    </span>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import Pane from './Pane';
import { v4 as uuidv4 } from 'uuid';
import { useIsMobile } from '../../hooks/useIsMobile';

const MIN_FRAC = 0.05;

function equalFractions(n) {
  return Array.from({ length: n }, () => 1 / n);
}

// Resize a fractions array to length n, renormalizing if trimmed, spreading remainder if grown.
function normalizeFractions(fracs, n) {
  if (fracs.length === n) return fracs;
  if (fracs.length > n) {
    const trimmed = fracs.slice(0, n);
    const sum = trimmed.reduce((a, b) => a + b, 0);
    return sum > 0 ? trimmed.map(v => v / sum) : equalFractions(n);
  }
  const sum = fracs.reduce((a, b) => a + b, 0);
  const extra = n - fracs.length;
  const share = Math.max((1 - sum) / extra, MIN_FRAC);
  return [...fracs, ...Array(extra).fill(share)];
}

export default function Grid({ parentUpdate, ...node }) {
  const isMobile = useIsMobile();
  const rows = node.rows || 3;
  const cols = node.cols || 3;
  const totalCells = rows * cols;

  // Derive children, padding with stable-id Empty cells for uninitialized slots.
  const rawChildren = node.children || [];
  const children = Array.from({ length: totalCells }, (_, i) =>
    rawChildren[i] || { id: `${node.id}-cell-${i}`, widget: 'Empty' }
  );

  const colWidths = normalizeFractions(node.colWidths || [], cols);
  const rowHeights = normalizeFractions(node.rowHeights || [], rows);

  const containerRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { type: 'col'|'row', index }
  const [dragPos, setDragPos] = useState(null);

  const handleDividerMouseDown = (type, index, e) => {
    e.preventDefault();
    setDragging({ type, index });
    setDragPos(type === 'col' ? e.clientX : e.clientY);
  };

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e) => {
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;

      if (dragging.type === 'col') {
        const usable = container.width - (cols - 1) * 5;
        const delta = (e.clientX - dragPos) / usable;
        const i = dragging.index;
        const newWidths = [...colWidths];
        let a = newWidths[i] + delta;
        let b = newWidths[i + 1] - delta;
        if (a < MIN_FRAC) { b -= (MIN_FRAC - a); a = MIN_FRAC; }
        if (b < MIN_FRAC) { a -= (MIN_FRAC - b); b = MIN_FRAC; }
        newWidths[i] = a;
        newWidths[i + 1] = b;
        parentUpdate('replace', node.id, { ...node, children, colWidths: newWidths, rowHeights });
        setDragPos(e.clientX);
      } else {
        const usable = container.height - (rows - 1) * 5;
        const delta = (e.clientY - dragPos) / usable;
        const j = dragging.index;
        const newHeights = [...rowHeights];
        let a = newHeights[j] + delta;
        let b = newHeights[j + 1] - delta;
        if (a < MIN_FRAC) { b -= (MIN_FRAC - a); a = MIN_FRAC; }
        if (b < MIN_FRAC) { a -= (MIN_FRAC - b); b = MIN_FRAC; }
        newHeights[j] = a;
        newHeights[j + 1] = b;
        parentUpdate('replace', node.id, { ...node, children, colWidths, rowHeights: newHeights });
        setDragPos(e.clientY);
      }
    };

    const onMouseUp = () => setDragging(null);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, dragPos, colWidths, rowHeights, rows, cols, node, parentUpdate, children]);

  const handleChildUpdate = (action, id, newNode) => {
    const newChildren = action === 'remove'
      ? children.map(c => c.id === id ? { id: uuidv4(), widget: 'Empty' } : c)
      : children.map(c => c.id === id ? newNode : c);
    parentUpdate('replace', node.id, { ...node, children: newChildren, colWidths, rowHeights });
  };

  // CSS grid tracks: content tracks separated by 5px divider tracks.
  const colTemplate = colWidths.map((w, i) =>
    i < cols - 1 ? `${w}fr 5px` : `${w}fr`
  ).join(' ');
  const rowTemplate = rowHeights.map((h, i) =>
    i < rows - 1 ? `${h}fr 5px` : `${h}fr`
  ).join(' ');

  const elements = [];

  // Content cells
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const child = children[r * cols + c];
      elements.push(
        <div
          key={`cell-${r}-${c}`}
          className="split-pane"
          style={{ gridRow: 2 * r + 1, gridColumn: 2 * c + 1, overflow: 'hidden', minWidth: 0, minHeight: 0 }}
        >
          <Pane parentUpdate={handleChildUpdate} {...child} />
        </div>
      );
    }
  }

  // Column dividers (vertical, spanning full height)
  for (let c = 0; c < cols - 1; c++) {
    elements.push(
      <div
        key={`col-div-${c}`}
        className="split-divider split-divider-vertical"
        style={{ gridColumn: 2 * c + 2, gridRow: '1 / -1', zIndex: 2 }}
        onMouseDown={(e) => handleDividerMouseDown('col', c, e)}
      />
    );
  }

  // Row dividers (horizontal, spanning full width)
  for (let r = 0; r < rows - 1; r++) {
    elements.push(
      <div
        key={`row-div-${r}`}
        className="split-divider split-divider-horizontal"
        style={{ gridRow: 2 * r + 2, gridColumn: '1 / -1', zIndex: 1 }}
        onMouseDown={(e) => handleDividerMouseDown('row', r, e)}
      />
    );
  }

  if (isMobile) {
    const realChildren = children.filter(c => c && c.widget !== 'Empty');
    return (
      <div className="grid-stack-mobile">
        {realChildren.map(child => (
          <Pane key={child.id} parentUpdate={handleChildUpdate} {...child} />
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="grid-container" style={{ gridTemplateColumns: colTemplate, gridTemplateRows: rowTemplate }}>
      {elements}
    </div>
  );
}

Grid.title = 'Grid';

Grid.get_schema = () => ({
  type: 'object',
  title: 'Grid Configuration',
  properties: {
    rows: {
      type: 'integer',
      title: 'Rows',
      minimum: 1,
      maximum: 10,
      default: 3
    },
    cols: {
      type: 'integer',
      title: 'Columns',
      minimum: 1,
      maximum: 10,
      default: 3
    }
  }
});

Grid.get_default = () => ({
  rows: 3,
  cols: 3
});

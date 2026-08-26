import React, { useState, useEffect, useRef } from 'react';
import Pane from './Pane';
import { useIsMobile } from '../../hooks/useIsMobile';

export default function Split({ parentUpdate, ...node}) {
  const isMobile = useIsMobile();
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState(null);
  const containerRef = useRef(null);

  const handleChildUpdate = (action, id, newNode) => {
    if (action === 'remove') {
      const otherChild = node.children.find(c => c.id !== id);
      if (otherChild) parentUpdate('replace', node.id, otherChild);
      else parentUpdate('remove', node.id);
    } else if (action === 'replace') {
      const newChildren = node.children.map(c => (c.id === id ? newNode : c));
      parentUpdate('replace', node.id, { ...node, children: newChildren });
    }
  };

  const splitType = node.splitType;
  const size = node.size || 0.5;

  const onMouseDown = (e) => {
    setDragging(true);
    setDragPos(splitType === 'vertical' ? e.clientX : e.clientY);
  };

  // Only attach mouse listeners when dragging - prevents constant repaints
  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e) => {
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;

      const delta = (splitType === 'vertical' ? e.clientX : e.clientY) - dragPos;
      let newSize = splitType === 'vertical'
        ? (size * container.width + delta) / container.width
        : (size * container.height + delta) / container.height;
      if (newSize < 0.1) newSize = 0.1;
      if (newSize > 0.9) newSize = 0.9;

      parentUpdate('replace', node.id, { ...node, size: newSize });
      setDragPos(splitType === 'vertical' ? e.clientX : e.clientY);
    };

    const onMouseUp = () => setDragging(false);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, dragPos, splitType, size, node, parentUpdate]);

  if (isMobile) {
    return (
      <div className="split-stack-mobile">
        <Pane parentUpdate={handleChildUpdate} {...node.children[0]} />
        <Pane parentUpdate={handleChildUpdate} {...node.children[1]} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`split-container split-${splitType}`}>
      <div className="split-pane" style={{ flexBasis: `${size * 100}%`, flexShrink: 0 }}><Pane parentUpdate={handleChildUpdate} {...node.children[0]}/></div>
      <div className={`split-divider split-divider-${splitType}`} onMouseDown={onMouseDown} />
      <div className="split-pane" style={{ flex: 1 }}><Pane parentUpdate={handleChildUpdate} {...node.children[1]} /></div>
    </div>
  );
}

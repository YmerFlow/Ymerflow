import React from 'react';
import { contrastText } from './mimeColors';
import { useDatasetDragSource } from '../../dnd/datasetDnd';

// A plain, draggable dataset chip reusing the shared dataset drag payload. Unlike
// ProcessNode's DatasetOutputBox it embeds no ReactFlow <Handle>, so it works outside
// ReactFlow context (e.g. the tree-mode info popover). Colored by the same
// datasetColorById map graph mode uses.
export default function DraggableDataset({ name, datasetId, datasetPath, processId, processVersion, bg }) {
  const dragRef = useDatasetDragSource({ datasetId, datasetPath, datasetName: name, processId, processVersion });
  return (
    <span
      ref={dragRef}
      className="badge"
      style={{
        cursor: 'grab',
        margin: '2px',
        border: '1px solid #aaa',
        ...(bg
          ? { background: bg, color: contrastText(bg), borderColor: bg }
          : { background: '#f8f9fa', color: '#555' }),
      }}
      title={name}
    >
      {name}
    </span>
  );
}

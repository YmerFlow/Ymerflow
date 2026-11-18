// Shared dataset drag-and-drop wiring. A FlowView output box is the drag source;
// a widget (first: PlotView) registers as a drop target to consume a dropped
// dataset. Lives outside flexout/ so the generic pieces stay reusable while all
// widget-specific logic (e.g. layer-type filtering) stays inside the consumer.
//
// Item type is distinct from flexout's 'pane', so pane/tab drop targets ignore a
// dataset drag and dataset drop targets ignore a pane drag.
import { useDrag, useDrop } from 'react-dnd';

export const DATASET_DRAG_TYPE = 'dataset';
// payload shape: { datasetId, datasetPath, datasetName, processId, processVersion }
// processId/processVersion identify the source output so a drop target can tell whether
// the dragged dataset is the active process's active version (→ an unpinned "current.<ds>"
// layer) or another process/version (→ the pinned datasetPath).

// Drag source — returns the connector ref to attach to a draggable element.
export function useDatasetDragSource(item) {
  const [, drag] = useDrag(
    { type: DATASET_DRAG_TYPE, item },
    [JSON.stringify(item)],
  );
  return drag;
}

// Drop target — onDrop(item, clientOffset) fires on drop. Returns the connector
// ref to attach to the drop container.
export function useDatasetDrop(onDrop) {
  const [, drop] = useDrop(
    {
      accept: DATASET_DRAG_TYPE,
      drop: (item, monitor) => onDrop(item, monitor.getClientOffset()),
    },
    [onDrop],
  );
  return drop;
}

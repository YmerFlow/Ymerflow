import React, { useContext, useCallback, useMemo } from "react";
import { ProcessContext } from '../../ProcessContext';
import { useRegisterMenu } from "../../flexout/MenuContext";
import { LayoutContext } from "../../flexout/LayoutContext";
import TagFilterBar from './TagFilterBar';
import ProcessGraphView from './ProcessGraphView';
import ProcessTreeView from './ProcessTreeView';
import { useProcessGraphModel } from './useProcessGraphModel';
import { useIsMobile } from '../../hooks/useIsMobile';

// Thin wrapper over the two display modes. The shared tag filter bar + its persistence
// and the derivation hook live here (both modes consume the same version-selection
// model); the `Graph` config flag picks the ReactFlow graph (default) or the text forest.
export default function FlowView({ parentUpdate, selectedFilterTagNames: savedFilterTagNames = [], Graph = true, ...nodeProps }) {
  const isMobile = useIsMobile();
  const { startNewProcess } = useContext(ProcessContext);
  const { findWidgetPaths, activatePath } = useContext(LayoutContext);

  const selectedFilterTagNames = useMemo(() => new Set(savedFilterTagNames), [savedFilterTagNames]);
  // Stable-by-value key for the active filter — the Set gets a fresh identity every
  // render (the `= []` default prop churns), but this string compares equal across
  // renders, so it won't trigger a graph re-fit/flicker loop.
  const filterKey = useMemo(
    () => [...selectedFilterTagNames].sort().join(','),
    [selectedFilterTagNames]
  );

  const model = useProcessGraphModel(selectedFilterTagNames);

  useRegisterMenu(["Process", "Create"], () => {
    startNewProcess();
    const paths = findWidgetPaths('ProcessEditor');
    if (paths.length > 0) activatePath(paths[0]);
  });

  const handleToggleFilterTag = useCallback((tagName) => {
    const next = new Set(selectedFilterTagNames);
    if (next.has(tagName)) next.delete(tagName);
    else next.add(tagName);
    parentUpdate?.('replace', nodeProps.id, { ...nodeProps, selectedFilterTagNames: [...next] });
  }, [selectedFilterTagNames, parentUpdate, nodeProps]);

  return (
    <div style={{ width: "100%", height: isMobile ? "70vh" : "100%", position: "relative", display: "flex", flexDirection: "column" }}>
      <TagFilterBar
        projectTags={model.projectTags}
        selectedTagNames={selectedFilterTagNames}
        onToggle={handleToggleFilterTag}
      />
      {Graph
        ? <ProcessGraphView model={model} filterKey={filterKey} />
        : <ProcessTreeView model={model} />}
    </div>
  );
}

FlowView.title = "Processes overview";

FlowView.get_default = () => ({ Graph: true });

FlowView.get_schema = () => ({
  type: 'object',
  properties: {
    id:     { type: 'string', title: 'ID', readOnly: true },
    widget: { type: 'string', title: 'Widget Type', readOnly: true },
    Graph:  { type: 'boolean', title: 'Graph', default: true },
  },
});

import React, { createContext, useState, useCallback, useMemo } from 'react';
import Split from "./components/Split";
import TabSet from "./components/TabSet";
import Grid from "./components/Grid";
import { findWidgetPaths, applyPath } from './layoutUtils';

export const LayoutContext = createContext();

var VerticalSplit = ({...args}) => <Split splitType="vertical" {...args} />;
VerticalSplit.title = "Split vertically";
VerticalSplit.description = "Split the pane vertically into two resizable children.";

var HozisontalSplit = ({...args}) => <Split splitType="horizontal" {...args} />;
HozisontalSplit.title = "Split horizontally";
HozisontalSplit.description = "Split the pane horizontally into two resizable children.";

var Empty = () => <div style={{ color: '#999' }}></div>;
Empty.title = "Empty";
Empty.description = "An empty placeholder pane with no content.";

TabSet.description = "Tabbed pane — children are switchable tabs.";
Grid.description = "A grid of resizable cells — children fill the cells row by row.";

// The flexout built-in node types, merged into the widget registry alongside the
// app-provided leaf widgets. These are flexout's own containers (plus Empty); the
// workspace-schema builder (workspaceSchema.js) imports this same map so it sees the
// whole node-type set from one place.
export const builtinWidgets = {
  VerticalSplit: VerticalSplit,
  HorizontalSplit: HozisontalSplit,
  TabSet: TabSet,
  Grid: Grid,
  Empty: Empty
};
    
export const LayoutProvider = ({ children, widgets, initial_layout, data_context }) => {
  const [layout, setLayout] = useState(
    initial_layout
      || {
        id: 'root',
        widget: 'Empty'
      });

  const updateLayout = useCallback((newLayout) => {
    console.log(newLayout);
    setLayout(newLayout);
  }, []);

  const activatePath = useCallback((path) => {
    setLayout(current => applyPath(current, path));
  }, []);

  const allWidgets = useMemo(
    () => ({
      ...widgets,
      ...builtinWidgets
    }),
    [widgets]
  );

  const contextValue = useMemo(
    () => ({
      widgets: allWidgets,
      layout,
      updateLayout,
      data_context: data_context || {},
      findWidgetPaths: (widgetType) => findWidgetPaths(layout, widgetType),
      activatePath,
    }),
    [allWidgets, layout, updateLayout, data_context, activatePath]
  );

  return (
    <LayoutContext.Provider value={contextValue}>
      {children}
    </LayoutContext.Provider>
  );
};

# Flexout Layout System

The Flexout layout system provides a flexible, drag-and-drop interface for arranging widgets in the Nagelfluh frontend. It supports splits, tabs, and a resizable grid.

## Overview

Flexout is a custom-built layout engine located in `frontend/src/flexout/`. It manages a recursive tree structure where each node represents either:
- A **widget** (content pane, e.g. `FlowView`, `PlotView`, `ProcessEditor`)
- A **split** (vertical or horizontal container, exactly two children)
- A **tab set** (tabbed container, any number of children)
- A **grid** (resizable rows x cols container)
- An **empty** placeholder

## Architecture

### Core Components

```
flexout/
├── LayoutContext.jsx      # LayoutProvider - holds the layout tree, exposes widgets/activatePath
├── MenuContext.jsx        # MenuProvider - global menu-tree registration (registerMenu / registerMenuComponent)
├── Layout.jsx             # MainLayout - renders the root Pane for the current layout tree
├── MenuBar.jsx            # Renders the registered menu tree as a Bootstrap navbar
├── layoutUtils.js         # findWidgetPaths / applyPath - locate & activate a widget instance by type
└── components/
    ├── Pane.jsx            # Wraps every node: header, widget-switch menu, Configure modal, error boundary
    ├── PaneMenuDropdown.jsx # Portal-rendered popover used by Pane and TabSet's tab menu
    ├── Split.jsx           # Resizable two-child split container (VerticalSplit / HorizontalSplit)
    ├── TabSet.jsx           # Tabbed container with drag-reorder, per-tab Configure, and title editing
    ├── Grid.jsx             # Resizable rows x cols container
    └── index.js             # (currently empty)
```

`flexout/index.js` is also currently empty (no barrel export - consumers import directly from the files above).

### Layout Tree Structure

Node-specific fields live directly on the node (there is no generic `data` wrapper). For example:

```javascript
{
  id: "root",
  widget: "VerticalSplit",
  size: 0.5,                 // fraction (0-1) of space given to children[0]
  children: [
    {
      id: "left-pane",
      widget: "FlowView"
    },
    {
      id: "right-split",
      widget: "HorizontalSplit",
      size: 0.5,
      children: [
        {
          id: "top-right",
          widget: "ProcessEditor"
        },
        {
          id: "bottom-right",
          widget: "TabSet",
          activeTab: "tab-2",
          children: [
            { id: "tab-1", widget: "PlotView" },
            { id: "tab-2", widget: "MapView" }
          ]
        }
      ]
    }
  ]
}
```

## LayoutContext

The `LayoutContext` provides global state and read access for the layout tree. Tree *mutation* does not go through the context (see [Tree Operations](#tree-operations) below) - the context is mainly used to read the current tree, look up available widget types, and jump to a specific widget instance.

### Provider Setup

```javascript
// App.jsx
import { LayoutProvider } from './flexout/LayoutContext';

const widgets = {
  FlowView,
  ProcessEditor,
  PlotView,
  // ... other widgets
};

function App() {
  return (
    <LayoutProvider widgets={widgets} initial_layout={layoutToUse} data_context={processContext}>
      {/* App content, e.g. <MainLayout /> */}
    </LayoutProvider>
  );
}
```

`initial_layout` seeds the tree (App.jsx loads it from a workspace - see [Persistence](#persistence)). `data_context` is passed through to any widget's `get_schema(data_context)` / `get_default(data_context)` static methods (e.g. `Grid.get_schema`), so widgets can build their Configure form against live app state.

### Context API

```javascript
import { useContext } from 'react';
import { LayoutContext } from './flexout/LayoutContext';

function MyComponent() {
  const {
    widgets,          // Available widget types: registered widgets merged with the built-ins
                       // (VerticalSplit, HorizontalSplit, TabSet, Grid, Empty)
    layout,            // Current layout tree (root node)
    updateLayout,      // Replace the entire layout tree: updateLayout(newLayoutOrUpdaterFn)
    data_context,      // Opaque object passed through to widgets' get_schema/get_default
    findWidgetPaths,   // findWidgetPaths(widgetType) -> array of paths (see below)
    activatePath,      // activatePath(path) -> switches TabSets along that path to show it
  } = useContext(LayoutContext);
}
```

`updateLayout` accepts either a new tree or a React-style updater function `(prevLayout) => newLayout` (used e.g. by `TabSet` when closing a tab from its drag source, since that removal can target a node anywhere in the tree, not just a direct child).

### Tree Operations

There are no `getNode`/`updateNode`/`removeNode`/`replaceNode`/`splitNode`/`addTab` context methods. Instead, each container component (`Split`, `TabSet`, `Grid`, and the root `MainLayout`) passes a `parentUpdate(action, id, newNode)` callback down to its children's `Pane`. A `Pane` (or a container reacting to a drag-and-drop) calls `parentUpdate('replace', node.id, newNode)` or `parentUpdate('remove', node.id)`, and the parent container is responsible for folding that into its own `children` array and then calling *its own* `parentUpdate` to propagate the change further up - all the way to `MainLayout`, whose `parentUpdate` calls `updateLayout` on the root.

For example, `Split`'s handler (`frontend/src/flexout/components/Split.jsx`):

```javascript
const handleChildUpdate = (action, id, newNode) => {
  if (action === 'remove') {
    const otherChild = node.children.find(c => c.id !== id);
    if (otherChild) parentUpdate('replace', node.id, otherChild); // collapse split to the surviving child
    else parentUpdate('remove', node.id);
  } else if (action === 'replace') {
    const newChildren = node.children.map(c => (c.id === id ? newNode : c));
    parentUpdate('replace', node.id, { ...node, children: newChildren });
  }
};
// ...
<Pane parentUpdate={handleChildUpdate} {...node.children[0]} />
```

`TabSet` and `Grid` follow the same pattern, adapted to their own child shape (an array of tabs, or a fixed-size `rows * cols` array).

#### Locating and activating a widget instance: `findWidgetPaths` / `activatePath`

Many widgets are singletons in practice (e.g. there's usually one `ProcessEditor` and one `ProcessLog` pane somewhere in the tree, possibly buried inside nested `TabSet`s). `findWidgetPaths(widgetType)` (from `frontend/src/flexout/layoutUtils.js`) walks the tree and returns every root-to-node id path that ends at a node of that widget type. `activatePath(path)` then walks the same path and, for every `TabSet` it passes through, sets that `TabSet`'s `activeTab` to the next id in the path - so calling it switches whatever tabs are in the way to reveal the target widget.

Real usage, `frontend/src/widgets/ProcessEditor.jsx`:

```javascript
function useActivateProcessLog() {
  const { findWidgetPaths, activatePath } = useContext(LayoutContext);
  return () => {
    const paths = findWidgetPaths('ProcessLog');
    if (paths.length > 0) activatePath(paths[0]);
  };
}
```

and `frontend/src/widgets/FlowView/index.jsx`, jumping to the `ProcessEditor` after starting a new process:

```javascript
const { findWidgetPaths, activatePath } = useContext(LayoutContext);
// ...
useRegisterMenu(["Process", "Create"], () => {
  startNewProcess();
  const paths = findWidgetPaths('ProcessEditor');
  if (paths.length > 0) activatePath(paths[0]);
});
```

## Built-in Widget Types

### VerticalSplit / HorizontalSplit

Resizable split containers with a draggable divider. Both are thin wrappers around the same `Split` component, differing only in the `splitType` they force.

**Properties:**
```javascript
{
  id: "split-1",
  widget: "VerticalSplit",  // or "HorizontalSplit"
  size: 0.5,                // fraction (0.1-0.9) of space given to children[0]
  children: [
    { id: "left", widget: "FlowView" },
    { id: "right", widget: "PlotView" }
  ]
}
```

**Features:**
- Drag the divider to resize (clamped to 10%-90%)
- Stores split position as `size` directly on the node
- Collapses to the surviving child if the other child is removed

**Implementation:** See `frontend/src/flexout/components/Split.jsx`.

### TabSet

Tabbed container for multiple widgets.

**Properties:**
```javascript
{
  id: "tabs-1",
  widget: "TabSet",
  activeTab: "tab-2",  // id of the currently selected child
  children: [
    { id: "tab-1", widget: "PlotView" },
    { id: "tab-2", widget: "MapView" },
    { id: "tab-3", widget: "ProcessLog" }
  ]
}
```

**Features:**
- Click a tab to switch the active widget
- Drag a tab to reorder it within the strip, or drop it onto another pane/tab strip to move it there
- Close (x) button, reachable via each tab's chevron menu
- Per-tab **Configure** modal, for widgets that define a static `get_schema` (same mechanism as the pane-level Configure modal - see [Pane](#pane))
- Per-tab title editing: click the active tab's label to turn it into a text input (`TabHeader` in `frontend/src/flexout/components/TabSet.jsx`); the value is stored as `customTitle` on the tab node
- Drag a tab out to create a new split (dropping it on another pane replaces that pane)
- Add a new (`Empty`) tab via the `+` button

**Implementation:** See `frontend/src/flexout/components/TabSet.jsx` (`TabHeader` sub-component handles the per-tab menu, Configure modal, and title editing).

### Grid

Resizable `rows x cols` container - a first-class alternative to nesting `Split`s when you want more than two panes arranged on a grid.

**Properties:**
```javascript
{
  id: "grid-1",
  widget: "Grid",
  rows: 2,
  cols: 2,
  colWidths: [0.5, 0.5],   // fractions per column, auto-normalized if rows/cols change
  rowHeights: [0.5, 0.5],
  children: [              // length rows*cols, padded with Empty cells if shorter
    { id: "cell-0", widget: "PlotView" },
    { id: "cell-1", widget: "MapView" },
    { id: "cell-2", widget: "Empty" },
    { id: "cell-3", widget: "Empty" }
  ]
}
```

**Features:**
- Drag any row/column divider to resize (minimum fraction enforced per track)
- `rows`/`cols` configurable via the pane's Configure modal (`Grid.get_schema`)
- Missing cells are padded with stable-id `Empty` placeholders so partially-filled grids don't lose data when resized

**Implementation:** See `frontend/src/flexout/components/Grid.jsx`.

### Empty

Placeholder widget for a blank pane.

**Properties:**
```javascript
{
  id: "empty-1",
  widget: "Empty"
}
```

An `Empty` node renders nothing but a blank pane; use the pane's chevron menu (see [Pane](#pane)) to pick a real widget for it.

## Pane

`Pane` (`frontend/src/flexout/components/Pane.jsx`) wraps every node in the tree - leaf widgets and containers alike - and is what actually calls `parentUpdate`/`updateLayout` in response to user actions.

**Props:** `Pane({ parentUpdate, onTabMoved, hideHeader, ...node })` - `parentUpdate` is the callback described in [Tree Operations](#tree-operations); `onTabMoved` is called by `TabSet` when a tab-drag ends by being dropped elsewhere; `hideHeader` is set by `TabSet` on its child panes (the tab strip already shows the header, so the pane's own header is suppressed) and by the root pane by convention (`border-top` styling only).

**Features:**
- Header with the widget's title (`Widget.title`), click-to-edit as a `customTitle` on the node
- A chevron button opens a `PaneMenuDropdown` popover (portal-rendered, closes on outside click) containing:
  - A **Configure** (gear) button, shown only if the widget defines a static `get_schema(data_context)` function - opens a `CustomForm` (JSON-Schema-driven) modal to edit the node's non-structural fields
  - A **delete** (x) button, calling `parentUpdate('remove', node.id)`
  - A list of buttons, one per registered widget type, to switch this pane's widget (`handleChangeContent`) - switching into/out of a container type (`VerticalSplit`/`HorizontalSplit`/`TabSet`/`Grid`) preserves existing children where possible
- The widget itself is rendered inside a `WidgetErrorBoundary` (a class component implementing `componentDidCatch`), so a crashing widget shows an in-pane error card with the error/stack instead of taking down the whole layout; the boundary resets when the widget type or node changes
- Drag-and-drop (see [Drag and Drop](#drag-and-drop))

There is no popout button - popout windows are not part of the current implementation (see below).

## Drag and Drop

Flexout uses `react-dnd` (`useDrag`/`useDrop`, item type `'pane'`) for drag-and-drop, implemented in `frontend/src/flexout/components/Pane.jsx` and `frontend/src/flexout/components/TabSet.jsx`.

There is no per-edge drop-zone splitting (no top/bottom/left/right/center hot zones). Dropping one pane onto another simply **replaces the target pane** with the dragged node (`parentUpdate('replace', targetId, draggedNode)` with a freshly generated id for the dragged node's copy). To end up with a split, drag a pane onto a `TabSet`'s tab strip (adds it as a new tab) or use the widget-switch menu to turn a pane into a `VerticalSplit`/`HorizontalSplit`/`Grid`, which wraps the existing content as one child/cell.

Dropping specifically onto a `TabSet`'s tab strip (rather than onto the pane body) instead calls `addTab`, appending the dragged node as a new tab; dropping onto an individual `TabHeader` calls `insertTabAt`, inserting it at that position. When a tab's own drag ends by being dropped somewhere else, `TabSet` removes it from its original location via `updateLayout` with an updater function that searches the whole tree for the source `TabSet` (`removeTabFromTree`), since the drop target may be anywhere.

**Drag sources:** tabs (from `TabSet`'s `TabHeader`) and pane headers (from `Pane`).

**See:** `frontend/src/flexout/components/Pane.jsx` and `frontend/src/flexout/components/TabSet.jsx` for the `useDrag`/`useDrop` implementations.

## Menu System

The `MenuContext` (`frontend/src/flexout/MenuContext.jsx`) provides a registration system for the global menu bar rendered by `MenuBar.jsx`. Menu entries form a tree keyed by label, not a flat map of top-level key -> array of actions.

### Registering menu entries

Use the hooks, not the raw context functions directly - they handle registration inside a `useEffect` for you:

```javascript
import { useRegisterMenu, useRegisterMenuComponent } from './flexout/MenuContext';

// A leaf action, at menu path File > New
useRegisterMenu(["File", "New"], () => handleNew(), /* position */ 1, /* active */ false);
```

`registerMenu(path, action, position = 1, active = false)`:
- `path` is an **array** of labels forming a tree path (e.g. `["File", "New"]`, or `["Process", "Create"]` as used by `FlowView`) - each intermediate label becomes (or reuses) a submenu node, and the last label becomes the clickable leaf
- `position` controls sort order within its siblings (ties break alphabetically); negative positions are rendered right-aligned in the top-level bar (see `MenuBar.jsx`'s `leftItems`/`rightItems` split)
- `active` marks the entry with an `active` CSS class (e.g. for a currently-selected option)
- There is no `shortcut` field and no `{ type: 'separator' }` concept in the real data model - the doc's earlier example describing those was aspirational, not implemented

There's also a second registration mode for mounting an arbitrary React component at a menu-tree position, e.g. for the project switcher in the top bar:

```javascript
// App.jsx
useRegisterMenuComponent(["_projectDropdown"], ProjectDropdown, -2);
useRegisterMenuComponent(["_processSelector"], ProcessSelector, -1);
```

`registerMenuComponent(path, component, position = 1)` - if the terminal node of `path` has a `component`, `MenuBar` renders `<Component />` in place of a button/submenu, at any depth (top-level, e.g. `_projectDropdown` above, or nested, e.g. `UserMenu`'s `useRegisterMenuComponent([menuName, 'Balance'], UserMenuExtras, -1)`).

### No `unregisterMenu`

`unregisterMenu` does not exist - there is no removal/cleanup API. `useRegisterMenu`/`useRegisterMenuComponent`'s `useEffect` calls register unconditionally on mount (and again if `active` changes, for `useRegisterMenu`) but return no cleanup function, so entries persist in the menu tree for the life of the app once registered. This matches how the hooks are actually used: from components that are mounted once near the app root (`App.jsx`, `WorkspaceMenu.jsx`, `UserMenu.jsx`) or from a widget whose menu entry should exist as long as that widget type is registered - not from something that mounts/unmounts frequently and needs its menu entry to disappear.

### Menu tree shape

Internally, `MenuProvider` keeps `menuTree` as nested objects keyed by label:

```javascript
{
  File: {
    position: 1,
    __children: {
      New: { position: 1, action: () => {}, active: false, __children: {} },
      Open: { position: 2, action: () => {}, active: false, __children: {} },
    }
  },
  _projectDropdown: {
    position: -2,
    component: ProjectDropdown,
    __children: {}
  }
}
```

`MenuBar.jsx` walks this tree, rendering nodes with a `component` as-is, leaf nodes (no `__children` entries) as buttons calling `action`, and everything else as a Bootstrap dropdown submenu.

## Persistence

Layouts are persisted server-side as **workspaces**, not in `localStorage`. `App.jsx` extracts a workspace id from the URL (`/app/w/:workspace/...`, falling back to `'default'`), loads it via `getWorkspace(workspaceId)` (`frontend/src/datamodel/api.js`), and uses the latest entry in `workspace.versions` as the `initial_layout` passed to `LayoutProvider`. If loading fails, it falls back to a hardcoded default layout.

Saving, updating, forking, and deleting workspaces goes through TanStack Query hooks in `frontend/src/datamodel/useQueries.js` - `useWorkspaces`, `useSaveWorkspace`, `useSaveWorkspaceVersion`, `useUpdateWorkspace`, `useForkWorkspace`, `useDeleteWorkspace`, `usePublicWorkspaces`. `frontend/src/WorkspaceMenu.jsx` is the UI for these (registered into the "Workspaces" menu via `useRegisterMenu`/`useRegisterMenuComponent`).

**See:** [Query Architecture](queries.md) for the full hook signatures and invalidation behavior.

## Best Practices

### Tree Manipulation

**DO**: Propagate changes via the `parentUpdate` callback threaded down from `MainLayout`, or via `updateLayout` at the root

```javascript
// Inside a Pane/Split/TabSet/Grid, given the parentUpdate prop:
parentUpdate('replace', node.id, newNode);
parentUpdate('remove', node.id);
```

**DON'T**: Directly mutate the layout tree

```javascript
// Wrong!
layout.children.push(newNode);
updateLayout(layout);
```

### Node IDs

**DO**: Generate unique IDs

```javascript
import { v4 as uuidv4 } from 'uuid';
const newNode = { id: uuidv4(), widget: 'PlotView' };
```

**DON'T**: Reuse IDs

```javascript
// Wrong! May cause conflicts, and confuses findWidgetPaths/activatePath
const newNode = { id: 'plot-1', widget: 'PlotView' };
```

### Widget Data

**DO**: Store widget-specific config directly on the node (there is no separate `data` sub-object)

```javascript
parentUpdate('replace', node.id, {
  ...node,
  plotElements: [...],
  selectedDataset: '...'
});
```

**DON'T**: Store in widget component state if persistence is needed

```javascript
// Wrong! Lost on widget unmount, and not saved with the workspace
const [config, setConfig] = useState({});
```

## Advanced Customization

### Custom Layout Widgets

You can create custom layout (container) widgets beyond the built-in `Split`/`TabSet`/`Grid`. For example, an accordion-style stack of collapsible panes (not currently implemented) would follow the same shape as `Grid`: accept `parentUpdate` and the rest of the node as props, render each child through its own `Pane` with a `handleChildUpdate` that folds child changes back into `parentUpdate('replace', node.id, { ...node, children: newChildren })`.

```javascript
// AccordionLayout.jsx
function AccordionLayout({ parentUpdate, ...node }) {
  const handleChildUpdate = (action, id, newNode) => {
    // fold child 'replace'/'remove' into this node's children, like Split/Grid do,
    // then: parentUpdate('replace', node.id, { ...node, children: newChildren });
  };

  return (
    <div className="accordion-layout">
      {node.children.map(child => (
        <div key={child.id} className="accordion-item">
          <Pane parentUpdate={handleChildUpdate} {...child} />
        </div>
      ))}
    </div>
  );
}

AccordionLayout.title = "Accordion";

// Register as a widget, alongside your regular content widgets
const widgets = {
  // ...
  AccordionLayout
};
```

### Custom Drop Behaviors

Override drop handling for specific widgets using `react-dnd` directly - matching the item type (`'pane'`) and payload shape (`{ node }`) used throughout Flexout:

```javascript
function CustomPane({ node, parentUpdate }) {
  const [, drop] = useDrop({
    accept: 'pane',
    drop: (dragged, monitor) => {
      if (monitor.didDrop()) return; // a nested drop target already handled it
      if (dragged.node.id === node.id) return;
      // Custom drop logic, falling back to the default "replace" behavior:
      parentUpdate('replace', node.id, { ...dragged.node, id: uuidv4() });
      return {};
    }
  });

  return <div ref={drop}>{/* ... */}</div>;
}
```

# Widget System

YmerFlow's frontend uses a flexible widget system where each pane in the layout can display different types of content. Widgets are React components that can be dragged, dropped, and rearranged within the Flexout layout system.

## Widget Basics

### What is a Widget?

A widget is a React component that:
- Renders content in a layout pane
- Has a static `title` property for display in menus
- Can access global state via React Context
- Can be instantiated multiple times in different panes

### Widget Registration

Widgets are not a static object — they're contributed through the plugin hook registry so that both built-in widgets and plugin-provided widgets can merge into the same list. `frontend/src/App.jsx` registers the built-ins via `registerHook('widgets', ...)`:

```javascript
import { registerHook, hooks } from './plugins/hooks';

// ── Register built-in widgets ─────────────────────────────────────────────────
registerHook('widgets', () => [
  { name: 'PlotView',          component: PlotView },
  { name: 'FlowView',          component: FlowView },
  { name: 'ProcessEditor',     component: ProcessEditor },
  { name: 'EnvironmentView',   component: EnvironmentView },
  { name: 'ProcessLog',        component: ProcessLog },
  { name: 'ProcessProgress',   component: ProcessProgress },
  { name: 'Export',            component: Export },
  { name: 'ProcessInfo',       component: ProcessInfo },
  { name: 'AEMModelSimulator', component: AEMModelSimulator },
  { name: 'InUseEditor',       component: InUseEditor },
  { name: 'PluginManager',     component: PluginManager },
]);
```

A `buildWidgets()` function turns all registered `{ name, component }` entries into the `{ name: Component }` map the layout system consumes:

```javascript
function buildWidgets() {
  const map = Object.fromEntries(
    hooks.run.widgets().map(({ name, component }) => [name, component])
  );
  window.__nagelfluh_widgets = map;
  return map;
}
```

`buildWidgets()` is called again after plugins finish loading (see the `useEffect` inside `AuthenticatedApp` in `App.jsx`), so any widgets a plugin registers via its own `registerHook('widgets', ...)` call are merged in alongside the built-ins before the app renders.

**See:** `frontend/src/App.jsx` - look for the `registerHook('widgets', ...)` call and `buildWidgets()`.

## Creating a New Widget

### Basic Widget Template

```javascript
// MyWidget.jsx
import React, { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';

function MyWidget() {
  const { processes, activeProcess } = useContext(ProcessContext);

  return (
    <div style={{ padding: '10px' }}>
      <h3>My Custom Widget</h3>
      <p>Active process: {activeProcess?.processId || 'None'}</p>
      {/* Your widget content here */}
    </div>
  );
}

// IMPORTANT: Set the static title property
MyWidget.title = "My Widget";

export default MyWidget;
```

### Register the Widget

Import it in `App.jsx` and add it to the `registerHook('widgets', ...)` call:

```javascript
import MyWidget from './widgets/MyWidget';

registerHook('widgets', () => [
  // ... existing widgets
  { name: 'MyWidget', component: MyWidget },
]);
```

The widget will now appear in the dropdown menu of every pane.

## Built-in Widgets

### FlowView

Visual graph of processes and their dependencies.

**Features:**
- ReactFlow-based node graph
- Shows process connections (input → process → output)
- Click node to set as active process
- Drag nodes to rearrange layout
- Auto-layout on process changes

**Usage:**
```javascript
const { processes, activeProcess, setActiveProcess } = useContext(ProcessContext);
```

**Key interactions:**
- Click process node → sets active process
- Drag nodes → repositions in graph
- Zoom/pan → navigate large graphs

### ProcessEditor

Dual-mode editor for creating and editing processes.

**Mode 1: Create Mode** (no active process)
- Select process type from dropdown
- Configure resources (CPU, memory, deadline)
- See estimated max cost
- Fill parameter form (JSON Schema-based)
- Submit to create process

**Mode 2: Edit Mode** (active process selected)
- View current process parameters
- Edit parameters
- Create new version with changes
- View output datasets

**Features:**
- JSON Schema form rendering via @rjsf/core
- Custom fields for dataset selection
- Resource validation
- Cost calculation
- Version history

**Data Access Pattern:**
```javascript
const { processes, activeProcess } = useContext(ProcessContext);

// Find the full process object
const process = processes.find(p => p.id === activeProcess?.processId);

// Access process data directly
const version = process?.versions[activeProcess?.version];
const outputs = version?.outputs;  // { "output_name": "url" }
const parameters = version?.parameters;
const state = version?.state;  // "pending", "running", "completed", "failed"
```

### ProcessLog

Real-time log viewer with WebSocket streaming.

**Features:**
- Live log updates via WebSocket
- Filter by process
- Status badges (Queued, Running, Done, Failed)
- Auto-scroll to latest
- Persistent log history

**Implementation:** See `frontend/src/widgets/ProcessLog.jsx` - uses WebSocket connection to backend for real-time log streaming.

### EnvironmentView

Table of processing environments (Docker images with registered process types) available in the project.

**Features:**
- Lists environments with name, Docker image, creator (process or bootstrap), and creation time
- Click a row to open a details modal
- Points users at the `create_environment` process type for creating new environments

**Implementation:** See `frontend/src/widgets/EnvironmentView.jsx`.

### ProcessProgress

Live plot of numeric progress values a running process reports in its logs.

**Features:**
- Parses a `##STATUS##<json>` tag out of log messages to extract numeric fields
- Streams log entries over WebSocket while the process is queued/running, falls back to a REST fetch once finished
- Dropdown to pick which numeric field to plot on the y-axis (x-axis is entry index)
- Renders via a `gladly-plot` `Plot` instance with a custom `ProgressLinePlot` layer type, same GPU pipeline PlotView uses

**Implementation:** See `frontend/src/widgets/ProcessProgress.jsx`.

### Export

Browsable tree of a process version's output datasets and their underlying files, for downloading.

**Features:**
- Fetches each dataset referenced in `process.versions[x].outputs` via `getDataset()`
- Renders a collapsible tree of dataset → parts → files, mirroring the dataset's `parts` structure
- Each file is a direct download link

**Implementation:** See `frontend/src/widgets/Export.jsx`.

### ProcessInfo

Read-only YAML-style dump of the active process's configuration and current version data.

**Features:**
- Merges the process object and its active version object (minus noisy fields like `versions`, `flow_x`, `flow_y`) and renders them as indented YAML-like text
- Auto-linkifies any URLs found in the dumped values (e.g. output dataset URLs)

**Implementation:** See `frontend/src/widgets/ProcessInfo.jsx`.

### AEMModelSimulator

Interactive editor for hand-building or editing synthetic AEM (airborne electromagnetic) resistivity models, for testing inversions against known models.

**Features:**
- Create a new synthetic flightline/model or load an existing one from a process's XYZ output
- Canvas-based brush painting of resistivity values and terrain, with adjustable brush radius/sharpness and colormap
- Add additional flightlines to a model, and save the edited model back out as an XYZ dataset

**Implementation:** See `frontend/src/widgets/AEMModelSimulator/index.jsx` and its supporting dialogs/canvas components in the same directory.

### InUseEditor

Companion control panel for bulk-editing per-sounding, per-gate "in use" flags on AEM data, driven by lasso selections made in a `PlotView` pane's `ChannelPlot` layers.

**Features:**
- Enable/Disable/Clear action modes, selectable via buttons or keyboard shortcuts (E/D/C)
- Undo last edit (Ctrl+Z) and save all pending in-memory diffs back to the datasets
- Shows aggregate stats (gate-sounding pairs edited, across how many datasets)
- Reads/writes edit state via `ProcessContext`'s `inMemoryDiffs`, `inUseAction`, `undoLastEdit`, `saveAllDiffs`

**Implementation:** See `frontend/src/widgets/InUseEditor.jsx`.

### PluginManager

Table of installed frontend/backend plugins with enable/disable/upgrade controls.

**Features:**
- Lists plugins (bundled or remote) with latest version, enabled state, and whether an upgrade is available
- Enable/disable/upgrade actions via `useEnablePlugin`/`useDisablePlugin`/`useUpgradePlugin` mutations
- Points users at the `build_frontend_plugin` process type for adding new plugins
- Changes take effect after a page reload

**Implementation:** See `frontend/src/widgets/PluginManager.jsx`.

### PlotView

GPU/WebGL scientific plotting built on the `gladly-plot` npm package, with a pluggable layer-type registry. There is no Plotly involved anywhere in this pipeline.

**Architecture:**
- A `gladly-plot` `Plot` instance (from `frontend/src/widgets/PlotView/index.jsx`) owns a `<canvas>`-backed regl/WebGL2 context and renders a config-driven set of layers
- **Layer Type Registry**: Pluggable layer types register themselves with `registerLayerType(name, new LayerType({...}))` at module load time (side-effect imports)
- **Config-driven layers**: The pane's `layoutConfig` (`{ transforms, layers, axes }`) is handed to `plot.update({ data, config })`; each entry in `layers` names a registered layer type plus its parameters
- **Dataset Integration**: `ProcessContext`'s `datasetCollection` is converted to a `DataGroup` (`dc.toDataGroup()`) for gladly's built-in resolution; custom layer types instead read raw dataset objects directly off `plot._rawData` (see the `gladly 0.0.6 DataGroup/_children Pattern` notes in project memory for why)
- **Picking & interaction**: `plot.on('mousemove'|'click', handler)` and `plot.pick(x, y)` drive the status bar and sounding-selection logic in `PlotView`

**Layer Type Structure:**

Layer types are defined in `frontend/src/widgets/PlotView/elements/` and registered with `gladly-plot`'s `registerLayerType`. Each one supplies:
- `getAxisConfig(parameters)` - returns `{ xAxis, xAxisQuantityKind, yAxis, yAxisQuantityKind }` for axis assignment
- `vert` / `frag` - GLSL (`#version 300 es`) vertex and fragment shader source strings
- `schema(data)` - JSON Schema for the layer's own configurable parameters
- `createLayer(regl, parameters, data, plot)` - builds the actual attribute arrays (`Float32Array`s) and returns one or more `{ attributes, uniforms, primitive }` draw calls

For example, `frontend/src/widgets/PlotView/elements/FlightlinePlot.js` registers a `FlightlinePlot` layer type that plots `lon`/`lat` (or configurable) columns as points/lines, colored by a single RGB uniform-per-vertex:

```javascript
import { LayerType, registerLayerType, AXIS_GEOMETRY } from 'gladly-plot';

registerLayerType('FlightlinePlot', new LayerType({
  name: 'FlightlinePlot',

  getAxisConfig: (parameters) => ({
    xAxis: parameters.xAxis ?? 'xaxis_bottom',
    xAxisQuantityKind: 'epsg_4326_x',
    yAxis: parameters.yAxis ?? 'yaxis_left',
    yAxisQuantityKind: 'epsg_4326_y',
  }),

  vert: RGB_VERT,   // GLSL vertex shader
  frag: RGB_FRAG,   // GLSL fragment shader

  schema: (data) => ({
    type: 'object',
    properties: {
      dataset:  { type: 'string', 'x-format': 'datasetPath' },
      x_column: { type: 'string', default: 'lon' },
      y_column: { type: 'string', default: 'lat' },
      mode:     { type: 'string', enum: ['lines', 'markers', 'lines+markers'], default: 'markers' },
      color:    { type: 'string', default: 'blue' },
      xAxis:    { type: 'string', enum: X_AXES, default: 'xaxis_bottom' },
      yAxis:    { type: 'string', enum: Y_AXES, default: 'yaxis_left'   },
    },
    required: ['dataset'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const rawData     = plot?._rawData ?? data;
    const dataset      = resolveDataPath(rawData, parameters.dataset);
    const flightlines  = dataset?.flightlines;
    if (!flightlines) return [];
    // ... build Float32Array attributes from flightlines[x_column]/[y_column] ...
    return [{ attributes: attribs, uniforms: { pointSize: 3.0 }, primitive: 'points' }];
  },
}));
```

**See:** `frontend/src/widgets/PlotView/elements/index.js` for the registry of all layer types, and `frontend/src/widgets/PlotView/index.jsx` for how the `Plot` instance is created and driven.

**Widget-level `get_schema`/`get_default` vs. per-layer-type `schema`:**

These are two unrelated conventions that happen to share the word "schema" — don't conflate them:

- **Widget-level `get_schema(data_context)` / `get_default(data_context)`** is a generic convention any widget component can opt into (as static functions on the component, like `title`). `Pane.jsx` and `TabSet.jsx` check `Widget.get_schema` — if present, a "Configure" (gear icon) action appears in the pane menu that opens a modal rendering a JSON Schema form (`CustomForm`) built from `Widget.get_schema(data_context)`, pre-filled from `Widget.get_default(data_context)` merged with the node's current data. Submitting the form calls `parentUpdate('replace', node.id, formData)`. Among the built-in widgets, only `PlotView` currently defines `get_schema`/`get_default`.

  `data_context` is threaded from `ProcessContext` down through `App.jsx` → `LayoutProvider` (`<LayoutProvider ... data_context={processContext}>`) → `LayoutContext`, and `Pane`/`TabSet` read it via `useContext(LayoutContext)`. So it really does carry the full `ProcessContext` value — but `PlotView.get_schema` itself does **not** walk `data_context.processes`/`versions`/`outputs` to build a dataset-name enum. It calls into `gladly-plot` directly:

  ```javascript
  PlotView.get_schema = (data_context = {}) => {
    // Pass null data so gladly emits x-format:'expression' schemas (no column enums);
    // combobox widgets populate options from ProcessContext at runtime.
    const rawGladlySchema = Plot.schema(null, data_context.layoutConfig);
    // ...wraps/patches rawGladlySchema for rjsf compatibility...
    return {
      type: 'object',
      properties: {
        id:           { type: 'string', title: 'ID',          readOnly: true },
        widget:       { type: 'string', title: 'Widget Type', readOnly: true },
        layoutConfig: gladlySchemaRest,
      },
      required: ['layoutConfig'],
    };
  };

  PlotView.get_default = () => ({
    layoutConfig: { transforms: [], layers: [], axes: {} },
  });
  ```

- **Per-layer-type `schema(data)`** (see `FlightlinePlot.js` above) is a separate, unrelated convention internal to `gladly-plot`'s `LayerType` — it describes that one layer type's own parameters (e.g. `dataset`, `x_column`, `color`) and has nothing to do with `ProcessContext` or `data_context`.

**Adding a Layer Type:**

1. Create a new file in `frontend/src/widgets/PlotView/elements/`
2. Call `registerLayerType(name, new LayerType({ getAxisConfig, vert, frag, schema, createLayer }))`
3. Import it as a side effect in `frontend/src/widgets/PlotView/elements/index.js`

**See existing examples:**
- `frontend/src/widgets/PlotView/elements/ChannelPlot.js`
- `frontend/src/widgets/PlotView/elements/FlightlinePlot.js`
- `frontend/src/widgets/PlotView/elements/ResistivityCurtain.js`

## Widget State Management

### Using ProcessContext

Most widgets need access to process data:

```javascript
import { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';

function MyWidget() {
  const {
    processes,          // Array of all processes
    activeProcess,      // { processId, version } or null
    setActiveProcess,   // Function to set active process
  } = useContext(ProcessContext);

  // Access full process data
  const process = processes.find(p => p.id === activeProcess?.processId);
  const version = process?.versions[activeProcess?.version];

  return (
    <div>
      {version && (
        <>
          <h4>{process.name}</h4>
          <p>State: {version.state}</p>
          <p>Outputs: {JSON.stringify(version.outputs)}</p>
        </>
      )}
    </div>
  );
}
```

### Process Object Structure

```javascript
{
  id: "process-abc-123",
  name: "FFT Analysis",
  type: "fft",
  versions: [
    {
      version: 0,
      parameters: { /* JSON Schema params */ },
      outputs: {
        "spectrum": "http://localhost:8000/dataset/xyz-789"
      },
      state: "completed",  // "pending" | "running" | "completed" | "failed"
      logs: [
        { timestamp: "2024-01-01T12:00:00Z", message: "Starting..." },
        // ...
      ]
    }
  ]
}
```

### Local Widget State

Widgets can maintain their own local state:

```javascript
function MyWidget() {
  const [selectedItem, setSelectedItem] = useState(null);
  const [filters, setFilters] = useState({ showAll: true });

  // Widget state persists while widget is mounted
  // State is lost when widget is removed from layout
}
```

### Persistent Widget Configuration

For configuration that should persist across sessions (survive save/reload of the workspace), store it directly as extra fields on the layout node itself. `Pane.jsx` renders `<Widget parentUpdate={parentUpdate} {...node} />` — every field on the node object is spread in as a prop, and `parentUpdate` is how the widget writes changes back into the layout tree. `PlotView` is the built-in example of this: it keeps its per-pane config under a `layoutConfig` field on the node.

```javascript
// A layout node is a plain object; any extra fields become widget props
{
  id: "pane-123",
  widget: "PlotView",
  layoutConfig: {
    layers: [ { FlightlinePlot: { dataset: "..." } } ],
    axes: {},
  }
}

// Access in the widget:
function PlotView({ id, widget, layoutConfig, parentUpdate, ...rest }) {
  const updateConfig = (newConfig) => {
    parentUpdate('replace', id, { id, widget, layoutConfig: newConfig, ...rest });
  };
  // ...
}
```

Widgets that want a "Configure" (gear icon) action in the pane menu instead of (or in addition to) editing their own state directly can define static `get_schema(data_context)` / `get_default(data_context)` on the component — see the PlotView section above for the real convention `Pane.jsx`/`TabSet.jsx` use to drive that modal.

## Widget Communication

### Via Active Process

The primary communication mechanism is through the active process:

```javascript
import { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useCreateProcess } from '../datamodel/useQueries';

// ProcessEditor: User creates/edits process
const { setActiveProcess, invalidateProject } = useContext(ProcessContext);
const createProcess = useCreateProcess();
const newProcess = await createProcess.mutateAsync({ proc, projectId });
await invalidateProject(projectId);
setActiveProcess({ processId: newProcess.id, version: 1 });

// FlowView: Shows visual feedback
const { activeProcess } = useContext(ProcessContext);
// Highlights active process node

// PlotView: Displays active process outputs
const { processes, activeProcess } = useContext(ProcessContext);
const outputs = processes.find(p => p.id === activeProcess.processId)
  ?.versions[activeProcess.version]?.outputs;
```

### Via Custom Context

For widget-specific communication that doesn't belong in `ProcessContext`, create a custom context and provide it alongside the other app-level providers in `App.jsx`. `PlotGroupContext` (`frontend/src/PlotGroupContext.jsx`) is the real built-in example — it lets multiple `PlotView` instances share a `gladly-plot` `PlotGroup` so their pan/zoom stay linked:

```javascript
// PlotGroupContext.jsx
import React, { createContext, useEffect, useRef } from 'react';
import { PlotGroup } from 'gladly-plot';

export const PlotGroupContext = createContext(null);

export function PlotGroupProvider({ children }) {
  const groupRef = useRef(null);
  if (!groupRef.current) {
    groupRef.current = new PlotGroup({}, { autoLink: true });
  }
  useEffect(() => () => { groupRef.current?.destroy(); groupRef.current = null; }, []);

  const value = {
    addPlot:    (name, plot) => groupRef.current?.add(name, plot),
    removePlot: (name)       => groupRef.current?.remove(name),
  };
  return <PlotGroupContext.Provider value={value}>{children}</PlotGroupContext.Provider>;
}

// Used inside PlotView:
const { addPlot, removePlot } = useContext(PlotGroupContext);
```

## Best Practices

### Data Access

**✅ DO**: Access process data directly from the processes array

```javascript
const process = processes.find(p => p.id === activeProcess.processId);
const outputs = process?.versions[activeProcess.version]?.outputs;
```

**❌ DON'T**: Assume data exists in complex abstractions

```javascript
// Don't create unnecessary intermediate state
const [currentOutputs, setCurrentOutputs] = useState({});
```

### Performance

**✅ DO**: Memoize expensive computations

```javascript
const processedData = useMemo(() => {
  return heavyComputation(rawData);
}, [rawData]);
```

**❌ DON'T**: Fetch data in render

```javascript
// Don't do this - causes infinite re-renders
const MyWidget = () => {
  const data = fetch(url).then(r => r.json());  // ❌ Wrong!
  return <div>{data}</div>;
};
```

### Error Handling

**✅ DO**: Handle loading and error states

```javascript
function MyWidget() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url)
      .then(r => r.json())
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [url]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return <div>{/* render data */}</div>;
}
```

### Styling

**✅ DO**: Use inline styles or CSS modules for widget-specific styling

```javascript
// Inline styles for simple cases
<div style={{ padding: '10px', backgroundColor: '#f0f0f0' }}>

// CSS modules for complex styling
import styles from './MyWidget.module.css';
<div className={styles.container}>
```

**❌ DON'T**: Use global CSS that might conflict

```css
/* ❌ Too generic, might conflict */
.container { padding: 10px; }

/* ✅ Widget-specific */
.myWidget-container { padding: 10px; }
```

## Advanced Topics

### Widget Props

`Pane.jsx` renders each widget as `<Widget parentUpdate={parentUpdate} {...node} />` — so a widget receives `parentUpdate` plus every field on its layout node spread in directly (at minimum `id` and `widget`, plus whatever custom fields the widget itself stores there, e.g. PlotView's `layoutConfig`). There is no `onClose`/`onPopout` — popout-to-new-window is not implemented anywhere in the current codebase, and pane removal goes through `parentUpdate('remove', id)` instead of a dedicated callback prop.

```javascript
function MyWidget({ id, widget, parentUpdate, ...rest }) {
  // id: unique identifier for this pane's layout node
  // widget: this widget's registered name (e.g. "MyWidget")
  // parentUpdate(action, id, newNode): 'replace' this node's data, or 'remove' it
  // ...rest: any custom fields this widget has stored on its own node

  return (
    <div>
      <button onClick={() => parentUpdate('remove', id)}>Close Me</button>
    </div>
  );
}
```

### Widget Lifecycle

```javascript
function MyWidget() {
  // Runs on mount
  useEffect(() => {
    console.log('Widget mounted');

    // Cleanup on unmount
    return () => {
      console.log('Widget unmounted');
    };
  }, []);

  // Runs when dependencies change
  useEffect(() => {
    console.log('Active process changed');
  }, [activeProcess]);
}
```

### Multiple Instances

Widgets can be instantiated multiple times — each occurrence is a separate layout node with its own `id`, rendered by its own `Pane`:

```javascript
// Two PlotView leaf nodes in the layout tree, each with its own config
{ id: "plot-1", widget: "PlotView", layoutConfig: { /* ... */ } }
{ id: "plot-2", widget: "PlotView", layoutConfig: { /* ... */ } }
```

Since `id` and any custom fields are spread in as props (see Widget Props above), each instance naturally receives its own data:

```javascript
function PlotView({ id, layoutConfig, parentUpdate }) {
  // layoutConfig is this instance's own config, already scoped by the layout tree
  // ...
}
```

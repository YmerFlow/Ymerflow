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

Widgets are registered in the `widgets` object in `frontend/src/App.js`.

**See:** `frontend/src/App.js` - look for the `widgets` constant where all built-in widgets are imported and registered.

## Creating a New Widget

### Basic Widget Template

```javascript
// MyWidget.js
import React from 'react';
import { useProcessContext } from './ProcessContext';

function MyWidget() {
  const { processes, activeProcess } = useProcessContext();

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

Add to `App.js`:

```javascript
import MyWidget from './MyWidget';

const widgets = {
  // ... existing widgets
  MyWidget,
};
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
const { processes, activeProcess, setActiveProcess } = useProcessContext();
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
const { processes, activeProcess } = useProcessContext();

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
- Status badges (Running, Completed, Failed)
- Auto-scroll to latest
- Persistent log history

**Implementation:** See `frontend/src/widgets/ProcessLog.js` - uses WebSocket connection to backend for real-time log streaming.

### PlotView

Plotly-based scientific plotting with extensible element system.

**Architecture:**
- **Plot Elements Registry**: Pluggable element types
- **Unit Matching**: Automatic axis assignment
- **Dataset Integration**: Direct dataset loading
- **Dynamic Traces**: Builds Plotly traces from data

**Plot Element Structure:**

Plot elements are defined in `frontend/src/widgets/PlotView/elements/` directory. Each element exports:
- `x_unit` and `y_unit` - For axis matching
- `parameters` - JSON Schema for configuration
- `render()` - Function that returns Plotly trace object

**See:** `frontend/src/widgets/PlotView/elements/index.js` for the registry of all plot elements.

**Plot Element `data_context`:**

**IMPORTANT**: When a plot element's `get_schema()` method is called, the `data_context` parameter contains **all entries from ProcessContext**. This includes:

```javascript
{
  processes,           // Array of all process objects
  activeProcess,       // { processId, version } or null
  datasets,           // Array of dataset objects (from useProcessOutputDatasets)
  datasetObjects,     // Loaded dataset objects
  fetchedData,        // Fetched dataset data
  currentProject,     // Current project ID
  // ... and all other ProcessContext values
}
```

**To get dataset names in `get_schema()`**, extract them from process outputs:

```javascript
get_schema: (data_context = {}) => {
  const processes = data_context.processes || [];

  // Extract all output dataset names from all processes
  const datasetNames = [];
  processes.forEach(proc => {
    proc.versions?.forEach(ver => {
      if (ver.outputs) {
        datasetNames.push(...Object.keys(ver.outputs));
      }
    });
  });

  return {
    // ... schema with datasetNames in enum
  };
}
```

**❌ DON'T** use `data_context.datasets` array and map `d.dataset_name` - this is the old pattern.

**✅ DO** use `data_context.processes` and extract output names from `process.versions[x].outputs` keys.

**Adding a Plot Element:**

1. Create new file in `frontend/src/widgets/PlotView/elements/`
2. Export an object with `xaxis`, `yaxis`, `get_schema()`, and `render()` function
3. Register in `frontend/src/widgets/PlotView/elements/index.js`

**See existing examples:**
- `frontend/src/widgets/PlotView/elements/ChannelPlot.js`
- `frontend/src/widgets/PlotView/elements/FlightlinePlot.js`
- `frontend/src/widgets/PlotView/elements/ResistivityCurtain.js`

### MapView

Geographic visualization of survey data.

**Features:**
- Interactive map with layers
- Display flight lines
- Show data coverage
- Geographic coordinate handling

## Widget State Management

### Using ProcessContext

Most widgets need access to process data:

```javascript
import { useProcessContext } from './ProcessContext';

function MyWidget() {
  const {
    processes,          // Array of all processes
    activeProcess,      // { processId, version } or null
    setActiveProcess,   // Function to set active process
    createProcess,      // Function to create new process
  } = useProcessContext();

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

For configuration that should persist across sessions, use the layout node's data:

```javascript
// In LayoutContext, each node can have custom data
{
  id: "pane-123",
  widget: "PlotView",
  data: {
    plotElements: [
      { type: "Line", params: { dataset: "..." } }
    ]
  }
}

// Access in widget:
function PlotView({ nodeId }) {
  const { getNode, updateNode } = useLayoutContext();
  const node = getNode(nodeId);
  const plotElements = node.data?.plotElements || [];

  const addElement = (element) => {
    updateNode(nodeId, {
      data: {
        ...node.data,
        plotElements: [...plotElements, element]
      }
    });
  };
}
```

## Widget Communication

### Via Active Process

The primary communication mechanism is through the active process:

```javascript
// ProcessEditor: User creates/edits process
const { setActiveProcess, createProcess } = useProcessContext();
await createProcess(type, params);
setActiveProcess({ processId: newId, version: 0 });

// FlowView: Shows visual feedback
const { activeProcess } = useProcessContext();
// Highlights active process node

// PlotView: Displays active process outputs
const { processes, activeProcess } = useProcessContext();
const outputs = processes.find(p => p.id === activeProcess.processId)
  ?.versions[activeProcess.version]?.outputs;
```

### Via Custom Context

For widget-specific communication, create custom contexts:

```javascript
// MapContext.js
const MapContext = createContext();

export function MapProvider({ children }) {
  const [selectedLocation, setSelectedLocation] = useState(null);
  return (
    <MapContext.Provider value={{ selectedLocation, setSelectedLocation }}>
      {children}
    </MapContext.Provider>
  );
}

// Use in multiple widgets
function MapView() {
  const { setSelectedLocation } = useContext(MapContext);
  // ...
}

function LocationInfo() {
  const { selectedLocation } = useContext(MapContext);
  // ...
}
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

Widgets receive props from the layout system:

```javascript
function MyWidget({ nodeId, onClose, onPopout }) {
  // nodeId: Unique identifier for this pane
  // onClose: Function to close this pane
  // onPopout: Function to popout this pane to new window

  return (
    <div>
      <button onClick={onClose}>Close Me</button>
      <button onClick={onPopout}>Popout</button>
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

Widgets can be instantiated multiple times:

```javascript
// Two PlotView widgets can show different plots
// Each maintains its own state and configuration
<Layout>
  <Pane widget="PlotView" nodeId="plot-1" />
  <Pane widget="PlotView" nodeId="plot-2" />
</Layout>
```

Use `nodeId` to distinguish between instances:

```javascript
function PlotView({ nodeId }) {
  const config = loadConfig(nodeId);  // Load instance-specific config
  // ...
}
```

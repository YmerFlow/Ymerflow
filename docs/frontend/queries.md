# Query and Data Invalidation Architecture

**Last Updated**: 2026-02-12

This document describes the frontend's data fetching and cache invalidation architecture using TanStack Query (React Query).

## Table of Contents

- [Overview](#overview)
- [Core Principles](#core-principles)
- [Query Hooks](#query-hooks)
- [Centralized Invalidation](#centralized-invalidation)
- [Usage Patterns](#usage-patterns)
- [Best Practices](#best-practices)
- [Common Pitfalls](#common-pitfalls)
- [Debugging](#debugging)

## Overview

YmerFlow uses [TanStack Query v4](https://tanstack.com/query/v4) for:
- Server state management
- Automatic background refetching
- Cache management
- Optimistic updates
- Request deduplication

**Architecture**: All data fetching uses custom hooks that wrap TanStack Query. All cache invalidation goes through centralized helpers in `ProcessContext`.

## Core Principles

### 1. **Use Hooks Everywhere**

❌ **Never** do this:
```javascript
fetch(`${API}/datasets?search=${search}`)
  .then(r => r.json())
  .then(data => setDatasets(data));
```

✅ **Always** do this:
```javascript
const { data: datasets = [] } = useSearchDatasets(search, true, projectId);
```

**Why**: Hooks connect components to the query cache. Manual `fetch()` calls are invisible to the cache system and won't update when data changes.

### 2. **Centralized Invalidation Only**

❌ **Never** do this:
```javascript
queryClient.invalidateQueries({ queryKey: ['processes'] });
// or
queryClient.refetchQueries({ queryKey: ['processes'] });
```

✅ **Always** do this:
```javascript
const { invalidateProject } = useContext(ProcessContext);
await invalidateProject(projectId);
```

**Why**: Centralized invalidation ensures all related queries are invalidated together, preventing race conditions and partial updates.

### 3. **Trust TanStack Query**

Don't implement:
- Polling loops to wait for data
- Manual cache coordination
- Complex refetch orchestration

TanStack Query handles all of this automatically when you use hooks and invalidate through the centralized helpers.

## Query Hooks

All query hooks are defined in `frontend/src/datamodel/useQueries.js`.

### Available Hooks

#### Projects and Environments

```javascript
// Fetch all projects
const { data: projects = [], isLoading, error } = useProjects();

// Fetch all environments
const { data: environments = [], isLoading, error } = useEnvironments();

// Fetch process types for an environment
const { data: types = {}, isLoading } = useEnvironmentProcessTypes(environmentId);
```

#### Processes

```javascript
// Fetch all processes for a project
const { data: processes = [], isLoading, error, refetch } = useProcesses(projectId);
// Note: refetch is available but prefer using invalidation helpers
```

#### Datasets

```javascript
// Fetch a single dataset by ID
const { data: dataset, isLoading, error } = useDataset(datasetId);

// Search datasets with filters
const { data: datasets = [], isLoading, error } = useSearchDatasets(
  searchText,      // Search string
  completedOnly,   // Boolean: only completed processes
  projectId        // Filter by project
);

// Fetch outputs for a specific process version
const { data: datasets = [], isLoading } = useProcessOutputDatasets(
  process,  // Process object
  version   // Version number
);
```

#### Mutations

```javascript
// Create a new project
const createProject = useCreateProject();
await createProject.mutateAsync({ name: "My Project" });

// Create a new environment
const createEnvironment = useCreateEnvironment();
await createEnvironment.mutateAsync({ name: "My Env", image: "..." });

// Create a new process (does NOT auto-invalidate)
const createProcess = useCreateProcess();
const newProcess = await createProcess.mutateAsync({
  proc: { name, type, params, ... },
  projectId
});
// Must manually invalidate after:
await invalidateProject(projectId);
```

### Query Keys

Query keys are centralized in `queryKeys` object:

```javascript
import { queryKeys } from './datamodel/useQueries';

queryKeys.projects                           // ['projects']
queryKeys.environments                       // ['environments']
queryKeys.environmentProcessTypes(envId)     // ['environmentProcessTypes', envId]
queryKeys.processes(projectId)               // ['processes', projectId]
queryKeys.dataset(id)                        // ['dataset', id]
queryKeys.datasets(search, completedOnly, projectId)  // ['datasets', { ... }]
queryKeys.processOutputDatasets(processId, version)   // ['processOutputDatasets', processId, version]
```

**Note**: You rarely need these directly. Use the invalidation helpers instead.

## Centralized Invalidation

All query invalidation MUST go through helpers provided by `ProcessContext`.

### Invalidation Helpers

```javascript
const {
  invalidateProcess,
  invalidateProject,
  invalidateDatasets
} = useContext(ProcessContext);
```

#### `invalidateProcess(processId, projectId)`

Invalidates a specific process and its outputs.

**Refetches**:
- `['processes', projectId]`
- `['processOutputDatasets', processId]` (all versions)

**Use when**: A specific process has been updated (parameters changed, new version created).

```javascript
// Example: After updating process parameters
await createProcess.mutateAsync({ proc: { id: processId, ... }, projectId });
await invalidateProcess(processId, projectId);
```

#### `invalidateProject(projectId)`

Invalidates all data for a project.

**Refetches**:
- `['processes', projectId]` - All processes
- `['datasets']` - All dataset searches
- `['processOutputDatasets']` - All process outputs (via predicate)

**Use when**:
- Creating a new process
- Deleting a process
- Any operation that affects multiple processes
- WebSocket update received (process state changed)

```javascript
// Example: After creating a new process
const newProcess = await createProcess.mutateAsync({ proc, projectId });
await invalidateProject(projectId);
setActiveProcess({ processId: newProcess.id, version: 1 });
```

#### `invalidateDatasets()`

Invalidates dataset searches only.

**Refetches**:
- `['datasets']` - All dataset searches

**Use when**: Dataset metadata has changed but processes haven't (rare).

```javascript
// Example: After dataset-only operation
await someDatasetOperation();
await invalidateDatasets();
```

### Automatic Invalidation

**WebSocket Updates**: When the backend sends a process state update via WebSocket, `ProcessContext` automatically calls `invalidateProject()`. You don't need to handle this manually.

**Location**: `frontend/src/ProcessContext.js:210-213`

```javascript
const handleWebSocketMessage = useCallback(async (update) => {
  await invalidateHelpers.invalidateProject();
}, [invalidateHelpers]);
```

## Usage Patterns

### Pattern 1: Creating a Process

```javascript
import { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useCreateProcess } from '../datamodel/useQueries';

function MyComponent() {
  const { currentProject, invalidateProject, setActiveProcess } = useContext(ProcessContext);
  const createProcess = useCreateProcess();

  const handleCreate = async () => {
    // 1. Create the process
    const newProcess = await createProcess.mutateAsync({
      proc: {
        name: "my-process",
        type: "fft",
        params: { ... },
        environment_id: envId
      },
      projectId: currentProject
    });

    // 2. Invalidate to update all components
    await invalidateProject(currentProject);

    // 3. Navigate to the new process
    setActiveProcess({
      processId: newProcess.id,
      version: 1
    });
  };

  return <button onClick={handleCreate}>Create Process</button>;
}
```

### Pattern 2: Searching Datasets

```javascript
import { useState, useEffect, useRef } from 'react';
import { useSearchDatasets } from '../datamodel/useQueries';

function DatasetSearch({ projectId }) {
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimer = useRef(null);

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchText]);

  // Use the hook with debounced search
  const { data: datasets = [], isLoading } = useSearchDatasets(
    debouncedSearch,
    true,  // completedOnly
    projectId
  );

  return (
    <div>
      <input value={searchText} onChange={e => setSearchText(e.target.value)} />
      {isLoading ? <div>Loading...</div> : (
        <ul>
          {datasets.map(ds => <li key={ds.id}>{ds.dataset_name}</li>)}
        </ul>
      )}
    </div>
  );
}
```

**Key**: The component automatically updates when `invalidateProject()` is called elsewhere, because the hook is connected to the query cache.

### Pattern 3: Displaying Process Outputs

```javascript
import { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useProcessOutputDatasets } from '../datamodel/useQueries';

function ProcessOutputs() {
  const { processes, activeProcess } = useContext(ProcessContext);

  // Find the active process object
  const process = activeProcess
    ? processes.find(p => p.id === activeProcess.processId)
    : null;

  // Fetch outputs for active version
  const { data: datasets = [], isLoading } = useProcessOutputDatasets(
    process,
    activeProcess?.version
  );

  if (!process) return <div>No process selected</div>;
  if (isLoading) return <div>Loading outputs...</div>;

  return (
    <ul>
      {datasets.map(ds => (
        <li key={ds.id}>{ds.dataset_name}: {ds.url}</li>
      ))}
    </ul>
  );
}
```

### Pattern 4: Updating Process Parameters

```javascript
import { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useCreateProcess } from '../datamodel/useQueries';

function ProcessParameterEditor({ process }) {
  const { currentProject, invalidateProject, setActiveProcess } = useContext(ProcessContext);
  const createProcess = useCreateProcess();

  const handleSave = async (newParams) => {
    // Creating with existing ID creates a new version
    const updatedProcess = await createProcess.mutateAsync({
      proc: {
        id: process.id,  // Same ID = new version
        name: process.name,
        type: process.type,
        environment_id: process.environment_id,
        params: newParams
      },
      projectId: currentProject
    });

    // Invalidate to show the new version
    await invalidateProject(currentProject);

    // Switch to the new version
    const latestVersion = Math.max(...updatedProcess.versions.map(v => v.version));
    setActiveProcess({
      processId: process.id,
      version: latestVersion
    });
  };

  return <ParameterForm onSave={handleSave} />;
}
```

## Best Practices

### 1. Always await invalidation

```javascript
// ✅ Good: Wait for refetch to complete
await invalidateProject(projectId);
setActiveProcess({ processId: newId, version: 1 });

// ❌ Bad: Race condition - activeProcess set before data arrives
invalidateProject(projectId);  // Don't await
setActiveProcess({ processId: newId, version: 1 });
```

### 2. Use staleTime appropriately

Current defaults (in `useQueries.js`):
- Projects: 5 minutes
- Environments: 5 minutes
- Process types: 5 minutes
- Processes: 10 seconds
- Datasets: 10 seconds
- Single dataset: 30 seconds

**Why short staleTime for processes/datasets**: These change frequently via user actions and WebSocket updates.

### 3. Enable queries conditionally

```javascript
// ✅ Good: Only fetch when needed
const { data: datasets } = useProcessOutputDatasets(
  process,
  version,
  { enabled: !!process && version != null }
);

// ❌ Bad: Hook errors if process is null
const { data: datasets } = useProcessOutputDatasets(process, version);
```

Most hooks already handle this, but be aware when passing options.

### 4. Use empty arrays for default values

```javascript
// ✅ Good: Prevents undefined errors
const { data: processes = [] } = useProcesses(projectId);
processes.map(p => ...);  // Safe even during loading

// ❌ Bad: Errors during loading
const { data: processes } = useProcesses(projectId);
processes.map(p => ...);  // Error: Cannot read property 'map' of undefined
```

### 5. Don't mix manual fetch with hooks

```javascript
// ❌ Bad: Component won't update when cache invalidates
useEffect(() => {
  fetch(`${API}/datasets?search=${search}`)
    .then(r => r.json())
    .then(setDatasets);
}, [search]);

// ✅ Good: Automatically updates
const { data: datasets = [] } = useSearchDatasets(search, true, projectId);
```

## Common Pitfalls

### Pitfall 1: Forgetting to invalidate after mutations

```javascript
// ❌ Bad: UI won't update
const newProcess = await createProcess.mutateAsync({ proc, projectId });
setActiveProcess({ processId: newProcess.id, version: 1 });
// Where's the invalidation?

// ✅ Good: UI updates immediately
const newProcess = await createProcess.mutateAsync({ proc, projectId });
await invalidateProject(projectId);
setActiveProcess({ processId: newProcess.id, version: 1 });
```

### Pitfall 2: Using wrong invalidation helper

```javascript
// ❌ Overkill: Invalidates everything when only one process changed
await invalidateProject(projectId);

// ✅ Better: Only invalidate what changed
await invalidateProcess(processId, projectId);
```

However, when in doubt, use `invalidateProject()`. It's better to refetch too much than too little.

### Pitfall 3: Not awaiting async invalidation

```javascript
// ❌ Bad: Race condition
invalidateProject(projectId);
console.log('Processes:', processes);  // Still old data!

// ✅ Good: Wait for refetch
await invalidateProject(projectId);
console.log('Processes:', processes);  // New data available
```

Note: Even after awaiting, the `processes` variable won't update immediately in the current render. It will update in the next render cycle. But awaiting ensures the data is in the cache.

### Pitfall 4: Invalidating in render

```javascript
// ❌ Bad: Causes infinite loop
function MyComponent() {
  const { invalidateProject } = useContext(ProcessContext);
  invalidateProject();  // Called every render!
  return <div>...</div>;
}

// ✅ Good: Invalidate in effect or handler
function MyComponent() {
  const { invalidateProject } = useContext(ProcessContext);

  useEffect(() => {
    invalidateProject();
  }, []);  // Only once

  return <div>...</div>;
}
```

### Pitfall 5: Duplicate invalidation

```javascript
// ❌ Bad: Mutation already invalidates, this is redundant
const createProject = useCreateProject();  // This auto-invalidates
await createProject.mutateAsync({ name });
await invalidateProjects();  // Unnecessary!

// Note: useCreateProcess does NOT auto-invalidate (by design)
// You must manually invalidate for processes
const createProcess = useCreateProcess();  // This does NOT auto-invalidate
await createProcess.mutateAsync({ proc, projectId });
await invalidateProject(projectId);  // Required!
```

## Debugging

### Inspecting the Cache

Use React Query DevTools (if installed):

```javascript
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

function App() {
  return (
    <>
      {/* Your app */}
      <ReactQueryDevtools initialIsOpen={false} />
    </>
  );
}
```

### Logging Query State

```javascript
const { data, isLoading, isFetching, isStale } = useProcesses(projectId);

console.log({
  data,
  isLoading,    // True during first load
  isFetching,   // True during any fetch (including refetch)
  isStale       // True if data is stale (past staleTime)
});
```

### Manual Cache Inspection

```javascript
import { useQueryClient } from '@tanstack/react-query';

const queryClient = useQueryClient();

// Get current cache state
const processesQuery = queryClient.getQueryState(['processes', projectId]);
console.log('Status:', processesQuery?.status);
console.log('Data:', processesQuery?.data);

// Get cached data directly
const cachedProcesses = queryClient.getQueryData(['processes', projectId]);
console.log('Cached processes:', cachedProcesses);

// See all queries in cache
const allQueries = queryClient.getQueryCache().getAll();
console.log('All queries:', allQueries.map(q => q.queryKey));
```

### Debugging Invalidation

Add temporary logging to invalidation helpers:

```javascript
// In ProcessContext.js (temporary debugging)
invalidateProject: async (projectId = currentProject) => {
  console.log('[invalidateProject] Starting for project:', projectId);

  await Promise.all([
    queryClient.refetchQueries({
      queryKey: ['processes', projectId],
      type: 'active'
    }).then(() => console.log('[invalidateProject] Processes refetched')),

    queryClient.refetchQueries({
      queryKey: ['datasets'],
      type: 'active'
    }).then(() => console.log('[invalidateProject] Datasets refetched')),

    // ... etc
  ]);

  console.log('[invalidateProject] Complete');
}
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Backend API                          │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP + WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  TanStack Query Cache                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Processes  │  │  Datasets   │  │   Outputs   │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
      ┌──────────┐      ┌──────────┐     ┌──────────┐
      │ FlowView │      │ PlotView │     │ Export   │
      │          │      │          │     │          │
      │ uses     │      │ uses     │     │ uses     │
      │ hooks    │      │ hooks    │     │ hooks    │
      └──────────┘      └──────────┘     └──────────┘
            │                 │                 │
            └─────────────────┼─────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ ProcessContext   │
                    │                  │
                    │ Invalidation     │
                    │ Helpers          │
                    │                  │
                    │ - invalidate     │
                    │   Process()      │
                    │ - invalidate     │
                    │   Project()      │
                    │ - invalidate     │
                    │   Datasets()     │
                    └──────────────────┘
                              ▲
                              │
                    WebSocket Updates
                    Mutations
                    User Actions
```

## Related Documentation

- [Widget System](./widgets.md) - How widgets consume query data
- [JSON Schema Forms](./forms.md) - Dataset selector integration
- [Layout System](./layout.md) - Layout state vs query state
- [System Overview](../architecture/overview.md) - Backend API structure

## Migration Guide

If you have old code using manual `fetch()`:

### Before (Manual Fetch)

```javascript
const [datasets, setDatasets] = useState([]);
const [loading, setLoading] = useState(false);

useEffect(() => {
  setLoading(true);
  fetch(`${API}/datasets?search=${search}&project_id=${projectId}`)
    .then(r => r.json())
    .then(data => {
      setDatasets(data);
      setLoading(false);
    });
}, [search, projectId]);
```

### After (TanStack Query Hook)

```javascript
const { data: datasets = [], isLoading } = useSearchDatasets(
  search,
  true,
  projectId
);
```

**Benefits**:
- ✅ Automatically refetches when invalidated
- ✅ Automatic caching and deduplication
- ✅ No manual loading state management
- ✅ Built-in error handling
- ✅ Background refetching
- ✅ Stale-while-revalidate behavior

## Summary

**The Three Rules**:

1. **Use hooks for all data fetching** - Never use manual `fetch()` for server data
2. **Invalidate through ProcessContext helpers only** - Never call `queryClient.invalidateQueries()` directly
3. **Trust TanStack Query** - Don't implement your own polling, caching, or coordination

Following these rules ensures deterministic, race-condition-free data propagation throughout the application.

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
const { data: dataset, isLoading, error } = useDataset(datasetId, projectId);

// Search datasets with filters
const { data: datasets = [], isLoading, error } = useSearchDatasets(
  searchText,      // Search string
  completedOnly,   // Boolean: only completed processes
  projectId        // Filter by project
);

// Fetch outputs for a specific process version
const { data: datasets = [], isLoading } = useProcessOutputDatasets(
  process,    // Process object
  version,    // Version number
  projectId   // Required - query is disabled without it
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

// Cancel a queued/running process version (does NOT auto-invalidate)
const cancelProcess = useCancelProcess();
await cancelProcess.mutateAsync({ processId, version, projectId });
await invalidateProject(projectId);
```

#### Project Export and Import

Export/import are async backend jobs: a mutation kicks the job off, and a paired polling
query watches it until it reaches a terminal `state` (`"done"` or `"failed"`), then stops
refetching automatically.

```javascript
import { useExportProject, useProjectExport, useImportProject, useProjectImport } from '../datamodel/useQueries';

// Start an export job (fire-and-forget)
const exportProject = useExportProject();
const { export_id: exportId } = await exportProject.mutateAsync(projectId);

// Poll it until done/failed - refetchInterval stops automatically at a terminal state
const { data: exportJob } = useProjectExport(projectId, exportId);
// exportJob.state: "pending" | "running" | "done" | "failed"

// Seed an already-created (empty) project from a previously-uploaded export zip
// (the zip must have been uploaded into that same project via uploadFile())
const importProject = useImportProject();
await importProject.mutateAsync({ projectId, uploadId });

// Poll the import job the same way
const { data: importJob } = useProjectImport(importId);
```

**Note**: `useProjectExport`/`useProjectImport` accept an `options` object as their last
argument (spread into the underlying `useQuery` call) so callers can override `enabled` or
`refetchInterval` if needed.

#### Storage Backends and Clusters

```javascript
import { useAvailableStorageBackends, useAvailableClusters } from '../datamodel/useQueries';

// Storage backends available for new projects - not live/quota-based, normal staleTime
const { data: backends = [] } = useAvailableStorageBackends();

// Clusters available for a project, filtered by live resource limits (e.g. Kueue quota).
// No staleTime - refetches whenever projectId or resourceRequests changes the query key,
// since quota can change between requests.
const { data: clusters = [] } = useAvailableClusters(projectId, { cpu: "2", memory: "4Gi" });
```

#### Project Membership and Invites

```javascript
import {
  useProjectMembers, useProjectInvites, useInviteMember, useCancelInvite,
  useLeaveProject, useInviteInfo, useAcceptInvite
} from '../datamodel/useQueries';

// List current members of a project
const { data: members = [] } = useProjectMembers(projectId);

// List pending invites for a project
const { data: invites = [] } = useProjectInvites(projectId);

// Invite a member by email (auto-invalidates projectInvites)
const inviteMember = useInviteMember(projectId);
await inviteMember.mutateAsync(email);

// Cancel a pending invite (auto-invalidates projectInvites)
const cancelInvite = useCancelInvite(projectId);
await cancelInvite.mutateAsync(inviteId);

// Leave a project (auto-invalidates the projects list)
const leaveProject = useLeaveProject(projectId);
await leaveProject.mutateAsync();

// Look up an invite by its token (e.g. on the accept-invite landing page); does not retry on error
const { data: invite, error } = useInviteInfo(token);

// Accept an invite (auto-invalidates the projects list)
const acceptInvite = useAcceptInvite();
await acceptInvite.mutateAsync(token);
```

`useInviteMember`, `useCancelInvite`, and `useLeaveProject` all take `projectId` as a hook
argument (not a mutation argument) so their `onSuccess` invalidation knows which
`projectInvites`/`projects` key to invalidate.

#### Publications

Publications are read-only, shareable snapshots of a project (see
[Publication read-only projects](../plans/done/publication-readonly-projects.md)).

```javascript
import { usePublications, useCreatePublication, useDeletePublication } from '../datamodel/useQueries';

// List publications for a project
const { data: publications = [] } = usePublications(projectId);

// Create a publication (auto-invalidates publications)
const createPublication = useCreatePublication(projectId);
await createPublication.mutateAsync({ findable: false, allowAnonymous: true });

// Delete a publication (auto-invalidates publications)
const deletePublication = useDeletePublication(projectId);
await deletePublication.mutateAsync(publicationId);
```

#### Version Tags

Tags label specific process versions (e.g. "approved", "final"). Tag CRUD auto-invalidates;
attaching/removing a tag from a version does not, since it changes process data.

```javascript
import {
  useProjectTags, useCreateTag, useUpdateTag, useDeleteTag,
  useAddVersionTag, useRemoveVersionTag
} from '../datamodel/useQueries';

// List tags defined for a project
const { data: tags = [] } = useProjectTags(projectId);

// Create/update/delete a tag definition (all auto-invalidate projectTags)
const createTag = useCreateTag(projectId);
await createTag.mutateAsync({ name: "approved", color: "#22c55e" });

const updateTag = useUpdateTag(projectId);
await updateTag.mutateAsync({ tagId, tag: { name: "approved-v2" } });

const deleteTag = useDeleteTag(projectId);
await deleteTag.mutateAsync(tagId);

// Attach/remove a tag from a specific process version (does NOT auto-invalidate -
// callers must use ProcessContext invalidation helpers, since this changes process data)
const addVersionTag = useAddVersionTag();
await addVersionTag.mutateAsync({ processId, version, tagId, projectId });
await invalidateProcess(processId, projectId);

const removeVersionTag = useRemoveVersionTag();
await removeVersionTag.mutateAsync({ processId, version, tagId, projectId });
await invalidateProcess(processId, projectId);
```

#### Plugins

```javascript
import { usePlugins, useEnablePlugin, useDisablePlugin, useUpgradePlugin } from '../datamodel/useQueries';

// List all registered plugins (requires authentication)
const { data: plugins = [] } = usePlugins();

// Enable/disable/upgrade a plugin (all auto-invalidate the plugins list)
const enablePlugin = useEnablePlugin();
await enablePlugin.mutateAsync(pluginId);

const disablePlugin = useDisablePlugin();
await disablePlugin.mutateAsync(pluginId);

const upgradePlugin = useUpgradePlugin();
await upgradePlugin.mutateAsync(pluginId);
```

**Note**: There is no `useInstallPlugin()`. A frontend plugin is built by creating a
`build_frontend_plugin` process in the Process Editor (its schema drives the form); it
auto-registers when the build completes and then appears via `usePlugins()`. These hooks only
enable/disable/upgrade already-registered plugins.

#### Workspaces

Workspaces are the persistence mechanism for the Flexout layout system — a saved workspace
embeds its full version list (including the layout tree), so selecting a workspace/version in
the UI never needs a follow-up fetch. **This has replaced localStorage as the real persistence
layer**; see [Layout System](./layout.md) for how the layout tree itself is structured.

```javascript
import {
  useWorkspaces, usePublicWorkspaces, useWorkspace, useSaveWorkspace,
  useSaveWorkspaceVersion, useUpdateWorkspace, useForkWorkspace, useDeleteWorkspace
} from '../datamodel/useQueries';

// List workspaces for a project
const { data: workspaces = [] } = useWorkspaces(projectId);

// List publicly-shared workspaces (no projectId scoping)
const { data: publicWorkspaces = [] } = usePublicWorkspaces();

// Fetch a single workspace by ID
const { data: workspace } = useWorkspace(workspaceId);

// Save a brand-new workspace (auto-invalidates workspaces for the project)
const saveWorkspace = useSaveWorkspace(projectId);
const newWorkspace = await saveWorkspace.mutateAsync({ title: "My Layout", layout });

// Save a new version onto an existing workspace (auto-invalidates workspaces for the project)
const saveWorkspaceVersion = useSaveWorkspaceVersion(projectId);
await saveWorkspaceVersion.mutateAsync({ workspaceId, layout });

// Update workspace metadata, e.g. title or public visibility
// (auto-invalidates both workspaces and publicWorkspaces)
const updateWorkspace = useUpdateWorkspace(projectId);
await updateWorkspace.mutateAsync({ workspaceId, title: "Renamed", is_public: true });

// Fork a workspace (optionally a specific version) into the current project
// (auto-invalidates workspaces for the project)
const forkWorkspace = useForkWorkspace(projectId);
await forkWorkspace.mutateAsync({ workspaceId, version });

// Delete a workspace (auto-invalidates workspaces for the project)
const deleteWorkspace = useDeleteWorkspace(projectId);
await deleteWorkspace.mutateAsync(workspaceId);
```

`useWorkspaces`, `useSaveWorkspace`, `useSaveWorkspaceVersion`, `useUpdateWorkspace`,
`useForkWorkspace`, and `useDeleteWorkspace` all take `projectId` as a hook argument so their
invalidation targets the right `workspaces(projectId)` key.

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
queryKeys.availableClusters(projectId, resourceRequests)  // ['availableClusters', projectId, cpu, memory]
queryKeys.availableStorageBackends           // ['availableStorageBackends']
queryKeys.projectExport(projectId, exportId) // ['projectExport', projectId, exportId]
queryKeys.projectImport(importId)            // ['projectImport', importId]
queryKeys.projectMembers(projectId)          // ['projectMembers', projectId]
queryKeys.projectInvites(projectId)          // ['projectInvites', projectId]
queryKeys.publications(projectId)            // ['publications', projectId]
queryKeys.inviteInfo(token)                  // ['inviteInfo', token]
queryKeys.projectTags(projectId)             // ['projectTags', projectId]
queryKeys.workspaces(projectId)              // ['workspaces', projectId]
queryKeys.publicWorkspaces                   // ['publicWorkspaces']
queryKeys.workspace(id)                      // ['workspace', id]
```

**Note**: A few hooks (`usePlugins` and its mutations) use inline `['plugins']` keys rather than an entry on `queryKeys` — there is no `queryKeys.plugins`.

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

**Location**: `frontend/src/ProcessContext.jsx`

```javascript
const handleWebSocketMessage = useCallback(async (update) => {
  await invalidateHelpers.invalidateProject();
}, [invalidateHelpers]);

useWebSocket(`${WS_API}/ws/processes/updates`, {
  enabled: !!currentProject,
  name: 'Process State Updates',
  onMessage: handleWebSocketMessage
});
```

Note: `invalidateProject()` is called with no explicit `projectId` argument — it defaults to `currentProject` via closure (see the helper's signature above), so the WebSocket handler always invalidates whatever project is currently active in the URL.

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
  const { currentProject, processes, activeProcess } = useContext(ProcessContext);

  // Find the active process object
  const process = activeProcess
    ? processes.find(p => p.id === activeProcess.processId)
    : null;

  // Fetch outputs for active version
  const { data: datasets = [], isLoading } = useProcessOutputDatasets(
    process,
    activeProcess?.version,
    currentProject
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
  projectId,
  { enabled: !!process && version != null && !!projectId }
);

// ❌ Bad: Missing projectId - query stays disabled (enabled checks !!projectId internally)
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
// In ProcessContext.jsx (temporary debugging)
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

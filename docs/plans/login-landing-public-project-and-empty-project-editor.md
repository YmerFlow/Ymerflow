# Login-landing fixups: public-project guard + empty-project Process Editor

## Goal

Smooth two rough edges in what a user lands on after selecting/opening a project:

- **(a)** When a signed-in user has no *own* projects, `AutoCreateProjectDialog` pops the
  "Create project" modal. If they arrived via a **public-project link**
  (`/app/.../p/<publicationId>`), that modal shouldn't interrupt them — they already have a
  project in view.
- **(c)** When the current project has **no processes**, and the `ProcessEditor` widget is
  present in the active workspace layout, auto-open it defaulted to the **latest Environment**
  and the **`import_skytem`** process type — so a fresh project lands the user directly on
  "import your first dataset".

> Note: the third part of this work — preserving the pre-login URL through the billing contract
> redirect — lives entirely in the billing plugin repo and has its own plan there
> (`plugins/billing/docs/plans/preserve-url-through-contract-redirect.md`). The two plans are
> independent and can be implemented separately.

## Design decisions (confirmed with user)

1. **(a) Guard on `currentProject`**: suppress the create-project modal whenever the URL already
   names a project or publication (`currentProject` is set), not just for public ones. Simplest
   rule that satisfies the request and is robust to the read-only/publication cases.
2. **(c) Default scope**: the "latest Environment + `import_skytem`" default applies **only** to
   the empty-project auto-open — **not** to every manual `Process > Create` (which stays blank).
3. **(c) Editor absent**: if `ProcessEditor` is **not** in the current workspace layout, **do
   nothing** — don't inject a pane into the user's chosen layout.
4. **(c) Workspace precondition**: if **no workspace is selected** (no `/w/:workspace` in the URL,
   i.e. `selectedEnvironment` is null), first select the `default` workspace — or, if that's
   unavailable, the first available one — **before** attempting to open the editor.

## Current state

- `frontend/src/AutoCreateProjectDialog.jsx` — opens `ProjectModal` when `projects.length === 0`
  (after awaiting the `pending_redirects` hook). Does not consider `currentProject`.
- `frontend/src/ProcessContext.jsx`:
  - URL is the single source of truth: `parseUrlParams`/`buildUrlPath` (lines ~95-166).
    `currentProject = urlParams.project` (line ~180); `selectedEnvironment = urlParams.workspace`
    (workspace id, line ~178). Setters navigate.
  - `startNewProcess: () => { setActiveProcess(null); setNewProcessToken(t => t + 1); }` (line ~515),
    exposed with `newProcessToken`. **`newProcessToken` is NOT in the `useMemo` deps array** — today
    it propagates only as a side effect of the `setActiveProcess(null)` navigation changing
    `activeProcess`.
  - Auto-select-first-project effect (lines ~496-500): only when `!currentProject`.
- `frontend/src/widgets/ProcessEditor.jsx`:
  - New-process reset effect keyed on `newProcessToken` (lines ~93-105) seeds
    `localEnvironment` from `selectedEnvironment` (a **workspace** id — effectively never a real
    environment id, so today's env default is broken) and `localType` to null.
  - Type-availability guard (lines ~132-137) clears `localType` only once `types` has loaded and
    the type is genuinely absent — a valid `import_skytem` survives.
  - Environment `<select>` options come from `environments` (each has `created_at`); type options
    are `Object.keys(types)` from `useEnvironmentProcessTypes(localEnvironment)`.
- `frontend/src/App.jsx` — `/app/*` route (~line 224-233) renders `<AutoCreateProjectDialog />`
  inside `LayoutProvider`, so siblings there get both `ProcessContext` and `LayoutContext`.
  `AppWithContext` (lines ~176-202) loads the `default` workspace's layout on mount via
  `getWorkspace('default')` but does **not** set `/w/...` in the URL (so `selectedEnvironment`
  stays null).
- `frontend/src/flexout/LayoutContext.jsx` — exposes `updateLayout`, `findWidgetPaths(widgetType)`,
  `activatePath(path)`. "Is ProcessEditor in the layout?" == `findWidgetPaths('ProcessEditor').length > 0`
  (the pattern `FlowView/index.jsx:200-204` already uses).
- `frontend/src/WorkspaceMenu.jsx` — `loadVersion` (lines 26-32) is the canonical "select a
  workspace" action: `updateLayout(entry.layout)` + `setSelectedEnvironment(id, version)`.
- Workspace hooks (`frontend/src/datamodel/useQueries.js`): `useWorkspace(id)` (line ~512),
  `useWorkspaces(projectId)` (line ~495). The global `default` workspace is **not** returned by
  `useWorkspaces(project)` (that endpoint is project-scoped — `backend/routers/workspaces.py`
  `list_workspaces`), so it must be fetched directly via `useWorkspace('default')`; it cannot be
  deleted, so it effectively always exists.
- Backend `list_environments` (`backend/routers/environments.py:30-34`) is unordered → pick the
  latest by `created_at` client-side.

## Implementation

### (a) `frontend/src/AutoCreateProjectDialog.jsx`

Destructure `currentProject` from `ProcessContext` and bail before opening the modal:

```jsx
const { projects, projectsLoading, currentProject, setCurrentProject } = useContext(ProcessContext);
...
useEffect(() => {
  if (checkedRef.current || projectsLoading) return;
  checkedRef.current = true;
  if (currentProject) return;        // URL already names a project/publication — don't interrupt
  if (projects.length !== 0) return;
  ...
});
```

### (c) Signal defaults through `startNewProcess` — `frontend/src/ProcessContext.jsx`

Add `newProcessDefaults` state and let `startNewProcess` accept optional `{ environmentId, type }`:

```jsx
const [newProcessDefaults, setNewProcessDefaults] = useState(null);
...
newProcessToken,
newProcessDefaults,
startNewProcess: (defaults = null) => { setNewProcessDefaults(defaults); setActiveProcess(null); setNewProcessToken(t => t + 1); },
```

**Add both `newProcessToken` and `newProcessDefaults` to the `contextValue` `useMemo` deps array.**
Required: in the empty-project case `activeProcess` is already `null`, so `setActiveProcess(null)`
doesn't change any existing dep and the memo would otherwise return a stale value — ProcessEditor
would never see the token bump or the defaults. (This also hardens the pre-existing token
propagation, which currently relies on the `activeProcess` side effect.)

Manual `Process > Create` (`FlowView/index.jsx:201`) keeps calling `startNewProcess()` with no
args → `newProcessDefaults` null → unchanged behaviour.

### (c) Consume defaults — `frontend/src/widgets/ProcessEditor.jsx`

Destructure `newProcessDefaults`. In the new-process reset effect:

```jsx
if (newProcessDefaults) {
  setLocalEnvironment(newProcessDefaults.environmentId ?? null);
  setLocalType(newProcessDefaults.type ?? null);   // 'import_skytem'
} else {
  setLocalEnvironment(selectedEnvironment || null);
  setLocalType(null);
}
```

### (c) Trigger component — new `frontend/src/AutoOpenProcessEditor.jsx`

Rendered as a sibling of `<AutoCreateProjectDialog />` in the `/app/*` route (`App.jsx`), returns
`null`. Fires **once per project** via a `handledProjectRef`.

Reads from `ProcessContext`: `currentProject, projects, processes, isLoading, environments,
environmentsLoading, selectedEnvironment, setSelectedEnvironment, startNewProcess`. From
`LayoutContext`: `updateLayout, findWidgetPaths, activatePath`. Plus `useWorkspace('default')` and
`useWorkspaces(currentProject)`.

Effect logic:
1. Bail unless: `currentProject` set; not already handled; `!isLoading` and `processes.length === 0`;
   `!environmentsLoading` and `environments.length > 0`.
2. If `projects.find(p => p.id === currentProject)?.read_only` → mark handled and bail (can't
   create processes on a read-only publication).
3. **Step 0** — if `!selectedEnvironment`: pick `defaultWorkspace ?? projectWorkspaces[0]`, take its
   latest version, `updateLayout(latest.layout)` + `setSelectedEnvironment(ws.id, latest.version)`,
   then **return without marking handled** (resume next render once URL/layout settle).
4. `const paths = findWidgetPaths('ProcessEditor')`. If empty → mark handled and bail (editor not in
   layout → do nothing).
5. Pick latest env: `environments.reduce((a,b) => new Date(b.created_at) > new Date(a.created_at) ? b : a)`.
   `startNewProcess({ environmentId: latest.id, type: 'import_skytem' })`, `activatePath(paths[0])`,
   mark handled.

The `default` layout already contains a `ProcessEditor` node, so after Step 0 selects `default`,
`findWidgetPaths` will locate it.

### (c) Wire-up — `frontend/src/App.jsx`

Import and render `<AutoOpenProcessEditor />` right after `<AutoCreateProjectDialog />` in the
`/app/*` route element.

## Files touched

- `frontend/src/AutoCreateProjectDialog.jsx` — guard on `currentProject` (a)
- `frontend/src/ProcessContext.jsx` — `startNewProcess(defaults)` + `newProcessDefaults` + deps fix (c)
- `frontend/src/widgets/ProcessEditor.jsx` — consume `newProcessDefaults` (c)
- `frontend/src/AutoOpenProcessEditor.jsx` — **new** trigger component (c)
- `frontend/src/App.jsx` — render `<AutoOpenProcessEditor />` in `/app/*` (c)

## Verification

Frontend auto-reloads; no servers to start.

- **(a)** As a user with no own projects, open `/app/w/<ws>/p/<publicationId>` → **no**
  Create-project modal. Plain `/app` with no own projects → modal still appears.
- **(c)** Open a project with zero processes in a workspace containing ProcessEditor → the editor
  tab activates, Environment = newest, type = `import_skytem`. In a workspace **without**
  ProcessEditor → nothing changes. Create a process, reload → editor does **not** re-open. A
  read-only publication with no processes → nothing happens.
- **(c) workspace precondition** — Open an empty project on `/app/p/<proj>` with **no** `/w/` →
  URL gains `/w/default/wv/<n>`, its layout loads, then the editor opens with the defaults.
- Regression: `Process > Create` from the menu still opens a **blank** editor (no forced
  `import_skytem`).

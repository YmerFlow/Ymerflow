# Fix: `/app` landing selects no workspace/project; Project dropdown stuck on *None*

## Goal

On landing at `/app` (or any URL missing a `/w/` segment) while signed in:

1. **Select the first workspace when none is selected**, and **the first project when none
   is** — writing both into the URL so the selectors are never stranded at *None*.
2. Do this **without changing the URL grammar**: a project stays strictly nested under a
   workspace (`/app/w/<ws>/wv/<v>/p/<project>/…`). We are *not* allowing a bare
   `/app/p/<project>`.
3. **Never render a workspace whose id isn't in the URL.** The on-screen layout must be a
   function of the URL's workspace — Empty when the URL names no workspace.

This is "Fix direction 2" from
`docs/bugs/app-landing-no-workspace-blocks-project-selection.md` (establish a workspace
segment on landing), explicitly **not** direction 1 (the URL grammar is unchanged).

## Design decisions (confirmed with user)

1. **Which workspace is "first".**
   - **If the user has ≥1 project:** select the **first project** *and simultaneously* the
     **first workspace available to that project** (public or private). "Available to that
     project" = the project's own workspaces from `GET /workspaces?project_id=…`
     (`useWorkspaces(projectId)`); if the project owns none, fall back to the `default`
     superpublic workspace.
   - **If the user has no projects:** select the **first public/superpublic workspace** (the
     `default` workspace), and no project.
   In every case the bootstrap performs a **single atomic navigation** to the fully-formed
   URL — it never lands in an intermediate "workspace set, project not yet" state.

2. **Layout is a derived function of the URL workspace (constraint 3), applied on *change*
   only.** A new `WorkspaceLayoutSync` component watches the URL's
   `(selectedEnvironment, selectedEnvironmentVersion)` pair. When that pair *changes*, it
   loads the matching workspace-version layout via `updateLayout`; when the URL names no
   workspace, it sets the layout to `Empty`. A ref tracks the last-applied
   `workspaceId@version` key so the sync **fires only on a real navigation to a different
   workspace/version (or to no-workspace)** — never on re-render or query refetch. In-place
   layout edits (drag/split/add-pane, "Save As New") mutate `layout` state but never the
   URL, so the ref key is unchanged and the user's edits are never clobbered.

## How workspace loading works today (context for the fix)

- **The URL is the source of truth for *which* workspace, but not for its *layout*.**
  `parseUrlParams` (`ProcessContext.jsx:95`) extracts `workspace`/`workspaceVersion`;
  `ProcessProvider` re-exposes them as `selectedEnvironment` / `selectedEnvironmentVersion`
  (`ProcessContext.jsx:178-179`). There is no React state for "current workspace" — it is
  derived from the URL every render.
- **The pane layout is separate state** in `LayoutContext` (`const [layout, setLayout]`,
  `flexout/LayoutContext.jsx:27`), mutated only via `updateLayout`.
- **Nothing links the two automatically.** They are hand-synced at each mutation point:
  1. `AppWithContext` mount effect (`App.jsx:186-211`) — the only non-user-triggered load.
     Runs **once**, reads `/w/<id>` from the URL *or falls back to `'default'`*, and seeds
     `LayoutProvider`'s `initial_layout`. **This is what violates constraint 3** (loads
     `default`'s layout at bare `/app`).
  2. `WorkspaceRow.loadVersion` (`WorkspaceMenu.jsx:26-32`) — click/version-change:
     `updateLayout(layout)` **then** `setSelectedEnvironment(id, v)`.
  3. `PublicWorkspaceSearch.handlePick` / `SaveCurrentWorkspaceItem.handleSave`
     (`WorkspaceMenu.jsx`) — same imperative pairing.
  4. `AutoOpenProcessEditor` "Step 0" (`AutoOpenProcessEditor.jsx:42-50`) — project-but-no-
     workspace: picks `default`, `updateLayout` + `setSelectedEnvironment`.
  5. `WorkspaceMenu` empty-effect (`WorkspaceMenu.jsx:222-226`) — when `selectedEnvironment`
     goes null, forces layout to `Empty`.
- **Consequence:** `setSelectedEnvironment` alone only rewrites the URL; it loads no layout.
  So the bootstrap must be paired with something that reacts to the URL-workspace change and
  loads the layout — which is exactly `WorkspaceLayoutSync`, and is also what makes
  constraint 3 hold.

## Root cause recap (from the bug report)

`buildUrlPath` nests `/p/<project>` inside `if (workspace)`, so with no workspace in the URL
the project is silently dropped and `setCurrentProject` becomes a no-op. Nothing ever writes
a workspace into the URL on landing, so `selectedEnvironment` stays null and the
auto-select-first-project effect spins uselessly. We keep the nested grammar and instead
**guarantee a workspace is in the URL before (atomically, alongside) the project**.

## Implementation

### 1. New component `frontend/src/AppBootstrap.jsx` (URL selection)

Renders `null`; a behaviour-only sibling of `AutoCreateProjectDialog` / `AutoOpenProcessEditor`.

Consumes from `ProcessContext`: `projects`, `projectsLoading`, `currentProject`,
`selectedEnvironment`. Uses `useNavigate` + the already-exported `buildUrlPath`.
Fetches the candidate workspaces it needs:

```js
const targetProjectId = currentProject ?? projects[0]?.id ?? null;
const { data: projectWorkspaces = [], isLoading: pwLoading } = useWorkspaces(targetProjectId);
const { data: defaultWorkspace }   = useWorkspace('default');
const { data: publicWorkspaces = [], isLoading: pubLoading } = usePublicWorkspaces();
```

Effect logic (guarded so it acts at most once per needed navigation; only when
`location.pathname.startsWith('/app')`):

```
if (selectedEnvironment) return;          // workspace already in URL — nothing to bootstrap
if (projectsLoading) return;              // wait for the project list

if (targetProjectId) {
  if (pwLoading) return;                   // wait for that project's workspaces before choosing
  const ws = projectWorkspaces[0] ?? defaultWorkspace;
  if (!ws) return;                         // default not loaded yet — wait, don't guess
  const version = latestVersion(ws);
  navigate(buildUrlPath(ws.id, version, targetProjectId, null, null, null, null));
  // → /app/w/<ws>/wv/<v>/p/<project>   (single atomic navigation)
} else {
  if (pubLoading) return;                  // wait for the public list
  const ws = (publicWorkspaces.find(w => w.superpublic) ?? publicWorkspaces[0]) ?? defaultWorkspace;
  if (!ws) return;
  const version = latestVersion(ws);
  navigate(buildUrlPath(ws.id, version, null, null, null, null, null));
  // → /app/w/<ws>/wv/<v>   (no project)
}
```

Notes:
- **Atomic navigation** via `buildUrlPath` directly (not `setSelectedEnvironment` +
  `setCurrentProject`) so the workspace and project land in the URL in one navigation, with
  no intermediate no-op state and no dependency on `setCurrentProject`'s carry race.
- **`latestVersion(ws)` = `ws.versions?.[ws.versions.length - 1]?.version ?? null`**.
- **Never fall back to `default` while a query is still loading** — only after
  `useWorkspaces` has resolved and returned zero owned workspaces. This prevents a
  "flash to default then correct" bounce.
- After the navigation, `selectedEnvironment` is truthy, so the guard stops the effect from
  re-firing.

### 2. New component `frontend/src/WorkspaceLayoutSync.jsx` (layout follows URL)

Renders `null`. Consumes `selectedEnvironment` / `selectedEnvironmentVersion` from
`ProcessContext`, `updateLayout` from `LayoutContext`, and `useWorkspace(selectedEnvironment)`.

```js
const lastAppliedKey = useRef(null);   // `${wsId}@${version}` or 'none'

useEffect(() => {
  if (!selectedEnvironment) {
    if (lastAppliedKey.current !== 'none') {
      updateLayout({ id: 'root', widget: 'Empty' });
      lastAppliedKey.current = 'none';
    }
    return;
  }
  // Wait until the loaded workspace actually matches the URL id (query may still hold the
  // previous workspace's data mid-navigation).
  if (!workspace || workspace.id !== selectedEnvironment) return;
  const versions = workspace.versions ?? [];
  const entry = versions.find(v => v.version === selectedEnvironmentVersion)
             ?? versions[versions.length - 1];
  if (!entry) return;
  const key = `${workspace.id}@${entry.version}`;
  if (lastAppliedKey.current === key) return;   // already applied — don't clobber edits
  updateLayout(entry.layout);
  lastAppliedKey.current = key;
}, [selectedEnvironment, selectedEnvironmentVersion, workspace, updateLayout]);
```

This is the single mechanism that satisfies constraint 3: the rendered layout is always the
layout of the workspace named in the URL (or Empty). It **replaces** today's mechanisms 1 and
5 (the mount-time `default` load and the WorkspaceMenu empty-effect).

### 3. `frontend/src/App.jsx`

- **Mount both components inside the `/app/*` route element**, as siblings of
  `MainLayout` / `AutoCreateProjectDialog` / `AutoOpenProcessEditor` (both are inside
  `LayoutProvider` and `ProcessProvider`, as required):
  ```jsx
  <AppBootstrap />
  <WorkspaceLayoutSync />
  ```
- **Remove the mount-time workspace-layout load** from `AppWithContext`
  (`App.jsx:186-211`), along with the `layoutToUse` / `layoutLoaded` state and the loading
  spinner gate (`App.jsx:182-219`). `LayoutProvider` now starts with an **Empty** layout
  (`initial_layout={{ id: 'root', widget: 'Empty' }}`); `WorkspaceLayoutSync` fills it in
  from the URL. The module-level `initial_layout` constant (the hardcoded
  FlowView/ProcessEditor/PlotView tree, `App.jsx:119-143`) becomes unused and is removed.
- The now-unused `location`/`useLocation` import in `AppWithContext` is cleaned up if nothing
  else uses it.

### 4. `frontend/src/ProcessContext.jsx`

- **Remove the auto-select-first-project effect** (`ProcessContext.jsx:496-501`). Project
  bootstrap now lives in `AppBootstrap`, which selects workspace + project atomically. (Left
  in place it would only re-introduce the no-op `setCurrentProject` path.)
- No change to `buildUrlPath` — the nested grammar is intentional and preserved.

### 5. `frontend/src/WorkspaceMenu.jsx`

- **Remove the empty-effect** (`WorkspaceMenu.jsx:222-226`) — `WorkspaceLayoutSync` now owns
  "no workspace → Empty".

### 6. `frontend/src/AutoOpenProcessEditor.jsx`

- **Remove "Step 0"** (`AutoOpenProcessEditor.jsx:42-50`) and its now-unused
  `defaultWorkspace` / `projectWorkspaces` fetches + `selectedEnvironment` guard usage. With
  `AppBootstrap` guaranteeing a workspace is selected whenever a project is, Step 0 is dead
  code. The remaining logic (open `ProcessEditor` defaulted to `import_skytem` for an empty
  project) is unchanged.

### Optional cleanup (not required; call out during review)

- `WorkspaceRow.loadVersion`, `PublicWorkspaceSearch.handlePick`, and
  `SaveCurrentWorkspaceItem.handleSave` still call `updateLayout` imperatively before/after
  `setSelectedEnvironment`. With `WorkspaceLayoutSync` these become redundant (the URL change
  re-applies the same layout via the sync). They are **harmless** to keep (identical content,
  and they give instant feedback before the sync's query resolves), so this plan keeps them.
  We can strip them in a follow-up if we want a single code path.

## Interaction to confirm during review

Today, switching to a project whose previously-open workspace was **private** drops the
workspace (`setCurrentProject`'s Decision-4 carry logic), leaving `selectedEnvironment` null
and the user parked at *None* until they pick a workspace. With this change, `AppBootstrap`
will instead **auto-select that project's first workspace** (its own first workspace, else
`default`). This matches the stated rule ("select the first workspace available to that
project if none is") and is better UX, but it is a **behavioural change** to the
dropped-private-workspace case — flag if that's not wanted.

## Affected files

- `frontend/src/AppBootstrap.jsx` — **new** (URL workspace+project bootstrap).
- `frontend/src/WorkspaceLayoutSync.jsx` — **new** (layout follows URL on change).
- `frontend/src/App.jsx` — mount both; remove mount-load + spinner + hardcoded layout const.
- `frontend/src/ProcessContext.jsx` — remove auto-select-first-project effect.
- `frontend/src/WorkspaceMenu.jsx` — remove empty-effect.
- `frontend/src/AutoOpenProcessEditor.jsx` — remove Step 0.

## Verification

- `cd frontend && npx vite build` (build check).
- Manual, using the running dev servers:
  1. **User with projects, bare `/app`** → URL becomes
     `/app/w/<ws>/wv/<v>/p/<project0>`; Workspace and Project selectors both populated; the
     workspace's layout renders. No *None* state, no flicker to `default` if the project owns
     a workspace.
  2. **User with a project that owns no workspace** → bootstraps to
     `/app/w/default/wv/<v>/p/<project0>`.
  3. **User with no projects** → `/app/w/default/wv/<v>` (no `/p/`); the existing
     auto-create-project dialog still opens.
  4. **Project dropdown** now selects normally (workspace already in URL to nest under).
  5. **Edit-preservation:** load a workspace, drag/split panes (don't save), trigger a
     processes/datasets refetch or a project-data change → layout edits **persist** (sync did
     not re-fire because the URL workspace/version didn't change).
  6. **Version switch:** change a workspace's version in the dropdown → layout reloads for the
     new version (URL `(ws,version)` key changed).
  7. **No-workspace state:** navigate to a URL with no `/w/` (or a dropped private workspace,
     if you keep that path) → layout goes Empty, never shows a prior workspace's panes.
  8. **Constraint 3 spot-check:** at no point does the app render a workspace's layout while
     the URL lacks the matching `/w/<id>` segment.
```

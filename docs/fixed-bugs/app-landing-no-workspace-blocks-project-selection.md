# Bug: `/app` landing selects neither workspace nor project, and the Project dropdown can't select a project until a workspace is chosen

## Symptoms

Reported behaviour when visiting `https://ymerflow.earth/app` while signed in, with
many owned projects and access to the superpublic workspace *Default*:

1. Landing on `/app` does **not** redirect to a project (or workspace). Both the
   Workspace and the Project selectors read **None**.
2. Trying to pick a project from the Project dropdown **fails** — nothing happens,
   the selector stays on *None*.
3. If you first pick a **workspace** (e.g. *Default*), the **first project is
   selected automatically** as a side effect, and from then on the Project dropdown
   **works normally**.

## Root cause

`buildUrlPath()` in `frontend/src/ProcessContext.jsx` refuses to encode a project
into the URL unless a workspace is also present. The project segment is **nested
inside the `if (workspace)` block**:

```js
// frontend/src/ProcessContext.jsx:140-166
export function buildUrlPath(workspace, workspaceVersion, project, process, version, part, sounding) {
  let path = '/app';

  if (workspace) {                     // ← everything below is gated on a workspace
    path += `/w/${workspace}`;
    if (workspaceVersion !== null && workspaceVersion !== undefined) {
      path += `/wv/${workspaceVersion}`;
    }
    if (project) {                     // ← project only appended when workspace is truthy
      path += `/p/${project}`;
      ...
    }
  }

  return path;                         // workspace == null → always just "/app"
}
```

The entire app treats **the URL as the single source of truth** for
`selectedEnvironment` (workspace) and `currentProject`:

```js
// frontend/src/ProcessContext.jsx:178-180
const selectedEnvironment = urlParams.workspace;   // null on bare /app
const currentProject      = urlParams.project;      // null on bare /app
```

So `setCurrentProject(id)` navigates through `buildUrlPath`, and when no workspace
is in the URL the project it was asked to set is **silently dropped** and the URL
stays `/app`. `currentProject` therefore never becomes non-null.

### Why nothing sets a workspace on landing

`AppWithContext` (`frontend/src/App.jsx:184-210`) loads the `default` workspace's
**layout** on mount, but deliberately does **not** write `/w/default` into the URL:

```js
const workspaceId = match ? match[1] : 'default';
const workspace = await getWorkspace(workspaceId);
...
setLayoutToUse(selectedVersion.layout);   // layout only — URL is untouched
```

Result on bare `/app`: the correct default layout renders, but the URL has **no
`/w/` segment**, so `selectedEnvironment` stays `null`.

### Why the auto-select-first-project effect spins uselessly

`ProcessContext` has an effect meant to auto-pick the first project:

```js
// frontend/src/ProcessContext.jsx:496-501
React.useEffect(() => {
  if (!currentProject && projects.length > 0 && location.pathname.startsWith('/app')) {
    setCurrentProject(projects[0].id);
  }
}, [projects, currentProject, setCurrentProject, location.pathname]);
```

On `/app` with projects present this fires and calls
`setCurrentProject(projects[0].id)`. But `setCurrentProject` builds the path with
`workspace = selectedEnvironment = null`:

```js
// frontend/src/ProcessContext.jsx:246-255
const setCurrentProject = useCallback((project) => {
  const [carryWorkspace, carryWorkspaceVersion] = currentWorkspace?.is_public
    ? [selectedEnvironment, selectedEnvironmentVersion]
    : [null, null];
  const path = buildUrlPath(carryWorkspace, carryWorkspaceVersion, project, null, null, null, null);
  navigate(path);   // buildUrlPath(null, null, project, …) === "/app"  → no-op navigation
}, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentWorkspace]);
```

`buildUrlPath(null, null, project, …)` returns just `"/app"`. `navigate('/app')`
is a no-op, `currentProject` stays `null`, and the effect can never make progress.
Both Workspace and Project remain **None**.

### Why picking a project from the dropdown "fails"

`ProjectDropdown` → `handleProjectSelect` → `setCurrentProject(projectId)`
(`frontend/src/ProjectDropdown.jsx:80-93`). Same code path, same outcome: with no
workspace in the URL the project is dropped by `buildUrlPath` and the navigation is
a no-op. The dropdown appears to do nothing.

### Why picking a workspace first fixes everything

Selecting a workspace calls `setSelectedEnvironment(ws, ver)`:

```js
// frontend/src/ProcessContext.jsx:241-244
const setSelectedEnvironment = useCallback((workspace, workspaceVersion = null) => {
  const path = buildUrlPath(workspace, workspaceVersion, currentProject, …);
  navigate(path);   // workspace truthy → "/app/w/<ws>/wv/<n>"
}, [...]);
```

Now the URL carries `/w/<ws>`, so `selectedEnvironment` becomes non-null. Two
things follow:

1. The auto-select-first-project effect fires again (`currentProject` still null),
   calls `setCurrentProject(projects[0].id)`, and this time
   `buildUrlPath(ws, ver, project, …)` **does** include `/p/<project>` — so the
   first project is selected "for free".
2. Every subsequent `setCurrentProject` from the dropdown now has a workspace in
   the URL to nest the project under, so the dropdown works normally.

This exactly matches the reported "select a workspace and then it all starts
working" behaviour.

### Note on `AutoOpenProcessEditor`

`AutoOpenProcessEditor` has a "Step 0" that *would* select the `default` workspace
when none is set (`frontend/src/AutoOpenProcessEditor.jsx:42-50`), but it is gated
on `if (!currentProject) return;` at the top of the effect (line 28). Because
`currentProject` never becomes non-null, Step 0 never runs — it cannot rescue the
landing case. It only helps once a project is already selected and turns out to be
empty.

## Trigger conditions

- Occurs on any entry to bare `/app` (or any URL with no `/w/` segment) — including
  the `"/"` and catch-all `*` routes that `Navigate` to `/app`
  (`frontend/src/App.jsx`).
- Independent of how many projects the user has or whether *Default* is public; the
  URL simply never gains a workspace segment on its own, and without one no project
  can be encoded.

## Data flow summary

```
GET /app
  → URL has no /w/ and no /p/
  → selectedEnvironment = null, currentProject = null          (both "None")
  → AppWithContext loads default LAYOUT but never writes /w/ to URL
  → auto-select-first-project effect: setCurrentProject(projects[0].id)
        → buildUrlPath(workspace=null, …, project)  ==  "/app"  (project dropped)
        → navigate("/app") is a no-op → currentProject stays null → loops with no effect
  → ProjectDropdown select → setCurrentProject(id) → same no-op
  → AutoOpenProcessEditor Step 0 never runs (guarded on currentProject)

User picks a workspace:
  → setSelectedEnvironment(ws) → "/app/w/<ws>/wv/<n>"  (workspace now in URL)
  → auto-select-first-project effect re-fires → buildUrlPath(ws, …, project)
        → "/app/w/<ws>/wv/<n>/p/<project>"  (project now sticks)
  → dropdown works from here on
```

## Affected files

- `frontend/src/ProcessContext.jsx`
  - `buildUrlPath()` (lines 140-166) — project (and everything under it) gated on a
    truthy workspace: **the defect**.
  - `setCurrentProject()` (lines 246-255) — no-op when no workspace in URL.
  - auto-select-first-project effect (lines 496-501) — cannot make progress.
- `frontend/src/App.jsx`
  - `AppWithContext` (lines 184-210) — loads default workspace layout but never
    writes `/w/default` to the URL, so `selectedEnvironment` starts null.
- `frontend/src/ProjectDropdown.jsx` (lines 80-93) — surfaces the no-op as a
  "dropdown does nothing" symptom.
- `frontend/src/AutoOpenProcessEditor.jsx` (lines 27-50) — its no-workspace Step 0
  is unreachable in the landing case because it is guarded on `currentProject`.

## Fix directions (not yet chosen)

These are options to discuss before implementation — no decision is made here.

1. **Allow a project in the URL without a workspace.** Restructure `buildUrlPath`
   so `/p/<project>` can be emitted independently of `/w/<workspace>` (make the URL
   grammar `[/w/<ws>[/wv/<n>]] [/p/<project>[/pr/…]]` rather than strictly nested).
   `parseUrlParams` already scans segments order-independently, so it should already
   parse `/app/p/<project>`; the asymmetry is only on the *build* side. This is the
   most direct fix for the reported bug.

2. **Establish a workspace segment on landing.** Make `AppWithContext` (or the
   auto-select effect) write `/w/default` (or the first available workspace) into
   the URL when none is present, before/alongside auto-selecting the first project —
   so `buildUrlPath` always has a workspace to nest under. This keeps the nested URL
   grammar but guarantees the precondition it depends on.

3. **Both** — allow project-without-workspace *and* default a sensible workspace,
   so the URL is clean and neither selector is ever stranded at *None*.

Option 1 addresses the strict root cause (the build/parse asymmetry); option 2
addresses the "nothing selects a workspace on landing" contributing cause. A
combination is likely the cleanest, but the URL-grammar decision (is a bare
`/app/p/<project>` a valid, shareable URL?) should be settled first.

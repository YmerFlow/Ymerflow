# Workspace Version in URL

## Goal

Represent the currently-loaded workspace *version* in the URL, in the same way workspace id,
project id, process id/version, part, and sounding already are — state lives in the URL only, not
in component `useState`, so reload/share/back-forward all reproduce exactly what's on screen.

This is one item (#4, "version in the URL") from the broader public-workspaces UX discussion. The
other items (viewing an unowned public workspace, seeding new projects, editability by home-project
membership) are separate follow-ups, not covered here.

---

## Background & Current State

### URL scheme (`frontend/src/ProcessContext.jsx:92-159`)

```
/app/w/:workspace/p/:project/pr/:process/v/:version/part/:part/s/:sounding
```

`parseUrlParams(pathname)` parses this into `{ workspace, project, process, version, part,
sounding }`; `buildUrlPath(workspace, project, process, version, part, sounding)` is the inverse,
used by every setter (`setSelectedEnvironment`, `setCurrentProject`, `setActiveProcess`,
`setCurrentPart`, `setCurrentSounding` — all in `ProcessContext.jsx:229-252`) and once externally
by `ProjectMembersModal.jsx:219-226` (publication copy-link button). Note the existing nesting
pattern: `version` sits directly after `process`, gated on `process` being present; `part`/
`sounding` are further gated on `version` being present. Workspace *version* has no equivalent —
there is no segment for it at all today.

### Where workspace version currently lives (not in the URL)

- **`WorkspaceRow`** (`frontend/src/WorkspaceMenu.jsx:12-67`): each row has its own
  `const [selectedVersion, setSelectedVersion] = useState(latestVersion)`, plus a `useEffect` that
  snaps it to the newest version when either the current pick vanishes or (for the active row) a
  new version was just saved. Clicking the title or changing the `<select>` calls `loadVersion`,
  which does `updateLayout(entry.layout)` then `setSelectedEnvironment(workspace.id)` — the id goes
  to the URL, the version does not.
- **`App.jsx:165-194`** (`AppWithContext`): on mount only (`useEffect(..., [])`), regex-extracts
  the workspace id from `location.pathname`, fetches it, and **always applies the latest version**
  — `workspace?.versions?.[workspace.versions.length - 1]`. There is nothing to read a version from
  even if one were in the URL.
- **Save** (`WorkspaceMenu.jsx:84-111`, `SaveCurrentWorkspaceComponent`): posts a new version via
  `useSaveWorkspaceVersion`, invalidates the workspaces query. The active row's local
  `selectedVersion` state then "snaps" to the new latest via the effect above — a side effect of
  local state, not an explicit URL update.

Net effect (the bug this plan fixes): reload always jumps to latest, an old/pinned version can't be
shared by URL, and the "snap to newest on save" behavior is implicit/fragile rather than an
explicit state transition.

---

## Design Decisions

### 1. New URL segment: `wv`, nested under `w` (chosen)

```
/app/w/:workspace/wv/:workspaceVersion/p/:project/pr/:process/v/:version/part/:part/s/:sounding
```

Mirrors the existing `v` (process version) placement directly after its parent (`pr`/`process`).
`wv` is optional and gated on `workspace` being present, but does **not** gate `p`/`pr`/`v` — i.e.
it's a sibling addition, not a new nesting level the rest of the path depends on (same relationship
`part`/`sounding` have to `version`, but `project`/`process` continuing regardless of `wv` matches
today's project/process independence from `w`/`p`).

**Rejected: query param** (`?wv=3`) — every other piece of this same state (workspace, project,
process, version, part, sounding) is a path segment; a query param would be an inconsistent
special case for no benefit.

### 2. `buildUrlPath` gains a second positional parameter (chosen)

```js
export function buildUrlPath(workspace, workspaceVersion, project, process, version, part, sounding)
```

Inserted right after `workspace`, matching where `version` sits right after `process` in the
existing signature. This is a breaking signature change — **all 6 call sites must be updated in the
same commit** (5 in `ProcessContext.jsx`, 1 in `ProjectMembersModal.jsx`).

**Rejected: object param** (`buildUrlPath({ workspace, workspaceVersion, project, ... })`) — larger
diff for no behavior change, and inconsistent with the function's current positional style. Not
worth a style change as a side effect of this plan.

### 3. Context exposes `selectedEnvironmentVersion`, derived from the URL only (chosen)

Same pattern as `selectedEnvironment` (`urlParams.workspace`): add
`const selectedEnvironmentVersion = urlParams.workspaceVersion;` — no `useState`, no local
component state anywhere. `WorkspaceRow` drops its `selectedVersion` state and the snap-to-newest
`useEffect` entirely; it reads `selectedEnvironmentVersion` from context when it's the active row.

Naming follows the existing (already misleading — `selectedEnvironment` is a workspace id, not a
runtime "environment") convention rather than fixing it here. **Not in scope for this plan** — a
separate cleanup, noted under Open Questions.

### 4. `setSelectedEnvironment` takes an optional second argument (chosen)

```js
const setSelectedEnvironment = useCallback((workspace, workspaceVersion = null) => { ... }, ...);
```

Workspace id and workspace version are always set together wherever the workspace changes (row
click, version dropdown, post-save bump — see below), so one setter with two params, not two
separate setters. The default `= null` keeps the one existing single-arg caller
(`ProcessContext.jsx:490`, the "auto-select" effect — see Open Questions, this call site is already
buggy/out of scope) working unchanged.

### 5. Inactive rows show latest version, no memory of a prior browse (chosen)

Today, an inactive row's local `selectedVersion` state lets you pre-pick a version in its dropdown
and have that survive re-renders — but picking any version, active row or not, already calls
`loadVersion` which immediately activates that workspace (`setSelectedEnvironment`). So the local
state never actually enabled "browse without activating"; it only cached each row's last pick
across re-renders. Dropping per-row state means inactive rows simply show `latestVersion`
(the same value they'd have initialized to before); the moment you pick a version, the row becomes
active and its display comes from the URL like any other active row.

**Rejected: keep per-row non-URL "pending pick" state** — would resurrect exactly the kind of
component-local duplication of URL state this plan removes, for a capability (pre-browse without
activating) that doesn't functionally exist today anyway.

### 6. Save explicitly bumps the URL to the new version (chosen)

`saveWorkspaceVersion` (`frontend/src/datamodel/api.js:507-510`) returns the created version
record, including `.version`. `SaveCurrentWorkspaceComponent`'s `handleSave`
(`WorkspaceMenu.jsx:90-98`) calls `setSelectedEnvironment(current.id, saved.version)` after a
successful save, replacing the old implicit "effect snaps local state to newest" behavior with an
explicit URL transition. Reloading immediately after a save now reproduces the just-saved version,
not an arbitrary "latest" that happens to be the same today only because nothing else changes it.

### 7. `App.jsx`'s mount effect honors the URL version instead of hardcoding latest (chosen)

Extract both `workspace` and `workspaceVersion` from `location.pathname` (regex or reuse
`parseUrlParams`), then pick
`workspace.versions.find(v => v.version === workspaceVersion) ?? workspace.versions[workspace.versions.length - 1]`
(falls back to latest if the URL has no version segment or references one that no longer exists —
same fallback shape already used for the no-`wv` case).

This effect stays mount-only (`[]` deps, as today) — it seeds the initial layout for a fresh page
load. All subsequent workspace/version changes during the session already go through
`WorkspaceRow.loadVersion`'s explicit `updateLayout` call, which this plan doesn't touch.

---

## Frontend Changes

### `frontend/src/ProcessContext.jsx`

- `parseUrlParams`: add `workspaceVersion: null` to the default object; parse a `wv` segment the
  same way `v` is parsed (`parseInt(segments[i + 1], 10)`).
- `buildUrlPath`: add `workspaceVersion` parameter (Design Decision 2); emit `/wv/:workspaceVersion`
  right after `/w/:workspace` when not null/undefined, per Design Decision 1.
- `selectedEnvironmentVersion = urlParams.workspaceVersion` — new derived value alongside
  `selectedEnvironment`.
- `setSelectedEnvironment(workspace, workspaceVersion = null)` — Design Decision 4; update its
  `buildUrlPath` call and dependency array (add `selectedEnvironmentVersion`... actually not
  needed since the incoming `workspaceVersion` argument replaces it — no context read required for
  this setter beyond what it already reads).
- `setCurrentProject`, `setActiveProcess`, `setCurrentPart`, `setCurrentSounding`: each already
  passes `selectedEnvironment` through unchanged when rebuilding the path (carrying the current
  workspace across the update); each must now also pass `selectedEnvironmentVersion` through
  unchanged, and add it to the relevant `useCallback` dependency array.
- Add `selectedEnvironmentVersion` to the context value object (both places it's currently listed,
  `ProcessContext.jsx:510` and `:549`).

### `frontend/src/WorkspaceMenu.jsx`

- `WorkspaceRow`: remove `selectedVersion` state, `prevLatestRef`, and the snap-to-newest
  `useEffect` (Design Decision 3/5). Read `{ selectedEnvironment, selectedEnvironmentVersion,
  setSelectedEnvironment }` from context. Displayed/controlled version =
  `isActive ? (selectedEnvironmentVersion ?? latestVersion) : latestVersion`. `loadVersion(versionNum)`
  drops `setSelectedVersion(entry.version)` and calls `setSelectedEnvironment(workspace.id,
  entry.version)` instead of the single-arg call.
- `SaveCurrentWorkspaceComponent`: also destructure `setSelectedEnvironment` from context;
  `handleSave` captures `saveVersion.mutateAsync(...)`'s resolved value and calls
  `setSelectedEnvironment(current.id, saved.version)` on success (Design Decision 6).

### `frontend/src/App.jsx`

- `AppWithContext`'s mount effect: extract workspace version from the path alongside workspace id
  (Design Decision 7); select that specific version's layout with fallback to latest.

### `frontend/src/ProjectMembersModal.jsx`

- `PublicationsTab`: also read `selectedEnvironmentVersion` from context; update the `copyLink`
  `buildUrlPath(...)` call to pass it as the second argument, so a copied publication link
  reproduces the exact workspace version the sharer was viewing, not just the workspace.

---

## Migration / Compatibility

Pure frontend, no backend/API change, no data model change. Old URLs without a `wv` segment parse
fine (`workspaceVersion` is `null`, falls back to latest — same behavior as today). No deprecation
window needed.

---

## Implementation Steps

1. `ProcessContext.jsx`: `parseUrlParams` + `buildUrlPath` signature and segment logic.
2. `ProcessContext.jsx`: `selectedEnvironmentVersion` derived value, threaded through all 5 setters
   and both context-value exports.
3. `WorkspaceMenu.jsx`: `WorkspaceRow` state removal + read-from-context display logic;
   `loadVersion` two-arg call.
4. `WorkspaceMenu.jsx`: `SaveCurrentWorkspaceComponent` post-save URL bump.
5. `App.jsx`: mount effect honors `wv` from the path.
6. `ProjectMembersModal.jsx`: `copyLink` passes `selectedEnvironmentVersion`.
7. Manual verification (below).

---

## Verification

- Open a workspace, pick an older version from its dropdown → URL gains `/wv/:n` → reload the page
  → the same older version loads (not latest).
- Click "Save" on the active workspace → URL's `/wv/:n` advances to the newly created version
  immediately (no reload needed) → reload → still shows that new version.
- Switch to a different, inactive workspace row and change its version dropdown directly (without
  clicking the title first) → it becomes the active workspace at that version, URL reflects both.
- Copy a publication link (`ProjectMembersModal` → Publications tab) while viewing a non-latest
  workspace version → open the link in a fresh session → same version loads.
- Load a URL with no `wv` segment (or an old bookmarked URL) → falls back to latest version, no
  error.
- Load a URL with a `wv` value that no longer exists for that workspace (deleted/invalid) → falls
  back to latest version, no error.

---

## Open Questions

- [ ] **Pre-existing bug, adjacent but out of scope**: the "auto-select" effect at
      `ProcessContext.jsx:486-492` calls `setSelectedEnvironment(latestEnv.id)` using `latestEnv`
      from `environments` (`useEnvironments()` → `GET /environments`, the process-runtime-image
      list) — not from `useWorkspaces()`. It's writing an *environment* id into the *workspace*
      URL slot. This plan's signature change to `setSelectedEnvironment` doesn't fix or worsen it
      (default second arg keeps the single-arg call working), but it's a real bug worth its own
      follow-up.
- [ ] **`selectedEnvironment`/`selectedEnvironmentVersion` naming** — both names are misleading
      (workspace, not runtime environment). Not renamed here to keep this diff scoped to adding the
      missing URL state; a naming cleanup could be a trivial separate pass.

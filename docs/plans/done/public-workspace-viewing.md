# Public Workspace Viewing & Editability

## Goal

Fix the design bugs in how public workspaces are shared and viewed, so the experience matches the
already-clean public *project* (publication) model: a public workspace can be viewed from any
project without being copied into it, the menu always reflects what's actually loaded, and
editability is a permission check (home-project membership), not an accident of which project
happens to be open.

Three bugs from the initial discussion, addressed here:

1. Navigating via URL to a public workspace the current project hasn't forked works, but the menu
   can't reflect it (blank/no active row).
2. The "Default" public workspace isn't copied into new projects, so their menu looks empty even
   though the URL still resolves it fine.
3. A workspace's editability today flips based on which project is currently open, not on whether
   the user actually has rights over the workspace's home project — confusing when the "same"
   workspace looks editable in one context and locked in another.

A fourth item — workspace **version** in the URL — is covered by a separate plan,
`docs/plans/workspace-version-in-url.md`. This plan doesn't depend on that one landing first (it
just carries whatever's in the URL forward, same as today), but the two touch adjacent code in
`ProcessContext.jsx` and are easiest to review in either order, not interleaved.

---

## Background & Current State

### Backend already supports this — the gap is entirely frontend

- `GET /workspace/{id}` (`backend/routers/workspaces.py:229-249`) already returns a workspace if
  **either** `is_public` **or** the caller is a member of `workspace.project_id` — with no
  `project_id` query param or "current project" concept involved at all. Viewing an unowned public
  workspace by id already works server-side, from any context.
- `POST /workspace/{id}/versions` (Save) and `PATCH /workspace/{id}` both go through
  `_require_workspace_member` (`workspaces.py:36-53`), which checks membership on
  `workspace.project_id` — the workspace's own home project — again independent of any "current
  project." **The backend already implements "editable iff member of home project," full stop.**
  No backend change is needed for this plan; every fix below is in the frontend's use of these
  existing endpoints.
- `POST /workspace/{id}/fork` (`workspaces.py:270-306`) snapshot-copies a public workspace's chosen
  version into a new workspace owned by the caller's project. This remains the only way to get an
  *independent, editable-here* copy — unchanged by this plan.
- Nothing in `backend/routers/projects.py`'s `create_project` seeds any workspace. This is already
  correct given the fix below (§Design Decision 4) — new projects don't need a copy of Default,
  they need the ability to *view* any public workspace without owning it.

### Where the frontend falls short

- `WorkspaceMenu.jsx`'s `WorkspaceList` (`WorkspaceMenu.jsx:142-154`) renders only
  `useWorkspaces(currentProject)` — workspaces owned by the current project. If `selectedEnvironment`
  (the URL's workspace id) refers to a public workspace owned by a *different* project, it's not in
  that list, so no row renders as active — the URL/state and the menu disagree (bug 1).
- `SaveCurrentWorkspaceComponent` (`WorkspaceMenu.jsx:84-111`) resolves `current` the same way —
  `workspaces.find(w => w.id === selectedEnvironment)` against the *current-project-owned* list —
  so Save is unconditionally disabled for a workspace that isn't owned by the current project, even
  when the user is a member of its actual home project and the backend would happily accept the
  write.
- `setCurrentProject` (`ProcessContext.jsx:234-237`) always carries `selectedEnvironment` unchanged
  across a project switch, regardless of whether the workspace is public or belongs to the project
  being switched away from. For a private workspace this leaves the URL pointing at a workspace the
  new project has no relationship to.
- The only UI to reach a public workspace from another project is `WorkspaceSharingModal.jsx`'s
  "Add public workspaces" tab, and its only action is **fork** (`useForkWorkspace` →
  `POST /workspace/{id}/fork`) — there's no "just look at it" action, so viewing-without-owning is
  URL-only today, with no discoverable in-app path to it.
- Adjacent, pre-existing bug directly relevant here: the "auto-select" effect at
  `ProcessContext.jsx:486-492` sets `selectedEnvironment` from `environments`
  (`useEnvironments()` → `GET /environments`, the *process-runtime-image* list, an unrelated
  backend concept) whenever `selectedEnvironment` is falsy. This plan introduces a case where
  `selectedEnvironment` is deliberately set to `null` (§Design Decision 4), which would immediately
  trigger this effect and overwrite it with a bogus id. It must be removed as part of this plan, not
  left to silently sabotage the new behavior.

---

## Design Decisions

### 1. Menu renders the URL's workspace even when unowned — "pinned" row (chosen)

`WorkspaceList` fetches `useWorkspaces(currentProject)` as today, plus conditionally
`useWorkspace(selectedEnvironment, { enabled: !!selectedEnvironment && not-already-in-owned-list })`
to resolve a workspace the current project doesn't own. If found, it's prepended to the rendered
rows. This mirrors how a pinned publication is merged into `useProjects()`'s result
(`docs/plans/done/publication-readonly-projects.md` §9) — same shape of fix, applied to workspaces.

**Rejected: have the backend merge it into `GET /workspaces`** — that endpoint is
project-scoped by design (`list_workspaces`, gated by `require_project_member` on `project_id`);
bolting an unrelated single-workspace lookup onto it conflates "workspaces this project owns" with
"the one workspace currently being viewed," which are different questions with different auth
rules. Two queries, both already existing hooks, composed in the frontend, is simpler and doesn't
touch the backend at all.

### 2. Stable `(public)` tag, not a context-dependent `(ro)` flip (chosen)

Every public workspace's row always shows a `(public)` tag, regardless of whether it happens to be
owned by the current project or just pinned for viewing. This was the resolution reached earlier in
discussion: don't make the row's label change meaning depending on context — let the label be
stable and let the Save button's enabled state (and tooltip) carry the "can I edit this right now"
information instead.

### 3. Editability = membership in the workspace's home project (chosen)

`SaveCurrentWorkspaceComponent` resolves `current` via `useWorkspace(selectedEnvironment)` (not the
project-scoped list), then computes
`canEdit = projects.some(p => p.id === current.project_id && !p.read_only)` using the already-loaded
`useProjects()` list from `ProcessContext` (the `!p.read_only` guard excludes pinned publication
entries — those aren't real memberships). Save is enabled iff `canEdit`, independent of
`currentProject`. When `current.project_id !== currentProject`, the button label becomes
`Save to "${current.project_name}"` (the workspace payload already includes `project_name` per
`Workspace.to_dict`) instead of the current unconditional `Save "${current.title}"`, so it's visible
that the write target differs from the project currently open.

"Save As New Workspace…" remains unconditionally available for any loaded workspace, public or
private, editable or not — unchanged, it already creates a new workspace owned by `currentProject`.

**Not built in this pass:** a clickable "switch to home project" affordance on the disabled-Save
tooltip, and a toast on the editable→read-only transition. Both were floated during discussion as
ways to further soften the "same-looking row, different editability" experience; deferred as
optional polish once the core membership-based model is in and used for a bit — see Open Questions.

### 4. Project switch: carry a public workspace forward, drop a private one (chosen)

`setCurrentProject` currently always passes `selectedEnvironment` through unchanged. It changes to:

```js
const setCurrentProject = useCallback((project) => {
  const carry = pinnedOrOwnedWorkspace?.is_public
    ? [selectedEnvironment, selectedEnvironmentVersion]
    : [null, null];
  const path = buildUrlPath(...carry, project, null, null, null, null);
  navigate(path);
}, [navigate, selectedEnvironment, selectedEnvironmentVersion, pinnedOrOwnedWorkspace]);
```

i.e. a public workspace's identity is legitimately independent of "current project" (that's the
whole point of this plan), so it stays open across a switch. A private workspace has no meaning
outside its owning project, so it's dropped rather than left stranded pointing at a project that
doesn't have it (today's confusing "menu shows nothing selected, stale layout stays on screen").

This requires `ProcessContext` to know the current workspace's `is_public` flag, which it doesn't
today — see §Frontend Changes for where that lookup lives (it needs `useWorkspace`/`useWorkspaces`
data inside `ProcessProvider` itself now, not just inside `WorkspaceMenu`).

**When dropped, also clear the layout to Empty**, not just the URL — otherwise the previous
project's panes (referencing its processes/datasets) stay on screen with no active workspace
selected, which is the exact "stale layout" confusion from the original bug report. Since
`LayoutContext` is nested *inside* `ProcessContext` (`App.jsx` renders `LayoutProvider` below
`AppWithContext`, which reads `ProcessContext`), `ProcessProvider` itself can't call `updateLayout`
directly. Instead, add a small effect co-located with `WorkspaceMenu` (or a new trivial component
mounted once alongside it) that watches `selectedEnvironment` and clears the layout when it
transitions from set to `null`:

```js
useEffect(() => {
  if (!selectedEnvironment) {
    updateLayout({ id: 'root', widget: 'Empty' });
  }
}, [selectedEnvironment]);
```

**Rejected: keep the stale layout, just fix the menu highlighting** — considered, since it's a
smaller change, but leaving process/dataset references from a project the user just navigated away
from on screen is the actual confusing part, not merely the missing highlight. Worth the extra
effect.

### 5. New projects get no seeded workspace — confirmed as correct, not a gap (chosen)

Per Design Decisions 1–2, a new project's menu shows Default (or any other public workspace whose
id is in the URL) via the pinned mechanism, without needing to own a copy. **No backend seeding
logic is added.** This directly resolves bug 2 as originally reported — the "empty menu" was a
symptom of the pinned-row gap (Decision 1), not of missing seed data.

### 6. Add a "View" action alongside "Fork" in the public-workspaces picker (chosen)

`WorkspaceSharingModal.jsx`'s `AddPublicWorkspacesTab` already has a search/select UI for public
workspaces plus a version picker; it only offers "Add to Project" (fork). Add a second button,
"View", that calls `setSelectedEnvironment(selected.id, selectedVersion)` (from `ProcessContext`)
and closes the modal — no mutation, no new workspace created, just navigates to it exactly like
opening it by URL does today. This is the missing discoverable path to "look at a public workspace
without owning it," which today only works if you already have the URL.

### 7. Remove the auto-select-into-`selectedEnvironment`-from-`environments` effect (chosen)

`ProcessContext.jsx:486-492` is deleted outright. It was already wrong (writing a process-runtime
image id into the workspace URL slot — see Background), and Decision 4 now deliberately produces a
`null` `selectedEnvironment` as a valid state (no workspace loaded, empty layout) rather than
something that must be auto-filled. Leaving it in place would immediately overwrite that valid
`null` state with garbage the moment any project without a matching "environment" list quirk is
opened.

**Not building a replacement "auto-select a sensible workspace" behavior** — with Decisions 1–6 in
place, an empty menu is a legitimate, self-explanatory state (nothing loaded; open "Public
Workspaces…" or a project-owned row to load one), not a gap needing an automatic fallback.

---

## Frontend Changes

### `frontend/src/ProcessContext.jsx`

- Add a `useWorkspace(selectedEnvironment)` (or reuse `WorkspaceMenu`'s existing owned-list query
  plus this one — see note below) inside `ProcessProvider` so `is_public`/`project_id` for the
  *currently selected* workspace is available to `setCurrentProject` (Decision 4) without
  `WorkspaceMenu` needing to duplicate the switch logic.
- `setCurrentProject`: branch on the loaded workspace's `is_public` per Decision 4.
- Delete the auto-select effect (`486-492`) and its now-unused `environments`/`useEnvironments`
  wiring **if** nothing else in this file depends on `useEnvironments()` — confirm before removing
  the import (a quick grep of the file for other `environments` usage as part of implementation).
- Context value gains nothing new here beyond what already exists (`selectedEnvironment`,
  `setSelectedEnvironment`, `projects`) — Decision 3's membership check and Decision 1's pinned-row
  fetch both live in `WorkspaceMenu.jsx`, reusing `useProjects()`/`useWorkspace()` directly rather
  than adding new context fields.

### `frontend/src/WorkspaceMenu.jsx`

- `WorkspaceList`: fetch the pinned workspace (Decision 1) alongside the owned list; merge for
  rendering; pass enough per-row info (`is_public`, `project_id`, `project_name`) for `WorkspaceRow`
  to render the tag and for `SaveCurrentWorkspaceComponent` to compute `canEdit`.
- `WorkspaceRow`: render `(public)` tag per Decision 2 when `workspace.is_public`.
- `SaveCurrentWorkspaceComponent`: resolve `current` via `useWorkspace(selectedEnvironment)`
  instead of the project-scoped `workspaces` list; compute `canEdit` per Decision 3; adjust the
  button label/tooltip/disabled state accordingly.
- Add the layout-clear effect from Decision 4 (co-located here since this file already imports both
  `LayoutContext` and `ProcessContext`).

### `frontend/src/WorkspaceSharingModal.jsx`

- `AddPublicWorkspacesTab`: add the "View" button per Decision 6, next to "Add to Project".

---

## Migration / Compatibility

Pure frontend, no backend or data model changes, no migration. Existing URLs/behavior for
project-owned workspaces are unaffected. The only behavior change for existing users: switching
projects while a *private* workspace is open now clears the layout instead of leaving it stale —
this is the intended fix, not a compatibility concern.

---

## Implementation Steps

1. `ProcessContext.jsx`: add the current-workspace lookup, branch `setCurrentProject` on
   `is_public`, delete the auto-select effect (confirm `useEnvironments` import is unused
   afterward).
2. `WorkspaceMenu.jsx`: pinned-row merge in `WorkspaceList`; `(public)` tag in `WorkspaceRow`;
   membership-based `canEdit` and label in `SaveCurrentWorkspaceComponent`; layout-clear effect.
3. `WorkspaceSharingModal.jsx`: "View" button in `AddPublicWorkspacesTab`.
4. Manual verification (below).

---

## Verification

- As a member of Project A only: paste a URL pointing at a public workspace owned by Project B
  (one you're not a member of) while Project A is the current project → menu shows it as the active
  row, tagged `(public)`, Save disabled with a tooltip naming Project B.
- As a member of *both* Project A and Project B: open that same public workspace while Project A is
  current → Save is enabled, labeled "Save to `<Project B name>`"; saving creates a new version
  under Project B, visible if you switch to Project B directly.
- From Project A, open "Public Workspaces…" → search → select Default → "View" (not "Add to
  Project") → it loads as the active workspace without creating any new workspace row in Project A.
- With that public workspace active, switch to Project C (also not its owner) via the project
  dropdown → it stays active (URL/menu unchanged aside from `p`).
- Load a **private** workspace owned by Project A, then switch to Project B → workspace clears
  (menu shows nothing active, layout resets to empty) rather than showing Project A's stale panes.
- Create a brand-new project → its workspace menu is empty (no owned workspaces) but "Public
  Workspaces…" still lists Default and any other public workspace, viewable immediately via "View".

---

## Open Questions

- [ ] **Deferred polish from discussion**: clickable "switch to home project" link on the disabled
      Save tooltip, and a toast on the editable→read-only transition when switching projects with a
      public workspace open. Not required for the core fix; candidates for a quick follow-up once
      this lands and the membership-based model has been used for a bit.
- [ ] **`useEnvironments()` fate**: confirm during implementation whether anything else in
      `ProcessContext.jsx` (or elsewhere) still needs it after the auto-select effect is deleted; if
      entirely unused, remove the query and its error-handling `useEffect`
      (`ProcessContext.jsx:211-219`) too rather than leaving a dead subscription.

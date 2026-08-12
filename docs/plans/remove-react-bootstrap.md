# Remove react-bootstrap — Raw Bootstrap Only

## Goal

Eliminate `react-bootstrap` from the frontend entirely. Every dropdown, modal, tab set, form
control, and other Bootstrap-styled widget is rebuilt on raw Bootstrap markup (HTML +
`data-bs-*` attributes, styled by the `bootstrap` CSS/JS already loaded) instead of the
`react-bootstrap` component library. `bootstrap` (CSS + the vanilla JS bundle) is the only
Bootstrap dependency left when this is done.

## Background & Current State

### The immediate trigger

`docs/plans/done/unify-project-workspace-publishing.md` added two new react-bootstrap
`<Dropdown>` menus (`ProjectDropdown.jsx`, `WorkspaceMenu.jsx`) containing text `<input>`
search boxes. Pressing Escape while focused in either crashed the whole app:
`TypeError: Cannot read properties of undefined (reading 'parentNode')`, thrown from inside
vanilla Bootstrap's own `Dropdown.dataApiKeydownHandler`
(`bootstrap/js/src/dropdown.js:397-436`).

Root cause: `frontend/src/index.jsx:9` loads the vanilla Bootstrap JS bundle
(`bootstrap/dist/js/bootstrap.bundle.min.js`) globally, and that bundle installs a
**capture-phase, document-level** keydown listener
(`EventHandler.on(document, EVENT_KEYDOWN_DATA_API, SELECTOR_MENU, ...)` —
`bootstrap/js/src/dom/event-handler.js:184` passes `isDelegated` as the native
`addEventListener` capture flag) that matches *any* element carrying Bootstrap's
`.dropdown-menu` CSS class — including ones rendered by `react-bootstrap`, which never sets
the `data-bs-toggle="dropdown"` attribute vanilla Bootstrap needs to resolve the owning
toggle. The lookup returns `undefined`, and vanilla Bootstrap crashes trying to construct a
`Dropdown` instance around it.

This was worked around for the immediate bug with a narrow guard
(`frontend/src/bootstrapDropdownConflictGuard.js`, marker attribute `data-rb-guard`,
`stopImmediatePropagation()` — capture-phase listeners on the same node run in registration
order, so registering before the bootstrap.bundle import lets it win the race). That guard is
a patch, not a fix: **two independent Bootstrap-flavored UI systems have been coexisting in
this codebase**, one raw (native `data-bs-toggle` markup + the vanilla JS bundle) and one
`react-bootstrap` (a separate, React-state-driven reimplementation of the same widgets, using
the same CSS classes for visual styling only). They share styling but not behavior, and
nothing stops a third collision like this one from happening again wherever a new
`react-bootstrap` component is dropped next to existing raw markup.

### Why raw markup exists at all: nested submenus

`frontend/src/flexout/MenuBar.jsx` renders the app's registered menu tree
(`frontend/src/flexout/MenuContext.jsx`) using raw `data-bs-toggle="dropdown"` markup with
**recursively nested `<li className="dropdown-submenu">`** entries for arbitrary-depth menu
paths (`docs/frontend/layout.md:317`: "each intermediate label becomes ... a submenu node").
`react-bootstrap`'s `<Dropdown>` has no built-in support for nested/multi-level submenus — it
only renders one flat menu level — which is the likely reason `MenuBar.jsx` was built on raw
markup instead of `react-bootstrap` in the first place, while every self-contained,
single-level dropdown/modal/form elsewhere in the app reached for `react-bootstrap` instead.

**This history predates this plan and wasn't fully reconstructed from the repo** — no commit
message, code comment, or doc spells out the original limitation. The nested-submenu
explanation above is inferred from the code (`MenuBar.jsx`'s recursion + the layout docs), not
confirmed. Flagged as an open question below — please correct it if the real story was
different; it doesn't change the plan's direction, but it's worth having written down
correctly.

### Current react-bootstrap footprint

21 files import from `react-bootstrap` (`grep -rl "from 'react-bootstrap'" frontend/src`):

| Component(s) used | Files |
|---|---|
| `Modal` (+ `.Header`/`.Title`/`.Body`) | `AccountPage.jsx`, `LandingPage.jsx`, `ProjectExportModal.jsx`, `ClustersAdminPanel.jsx`, `flexout/components/Pane.jsx`, `flexout/components/TabSet.jsx`, `ProjectMembersModal.jsx`, `WorkspaceSharingModal.jsx`, `ProjectModal.jsx`, `widgets/ProcessEditor.jsx`, `widgets/EnvironmentView.jsx`, `StorageBackendsAdminPanel.jsx` |
| `Table` | `AccountPage.jsx`, `ClustersAdminPanel.jsx`, `AdminPage.jsx`, `ProjectMembersModal.jsx`, `WorkspaceSharingModal.jsx`, `StorageBackendsAdminPanel.jsx`, `widgets/EnvironmentView.jsx` |
| `Form.*` (`Group`/`Label`/`Control`/`Check`/`Select`/`Text`) | `AccountPage.jsx`, `LandingPage.jsx`, `ClustersAdminPanel.jsx`, `ProjectMembersModal.jsx`, `jsoneditor/FileUploadField.jsx`, `clusterProviders/KubeconfigClusterForm.jsx`, `WorkspaceSharingModal.jsx`, `ProjectDropdown.jsx`, `ProjectModal.jsx`, `jsoneditor/EPSGSelector.jsx`, `WorkspaceMenu.jsx`, `jsoneditor/DatasetSelector.jsx`, `StorageBackendsAdminPanel.jsx`, `storageProviders/S3StorageForm.jsx` |
| `Alert` | `AccountPage.jsx`, `ProjectExportModal.jsx`, `ClustersAdminPanel.jsx`, `ProjectMembersModal.jsx`, `ProjectModal.jsx`, `StorageBackendsAdminPanel.jsx`, `widgets/EnvironmentView.jsx` |
| `Card` | `AccountPage.jsx`, `LandingPage.jsx`, `ClustersAdminPanel.jsx`, `AdminPage.jsx`, `InviteAcceptPage.jsx`, `StorageBackendsAdminPanel.jsx`, `widgets/ProcessEditor.jsx` |
| `Button` | nearly all of the above |
| `Spinner` | `InviteAcceptPage.jsx`, `ClustersAdminPanel.jsx`, `ProjectMembersModal.jsx`, `WorkspaceSharingModal.jsx`, `StorageBackendsAdminPanel.jsx` |
| `Badge` | `AccountPage.jsx`, `ClustersAdminPanel.jsx`, `AdminPage.jsx`, `StorageBackendsAdminPanel.jsx` |
| `ProgressBar` | `ProjectExportModal.jsx`, `jsoneditor/FileUploadField.jsx`, `ProjectModal.jsx` |
| `Dropdown` | `ProjectDropdown.jsx`, `WorkspaceMenu.jsx` |
| `Tab`/`Tabs`/`Nav`/`Tab.Container` | `TabbedPage.jsx` (URL-controlled, via `activeKey`/`onSelect`), `ProjectMembersModal.jsx` (uncontrolled, via `defaultActiveKey`) |
| `InputGroup` | `ProjectMembersModal.jsx` |
| `Collapse` | `widgets/Export.jsx` |
| `Container`/`Row`/`Col` | `TabbedPage.jsx`, `AccountPage.jsx`, `LandingPage.jsx`, `InviteAcceptPage.jsx`, `AdminPage.jsx`, `ClustersAdminPanel.jsx`, `StorageBackendsAdminPanel.jsx` |

`backdrop="static"` (non-dismissible modal, no close-on-backdrop-click) is used twice —
`AccountPage.jsx:412` (revealed API key) and `LandingPage.jsx:221` (ToS modal, per
`docs/plans/done/tos-signup-modal.md`) — and must be preserved.

`bootstrap` (`^5.3.8`) is already a direct dependency (CSS via `styling.scss`, JS bundle via
`index.jsx`); `react-bootstrap` (`^2.10.10`) becomes removable once every file above is
converted.

---

## Design Decisions

### 1. A small shared `uikit/` only for widgets with real behavior; everything else inline (chosen)

New folder `frontend/src/uikit/` holds hand-rolled replacements **only** for the pieces that
have actual JS-managed state — `Modal.jsx`, `Tabs.jsx`, and a `useBootstrapDropdown` hook (see
Decisions 2-4). Purely-visual react-bootstrap components (`Badge`, `Card`, `Container`, `Row`,
`Col`, `Alert`, `Spinner`, `ProgressBar`, `InputGroup`, `Button`, every `Form.*` piece) are
**not** wrapped in anything — each call site is rewritten to the plain HTML element with the
matching Bootstrap class directly (e.g. `<Button variant="primary">` → `<button
className="btn btn-primary">`, `<Form.Check type="checkbox">` → `<input type="checkbox"
className="form-check-input">` + `<label className="form-check-label">`). These are one-line,
behavior-free mappings repeated at call sites already, exactly like `MenuBar.jsx`'s existing
raw markup does today; a wrapper would add a layer of indirection for zero behavioral payoff.

**Rejected: wrap everything, including purely-visual components, in `uikit/` equivalents.**
Would produce a shadow reimplementation of most of `react-bootstrap`'s API surface — the same
maintenance burden this plan exists to remove, just renamed. Reserve `uikit/` for the ~4
components where hand-rolling the *behavior* (not just the markup) is the actual work.

### 2. Modal: fully React-state-driven, no vanilla `bootstrap.Modal` JS instance (chosen)

`uikit/Modal.jsx` renders the modal markup directly keyed off a `show` boolean prop (already
how every one of the 12 current call sites works — `show={showX}` / `onHide={() =>
setShowX(false)}`, driven by `useState` in the parent). No `data-bs-toggle="modal"`, no
`bootstrap.Modal.getOrCreateInstance()`, no ref-based imperative show()/hide() calls — the
component just conditionally renders the backdrop + dialog markup and toggles the `show`
CSS class, wiring the backdrop-click and Escape-key handlers itself in React (`onClick`,
`onKeyDown`), calling the passed `onHide`. Supports `size` (`sm`/`lg`/`xl` → `modal-sm`
etc.), `backdrop="static"` (skip the backdrop-click-closes handler and add the
`modal-static` bounce class), and a `closeButton` flag on the header for the `×` button.

**Rejected: drive it via the vanilla `bootstrap.Modal` JS instance API**
(`data-bs-toggle="modal"` + `Modal.getOrCreateInstance(ref.current)` called imperatively from
a `useEffect` synced to the `show` prop). This is the *exact* dual-ownership shape that caused
the crash this plan exists to fix — two separate systems (React state, vanilla JS instance
state) both believing they own "is this open," kept in sync only by best-effort `useEffect`
plumbing. Since modal visibility is already 100% React-driven at every call site today, there
is no reason to introduce a second source of truth just to say the JS instance API was used.

### 3. Dropdown: raw `data-bs-toggle` + `data-bs-auto-close`, imperative close-on-select via a small hook (chosen)

`ProjectDropdown.jsx` and `WorkspaceMenu.jsx` (currently the only two `react-bootstrap
Dropdown` users) move to raw markup matching `MenuBar.jsx`'s proven pattern — vanilla
Bootstrap already handles open/close/keyboard-nav/positioning for it today with zero React
state — instead of reinventing a parallel React-controlled raw dropdown. Their "stay open
while typing in the search box" requirement (currently `autoClose="outside"` +
React-controlled `show`) maps directly onto Bootstrap 5's own `data-bs-auto-close="outside"`
attribute — no JS or React state needed for that part at all.

The one thing raw markup doesn't give for free: closing the menu *programmatically* after a
deliberate row/item click (selecting a project, picking a workspace version, choosing a search
result) — `data-bs-auto-close="outside"` means inside clicks never auto-close. A tiny shared
hook, `uikit/useBootstrapDropdown()`, wraps this: returns a toggle `ref` and a `close()`
function (`bootstrap.Dropdown.getInstance(toggleRef.current)?.hide()`) for call sites to
invoke from their own click handlers — the only imperative-JS-instance touch point in this
plan, deliberately narrow (read-and-command an existing instance already owned by vanilla
Bootstrap, not a second parallel state machine) and non-controversial since `MenuBar.jsx`
already implicitly relies on vanilla Bootstrap owning dropdown state.

**Rejected: hand-roll dropdown open/close entirely in React state** (a raw-markup version of
what `ProjectDropdown`/`WorkspaceMenu` do today with `react-bootstrap`'s controlled `show`
prop). Would re-litigate positioning (Popper), outside-click detection, and keyboard nav that
vanilla Bootstrap already provides for free via `data-bs-toggle` — exactly the kind of
duplicate-implementation this plan is trying to collapse back to one.

### 4. Tabs: plain `useState` + raw `nav-tabs` markup, no vanilla JS (chosen)

Both current shapes — `TabbedPage.jsx`'s URL-controlled tabs (`activeKey` from `useParams`)
and `ProjectMembersModal.jsx`'s locally-uncontrolled tabs (`defaultActiveKey`) — already only
render the *active* tab's content (no hidden-but-mounted panes, no `Tab.Pane` fade
transitions), so there's nothing for `data-bs-toggle="tab"`'s JS to actually do beyond
toggling an `active` class. `uikit/Tabs.jsx` is a small controlled component (`activeKey` +
`onSelect` props, matching the two existing call shapes) rendering raw `<ul
className="nav nav-tabs">` / `<li className="nav-item">` / `<button className="nav-link
{active}">`, with the caller owning the state (`useParams`-derived for `TabbedPage`, a plain
local `useState` for `ProjectMembersModal`, replacing its currently-uncontrolled
`defaultActiveKey`). No `data-bs-toggle`, no vanilla JS involvement.

### 5. Collapse: plain conditional render, animation dropped (chosen)

`widgets/Export.jsx`'s two `<Collapse in={isExpanded}>` usages (expand/collapse a details
section, not a core interaction) become a plain `{isExpanded && <div>...}` — no Bootstrap
`.collapse`/`.collapsing` classes, no vanilla `bootstrap.Collapse` instance, no animation.

**Rejected: raw `data-bs-toggle="collapse"` + vanilla `bootstrap.Collapse`**, which would
preserve the height-transition animation. Available as a fallback if the instant-snap loses
something the user cares about, but adds a fourth JS-instance-owned widget for a
non-load-bearing visual flourish; starting from the simplest option and only reaching for the
vanilla-JS version if the animation is actually missed.

### 6. `frontend/src/bootstrapDropdownConflictGuard.js` and `data-rb-guard` are deleted, not kept (chosen)

Once no `react-bootstrap` `<Dropdown>` exists, the guard has nothing left to guard against —
it becomes dead code documenting a conflict that no longer exists in the codebase. Deleted in
the same phase that converts `ProjectDropdown.jsx`/`WorkspaceMenu.jsx` (Phase 1, see
Implementation Steps).

### 7. `react-bootstrap` is uninstalled from `package.json` only after every usage is gone (chosen)

`npm uninstall react-bootstrap` runs as the last step, once `grep -rl "from 'react-bootstrap'"
frontend/src` returns nothing — not earlier, and not left in `package.json` as unused
dead weight once the migration is done. `bootstrap` stays (CSS + the vanilla JS bundle both
remain load-bearing throughout and after).

### 8. Phased rollout, one PR-sized phase at a time (chosen)

21 files is too much to land and verify as one change. Phases below are ordered by
blast-radius (smallest/highest-value first) and are each independently shippable — the app
runs correctly with `react-bootstrap` and raw-markup components coexisting mid-migration,
same as it does today.

---

## `uikit/` Components (built in Phase 1)

- **`uikit/Modal.jsx`** — `<Modal show onHide size backdrop>` wrapping `Modal.Header`
  (`closeButton`), `Modal.Title`, `Modal.Body` as sub-exports, matching the current
  `react-bootstrap` call shape closely enough that most call sites only need their import
  line changed. Implements Decision 2.
- **`uikit/Tabs.jsx`** — `<Tabs activeKey onSelect>` + `<Tabs.Item eventKey title>` (or
  equivalent), covering both the `TabbedPage.jsx` (controlled) and `ProjectMembersModal.jsx`
  (adds local `useState`) shapes. Implements Decision 4.
- **`uikit/useBootstrapDropdown.js`** — hook returning `{ toggleRef, close }`. Implements
  Decision 3.

Everything else (Decision 1) is inline raw markup at each call site — documented here as a
reference table for implementers, not built as components:

| react-bootstrap | Raw replacement |
|---|---|
| `<Button variant="primary" size="sm">` | `<button className="btn btn-primary btn-sm">` |
| `<Badge bg="secondary">` | `<span className="badge bg-secondary">` |
| `<Card>` / `.Header` / `.Body` | `<div className="card">` / `card-header` / `card-body` |
| `<Container>` / `<Row>` / `<Col>` | `<div className="container">` / `row` / `col` |
| `<Alert variant="danger">` | `<div className="alert alert-danger" role="alert">` |
| `<Spinner animation="border" size="sm">` | `<div className="spinner-border spinner-border-sm" role="status">` |
| `<ProgressBar now={n}>` | `<div className="progress"><div className="progress-bar" style={{width: `${n}%`}}>` |
| `<InputGroup>` | `<div className="input-group">` |
| `<Form.Group>` | `<div className="mb-3">` |
| `<Form.Label>` | `<label className="form-label">` |
| `<Form.Control>` | `<input className="form-control">` / `<textarea className="form-control">` |
| `<Form.Select>` | `<select className="form-select">` |
| `<Form.Check type="checkbox">` | `<input type="checkbox" className="form-check-input">` + `<label className="form-check-label">` |
| `<Form.Text>` | `<div className="form-text">` |
| `<Table size="sm" hover>` | `<table className="table table-sm table-hover">` |

---

## Implementation Steps

1. **Phase 1 — foundation + the files that started this.** Build `uikit/Modal.jsx`,
   `uikit/Tabs.jsx`, `uikit/useBootstrapDropdown.js`. Convert `ProjectDropdown.jsx` and
   `WorkspaceMenu.jsx` to raw dropdown markup (Decision 3). Delete
   `bootstrapDropdownConflictGuard.js`, its import in `index.jsx`, and every `data-rb-guard`
   attribute (Decision 6). Manually verify: both toolbar dropdowns open/close, search boxes
   stay open while typing, Escape no longer crashes (regression check for the bug that started
   this), selecting a row/result closes the menu, nested nothing broke in `MenuBar.jsx`.

2. **Phase 2 — flexout layout system.** `flexout/components/Pane.jsx`,
   `flexout/components/TabSet.jsx` — both single, simple `Modal` usages (pane configuration
   dialogs). Convert to `uikit/Modal`. Small blast radius, but core layout code — verify pane
   config dialogs open/save/cancel correctly across a couple of widget types.

3. **Phase 3 — standalone modals.** `ProjectModal.jsx`, `ProjectExportModal.jsx`,
   `ProjectMembersModal.jsx` (also converts its internal `Tabs` per Decision 4 and its
   `InputGroup`/`Spinner`/`Alert`/`Form.*`/`Table` per the reference table),
   `WorkspaceSharingModal.jsx`. These are the modals reachable from the two dropdowns
   converted in Phase 1 — natural next step, and exercises `uikit/Modal` + `uikit/Tabs`
   together.

4. **Phase 4 — admin pages.** `AdminPage.jsx`, `ClustersAdminPanel.jsx`,
   `StorageBackendsAdminPanel.jsx`, `TabbedPage.jsx` (converts its `Tab.Container`/`Nav` to
   `uikit/Tabs`), `clusterProviders/KubeconfigClusterForm.jsx`,
   `storageProviders/S3StorageForm.jsx`. Admin-only surface, lower traffic, safe to batch.

5. **Phase 5 — account/auth/landing pages.** `AccountPage.jsx` (includes a `backdrop="static"`
   modal — verify it truly doesn't close on backdrop click), `LandingPage.jsx` (includes the
   ToS `backdrop="static"` modal — re-verify against
   `docs/plans/done/tos-signup-modal.md`'s non-dismissible requirement), `InviteAcceptPage.jsx`.

6. **Phase 6 — process/widget UI.** `widgets/ProcessEditor.jsx`, `widgets/EnvironmentView.jsx`,
   `widgets/Export.jsx` (Collapse → plain conditional render, Decision 5),
   `jsoneditor/DatasetSelector.jsx`, `jsoneditor/EPSGSelector.jsx`,
   `jsoneditor/FileUploadField.jsx`. Touches the JSON-schema-driven form widgets documented in
   `docs/frontend/forms.md` — re-read that doc's custom-widget section before touching these
   three.

7. **Phase 7 — cleanup.** Confirm `grep -rl "from 'react-bootstrap'" frontend/src` is empty.
   `npm uninstall react-bootstrap` (Decision 7). Update
   `docs/architecture/dependencies.md`'s react-bootstrap row (remove it) and
   `docs/frontend/forms.md:461`'s mention of `react-bootstrap` in `DatasetSelector`/
   `EPSGSelector`/`FileUploadField`.

Each phase is independently shippable; land and verify one before starting the next rather
than converting all 21 files in one pass.

---

## Verification (per phase, at minimum)

- No `react-bootstrap` import remains in any file touched by that phase.
- No new `frontend/src/bootstrapDropdownConflictGuard.js`-style crash — specifically, retest
  Escape/ArrowUp/ArrowDown with focus inside every converted dropdown/modal/form control.
- Both `backdrop="static"` modals (`AccountPage.jsx` revealed API key,
  `LandingPage.jsx` ToS) still refuse to close on backdrop click after conversion.
- `MenuBar.jsx`'s existing nested submenus still work unmodified (regression check — nothing
  in this plan touches `MenuBar.jsx` itself, but every phase changes what's loaded alongside
  it).
- Modal open/close, tab switching, and dropdown open/close/search/select all still work via a
  real browser pass (per `CLAUDE.md`'s UI-change testing requirement), not just a lint/build
  check.
- Final phase: `npm run build` succeeds with `react-bootstrap` absent from
  `package.json`/`package-lock.json`.

---

## Open Questions

- [ ] **The nested-submenu explanation (Background, "Why raw markup exists at all")** is
      inferred from the code, not confirmed against the actual history. If the real reason raw
      markup was chosen for `MenuBar.jsx` was something else, it doesn't change this plan's
      direction (raw bootstrap wins either way, per your instruction) — but it's worth having
      right for the next person who wonders the same thing.
- [ ] **Collapse animation (Decision 5)**: confirm dropping it (plain conditional render) is
      fine, versus the fallback vanilla-`bootstrap.Collapse` option that preserves it.

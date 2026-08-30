# Workspace "Edit as code" YAML Modal — Plan

## Goal

Add a modal YAML editor for the **current workspace**, opened from a new
**"Edit as code"** entry (with an `fa-code` icon) in the workspace menu. The
modal is large so the user can see and edit a lot of YAML at once. Editing
operates on the **live flexout layout tree** — the same object the existing
"Save" menu item writes back as a new version — and confirming applies the
parsed YAML to the running app via `updateLayout()`. Persisting is left to the
existing "Save" item (single save path).

```
Workspace ▾
 ├─ (workspace rows + version selects)
 ├──────────────
 ├─ Save "…"
 ├─ Save As New Workspace…
 ├─ Publish Workspaces…
 ├─ ⟨ ⟩ Edit as code…        ← new entry, fa-code icon
 └──────────────
        │ click
        ▼
 ┌────────────────────────────────────────────┐
 │ Edit workspace as code            [x]      │  ← big Modal (size="xl")
 │ ┌────────────────────────────────────────┐ │
 │ │ id: root                               │ │
 │ │ widget: VerticalSplit                  │ │  ← monospace textarea, ~70vh
 │ │ children:                              │ │
 │ │   - id: …                              │ │
 │ │     widget: FlowView                   │ │
 │ │ …                                      │ │
 │ └────────────────────────────────────────┘ │
 │ [parse error shown here if invalid]        │
 │                       [Cancel]  [Apply]    │
 └────────────────────────────────────────────┘
```

## Design decisions (agreed with user)

1. **Edit scope: the live layout tree.** The modal serializes/edits the current
   flexout layout (the object in `LayoutContext.layout`, mirrored by
   `WorkspaceMenu`'s `layoutRef`) — *not* the full workspace object. Metadata
   (title, `is_public`, `superpublic`) stays owned by the existing Save-As /
   Publish menu items. This matches how a "workspace" is edited today.
2. **Editor surface: a plain monospace `<textarea>`.** No heavy code-editor
   dependency (no Monaco/CodeMirror). Only a YAML parse/serialize library is
   added. Robust and simple; syntax highlighting is out of scope.
3. **Confirm behaviour: apply to the live layout only.** On Apply we parse the
   YAML and call `updateLayout(parsed)` so the running app re-renders with the
   edited layout. We do **not** write a new version here — the user persists via
   the existing "Save" item. One save path, and it works even when the user
   isn't a member of the workspace's project (they can still experiment locally).

## Background — how the pieces fit (from exploration)

- **Menu:** `frontend/src/WorkspaceMenu.jsx` (registered in
  `frontend/src/App.jsx:115` as `_workspaceMenu`). It is a react-bootstrap
  `<Dropdown>`; action items are plain `<button className="dropdown-item">` in
  `<Dropdown.Menu>` (lines 243–259). It already keeps `layoutRef` synced to
  `LayoutContext.layout` (lines 211, 215–217) and already drives one modal
  (`showSharingModal` state → `<WorkspaceSharingModal>` sibling, lines 212, 262–266).
  This is the exact pattern to mirror for the new modal.
- **Live layout + apply:** `frontend/src/flexout/LayoutContext.jsx` exposes
  `{ layout, updateLayout }` (lines 51–60). `updateLayout(newTree)` is what a
  version-load already calls (`WorkspaceMenu.jsx:29`) to swap the layout live.
- **Layout shape:** a recursive flexout tree — root `{ id, widget }`, nodes may
  have `children: [...]` and per-widget fields. Stored as JSON in
  `WorkspaceVersion.layout` (`backend/models/workspace.py`), so it is pure JSON
  and safe to YAML round-trip.
- **Modal pattern:** react-bootstrap `<Modal show onHide>` with parent
  `useState` — see `frontend/src/WorkspaceSharingModal.jsx`.
- **Icons:** FontAwesome free is available app-wide
  (`@fortawesome/fontawesome-free`, imported in `frontend/src/index.jsx`); used
  as `<i className="fa fa-code" />`. The workspace menu currently has no icons;
  this entry adds one (spec'd below), matching icon usage elsewhere
  (`ProcessEditor.jsx`, `flexout/components/TabSet.jsx`).
- **YAML:** no parser exists. `frontend/src/widgets/ProcessInfo.jsx` has a
  hand-rolled `toYaml` *serializer only* (no `load`), so it cannot round-trip.
  We add `js-yaml` for both `dump` and `load`.

## New dependency (requires user npm approval)

Per CLAUDE.md npm rule, get explicit approval before installing:

```bash
cd frontend && npm install --save js-yaml
```

- `js-yaml` — mature, ~standard YAML 1.1 parser/serializer. Used for
  `yaml.dump(layout)` (pretty serialize) and `yaml.load(text)` (parse back).
- Registry version only (never a `file:` path). This is the sole new dep;
  the editor itself is a native `<textarea>`.

## Implementation steps

### 1. New component `frontend/src/WorkspaceCodeModal.jsx`

A self-contained modal that reads and applies the live layout via
`LayoutContext` (so `WorkspaceMenu` only toggles a boolean).

- Props: `{ show, onHide }`.
- `const { layout, updateLayout } = useContext(LayoutContext);`
- Local state: `const [text, setText] = useState('')` and
  `const [error, setError] = useState(null)`.
- **Seed on open:** `useEffect(() => { if (show) { setText(yaml.dump(layout));
  setError(null); } }, [show])`. Re-serialising each open picks up any layout
  changes the user made since last time. Use `yaml.dump(layout, { indent: 2,
  noRefs: true, lineWidth: -1 })` so anchors/wrapping don't obscure the tree.
- **Editor:** `<Modal size="xl">` with a `<Form.Control as="textarea">` (or a
  bare `<textarea className="form-control">`) styled big and monospace:
  `style={{ height: '70vh', fontFamily: 'monospace', whiteSpace: 'pre',
  overflowWrap: 'normal' }}`, `spellCheck={false}`, `wrap="off"`. This satisfies
  "big so you easily see a lot of the yaml".
- **Apply handler:**
  ```js
  const handleApply = () => {
    let parsed;
    try {
      parsed = yaml.load(text);
    } catch (e) {
      setError(e.message);         // keep modal open, show the YAML error
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.widget) {
      setError('Layout must be an object with at least a "widget" field.');
      return;
    }
    updateLayout(parsed);
    onHide();
  };
  ```
  The light `parsed.widget` sanity check prevents applying obviously-wrong YAML
  (a string/number/list) that would crash the layout renderer; it is not a full
  schema validation (out of scope — see below).
- **Footer:** `<Modal.Footer>` with a `Cancel` (`onClick={onHide}`) and a
  primary `Apply` button. Render `error` above the footer (e.g. a red
  `<div className="text-danger small">`) when set.
- **No auto-save note:** include a small muted hint in the modal body/footer,
  e.g. "Applies to the current layout — use Workspace ▸ Save to persist as a new
  version." so the behaviour is discoverable.

### 2. Wire the menu entry in `frontend/src/WorkspaceMenu.jsx`

- Add state near the existing `showSharingModal`:
  `const [showCodeModal, setShowCodeModal] = useState(false);`
- Add a `dropdown-item` button after "Publish Workspaces…" (after line 256):
  ```jsx
  <button
    type="button"
    className="dropdown-item"
    onClick={() => { setShowCodeModal(true); setMenuOpen(false); }}
  >
    <i className="fa fa-code me-2" aria-hidden="true" />Edit as code…
  </button>
  ```
- Render the modal as a sibling next to `<WorkspaceSharingModal>` (near lines
  262–266):
  ```jsx
  <WorkspaceCodeModal show={showCodeModal} onHide={() => setShowCodeModal(false)} />
  ```
- Import it at top: `import WorkspaceCodeModal from './WorkspaceCodeModal';`

Because `WorkspaceCodeModal` pulls the layout straight from `LayoutContext`,
no `layoutRef` needs to be threaded into it.

## Verification

Servers auto-reload (do not start them). After `npm install js-yaml`:

1. Open the app, pick a non-trivial workspace (a split/tab layout), open
   Workspace ▸ **Edit as code…**. Confirm the modal is large and shows the
   layout as readable YAML.
2. Make a harmless edit (e.g. reorder children / change a tab title if present),
   click **Apply** → the layout visibly updates live; modal closes.
3. Introduce a YAML syntax error (bad indentation) → **Apply** shows the parse
   error inline and keeps the modal open; nothing changes.
4. Replace the whole doc with a scalar (`just a string`) → the "must be an
   object with a widget field" guard fires; no crash.
5. After a successful Apply, use the existing Workspace ▸ **Save** to confirm the
   edited layout persists as a new version (unchanged save path).
6. Cancel / close (x) discards edits without touching the layout.

## Files touched

- `frontend/src/WorkspaceCodeModal.jsx` — **new** modal component.
- `frontend/src/WorkspaceMenu.jsx` — new "Edit as code…" item + modal wiring.
- `frontend/package.json` / `package-lock.json` — add `js-yaml` (after approval).

## Out of scope

- No JSON-Schema validation of the layout against `GET /workspace/schema`
  (the light `widget` check is the only guard). Could be a follow-up.
- No syntax highlighting / line numbers / rich code editor (plain textarea).
- No editing of workspace metadata (title/public flags) — handled by existing
  Save-As / Publish items.
- No new save semantics — Apply only touches the live layout; persisting stays
  with the existing "Save" item.
- No backend changes.

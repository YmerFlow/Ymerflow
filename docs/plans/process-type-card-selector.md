# Process Type Card Selector — Plan

## Context

In the process editor (`frontend/src/widgets/ProcessEditor.jsx`), a user picks which process
type to create from a plain Bootstrap `<select>` (`ProcessEditor.jsx:282-293`). The options are
built straight from `Object.keys(types)` and use the raw setuptools entry-point name (e.g.
`compound_filter`, `import_skytem`, `invert_tem`) as **both** the value and the visible label.
There is no human-readable title and no description/help text anywhere the user can see while
choosing — the only prose in the system is per-*field* `title`/`description` inside each schema's
`properties`, which RJSF renders later in the parameter form.

This plan does two things:

1. **Adds type-level `title` + `description`** to each process class's JSON Schema so the
   information exists end-to-end (no plumbing changes — the existing wrapper carries it through).
2. **Replaces the `<select>` with a custom card-dropdown** in the process editor: the currently
   selected type is shown as a card (with a dropdown arrow) inside the form; clicking it drops
   down a large, scrollable box of cards (title + description) — one per available type; clicking
   a card selects it and closes the box.

### Decisions settled with the user

- **Where the metadata lives:** top-level `title` and `description` keys inside each class's
  `schema()` return value. JSON Schema blesses both at the top level, and the existing pipeline
  already carries the whole schema verbatim (see "Why no plumbing" below), so **no backend/API/DB
  changes are needed** — the frontend already receives `types[t].schema`.
- **The cards ARE the dropdown** — not a pre-selection grid that reverts to a `<select>`. One
  custom control replaces the `<select>` entirely, in both new-process and existing-process
  (edit / change-type) modes: a collapsed trigger showing the selected type's card + a dropdown
  arrow, expanding to a scrollable box of cards.
- **Fallback for missing metadata → machine name as title.** A type whose schema has no `title`
  (older environment built before this change, or any not-yet-rebuilt type) shows the raw
  entry-point name as the card title and simply omits the description line. The selector always
  works; missing metadata just looks plain. No prettification of the machine name.
- **No search/filter box.** Just a scrollable list of cards. Current type count is small (13);
  keep the UI minimal. (Revisit if the list grows large.)
- **Scope: base-runner + all plugins.** Add `title`/`description` to **every** registered process
  class (all 13, see inventory below). There are in fact no plugin packages outside base-runner
  today — every `ymerflow.process_types` registration lives in the three base-runner packages — so
  "all plugins" is fully covered by updating those three.

## Background — current state (confirmed by reading the code)

### Data path (why no plumbing is needed)

- Each process class exposes a classmethod `schema()` returning a JSON Schema dict whose immediate
  keys today are only `type` / `properties` / `required`.
- `docker/base-runner/get_schema.py:33-43` loads every `ymerflow.process_types` entry point, calls
  `process_class.schema()`, and wraps it verbatim as `schemas[name] = {"schema": schema}` into
  `/app/process_schemas.json`. **It copies the whole schema dict** — any new top-level key
  (`title`, `description`) rides along automatically.
- At environment-build time `create_environment.run` extracts that file and stores it as the
  environment's `process_types` JSON column (`backend/models/environment.py:16`).
- Backend serves it verbatim: `GET /environments/{env_id}/process-types`
  (`backend/routers/environments.py:37-59`) returns `environment.process_types` — the full dict
  `{ typeName: { "schema": {...} }, ... }`.
- Frontend fetches via `useEnvironmentProcessTypes` (`frontend/src/datamodel/useQueries.js:185-193`)
  → `getEnvironmentProcessTypes` (`frontend/src/datamodel/api.js:343-346`), and already reads
  `types[localType].schema` (`ProcessEditor.jsx:174`). So `types[t].schema.title` and
  `types[t].schema.description` become available **for free** once the classes set them.

**Consequence:** to *see* new titles/descriptions in an existing environment, that environment must
be rebuilt / re-registered (the `create_environment` process re-extracts `process_schemas.json`).
Until then, that environment's stored schemas have no top-level title/description and the selector
shows the machine-name fallback. This is expected and requires no migration — it's data captured at
build time.

### Current picker (`ProcessEditor.jsx:282-293`)

```jsx
{localEnvironment && (
  <div className="mb-3">
    <label className="form-label">Process Type: </label>
    <select
      className="form-select" value={localType || ""} disabled={typesLoading}
      onChange={e => { setLocalType(e.target.value); if (!isExisting) setFormData({}); }}
    >
      <option value="">{typesLoading ? "Loading..." : "Select type..."}</option>
      {Object.keys(types).map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  </div>
)}
```

Behaviour to preserve exactly:
- Only shown once `localEnvironment` is set.
- Selecting a type sets `localType`; in new-process mode (`!isExisting`) it also resets
  `setFormData({})`.
- `disabled` while `typesLoading`; placeholder "Loading..." / "Select type..." for the empty state.
- Works in both new-process and existing-process (change-type) modes — the same control is used;
  today the `<select>` is editable even when editing an existing process.
- Downstream, `types[localType]?.schema` drives the `CustomForm` (`ProcessEditor.jsx:174,394-402`),
  and several effects key off `localType` (auto-name at `:157-162`, reset-if-unavailable at
  `:165-170`). The new control changes **only how a type is chosen**; it keeps setting the same
  `localType` state, so all of that keeps working untouched.

## Process-type class inventory (all 13 need `title` + `description`)

All under `docker/base-runner/`. None currently has a top-level `title`/`description`.

| Package | Entry-point name | Class file (schema line) |
|---|---|---|
| ymerflow_processes | create_environment | `ymerflow_processes/fake_processes.py:11` |
| ymerflow_processes | compound_filter | `ymerflow_processes/compound_filter.py:97` |
| ymerflow_processes | build_frontend_plugin | `ymerflow_processes/build_frontend_plugin.py:47` |
| aem_processes | import_skytem | `aem_processes/aem_processes/import_process.py:15` |
| aem_processes | import_ymerflow_aem | `aem_processes/aem_processes/import_msgpack_process.py:13` |
| aem_processes | process_tem | `aem_processes/aem_processes/processing_process.py:15` |
| aem_processes | invert_tem | `aem_processes/aem_processes/inversion_process.py:33` |
| aem_processes | forward_tem | `aem_processes/aem_processes/forward_process.py:32` |
| aem_processes | grid_tem | `aem_processes/aem_processes/gridding_process.py:432` |
| mag_processes | import_mag | `mag_processes/mag_processes/import_process.py:13` |
| mag_processes | process_mag | `mag_processes/mag_processes/processing_process.py:18` |
| mag_processes | equiv_source_mag | `mag_processes/mag_processes/equiv_source_process.py:63` |
| mag_processes | inversion_3d_mag | `mag_processes/mag_processes/inversion_3d_process.py:76` |

Two schemas (`aem` + `mag` `processing_process.py`) build `properties.steps` dynamically via
`swaggerspect`; the top-level `title`/`description` are still added to the outer dict they return,
independent of the dynamic `steps` sub-schema.

## Design decisions

### Decision 1 — Metadata as top-level `title`/`description` in each `schema()` — **chosen**

Each class's `schema()` gains two top-level keys, e.g.:

```python
@classmethod
def schema(cls):
    return {
        "type": "object",
        "title": "Compound Filter",
        "description": "Apply a chain of libaarhusxyz filters to an XYZ dataset. "
                       "Optionally applies an InUse diff produced by the flag editor.",
        "properties": { ... },
        "required": ["input"],
    }
```

- `title`: a short human-readable name (a few words).
- `description`: one to three sentences saying what the process does and what it consumes/produces,
  written for a user choosing between types — not internal implementation notes.

**Rejected:** a sibling field next to `schema` (`{"schema": ..., "description": ...}`). It would
force explicit threading through `get_schema.py`'s wrapper and the frontend read; putting it inside
the schema is standard JSON Schema and needs zero plumbing. **Rejected:** injecting titles centrally
in `get_schema.py` from a lookup table — that divorces the text from the class it describes and
rots. Text lives with the class.

### Decision 2 — A dedicated `ProcessTypeSelect` component, not inline JSX — **chosen**

Build `frontend/src/widgets/ProcessTypeSelect.jsx` (a plain widget-local component, not a flexout
widget) and drop it into `ProcessEditor.jsx` in place of the `<select>` block. Rationale: the
control has its own open/closed state, outside-click handling, and card markup — inlining that into
the already-large `ProcessEditor` hurts readability, and a named component is testable in isolation.

Props (thin wrapper over the existing `<select>` contract, so the editor barely changes):

```jsx
<ProcessTypeSelect
  types={types}            // the { name: { schema } } dict, unchanged
  value={localType}        // selected type name or null
  disabled={typesLoading}
  loading={typesLoading}
  onChange={(t) => { setLocalType(t); if (!isExisting) setFormData({}); }}
/>
```

The `onChange` body is **exactly** today's `<select>` `onChange` logic, so all downstream effects
and the `CustomForm` wiring are untouched.

### Decision 3 — Collapsed trigger + absolutely-positioned dropdown panel — **chosen**

- **Collapsed trigger:** a full-width clickable card-like control (reuse Bootstrap `card`/`form`
  styling to match the surrounding form) showing the selected type's **title** (machine-name
  fallback) as a bold line, its **description** as a muted line beneath (omitted when absent), and a
  right-aligned dropdown caret (`fa fa-chevron-down`, rotated when open). When nothing is selected,
  the trigger shows the placeholder — "Select type…" (or "Loading…" when `loading`).
- **Dropdown panel:** on click, render an absolutely-positioned box below the trigger
  (`position: absolute; z-index` above form fields; `width: 100%` of the trigger). It has a
  **large max-height and `overflow-y: auto`** (scrollable when the list is tall) and contains one
  **card per type** (`Object.keys(types)`), each showing title + description. The currently
  selected type's card is visually marked (e.g. `border-primary` / active background). Clicking a
  card calls `onChange(name)` and closes the panel. Clicking outside the control, pressing `Escape`,
  or selecting a card closes it.
- **State:** local `useState(open)`. Outside-click via a `useEffect` that adds/removes a
  `mousedown` listener on `document` and closes when the click target is outside a `ref` on the
  root. `Escape` via a `keydown` listener while open. No portal needed — a positioned panel inside
  a `position: relative` root is enough given the editor layout.
- **Disabled/loading:** when `disabled`, the trigger is non-interactive (no open on click) and
  styled muted, mirroring the old `<select disabled>`.

**Card content helper:** a small `typeTitle(name, type)` → `type?.schema?.title || name` and
`typeDescription(type)` → `type?.schema?.description || null`, used by both the trigger and the
list so the fallback rule lives in one place (Decision: machine-name fallback, no prettification).

**Rejected:** a native `<select>` with `<optgroup>`/richer options — browsers don't render
descriptions or multi-line option content, which is the whole point. **Rejected:** react-bootstrap
`Dropdown` — its menu is designed for short action items and fights multi-line cards and full-width
sizing; a hand-rolled panel is simpler here and the codebase already hand-rolls similar controls.

### Decision 4 — Fallback: machine name as title, no description line — **chosen**

If `schema.title` is missing → title = the entry-point/type name verbatim. If `schema.description`
is missing → no description line rendered (trigger and cards just show the title). No derivation of
a pretty name from the machine name. This keeps the control fully functional against environments
built before this change and any type that hasn't set the fields.

### Decision 5 — No search/filter box — **chosen**

The panel is a plain scrollable card list. (If the type count grows large later, a filter input is
an easy additive follow-up — noted, not built now.)

## Frontend changes

- **`frontend/src/widgets/ProcessTypeSelect.jsx`** (new) — the component described in Decisions 2–5:
  collapsed trigger, absolutely-positioned scrollable card panel, outside-click/Escape close,
  machine-name fallback, disabled/loading handling. Exports the `typeTitle`/`typeDescription`
  helpers (or keeps them local). Pure presentational + local state; no data fetching, no context.
- **`frontend/src/widgets/ProcessEditor.jsx`** — replace the `<select>` block (`:282-293`) with
  `<ProcessTypeSelect .../>` wired as in Decision 2. No other logic changes: `localType`,
  `types`, `typesLoading`, the `setFormData({})` reset, and every downstream effect stay exactly as
  they are. Keep the `{localEnvironment && (...)}` gate and the `<label>Process Type:</label>`.
- **Styling** — reuse existing Bootstrap classes (`card`, `text-muted`, `border-primary`,
  `form-label`) plus a small amount of inline style for the positioned panel and max-height, in
  keeping with the inline-style pattern already used elsewhere in the widgets (e.g. FlowView cards).
  No new CSS framework, no new npm deps.

## Backend / process changes

- **13 `schema()` methods** (see inventory) each gain top-level `title` + `description`
  (Decision 1). Text is written per class for a user choosing a type. No signature changes, no new
  return keys beyond these two, no changes to `properties`.
- **`docker/base-runner/get_schema.py`** — no change (already copies the whole schema).
- **Backend / API / models / Alembic** — **no changes, no migration.** The metadata rides the
  existing `{"schema": ...}` wrapper and the existing JSON column.

## Migration / compatibility

- **Existing environments** keep their already-captured `process_types` JSON, which has no
  top-level title/description → the selector shows the **machine-name fallback** for those types
  until the environment is rebuilt (`create_environment`), which re-extracts `process_schemas.json`
  from a freshly built runner image. This is data-captured-at-build-time behaviour, not a code
  migration. Document that operators should rebuild environments to surface the new descriptions.
- **No DB migration.** No schema/model/endpoint change.
- **Old frontend + new environment** or **new frontend + old environment** both work: the frontend
  reads `schema.title`/`schema.description` defensively with fallback, and any consumer ignoring
  the new keys is unaffected (they're additive top-level JSON Schema keys).

## Implementation order

1. Add `title` + `description` to all 13 `schema()` methods (three base-runner packages). Purely
   additive; safe to land first.
2. Build `ProcessTypeSelect.jsx` (trigger + panel + close behaviour + fallback), rendering off the
   `types` dict.
3. Swap it into `ProcessEditor.jsx`, preserving the exact `onChange`/`setFormData` contract.
4. Rebuild a runner image + re-register an environment so real titles/descriptions appear (needed
   only to *see* the text; the UI works with fallback before that).

## Verification

- **Frontend (servers already running, auto-reload):**
  - With an environment whose types have `title`/`description`, open the process editor: the
    Process Type control shows a collapsed card with the selected (or placeholder) title; clicking
    opens a scrollable panel of cards each showing title + description; clicking a card selects it,
    updates the parameter form, and closes the panel.
  - Selecting a type in **new-process** mode clears the parameter form (`setFormData({})`); in
    **existing-process** mode changing the type behaves as the old `<select>` did.
  - Outside-click and `Escape` close the panel; the caret rotates open/closed; the control is
    disabled and shows "Loading…" while `typesLoading`.
  - **Fallback:** point at an environment built before this change (or a type with no title) and
    confirm the card shows the raw type name and no description line, and selection still works.
  - Downstream regressions: auto-generated process name (`:157-162`) and reset-if-type-unavailable
    on environment switch (`:165-170`) still fire correctly.
- **Schema/pipeline:** rebuild the runner image, run `create_environment`, and confirm
  `GET /environments/{id}/process-types` returns each type's `schema.title`/`schema.description`;
  confirm the editor renders them.
- **Backend:** unchanged — no new tests required beyond confirming `get_schema.py` output now
  contains the top-level keys (a quick check of the generated `process_schemas.json`).

## Open questions

None outstanding — all design points settled with the user (metadata location, cards-as-dropdown,
machine-name fallback, no search box, base-runner + all-plugins scope). Item to revisit only if the
type list grows large: an optional filter input in the panel (additive, not in this scope).

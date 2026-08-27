# Process/version selector for info/export/log widgets + Process comparison widget

## Goal

Two related changes, sharing one new piece of machinery:

1. **Make `ProcessInfo`, `Export`, and `ProcessLog` able to target an arbitrary
   process/version**, not just the active one — exactly the way PlotView layers can
   target arbitrary process outputs. Each defaults to the active process/version via a
   literal `"current"` value, handled **inside the field** the same way `datasetPath`
   already handles `current.<dataset>`.

2. **Add a new `ProcessComparison` widget** that selects *two* process/versions with two
   inline comboboxes (rendered in the widget body, not the config gear, but persisted to
   the workspace the same way), and renders a diff table of their config dictionaries.

The unifying idea: introduce a **process/version reference** — a short dot-path string
(`"current"` or `"<procName>.<version>"`) — that is the 2-segment analogue of the
3-segment dataset path (`"current.<ds>"` / `"<procName>.<version>.<ds>"`) PlotView already
uses. Both are rendered by the same combobox component and resolved by shared helpers.

## Background — how PlotView already does this

- Layer schema fields declare `x-format: "datasetPath"`
  (`frontend/src/widgets/PlotView/elements/*.js`).
- `CustomStringField.jsx` routes `datasetPath` → `DatasetPathField` → `DatasetColumnCombobox`
  in `mode="dataset"`.
- `DatasetColumnCombobox` (`frontend/src/jsoneditor/DatasetColumnCombobox.jsx`) enumerates
  options from `ProcessContext`: `current.<ds>` for the active process plus
  `<proc.name>.<version>.<ds>` for every output of every version of every process.
- The stored value is the dot-path string; `"current"` as the first segment means the
  active process. PlotView resolves non-`current` paths lazily
  (`widgets/PlotView/index.jsx`).

The three target widgets instead read `activeProcess.{processId,version}` straight from
`ProcessContext` and take no config. The flexout layout node already spreads its whole
object onto the widget (`Pane.jsx:278 <Widget parentUpdate={...} {...node} />`) and supports
per-widget config via `get_schema`/`get_default` + `parentUpdate('replace', id, formData)`
(`Pane.jsx:95,102-124`). No flexout changes are required.

## Reference value semantics (shared by all four widgets)

A **process/version reference** is a string:

- `"current"` (default) → the active process/version from `ProcessContext.activeProcess`.
- `"<procName>.<version>"` → a specific process (matched by `name`, as in the dataset
  path) and numeric version.

This is intentionally the prefix form of a `datasetPath` value, so the two fields behave
identically w.r.t. the `current` literal and `<procName>.<version>` addressing.

## Part A — shared machinery

### A1. New combobox mode: `mode="process"`

Extend `DatasetColumnCombobox.jsx` `buildOptions()` with a third branch:

```js
if (mode === 'process') {
  if (!filter || 'current'.includes(lower)) opts.push('current');
  for (const proc of (processes || [])) {
    for (const ver of (proc.versions || [])) {
      const path = `${proc.name}.${ver.version}`;
      if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
    }
  }
}
```

No lazy loading is needed (the process list is already in context), so `triggerLazyLoad`
stays a no-op for this mode. Everything else in the component (input, dropdown, select,
click-outside) is reused unchanged.

### A2. New field wrapper + `x-format` route

- Add `ProcessVersionField.jsx` next to `DatasetPathField.jsx` — identical wrapper but
  `mode="process"`.
- In `CustomStringField.jsx`, add a branch:
  ```js
  if (schema['x-format'] === 'processVersion') {
    return <ProcessVersionField formData={props.formData}
                                onChange={props.onChange}
                                fieldPathId={props.fieldPathId} />;
  }
  ```

This makes `{ type: 'string', 'x-format': 'processVersion' }` a reusable schema field for
any config gear.

### A3. Shared resolver: `frontend/src/datamodel/processRef.js`

```js
// Resolve a process/version reference string to concrete objects.
export function resolveProcessRef(value, activeProcess, processes) {
  let processId, version;
  if (!value || value === 'current') {
    if (!activeProcess) return null;
    ({ processId, version } = activeProcess);
  } else {
    const [procName, verStr] = value.split('.');
    const proc = (processes || []).find(p => p.name === procName);
    if (!proc) return null;
    processId = proc.id;
    version = parseInt(verStr, 10);
  }
  const process = (processes || []).find(p => p.id === processId);
  const versionObj = process?.versions?.find(v => v.version === version);
  return { processId, version, process, versionObj };
}
```

All four widgets call this instead of reading `activeProcess` directly.

### A4. Shared config builder + flatten/diff: `frontend/src/datamodel/processConfig.js`

Extract the config-dictionary construction currently inlined in `ProcessInfo.jsx:83-91`
so `ProcessInfo` and `ProcessComparison` build the exact same object:

```js
const EXCLUDED_FIELDS = new Set(['versions', 'flow_x', 'flow_y']);

export function buildProcessConfig(process, versionObj) {
  const config = Object.fromEntries(
    Object.entries(process).filter(([k]) => !EXCLUDED_FIELDS.has(k)));
  if (versionObj) {
    Object.assign(config, Object.fromEntries(
      Object.entries(versionObj).filter(([k]) => !EXCLUDED_FIELDS.has(k))));
  }
  return config;
}

// Flatten nested objects/arrays to { 'a.b.0.c': leafValue }.
// Leaves: null/number/string/boolean and empty {}/[].
export function flattenConfig(obj, prefix = '', out = {}) { /* recursive walk */ }

// Union of keys; include a key only when JSON.stringify(a) !== JSON.stringify(b).
export function diffConfigs(cfgA, cfgB) {
  const fa = flattenConfig(cfgA), fb = flattenConfig(cfgB);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const rows = [];
  for (const path of [...keys].sort()) {
    if (JSON.stringify(fa[path]) !== JSON.stringify(fb[path])) {
      rows.push({ path, a: fa[path], b: fb[path] });
    }
  }
  return rows;
}
```

`ProcessInfo.jsx` is refactored to import `buildProcessConfig` (behaviour unchanged).

## Part B — gear-config for ProcessInfo / Export / ProcessLog

For each of the three widgets:

1. Add `static get_default()` → `{ processRef: 'current' }`.
2. Add `static get_schema()` exposing the ref (mirroring PlotView's readonly id/widget):
   ```js
   Widget.get_schema = () => ({
     type: 'object',
     properties: {
       id:         { type: 'string', title: 'ID', readOnly: true },
       widget:     { type: 'string', title: 'Widget Type', readOnly: true },
       processRef: { type: 'string', title: 'Process / version',
                     'x-format': 'processVersion', default: 'current' },
     },
   });
   ```
   The config gear + save is handled entirely by `Pane.jsx` (`handleConfigSubmit` →
   `parentUpdate('replace', ...)`); these widgets do **not** self-persist.
3. Change the component to read the `processRef` prop (delivered via `{...node}`) and
   resolve it:
   ```js
   const { activeProcess, processes, currentProject } = useContext(ProcessContext);
   const ref = resolveProcessRef(processRef, activeProcess, processes);
   ```
   Then replace every `activeProcess.processId` / `activeProcess.version` with
   `ref.processId` / `ref.version` (and use `ref.process` / `ref.versionObj` where those
   are already looked up).

Per-widget notes:

- **ProcessInfo** (`ProcessInfo.jsx`): swap the inline lookup for `ref`, and use
  `buildProcessConfig(ref.process, ref.versionObj)`. "No process selected" now means
  `ref === null` (i.e. `current` with no active process, or a stale/removed reference).
- **Export** (`Export.jsx`): the `useEffect` reads `ref.versionObj.outputs`; add
  `processRef` to the dependency array. Header `{process.name} (v{version})` uses `ref`.
- **ProcessLog** (`ProcessLog.jsx`): derive `processId`/`version` from `ref` instead of
  `activeProcess`. The REST call `getProcessLogs(processId, version, currentProject)` and
  WS URL `${WS_API}/ws/process/${processId}/logs?version=${version}` are unchanged — they
  already take explicit ids. Add `processRef` to the effect deps.

**Follow-vs-pin behaviour** falls out for free: an unset/`"current"` ref re-resolves as
`activeProcess` changes (URL navigation), so an unconfigured pane keeps following the
active process; a pinned `"<proc>.<ver>"` ref ignores navigation.

**No pane-title indicator.** A pinned pane is *not* auto-renamed. Widget titles are
user-overridable, so the user renames the pane themselves if they want to label it. This
avoids the dynamic-default-title mechanism entirely.

## Part C — new `ProcessComparison` widget

New file `frontend/src/widgets/ProcessComparison.jsx`, registered in `App.jsx`
(`import` near line 33; entry `{ name: 'ProcessComparison', component: ProcessComparison }`
in the widgets array near line 73).

### Persistence

Signature `function ProcessComparison({ refA, refB, parentUpdate, id, widget, ...rest })`.
Two `DatasetColumnCombobox mode="process"` are rendered **inline** in the widget body.
`onChange` writes the value back into the layout node the same way PlotView self-persists:

```js
parentUpdate('replace', id, { id, widget, refA: nextA, refB: refB, ...rest });
```

Defaults: `ProcessComparison.get_default = () => ({ refA: 'current', refB: 'current' })`.
(No `get_schema` — configuration is the two inline comboboxes, not the gear. Omitting
`get_schema` simply means the gear button is hidden; `get_default` values still merge in via
`Pane.jsx` `formData`.)

### Rendering

```
[ combobox A ]   [ combobox B ]

| Path | <procA> (v<verA>) | <procB> (v<verB>) |
|------|-------------------|-------------------|
| ...  | ...               | ...               |
```

- Resolve both refs with `resolveProcessRef`; build both configs with
  `buildProcessConfig`; rows = `diffConfigs(cfgA, cfgB)`.
- Only differing leaf paths are shown (identical values are omitted — that is the whole
  point of the widget).
- A value present on only one side renders as the value on that side and an em-dash `—`
  (or blank) on the other; render leaves via a small `formatValue` (JSON for
  objects/arrays, string otherwise).
- Column headers show `process.name (vN)` for each side; if a ref is unresolved, show a
  placeholder header and a "select a process" empty state.
- `ProcessComparison.title = "Process comparison"`.

## Files touched

**New**
- `frontend/src/jsoneditor/ProcessVersionField.jsx`
- `frontend/src/datamodel/processRef.js`
- `frontend/src/datamodel/processConfig.js`
- `frontend/src/widgets/ProcessComparison.jsx`

**Modified**
- `frontend/src/jsoneditor/DatasetColumnCombobox.jsx` — add `mode="process"` branch.
- `frontend/src/jsoneditor/CustomStringField.jsx` — route `x-format: "processVersion"`.
- `frontend/src/widgets/ProcessInfo.jsx` — gear field + resolve ref + use `buildProcessConfig`.
- `frontend/src/widgets/Export.jsx` — gear field + resolve ref.
- `frontend/src/widgets/ProcessLog.jsx` — gear field + resolve ref.
- `frontend/src/App.jsx` — register `ProcessComparison`.

## Resolved design decisions

1. **Ref storage key naming** — `processRef` on the three single-target widgets;
   `refA`/`refB` on the comparison widget. Per-widget node fields, no shared name.
2. **No pane-title indicator** — pinned panes are not auto-renamed; the user renames the
   pane if they want a label (titles are already user-overridable). See Part B.
3. **Flatten to scalar leaves** — the diff flattens all the way to scalar leaves, so each
   differing leaf is its own dot-path row (finest "path that differed").
4. **Missing side renders as em-dash `—`** — a leaf present on only one side shows its
   value on that side and `—` on the other, so "absent" is distinct from empty/null.
5. **Diff rows sorted lexicographically by dot-path** — stable and predictable; groups
   sibling paths together.

## Out of scope

- No backend changes (all data sources already accept explicit process id + version).
- No changes to flexout internals.
- No change to `datasetPath` behaviour; it only gains a sibling `processVersion` sharing
  the same combobox component.
```

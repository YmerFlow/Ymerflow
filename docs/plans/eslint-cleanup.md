# ESLint Findings Cleanup — Plan

## Goal

Two pre-existing ESLint findings were surfaced while verifying the
`workspace-version-in-url` change (confirmed via `git stash` that both predate
that work and are unrelated to it — see
`docs/plans/done/workspace-version-in-url.md`). Document them here and decide
fixes before touching the code.

```
frontend/src/App.jsx
  47:1  error  Import in body of module; reorder to top  import/first
  48:1  error  Import in body of module; reorder to top  import/first
  49:1  error  Import in body of module; reorder to top  import/first
  50:1  error  Import in body of module; reorder to top  import/first
  51:1  error  Import in body of module; reorder to top  import/first

frontend/src/ProcessContext.jsx
  545:5  warning  React Hook useMemo has a missing dependency: 'newProcessToken'.
                  Either include it or remove the dependency array  react-hooks/exhaustive-deps
```

One of these (`ProcessContext.jsx`) is not just a style nit — tracing it down turned
up a real, reproducible functional bug (see below).

---

## Finding 1: `App.jsx` — `import/first` (cosmetic, no runtime bug)

### Root cause

`frontend/src/App.jsx:1-51` has three import blocks with a statement wedged between
the second and third:

```js
import { registerHook, hooks } from './plugins/hooks';       // block 2, ends here
import { buildDatasetRegistry } from './datamodel/datasetRegistry';
import { buildLayerTypeRegistry, buildQuantityKindRegistry } from './plugins/registries';
import { loadPlugins } from './plugins/loadPlugin';
import { API, getPublicationInfo } from './datamodel/api';

// Expose API URL for plugins that need to call the backend
if (typeof window !== 'undefined') window.__nagelfluh_api = API;   // <-- non-import statement

// ── Register built-in dataset types ──────────────────────────────────────────
import { JsonDataset, XyzDataset, MagDataset } from './datamodel/dataset';  // block 3, flagged
import { WebxtileDataset } from './datamodel/webxtile';
import SameAsBackendClusterForm from './clusterProviders/SameAsBackendClusterForm';
import KubeconfigClusterForm from './clusterProviders/KubeconfigClusterForm';
import S3StorageForm from './storageProviders/S3StorageForm';
```

ESLint's `import/first` requires all imports to precede all other module-level
statements. The `window.__nagelfluh_api = API` line breaks that, so every import
after it is flagged — 5 errors, one per import statement in block 3.

This is purely a lint/style violation. Module load order is unaffected either way:
ES module imports are hoisted and fully resolved before any module-body statement
executes, regardless of source position, so `window.__nagelfluh_api = API` already
runs after all three import blocks are loaded today. Reordering is a no-op at
runtime.

### Design Decision

Move the `if (typeof window !== 'undefined') window.__nagelfluh_api = API;` line
(and its comment) down, below the last import statement (`import S3StorageForm ...`)
and above the `registerHook('dataset_types', ...)` call that currently follows it.
This collapses all imports into one contiguous leading block, satisfying
`import/first`, with no behavior change.

**Rejected: `// eslint-disable-line import/first` on the 5 flagged lines** — suppresses
the symptom without fixing the actual ordering; a one-line move is just as cheap and
leaves no lint-disable to maintain.

---

## Finding 2: `ProcessContext.jsx` — stale `newProcessToken` in `contextValue`

### Root cause

`contextValue` is built by `useMemo` (`ProcessContext.jsx:502-545` computation,
deps at `:546-...`). `newProcessToken` is spread into the returned object
(`ProcessContext.jsx:514`) but is **not** listed in the memo's dependency array.

`newProcessToken` is bumped by `startNewProcess`:

```js
startNewProcess: () => { setActiveProcess(null); setNewProcessToken(t => t + 1); },
```

`useMemo` only recomputes when a *listed* dependency changes — it does not detect
that an unlisted variable used inside the factory also changed. Today this
"works" only by coincidence: `setActiveProcess(null)` calls `navigate(...)`, which
changes `location.pathname` → `activeProcess` (a listed dep) → forces a
recompute, which then happens to pick up the fresh `newProcessToken` value too.

That coincidence breaks whenever `activeProcess` is already `null` when
`startNewProcess` is called — e.g. the user is already in "new process" mode
(no process selected) and clicks "New Process" again. In that case
`setActiveProcess(null)` is a no-op (`activeProcess` was already `null`,
`location.pathname` doesn't change), so `activeProcess` doesn't change,
`contextValue`'s memo doesn't recompute, and `newProcessToken` is delivered to
consumers unchanged.

### Consumer impact

`frontend/src/widgets/ProcessEditor.jsx:93-105` relies on `newProcessToken`
specifically to reset all its local form state (name, type, form data, tags, cpu,
memory, deadline, cluster) whenever "New Process" is triggered:

```js
useEffect(() => {
  if (newProcessToken === 0) return;
  setProcessName("");
  setLocalEnvironment(selectedEnvironment || null);
  setLocalType(null);
  setFormData({});
  ...
}, [newProcessToken]);
```

### Failure scenario

1. User clicks "New Process" once (`activeProcess: something → null`) — token bump
   is (coincidentally) delivered, form resets correctly.
2. User fills in some fields (name, type, params) but does not save or select an
   existing process.
3. User clicks "New Process" again. `activeProcess` is already `null`, so
   `contextValue` does not recompute, `ProcessEditor` never sees the incremented
   `newProcessToken`, and the reset effect does not fire — the half-filled form
   from step 2 is left in place instead of being cleared.

### Design Decision

Add `newProcessToken` to the `contextValue` `useMemo` dependency array
(`ProcessContext.jsx`, the array following the object literal). This is the fix
the ESLint warning itself is asking for, and it removes the accidental coupling to
`activeProcess` happening to change on every call.

**Rejected: `// eslint-disable-line react-hooks/exhaustive-deps`** — this is the
line already carrying that suppression for *other* effects in `ProcessEditor.jsx`
for deliberate reasons (e.g. `:105`, `:121`, `:137`); this warning is different —
it is not a deliberate partial-deps effect, it's a real omission with a
demonstrated failure scenario above. Disabling it would hide the bug rather than
fix it, which conflicts with CLAUDE.md rule 8 ("never swallow errors" / avoid
invisible bugs).

---

## Implementation Steps

1. `App.jsx`: move the `window.__nagelfluh_api = API` line (with its comment) to
   immediately after the last import (`import S3StorageForm from
   './storageProviders/S3StorageForm';`), before `registerHook('dataset_types', ...)`.
2. `ProcessContext.jsx`: add `newProcessToken` to the `contextValue` `useMemo`
   dependency array.
3. Run `npx eslint src/App.jsx src/ProcessContext.jsx` from `frontend/` — confirm
   zero errors/warnings on both files.
4. Manual verification (below).

---

## Verification

- `npx eslint frontend/src/App.jsx frontend/src/ProcessContext.jsx` reports no
  `import/first` errors and no `react-hooks/exhaustive-deps` warning.
- App still boots normally (dataset types, widgets, cluster/storage provider forms
  all still register) — confirms the import reorder in Finding 1 was a no-op.
- In the running app: open an existing process, then click "New Process", type a
  name/select a type, then click "New Process" again *without* selecting another
  process in between — the form now clears on the second click too (previously it
  did not).

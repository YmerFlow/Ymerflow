# Dataset paths break when a process/dataset name contains a dot

## Motivation

Selecting a dataset such as `INV PROPOSAL minimal window (ar 1.0).1.smooth_model` in a
Resistivity Curtain (or any plot layer with an `x-format: datasetPath` field) produces an
empty plot. The process name contains a literal dot (`ar 1.0`), and every consumer of a
dataset path splits on `.` positionally, so the name mis-segments.

Dataset references in plot layers are stored as **dot-joined strings**:

```
current.<dsName>[.<col…>]
<procName>.<version>.<dsName>[.<col…>]
```

The scheme assumes `procName` and `dsName` are dot-free. Real geophysics names aren't
(`ar 1.0`, decimal parameters in names, etc.).

### Where it breaks today

For `"INV PROPOSAL minimal window (ar 1.0).1.smooth_model"`:

- `frontend/src/widgets/PlotView/index.jsx:69,281` — `const [procName, verStr, dsName] = dsPath.split('.')`
  yields `procName="INV PROPOSAL minimal window (ar 1"`, `verStr="0)"`, `dsName="1"`, dropping
  `smooth_model`. The dataset never lazily loads.
- `frontend/src/widgets/PlotView/colorUtils.js:51` — `resolveDataPath` walks the tree via
  `path.split('.').reduce(...)` → indexes wrong keys → `undefined` → curtain gets no
  `flightlines` → empty plot.
- `frontend/src/jsoneditor/DatasetColumnCombobox.jsx:93` and
  `frontend/src/datamodel/processRef.js:16` split the same way.
- gladly-plot's own `Data._resolve` (`node_modules/gladly-plot/src/data/Data.js:153`) splits at
  the **first** dot and recurses through `_children`, so a dotted `_children` key breaks its
  built-in `getData`/`getQuantityKind` too.

## Approach — dot-eliminating encoding, ymerflow-only

Encode the dot **out of** each atomic name segment so the only dots remaining in a path are
true segment boundaries. Then gladly's naive first-dot split always lands on a boundary and
needs no change — the entire fix lives in ymerflow.

A marker escape like `\.` does **not** work: gladly (and our own code) scan for the next `.`
with `indexOf`/`split` and have no notion of an escape char, so the literal dot inside `1\.0`
still splits. The encoded segment must contain **no `.` at all**.

**Encoding:** replace `.` with `,` per segment.

```js
encodeSeg(s) = String(s).replaceAll('.', ',')
```

Chosen over percent-encoding purely for readability (`ar 1,0` vs `ar 1%2E0`). This is a
deliberately lossy substitution: two names differing only by `.` vs `,` would collide. We
accept that risk — such a pair is vanishingly unlikely in practice.

**No decode step.** Because the substitution isn't reversible, we never decode. Wherever a
segment must be matched back to a real object, we **encode the candidate and compare in
encoded space**:

```js
processes.find(p => encodeSeg(p.name) === procNameSeg)
Object.keys(ver.outputs).find(k => encodeSeg(k) === dsNameSeg)
```

**Scope of encoding:** only `procName` and `dsName` segments. Leave alone:
- `version` — always a non-negative integer, dot-free.
- the column tail (`col…`) — column paths are **intentionally** dot-nested (e.g. `grid.x`,
  per the DataGroup `_children` convention). Encoding them would break that nesting. Since
  `procName`/`dsName` are each a single encoded (dot-free) segment, the existing
  `parts.slice(0, 3)` correctly isolates the dataset path and leaves the multi-segment column
  tail as the remainder.

### Contract after the change

- A path is: `encodeSeg(procName) . version . encodeSeg(dsName) [ . col… ]` (or
  `current . encodeSeg(dsName) [ . col… ]`).
- Every data tree (`_children` and the own-property mirror on `dataForPlot`) is keyed by the
  **encoded** segment.
- `resolveDataPath` (colorUtils.js) and gladly's `_resolve` stay **unchanged** — they split
  the encoded path and index encoded keys, always consistent.

## Touch points

A single shared helper, then apply it at the encode boundaries and encoded-compare lookups.

1. **New helper** — `encodeSeg(s)` exported from a small module (e.g.
   `frontend/src/datamodel/datasetPath.js`), imported where needed.

2. **`frontend/src/jsoneditor/DatasetColumnCombobox.jsx`** — `buildOptions`:
   - process mode: `` `${encodeSeg(proc.name)}.${ver.version}` ``
   - dataset mode: `` `current.${encodeSeg(dsName)}` `` and
     `` `${encodeSeg(proc.name)}.${ver.version}.${encodeSeg(dsName)}` ``
   - column mode: `` `current.${encodeSeg(dsName)}.${col}` ``, stub
     `` `${encodeSeg(proc.name)}.${ver.version}.${encodeSeg(dsName)}.<column>` ``
   - `triggerLazyLoad`: after `split('.')`, match `proc`/output key by encoded compare; key
     `lazilyLoadedColumns` by the encoded dsPath.

3. **`frontend/src/widgets/PlotView/index.jsx`**:
   - lazy-load scan (`:59`) and merge (`:281`) — `split('.')` still yields encoded segments;
     resolve `proc`/`ver`/output via encoded compare (`processes.find(p => encodeSeg(p.name) === procName)`,
     `Object.keys(ver.outputs).find(k => encodeSeg(k) === dsName)`); store data under the
     encoded keys in both `dataForPlot[…]` and the `_children` chain.

4. **`frontend/src/datamodel/dataset.js` — `DatasetCollectionAdapter`**:
   - `toDataGroup()` — key children by `encodeSeg(name)`.
   - `columns()` — emit `` `${encodeSeg(name)}.${col}` ``.
   - `getData`/`getQuantityKind`/`_parse` — after splitting the prefix, find the dataset by
     encoded compare (`Object.entries(this._datasets).find(([n]) => encodeSeg(n) === nameSeg)`)
     so encoded prefixes resolve against the raw-keyed `_datasets`.

5. **`frontend/src/datamodel/processRef.js`** — `resolveProcessRef`: match the process by
   `encodeSeg(p.name) === procName`.

6. **`backend/routers/workspaces.py` — MCP path-completion tools** (added during
   implementation). `complete_process_version_path`, `complete_dataset_path`, and
   `complete_column_path` construct the *same* dot-joined paths and are what agents use to
   build workspace layout configs, so they must emit identically-encoded strings. Added a
   Python `_encode_seg(s)` = `str(s).replace('.', ',')` — a byte-for-byte mirror of the JS
   `encodeSeg` — and applied it to every `process.name`/`dataset_name` segment at path
   construction (never to version numbers or the column tail). The backend only ever
   *constructs* paths (frontend resolves them), so no decode side is needed. `_stats_relevant`
   / `_matches` compare against the encoded `ds_path`, consistent with the encoded `prefix` an
   agent types.

## What stays untouched

- **gladly-plot** — no fork, no version bump. It only ever sees internally-consistent encoded
  strings and dot-free keys.
- `resolveDataPath` in `colorUtils.js` — mechanics unchanged.
- Column-path handling / the `grid.x` nested-column convention.

## Visible artifact

Names that actually contain a `.` show a `,` in the stored path and the combobox
(`INV PROPOSAL minimal window (ar 1,0).1.smooth_model`). Version numbers and dot-free names are
unaffected.

## Testing

- Manual: create/select a process whose name contains a dot; add a Resistivity Curtain (2D and
  3D) referencing its output; confirm the curtain renders and axes resolve.
- Regression: confirm dot-free names still work in FlightlinePlot, MagLinePlot, ChannelPlot,
  SoundingPlot/Marker, and the built-in (gladly) layer types.
- Confirm the process/version combobox (`mode='process'`) and `resolveProcessRef` consumers
  still resolve dot-free names.

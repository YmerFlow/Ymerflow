# Filter dataset pickers by target media types

**State:** decided 2026-11-16, ready to implement
**Labels:** enhancement, frontend, jsoneditor, aem-processes, mag-processes
**Repos touched:** main (`frontend/`), `deps/aem-processes`, `deps/mag-processes`

## Motivation

A JSON Schema dataset field (`"x-format": "dataset"`) renders a `DatasetSelector`
that lists **every** completed dataset in the project; a PlotView layer's
`dataset` field (`"x-format": "datasetPath"`) renders a `DatasetColumnCombobox`
that lists every process-scoped dataset path. Neither knows what kind of dataset
the field wants, so nothing stops a user from feeding a raw AEM data file to a
field that needs a resistivity model, or a MagData line set to a field that needs
a gridded field.

This plan lets a schema field (process param **or** plot layer) declare which
media types the referenced dataset's root part must expose, and makes both picker
widgets hide datasets that do not qualify. To make the filter meaningful for AEM —
where raw data and inverted models are today the *same* media type — it also
splits the AEM XYZ media type into data vs model, and the MAG webxtile media type
into equiv-source-grid vs 3D-model.

## What exists

### The two picker widgets (different code paths)

- **Process params** → `frontend/src/jsoneditor/CustomStringField.jsx:34-59`
  matches `x-format: "dataset"` and renders `DatasetSelector` from an inline
  `ui:widget` wrapper that forwards only `id/value/onChange/required` — **not
  `schema`** (lines 47-52). `DatasetSelector`
  (`frontend/src/jsoneditor/DatasetSelector.jsx`) searches the dataset API via
  `useSearchDatasets(debouncedSearch, true, currentProject)` (lines 21-25) and
  groups results for display (`getDisplayItems`, lines 88-133). No mime filter.
- **PlotView layer `dataset` fields** → `CustomStringField.jsx:23-31` matches
  `x-format: "datasetPath"` and renders `DatasetPathField` →
  `DatasetColumnCombobox` (`mode="dataset"`,
  `frontend/src/jsoneditor/DatasetColumnCombobox.jsx:42-56`), which lists
  process-scoped paths (`current.<ds>`, `<proc>.<ver>.<ds>`) from `ProcessContext`
  with no type check. Layer schemas flow through the **same** editor
  (`CustomForm.jsx`) and the same `CustomStringField` dispatcher as process
  params; only the `x-format` value differs.

### Dataset object shape (how we read available formats)

Backend `Dataset.to_dict()` (`backend/models/dataset.py:61-71`) returns
`mime_type` (primary) and `parts`. The **root part's** file formats are:
- New format: `parts.files` — a `{ mime_type → url }` map; keys are the media types.
- Old format: `parts[""].mime_type` — a single media type.

`Dataset.url` (`backend/models/dataset.py:49-59`) resolves the primary file via
`parts.files[self.mime_type]`, so **the top-level `mime_type` must be a key in
`parts.files`** — a hard constraint for the mime split (both move together).

### Mime landscape today

| Output | Media type | Written where |
|---|---|---|
| AEM raw data, processed data, **inverted models, synthetics** — all | `application/x-aarhusxyz-msgpack` | `deps/aem-processes/.../dataset_utils.py:212` (top-level) + files-map keys `:151`, `:193` (hardcoded) |
| AEM gridded (`grid_tem`) | `application/x-webxtile` | `deps/aem-processes/.../gridding_process.py:830` |
| MAG line data (import **and** process) | `application/x-magdata-msgpack` | `deps/mag-processes/.../dataset_utils.py:247` + files key `:170-175` |
| MAG equiv-source grid **and** 3D model | `application/x-webxtile` | `deps/mag-processes/.../dataset_utils.py:320` + files key `:313-316` |

- The backend is a pass-through: `backend/models/process.py:1383` reads
  `info['mime_type']` and stores it unchanged on the `Dataset` row
  (`backend/models/dataset.py:14`). No sniffing. So the mime is decided entirely
  process-side, in the two `dataset_utils.py` writers.
- Model-consuming processes (`Forward`, `Gridding`, `CompareModels`) read their
  input as a **URL** (`kwargs.get('input_model')` → `.../root.msgpack`, e.g.
  `forward_process.py:79,107-110`), *not* a `files[mime]` lookup — so the mime
  split does **not** touch their read path (the URL still resolves because
  top-level mime and files key move together).

### Data-vs-model is detectable (ALC naming standard)

After normalization everything is in the ALC naming standard, so an inverted
resistivity model has exactly one canonical marker: `layer_data["resistivity"]`
(`deps/libaarhusxyz/libaarhusxyz/normalizer.py:203`, `xyz.py:449`; the normalizer
maps `{"Res": "resistivity"}`). Raw/processed TEM data and synthetic responses
never carry it (they carry gate channels). So the writer test is exactly
`"resistivity" in xyz.layer_data` → model, else data.

### Frontend mime → class mapping (what the split must register)

- Hardcoded factory `frontend/src/datamodel/dataset.js:1024-1035`:
  `application/x-aarhusxyz-msgpack → XyzDataset`,
  `application/x-magdata-msgpack → MagDataset`, `application/json → JsonDataset`,
  else plugin registry → fallback `Dataset`.
- Plugin hook `frontend/src/App.jsx:69-73` registers the same three plus
  `application/x-webxtile → WebxtileDataset`.
- Display names `frontend/src/widgets/Export.jsx:10-11`.

## Decisions (settled with user 2026-11-16)

1. **Schema key:** `x-target-mediatypes`. Used in **both** process-param schemas
   (`x-format: "dataset"`) and PlotView layer schemas (`x-format: "datasetPath"`).
2. **Grammar — OR of ANDs:**
   - A flat list of strings `["a", "b"]` is a single AND group (dataset must expose
     **all** of them in its root part).
   - A list of lists `[["a", "b"], ["c"]]` is an **OR** between groups, AND within
     each group. A dataset passes if **any** sublist is fully satisfied.
3. **Root-part media types only:** keys of `parts.files` (new) / `parts[""].mime_type`
   (old). Top-level `dataset.mime_type` is not separately consulted (it is already a
   key in `parts.files`).
4. **Filtering is client-side** in both widgets, over data each already has. No
   backend/endpoint change.
5. **Absent/empty key → list everything** (opt-in, backward compatible).
6. **AEM mime split:** new `application/x-aarhusxyz-model-msgpack` for inverted
   resistivity models. Chosen over a parameterized `…-msgpack;kind=model` because
   every mime check in the codebase is raw `===` / exact dict-key lookup (incl.
   `parts.files[mime_type]`); a parameter would force media-type-aware parsing at
   every match site and risk the files-key/mime drifting apart.
   - **Assignment: structural**, in the writer: `"resistivity" in xyz.layer_data`
     → model mime, else data mime. Synthetics and difference outputs are handled
     automatically (synthetics have no resistivity layer → data; a comparison
     *difference model* has one → model).
7. **MAG mime split:** `application/x-mag-grid-webxtile` (equiv-source grid) and
   `application/x-mag-model-webxtile` (3D susceptibility model). Generic
   `application/x-webxtile` stays for AEM `grid_tem`. **Assignment: explicit at the
   call site** (the mag process knows which it writes) — `write_webxtile_dataset`
   takes a `mime_type` argument.
8. **Frontend classes:** reuse existing — model mime → `XyzDataset`; both new mag
   mimes → `WebxtileDataset`. Mime drives only filter labels + factory dispatch;
   behavior is unchanged.
9. **Legacy datasets:** pre-split models/grids carry the old generic mime. Model-
   and grid-typed fields accept **new OR legacy** (an OR group for each), so
   existing datasets stay selectable.

## Design

### A. Matching helper (shared)

Add a small pure helper (e.g. `frontend/src/jsoneditor/mediatypeMatch.js`):

```js
// Root-part media types a dataset exposes.
export function rootPartMediatypes(ds) {
  const parts = ds.parts || {};
  if (parts.files) return Object.keys(parts.files);            // new format
  if (parts[""] && parts[""].mime_type) return [parts[""].mime_type]; // old format
  return [];
}

// Normalize x-target-mediatypes to a list of AND-groups (OR between groups).
function normalizeGroups(spec) {
  if (!spec || spec.length === 0) return null;                 // no constraint
  return Array.isArray(spec[0]) ? spec : [spec];               // flat → single group
}

// True if ds satisfies the constraint (any group fully matched).
export function datasetMatchesMediatypes(ds, spec) {
  const groups = normalizeGroups(spec);
  if (!groups) return true;
  const available = new Set(rootPartMediatypes(ds));
  return groups.some(group => group.every(mt => available.has(mt)));
}
```

### B. Process-param widget — `DatasetSelector`

- `CustomStringField.jsx:47-52`: add
  `targetMediatypes={schema['x-target-mediatypes']}` to the `<DatasetSelector>`
  wrapper (`schema` is already destructured at line 9).
- `DatasetSelector.jsx`: accept `targetMediatypes`; filter the searched array
  through `datasetMatchesMediatypes` before `getDisplayItems()` (line 88). Empty
  spec → unchanged. The "No datasets found" empty state already covers a fully
  filtered list.

### C. Layer widget — `DatasetPathField` / `DatasetColumnCombobox`

- `CustomStringField.jsx:23-31`: forward `schema['x-target-mediatypes']` into
  `DatasetPathField`.
- `DatasetPathField` → `DatasetColumnCombobox` (`DatasetColumnCombobox.jsx:42-56`):
  accept the constraint and filter the listed dataset paths by the matching
  dataset object's root-part media types (the dataset objects are available from
  `ProcessContext`). Empty spec → unchanged.

### D. AEM mime split (process side, `deps/aem-processes`)

`aem_processes/dataset_utils.py`:
- In `DatasetWriter.__init__`, compute the msgpack mime once:
  `self.msgpack_mime = "application/x-aarhusxyz-model-msgpack" if ("resistivity" in
  getattr(xyz, "layer_data", {})) else "application/x-aarhusxyz-msgpack"`.
- Use `self.msgpack_mime` in place of the hardcoded literal at the files-map keys
  (`:151`, `:193`) **and** the top-level `info["mime_type"]` (`:212`) — so key and
  top-level stay identical (required by `Dataset.url`).
- `compare_process.py`'s `ComparisonWriter(DatasetWriter)` inherits this
  automatically (its difference output has a `resistivity` layer → model mime).
- Synthetics (`forward`, inversion `*_synthetic`) have no resistivity layer → data
  mime, unchanged.

### E. MAG mime split (process side, `deps/mag-processes`)

`mag_processes/dataset_utils.py` `write_webxtile_dataset(...)`:
- Add a `mime_type` parameter; use it for both the files-map key (`:313-316`) and
  the top-level `info["mime_type"]` (`:320`).
- `equiv_source_process.py:161` passes `application/x-mag-grid-webxtile`.
- `inversion_3d_process.py:169` passes `application/x-mag-model-webxtile`.

### F. Frontend mime registration (new mimes → existing classes)

- `App.jsx:69-73` hook: add
  `{ mimeType: 'application/x-aarhusxyz-model-msgpack', cls: XyzDataset }`,
  `{ mimeType: 'application/x-mag-grid-webxtile', cls: WebxtileDataset }`,
  `{ mimeType: 'application/x-mag-model-webxtile', cls: WebxtileDataset }`.
- `dataset.js:1024-1035` `createDatasetInstance`: add the model-mime branch →
  `XyzDataset` (the two mag mimes resolve via the plugin registry fallback, so no
  hardcoded branch needed, but add them if matching the existing explicit style).
- `Export.jsx:10-11`: add display names ("AEM resistivity model (msgpack)",
  "Magnetic grid (webxtile)", "Magnetic 3D model (webxtile)").

### G. Field & layer assignments

**AEM process fields** (`deps/aem-processes`):

| Process.field | `x-target-mediatypes` |
|---|---|
| `Processing.input_data` (data) | `["application/x-aarhusxyz-msgpack"]` |
| `Inversion.input_data` (processed data) | `["application/x-aarhusxyz-msgpack"]` |
| `ApplyManualEdits.input` (data) | `["application/x-aarhusxyz-msgpack"]` |
| `YFProcessTEM.input_data`, `YFQCTEM.input_data` (`_PipelineProcess`) | `["application/x-aarhusxyz-msgpack"]` |
| `Forward.input_model` (model) | `[["application/x-aarhusxyz-model-msgpack"], ["application/x-aarhusxyz-msgpack"]]` |
| `Gridding.input_model` (model) | `[["application/x-aarhusxyz-model-msgpack"], ["application/x-aarhusxyz-msgpack"]]` |
| `CompareModels.input_model_a` / `input_model_b` (model) | `[["application/x-aarhusxyz-model-msgpack"], ["application/x-aarhusxyz-msgpack"]]` |
| `Gridding.dtm` (GeoTIFF raster) | out of scope unless the DTM dataset's mime is known; leave unconstrained for now |

**MAG process fields** (`deps/mag-processes`):

| Process.field | `x-target-mediatypes` |
|---|---|
| `MagProcessing.input_data` | `["application/x-magdata-msgpack"]` |
| `MagEquivSource.input_data` (processed mag) | `["application/x-magdata-msgpack"]` |
| `MagInversion3D.input_data` (grid) | `[["application/x-mag-grid-webxtile"], ["application/x-webxtile"]]` |

**PlotView layer schemas** (`frontend/src/widgets/PlotView/elements/`), on the
`dataset` property (next to `'x-format': 'datasetPath'`):

| Layer | `x-target-mediatypes` |
|---|---|
| `MagLinePlot` | `["application/x-magdata-msgpack"]` |
| `ChannelPlot`, `SoundingPlot`, `GateAnomalyPlot`, `SoundingMarker` (gated AEM data) | `["application/x-aarhusxyz-msgpack"]` |
| `SoundingResistivityPlot`, `ResistivityCurtain` (2D/3D/Lines, via `_commonSchemaProperties`) | `[["application/x-aarhusxyz-model-msgpack"], ["application/x-aarhusxyz-msgpack"]]` |
| `FlightlinePlot` (positions exist in both data & model) | `[["application/x-aarhusxyz-msgpack"], ["application/x-aarhusxyz-model-msgpack"]]` |
| `GridLayer` | no `dataset` field (expression refs) — skip |

## Backward compatibility & caveats

- **Legacy models stay selectable** in model/grid fields via the OR legacy group.
- **Data fields still accept legacy models:** a pre-split model carries the data
  mime, so `["application/x-aarhusxyz-msgpack"]` matches it. This is unavoidable
  without a backfill and is no worse than today (which matches everything). *New*
  models are correctly excluded from data fields.
- **URL resolution stays intact:** top-level mime and `parts.files` key move
  together, so `Dataset.url` and the URL-based process read paths are unaffected.
- **Stale-deps:** the runner image builds `libaarhusxyz` and the process packages
  from GitHub master, while `deps/` clones may diverge
  ([[libaarhusxyz_stale_deps_trap]], [[sdk_checkout_stale_deps_trap]]). Before
  editing, fetch and diff `dataset_utils.py` (both repos) and the `resistivity`
  detection against `origin/master`, edit against master, and push — a local-only
  edit won't reach the runner.

## Testing

Manual, against a project with mixed datasets (raw AEM import, inverted model,
processed mag, equiv-source grid):
1. Field with no `x-target-mediatypes` lists everything (unchanged).
2. A data field (`["…-msgpack"]`) hides *new* models; a model field hides raw data
   and keeps models (new and legacy).
3. OR-of-ANDs: a `[["a","b"],["c"]]` field matches datasets exposing a+b, or c.
4. Mag 3D-inversion field lists equiv-source grids (new and legacy webxtile), not
   MagData line sets.
5. PlotView: a ResistivityCurtain layer's dataset picker lists only models; a
   MagLinePlot picker lists only MagData.
6. An existing stored value on a now-filtered-out dataset still renders its label
   (label path uses `getDataset`, independent of the search list).
7. Re-run an inversion after the split → its model output carries the new model
   mime; its synthetic output carries the data mime.

## Files touched

**main repo (`frontend/`):**
- `src/jsoneditor/mediatypeMatch.js` — new shared helper.
- `src/jsoneditor/CustomStringField.jsx` — forward `x-target-mediatypes` to both widgets.
- `src/jsoneditor/DatasetSelector.jsx` — accept prop, filter.
- `src/jsoneditor/DatasetPathField.jsx` + `DatasetColumnCombobox.jsx` — accept prop, filter.
- `src/App.jsx` — register new mimes → existing classes.
- `src/datamodel/dataset.js` — factory branch for model mime.
- `src/widgets/Export.jsx` — display names.
- `src/widgets/PlotView/elements/*.js` — `x-target-mediatypes` on layer `dataset` fields.

**`deps/aem-processes`:**
- `aem_processes/dataset_utils.py` — structural data/model mime.
- `aem_processes/{processing,inversion,forward,gridding,compare,apply_manual_edits,yf_processing}_process.py` — `x-target-mediatypes` on dataset fields.

**`deps/mag-processes`:**
- `mag_processes/dataset_utils.py` — `mime_type` arg on `write_webxtile_dataset`.
- `mag_processes/{equiv_source,inversion_3d}_process.py` — pass new mimes.
- `mag_processes/{processing,equiv_source,inversion_3d}_process.py` — `x-target-mediatypes` on dataset fields.

No backend, migration, or dependency-version changes.

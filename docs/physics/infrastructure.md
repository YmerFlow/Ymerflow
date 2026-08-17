# Common Infrastructure

Documents shared infrastructure components used by all scientific pipelines in YmerFlow.

## Sensitivity Matrix Caching

Both magnetic inversion systems use a hash-keyed caching mechanism to avoid recomputing the sensitivity (Jacobian) matrix when the survey geometry and parameters are unchanged.

### Algorithm

**Source**: [`sensitivity_cache.py`](https://github.com/SagebrushGeoTools/simplemag/blob/master/mag_inversion/sensitivity_cache.py) (simplemag)

```python
sensitivity_hash(receiver_locations, field_params, mesh_params, model_type) → SHA-256 hex string
```

The hash is computed from:
- Receiver 3D locations (array of x, y, z coordinates)
- Earth field (B₀ intensity, inclination, declination)
- Mesh parameters (cell size, padding, depth, refinement levels)
- Model type (scalar/vector)

### Storage

Two modes:
1. **`"disk"`** (default for both systems): Sensitivity matrix G is computed once, written to `sensitivity_path/<hash>/` as `.npy` files, and memory-mapped during inversion. Enables large surveys (>few GB).
2. **`"ram"`**: Full G in memory — fastest but memory-bound.
3. **`"forward_only"`**: Never cache (recompute each `Jvec` product) — slowest.

### Blob Storage Sync

The process wrappers (`equiv_source_process.py`, `inversion_3d_process.py`) sync the hash-keyed sensitivity directories to/from blob storage:
- **Download** before inversion: Any existing cached G for this geometry is retrieved
- **Upload** after inversion: Updated G is persisted for future runs

This enables efficient iterative refinement — the expensive sensitivity computation is a one-time cost per survey geometry.

## Data Formats

### msgpack (Primary AEM data container)

AEM data flows as **msgpack**-serialized `libaarhusxyz.XYZ` objects. The format embeds:
- `flightlines`: DataFrame of per-sounding attributes (position, altitude, tilt, current)
- `layer_data`: Dict of per-gate DataFrames (Gate, InUse, STD, relErr)
- `model_info`: Metadata (gate times, projection, scalefactor)
- `layer_params`: Layer geometry (dep_top, dep_bot) for model data

The `libaarhusxyz.export.msgpack` module handles serialization/deserialization. The format supports numpy arrays efficiently via msgpack-numpy.

### webxtile (Gridded output format)

Both AEM gridding and magnetic inversion outputs use **webxtile** — a tiled format designed for WebGL rendering (used by the gladly frontend). An xarray Dataset is partitioned into tiles along spatial dimensions, enabling progressive loading and client-side visualization without downloading the full volume.

### MagData (Magnetics container)

`AirMagTools.MagData` wraps a pandas DataFrame with:
- MultiIndex: `(line, fidcount)`
- Columns: easting, northing, gpsalt, magcom, diurnal, surface, utctime, flight
- `meta` dict: CRS, field parameters, sample frequency

Persisted via `pandas.to_pickle()`.

## Entry Point Registration

The project uses Python's `importlib.metadata` entry points for plugin-like registration of all process types, system descriptions, and processing steps:

```python
# setup.py or pyproject.toml
[entry_points]
ymerflow.process_types =
    import = aem_processes.aem_processes.import_process:Import
    processing = aem_processes.aem_processes.processing_process:Processing
    inversion = aem_processes.aem_processes.inversion_process:Inversion
    forward = aem_processes.aem_processes.forward_process:Forward
    gridding = aem_processes.aem_processes.gridding_process:Gridding
    mag_import = mag_processes.mag_processes.import_process:MagImport
    mag_processing = mag_processes.mag_processes.processing_process:MagProcessing
    mag_equiv_source = mag_processes.mag_processes.equiv_source_process:MagEquivSource
    mag_inversion_3d = mag_processes.mag_processes.inversion_3d_process:MagInversion3D

simpeg.static_instrument =
    SingleMomentTEMXYZSystem = simpeg.electromagnetics.utils.static_instrument.single:SingleMomentTEMXYZSystem
    DualMomentTEMXYZSystem = simpeg.electromagnetics.utils.static_instrument.dual:DualMomentTEMXYZSystem

emeraldprocessing.pipeline_step =
    correct_altitude_and_topo = emeraldprocessing.tem.corrections:correct_altitude_and_topo
    cull_roll_pitch_alt = emeraldprocessing.tem.culling:cull_roll_pitch_alt
    moving_average_filter = emeraldprocessing.tem.corrections:moving_average_filter
    ...

mag_pipeline.filters =
    set_constants = AirMagTools.magfilters:set_constants
    diurnal_qc_for_15s_chord = AirMagTools.magfilters:diurnal_qc_for_15s_chord
    noise_qc = AirMagTools.magfilters:noise_qc
    ...

ymerflow.mag_equiv_source_systems =
    MagEquivalentSourceSystem = mag_inversion.equivalent_source:MagEquivalentSourceSystem

ymerflow.mag_inversion_3d_systems =
    MagInversion3DSystem = mag_inversion.full_3d:MagInversion3DSystem
```

### swaggerspect Schema Generation

The `swaggerspect` library dynamically generates JSON Schemas by introspecting entry-point groups. For process types that have variable parameters (system descriptions, processing steps), the schema is built at runtime:

```python
# Inversion schema: reads simpeg.static_instrument entry points
schema["properties"]["system"] = swaggerspect.swagger_to_json_schema(
    swaggerspect.get_apis("simpeg.static_instrument"),
    multi=False
)

# Processing schema: reads emeraldprocessing.pipeline_step entry points
schema["properties"]["steps"] = swaggerspect.swagger_to_json_schema(
    swaggerspect.get_apis("emeraldprocessing.pipeline_step"),
    multi=True
)
```

This enables the frontend to auto-generate configuration forms from the available system descriptions and processing steps without hardcoding any UI.

## Dataset Writing Utilities

**Source**: `docker/base-runner/aem_processes/dataset_utils.py`

The `write_dataset()` function handles:
1. Creating a UUID-based dataset directory under the process's storage path
2. Writing msgpack, GeoJSON, XYZ, and differential msgpack representations
3. Writing a `info.json` manifest with MIME types and file references

The magnetic pipeline uses `write_webxtile_dataset()` for gridded outputs, which writes the xarray Dataset as webxtile tiles and creates the dataset manifest.

# Mag Inversion with SimPEG: Equivalent Source + Full 3D

## Overview of the Two-Stage Approach

For airborne mag (TMI data), the standard workflow is:

**Stage 1 — Equivalent Source (gridding/leveling)**
Invert TMI data for effective dipoles/charges distributed on a thin flat horizontal layer positioned
just below the lowest flight altitude. This gives you:
- Gridded magnetic data at any arbitrary elevation (upward/downward continuation)
- 3-component (Bx, By, Bz) fields from TMI-only input
- Removal of terrain and altitude variation effects
- A predictable, noise-reduced dataset for Stage 2

**Stage 2 — Full 3D Inversion**
Invert the gridded/continued data for a 3D susceptibility model.

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Equivalent source layer geometry | Flat (horizontal), TensorMesh | Simple; sufficient for most surveys |
| 3D inversion mesh | OcTree (TreeMesh) | 5–10× fewer cells than tensor at same resolution |
| Model type (inversion type) | Parameter: `scalar` / `vector` / `amplitude` | All three exposed |
| Sensitivity storage | `store_sensitivities="disk"` | Handles large surveys without RAM limit |
| Sensitivity caching | Hash-based filename in `sensitivity_path` | Reuse G across runs with same mesh/survey |
| Library structure | Standalone [simplemag](https://github.com/SagebrushGeoTools/simplemag) library | Usable/testable outside YmerFlow |
| SimPEG exposure | All parameters exposed as class attributes | Follows AEM XYZSystem pattern exactly |

---

## Comparison with AEM Inversion Architecture

The existing AEM pipeline (`XYZSystem` / `Simulation1DLayeredStitched`) works sounding-by-sounding
— 1D physics at each location. Magnetics is fundamentally different:

| Aspect | AEM (1D stitched) | Mag Equivalent Source | Mag Full 3D |
|--------|-------------------|-----------------------|-------------|
| **Physics domain** | 1D per sounding | 2D (horizontal layer) | 3D volume |
| **Sensitivity matrix** | Block-diagonal; never formed globally | Dense `(nD × nC_layer)` | Dense `(nD × nC_volume)` |
| **Independence** | Soundings largely independent | All data points see all cells | All data points see all cells |
| **Nonlinearity** | Moderately nonlinear | Linear (χ) or quasi-linear (amplitude) | Linear (χ) |
| **Solver** | Sparse factorization per sounding | Dense matrix multiply `G*m` | Dense `G*m` |
| **Memory strategy** | Small matrices; parallel per sounding | `store_sensitivities="disk"` + memmap | `store_sensitivities="disk"` or Dask |

---

## Stage 1: Equivalent Source — Details

**What it is:** A thin flat horizontal layer of dipoles (susceptibility model) that reproduces
the observed TMI. Forward operator `G` is linear and fixed — straightforward linear inversion.

**SimPEG implementation:**
```python
from SimPEG.potential_fields import magnetics
from discretize import TensorMesh

# Thin layer mesh: 1 cell thick, flat at `layer_depth` below min flight altitude
mesh = TensorMesh([hx, hy, [dz]], origin=[x0, y0, z_layer])

sim = magnetics.simulation.Simulation3DIntegral(
    mesh=mesh,
    survey=survey,
    chiMap=IdentityMap(),
    actInd=np.ones(mesh.nC, dtype=bool),
    store_sensitivities="disk",
    sensitivity_path="./sensitivity_cache/{hash}/",
)
```

**Regularization:** `regularization.Tikhonov` with `alpha_z=0` (no vertical, single layer).

**What you get out:** Use forward operator to predict Bx, By, Bz, TMI on regular grid at uniform
output altitude. This is the input to Stage 2.

---

## Stage 2: Full 3D Inversion — Details

**What it is:** Invert gridded Bx/By/Bz (or TMI) for a 3D susceptibility distribution.
Amplitude data is preferable if remanent magnetization is present.

**SimPEG implementation:**
```python
from discretize import TreeMesh

# OcTree mesh refined near surface and observations
mesh = mesh_builder_xyz(receiver_locs, [cs, cs, cs], ...)
mesh = refine_tree_xyz(mesh, topo, method='surface', ...)
mesh = refine_tree_xyz(mesh, receiver_locs, method='radial', ...)

sim = magnetics.simulation.Simulation3DIntegral(
    mesh=mesh,
    survey=survey,
    chiMap=IdentityMap(),
    actInd=active_cells,
    store_sensitivities="disk",
    sensitivity_path="./sensitivity_3d_cache/{hash}/",
    model_type="scalar",           # or "vector" for MVI
    is_amplitude_data=False,       # True for amplitude inversion
)
```

**Regularization:** `regularization.Tikhonov` with full x/y/z smoothness.

---

## Sensitivity Matrix Caching Strategy

The sensitivity matrix `G` (shape `nD × nC`) is expensive to compute and independent of
regularization. It depends only on: receiver locations, mesh geometry, Earth field parameters,
and model type. We cache by hashing these.

**Hash ingredients:**
- SHA-256 of receiver location array bytes
- Field parameters (intensity, inclination, declination)
- Mesh parameters (cell size, layer depth, padding, etc.)
- Model type (scalar vs vector)
- NOT: regularization parameters, optimizer settings

**Cache location:** `{sensitivity_path}/{16-char-hash}/sensitivity.npy`

SimPEG already skips recomputation when the file exists with matching shape. So pointing
`sensitivity_path` at a hash-based subdirectory achieves reuse automatically.

**Blob storage workflow:**
1. Compute hash; set `sensitivity_path` to local NVMe temp dir / `{hash}`
2. Check if `{storage_base}/sensitivity_cache/{hash}/sensitivity.npy` exists in blob
3. If yes, download to local temp path before running inversion
4. After inversion, upload local `.npy` to blob for future runs
5. This is wired up in the YmerFlow process layer (not the system library)

**Memory sizing:**
```
Memory (GB) = nD × nC × 4 bytes / 1e9
```
- Equiv source, 50 m spacing, 50 km² survey: ~50k data × ~10k cells = ~2 GB (fits in RAM even)
- Full 3D OcTree, same survey: ~50k data × ~500k cells = ~100 GB → disk essential

---

## Strategic Decisions

**model_type parameter:**
- `"scalar"` — induced magnetization only, model = susceptibility χ (SI)
- `"vector"` — MVI: arbitrary magnetization, model = (Mx, My, Mz) per cell, input: Bx/By/Bz
- `"amplitude"` — scalar model but data = |B| (remanence-insensitive), input: Bx/By/Bz from equiv source

**OcTree mesh:**
- Refinement levels near observations and surface: `mesh__octree_levels_obs`, `mesh__octree_levels_surf`
- Core cell size drives the base resolution
- Depth of core region: `mesh__depth_core`
- Horizontal/vertical padding: `mesh__max_distance`

**Regularization:**
- L2 (Tikhonov) is the default and always runs
- IRLS (sparse, `Update_IRLS`) is optional and runs after L2 convergence
- `UpdateSensitivityWeights` corrects depth-dependent resolution loss in 3D

**Topography:**
- Equivalent source: flat — not relevant since layer is above terrain
- Full 3D: active cells below topography surface; topography passed as Nx3 array or xarray

---

## Library Structure

```
simplemag/  (https://github.com/SagebrushGeoTools/simplemag)
├── setup.py                    # Package + entry points for nagelfluh.mag_inversion_systems
├── mag_inversion/
│   ├── __init__.py             # Exports MagEquivalentSourceSystem, MagInversion3DSystem
│   ├── equivalent_source.py   # MagEquivalentSourceSystem (TensorMesh, flat layer)
│   ├── full_3d.py             # MagInversion3DSystem (OcTree, scalar/vector/amplitude)
│   ├── directives.py          # ReportingDirective (same pattern as AEM)
│   └── sensitivity_cache.py   # Hash computation utility
└── examples/
    └── mag_inversion_example.ipynb   # Synthetic data demo: equiv source → 3D
```

The process types (in `mag_processes`) import from this library and wrap it with YmerFlow
process schema/run/storage patterns.

---

## Proposed Process Chain

```
MagData (raw flight data)
  └─► MagImport          → normalized MagData msgpack
        └─► MagProcessing    → leveled/corrected MagData
              └─► MagEquivSource  → equivalent source model
                                    + gridded Bx/By/Bz/TMI at uniform altitude (webxtile)
                    └─► MagInversion3D  → 3D susceptibility/magnetization (webxtile 3D)
```

Both inversion processes expose a `system` JSON schema (parallel to AEM `inversion_process.py`),
populated from `nagelfluh.mag_inversion_systems` entry points. This allows dropping in alternative
system implementations without code changes.

---

## Implementation Plan

### Phase 1 — Library ([simplemag](https://github.com/SagebrushGeoTools/simplemag))

- [x] `setup.py` with entry points
- [x] `mag_inversion/directives.py` — `ReportingDirective`
- [x] `mag_inversion/sensitivity_cache.py` — `sensitivity_hash()` utility
- [x] `mag_inversion/equivalent_source.py` — `MagEquivalentSourceSystem`
  - All config as class attributes (model_type, field params, mesh, reg, optimizer, IRLS, sensitivity)
  - `make_survey()`, `make_mesh()`, `make_simulation()`, `make_misfit()`, `make_regularization()`
  - `make_directives()`, `make_optimizer()`, `make_inversion()`
  - `invert()` → `(model, mesh, sim)`
  - `predict_on_grid(model, mesh, sim)` → `{comp: 2D array}` on regular grid
  - `to_xarray(model, mesh, sim)` → `xr.Dataset` (for webxtile output)
  - `run()` → full pipeline
- [x] `mag_inversion/full_3d.py` — `MagInversion3DSystem`
  - Input: `xr.Dataset` (from webxtile equiv source output)
  - All config as class attributes (model_type, field, mesh, topo, reg, optimizer, IRLS, sensitivity)
  - Same `make_*` structure as above
  - `to_xarray(model, mesh, active_cells)` → 3D `xr.Dataset` (scatter + regular grid for webxtile)
  - `run()` → full pipeline
- [x] `examples/mag_inversion_example.ipynb` — synthetic prism test

### Phase 2 — YmerFlow Process Types (`docker/base-runner/mag_processes/`)

- [ ] `mag_processes/equiv_source_process.py` — `MagEquivSource` process class
  - Schema: input MagData URL, system config, sensitivity blob storage options
  - Run: localize URL, load MagData, instantiate system, download/upload G cache, run, write webxtile
- [ ] `mag_processes/inversion_3d_process.py` — `MagInversion3D` process class
  - Schema: input webxtile URL, system config, sensitivity blob storage options
  - Run: load webxtile, instantiate system, download/upload G cache, run, write 3D webxtile
- [ ] Update `setup.py` with new entry points

---

## SimPEG Key Classes Reference

- `SimPEG.potential_fields.magnetics.simulation.Simulation3DIntegral`
  - `store_sensitivities`: `"disk"`, `"ram"`, `"forward_only"`
  - `sensitivity_path`: directory string (must end with `/`)
  - `model_type`: `"scalar"` or `"vector"`
  - `is_amplitude_data`: bool (for amplitude inversion)
  - `actInd`: bool array of active cells
- `SimPEG.potential_fields.magnetics.receivers.Point`
  - `components`: list from `["tmi", "bx", "by", "bz", "bxx", "bxy", "bxz", "byy", "byz", "bzz"]`
- `SimPEG.potential_fields.magnetics.sources.SourceField`
  - `parameters`: `[intensity_nT, inclination_deg, declination_deg]`
- `SimPEG.regularization.Tikhonov`
  - `alpha_s`, `alpha_x`, `alpha_y`, `alpha_z`
  - `indActive`: active cell boolean array
  - `mapping`, `mref`
- `SimPEG.directives.Update_IRLS` — sparse regularization
- `SimPEG.directives.UpdateSensitivityWeights` — depth weighting for 3D
- `SimPEG.directives.UpdatePreconditioner` — preconditioning for IRLS
- `discretize.TensorMesh` — for equivalent source (flat layer)
- `discretize.TreeMesh` + `discretize.utils.mesh_builder_xyz` + `refine_tree_xyz` — for 3D OcTree

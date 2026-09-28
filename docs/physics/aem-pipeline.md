# AEM Data Processing

Documents the processing steps in `docker/base-runner/aem_processes/processing_process.py` and the underlying [emerald-processing-em](https://github.com/YmerFlow/emerald-processing-em) library.

## Overview

Processing is orchestrated by the `Processing` process class (`processing_process.py`), which loads data in msgpack format, creates an `emeraldprocessing.pipeline.ProcessingData` instance, and applies a configurable sequence of steps via `ProcessingData.process(steps)`. Each step is a function registered under the `emeraldprocessing.pipeline_step` entry-point group.

## Data Model

Data is stored in a `libaarhusxyz.XYZ` object (the `data.xyz` attribute of `ProcessingData`) with:
- **`flightlines`**: DataFrame indexed by sounding, with columns for position (UTMX, UTMY), altitude (TxAltitude), topography, tilt (TxRoll, TxPitch), transmitter current, etc.
- **`layer_data`**: Dict of DataFrames, each with one column per time-gate:
  - `Gate_Ch##` — measured dB/dt values (V/(A·m⁴))
  - `InUse_Ch##` — boolean mask (1=active, 0=culled)
  - `STD_Ch##` — relative standard deviation (fraction of signal)

## Corrections

### Altitude and Topography Correction

**Source**: `corrections.py:correct_altitude_and_topo()`

Resamples flight altitude and surface topography from a Digital Terrain Model (DTM) GeoTIFF. Steps:

1. Sample DTM at each sounding's (x, y) position using the survey CRS
2. Compute new topography from DTM: `topo_new = DEM(x, y)`
3. Compute new transmitter altitude: `alt_new = Tx_z - topo_new` where `Tx_z` is transmitter source elevation (from TXZ column or `topo_orig + alt_orig`)
4. Store original values as `orig_Topography`, `orig_TxAltitude`, and differences as `o_d_diff_*`

Used to replace erroneous flight GPS altitudes with terrain-corrected values derived from a high-resolution DTM.

### Tilt Correction

**Source**: `corrections.py:correct_data_tilt_for1D()`

Corrects data amplitudes for the horizontal component of the transmitter dipole moment when the transmitter is tilted. For a 1D earth assumption, only the vertical component of the dipole contributes to the measured response. The correction factor is:

```
corrected_data = data / (cos(TxRoll) · cos(TxPitch))²
```

Original tilt values are saved as `TxRoll_orig`/`TxPitch_orig` and the working values are set to zero (effectively rotating the data to an untilted reference frame). The `assume_horizontal_transmitter()` step can be used before this when tilt measurements are unreliable.

**References**: Auken et al. (2009) — the SkyTEM processing scheme uses this same tilt correction for 1D inversion.

### Moving Average Filter

**Source**: `corrections.py:moving_average_filter()`

A line-by-line rolling window averaging filter with gate-dependent window widths (trapezoid: linearly varying from `width_at_first_gate` to `width_at_last_gate`). Three averaging methods:

1. **SST (Sum-of-Squares-Total)**: Uses `rolling_SST_mean_df()` — a variance-based averaging that accounts for per-datum uncertainties. Outputs a weighted mean and consistent uncertainty estimate.

2. **Hybrid** (default): Alpha-trimmed mean followed by inverse-variance weighting. More robust to outliers and handles NaN regions near culled data better than pure SST.

3. **Simple**: Straight rolling mean with STD from unweighted standard error of the mean.

The `min_valid_fraction` parameter controls how much of the window must contain valid data to produce an output (default 0.35, matching Aarhus Workbench practice).

## Data Culling

All culling functions operate by setting the `InUse_Ch##` flags to 0 for disabled data. Data with `InUse == 0` is excluded from the inversion.

### Roll, Pitch, and Altitude Limits

**Source**: `culling.py:cull_roll_pitch_alt()`

Disables all gates of a sounding when transmitter roll, pitch, or altitude exceed specified thresholds:

```
inuse[i, :] = 0  if |roll| > max_roll OR |pitch| > max_pitch
                 OR alt > max_alt OR alt < min_alt
```

### Geometry Proximity

**Source**: `culling.py:cull_on_geometry()`

Disables gates based on proximity to infrastructure (power lines, pipelines, etc.) defined in a shapefile. Uses per-moment gate-dependent safety distances with linear interpolation between first-gate and last-gate distances:

```
For each gate g in moment m:
    safety_dist[g] = interpolate([first_gate, last_gate],
                                  [dist_first_gate, dist_last_gate])[g]
    inuse[i, g] = 0  if distance(i, infrastructure) < safety_dist[g]
```

### STD Threshold

**Source**: `culling.py:cull_std_threshold()`

Disables gates where the relative STD exceeds a threshold (after a specified first gate to evaluate):

```
inuse[i, g] = 0  if STD_Ch##[i, g] > threshold, for g >= first_gate
```

### Negative Data

**Source**: `culling.py:cull_negative_data()`

Disables gates with negative dB/dt values (unphysical late-time noise) after a specified first gate:

```
inuse[i, g] = 0  if Gate_Ch##[i, g] < 0, for g >= first_gate
```

### Transient Slope Thresholds

**Source**: `culling.py:cull_max_slope()`, `cull_min_slope()`

Slope is the log-log derivative of the transient decay:

```
slope = d(log₁₀(Gate)) / d(log₁₀(t))
```

Physical interpretation:
- Half-space response: slope = -2.5 (t⁻⁵/² decay)
- Background noise: slope ≈ -0.5 (t⁻¹/²)
- Steeper slope (< -2.5): higher resistivity
- Shallower slope (> -2.5): higher conductivity

Gates are disabled where slope exceeds `max_slope` or falls below `min_slope`.

### Transient Curvature Thresholds

**Source**: `culling.py:cull_max_curvature()`, `cull_min_curvature()`

Second-order derivative using central finite differences:

```
curvature_k = (x_{k+1} - 2·x_k + x_{k-1}) / (t_{k+1} - t_{k-1})²
```
where x = log₁₀(Gate), t = log₁₀(gate_time).

Interpretation:
- Positive curvature: decreasing decay rate → transition to conductive layer
- Negative curvature: increasing decay rate → transition to resistive layer
- Near-zero: homogeneous half-space

### Sounding Tail Culling

**Source**: `culling.py:cull_sounding_tails()`

After any gate is disabled by a per-gate culling filter, all later gates in that sounding are also disabled. This implements the standard Aarhus Workbench "disable tails" behaviour.

### Too Few Gates

**Source**: `culling.py:cull_soundings_with_too_few_gates()`

Disables an entire sounding if it has fewer than `min_number_of_gates` active gates remaining after other culling.

## Noise Model

**Source**: `corrections.py:add_replace_gex_std_error()`

Replaces STD values with a parametric noise model combining:

1. **Uniform relative noise**: From GEX `UniformDataSTD` (default ~3%)
2. **Time-dependent noise floor**: `noise_level_1ms × (t × 1000)^(noise_exponent) / dipole_moment`
3. **Quadrature combination**: `STD = sqrt(abs_frac² + relative_frac²)` where `abs_frac = N_abs / |signal|`

The noise floor at 1ms (in V/m²) accounts for system noise characteristics, with empirical values for SkyTEM 304:
- Low moment (Ch1): ~5×10⁻¹⁰ V/m²
- High moment (Ch2): ~1.5×10⁻⁹ V/m²

## Entry Points

The step contract, the runner and how each step reports what it did are described in [Pipelines](../architecture/pipelines.md). All processing steps are registered as:
```
emeraldprocessing.pipeline_step:
    - correct_altitude_and_topo = emeraldprocessing.tem.corrections:correct_altitude_and_topo
    - cull_roll_pitch_alt = emeraldprocessing.tem.culling:cull_roll_pitch_alt
    - moving_average_filter = emeraldprocessing.tem.corrections:moving_average_filter
    ...
```

## Key Source Files

- `docker/base-runner/aem_processes/processing_process.py` — Process wrapper
- [`emeraldprocessing/pipeline/__init__.py`](https://github.com/YmerFlow/emerald-processing-em/blob/master/emeraldprocessing/pipeline/__init__.py) — ProcessingData class
- [`emeraldprocessing/tem/corrections.py`](https://github.com/YmerFlow/emerald-processing-em/blob/master/emeraldprocessing/tem/corrections.py) — Altitude, tilt, moving average, noise model
- [`emeraldprocessing/tem/culling.py`](https://github.com/YmerFlow/emerald-processing-em/blob/master/emeraldprocessing/tem/culling.py) — All culling filters
- [`emeraldprocessing/tem/utils.py`](https://github.com/YmerFlow/emerald-processing-em/blob/master/emeraldprocessing/tem/utils.py) — Slope/curvature calculation, DEM sampling, noise model generation

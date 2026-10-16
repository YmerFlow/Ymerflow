# Magnetics Processing

Documents the magnetic QC and processing pipeline in `docker/base-runner/mag_processes/processing_process.py` and the underlying [AirMagTools](https://github.com/SagebrushGeoTools/AirMagTools) library.

## Overview

The magnetics processing pipeline applies configurable QC filters to airborne magnetic survey data. Filters are registered under the `mag_pipeline.filters` entry-point group and orchestrated by `AirMagTools.pipeline.MagPipeline`.

## Data Model

Data is stored in `AirMagTools.MagData` objects, which wrap a **pandas DataFrame** indexed by `(line, fidcount)` with columns for:
- Position: `easting`, `northing` (projected, metres)
- Altitude: `gpsalt` (GPS altitude), `surface` (drape surface)
- Magnetic field: `magcom` (compensated total magnetic intensity), `diurnal` (base station)
- Time: `utctime`
- Metadata: `flight`, `line`

The `MagData.meta` dict contains survey metadata including earth field parameters, CRS, and sample frequency.

## QC Filters

### 4th Difference Noise

**Source**: `magfilters.py:fourth_difference()`, `noise_qc()`

The GSC standard symmetric 4th difference formula:

```
δ⁴M_i = M_{i-2} - 4·M_{i-1} + 6·M_i - 4·M_{i+1} + M_{i+2}
```

This is a high-pass filter that suppresses long-wavelength signals and amplifies high-frequency noise. The threshold for "out of spec" (oos) is typically ±0.01 nT for survey production data (±0.05 nT for the comparison channel).

The `noise_qc()` filter:
1. Computes 4th difference per flight line
2. Creates an `mag_4th_diff_oos` mask where `|4th_diff| > threshold`
3. Writes `magcom_2nd` and `magcom_4th` channels

**Reference**: Geological Survey of Canada (GSC) airborne magnetic QC standards.

### Diurnal Chord Analysis

**Source**: `magfilters.py:diurnal_qc_for_15s_chord()`, `diurnal_qc_for_60s_chord()`

Detects periods of high geomagnetic activity (solar storms) by comparing the diurnal magnetometer reading to interpolated "chord" lines.

**15-second chord**:
```
l_magD_15 = diurnal[t]  where floor(utctime/15) × 15 = floor(utctime × 10) / 10
chrd_Lmag15 = interpolate(l_magD_15)  # linear interpolation
l_magdiff15 = diurnal - chrd_Lmag15
oos_15 = |l_magdiff15| > 0.5 nT
```

**60-second chord**:
```
l_magD_60 = diurnal[t]  where floor(utctime/60) × 60 = floor(utctime × 10) / 10
chrd_Lmag60 = interpolate(l_magD_60)
l_magdiff60 = diurnal - chrd_Lmag60
oos_60 = |l_magdiff60| > 3 nT
```

Larger diurnal variations indicate solar storms that corrupt the magnetic survey data.

### Drape Analysis

**Source**: `magfilters.py:drape_and_speed_qc()`, `auto_drape_analysis()`

Identifies flight segments where the aircraft deviates from the specified drape surface by more than the vertical tolerance for more than the along-track distance tolerance.

**Per-line calculations**:
```
step_distance = √((easting_{i-1} - easting_i)² + (northing_{i-1} - northing_i)²)
speed = step_distance / (utctime_i - utctime_{i-1})
drape_deviation = gpsalt - surface
```

**Out-of-spec detection** (defaults: 15 m vertical tolerance, 800 m along-track)::
1. Mark all points where `|drape_deviation| > 15 m`
2. Find contiguous segments of marked points
3. If segment distance > 800 m, record as out-of-spec (including max/average deviation, average speed, fiducial range)

### Butterworth Filters

**Source**: `magfilters.py:lowpass_filter_butterworth()`, `highpass_filter_butterworth()`, `bandpass_filter_butterworth()`

Applies a 4th-order Butterworth filter with configurable cutoff frequency using `scipy.signal.filtfilt` (forward-backward for zero phase delay):

```
b, a = butter(order=4, Wn=cutoff_freq/nyquist, btype=btype)
filtered = filtfilt(b, a, data)
```

Per-line application grouped by `line` index level.

### Downline Distance

**Source**: `magfilters.py:downline_distance()`

Cumulative along-track distance from the start of each flight line:

```
distance[i] = Σ_{j=1}^{i} √((easting_j - easting_{j-1})² + (northing_j - northing_{j-1})²)
```

### Elevation and Surface Error

**Source**: `magfilters.py:elevation()`, `surface_error()`

- `elevation = gpsalt - dtm` — absolute elevation above a DTM
- `surface_error = gpsalt - surface` — deviation from the survey drape surface

## Pipeline Orchestration

The `MagPipeline` class (`pipeline.py`) loads filter functions from `mag_pipeline.filters` entry points and runs them as a sequence. Each filter receives `(pipeline, data)` and modifies `data.data` (the DataFrame) in place. The general pattern — pipeline document, entry-point registry, step contract, and the log / step report / statistics output channels — is in [Pipelines](../architecture/pipelines.md).

## Key Source Files

- `docker/base-runner/mag_processes/processing_process.py` — Process wrapper
- [`AirMagTools/magdata.py`](https://github.com/SagebrushGeoTools/AirMagTools/blob/main/AirMagTools/magdata.py) — MagData class
- [`AirMagTools/magfilters.py`](https://github.com/SagebrushGeoTools/AirMagTools/blob/main/AirMagTools/magfilters.py) — All QC filter implementations
- [`AirMagTools/pipeline.py`](https://github.com/SagebrushGeoTools/AirMagTools/blob/main/AirMagTools/pipeline.py) — MagPipeline orchestration

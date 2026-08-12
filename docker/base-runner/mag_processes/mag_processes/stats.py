"""Pre-computed statistics for MAG datasets."""

import math
import numpy as np

STATS_MIME = "application/vnd.ymerflow.stats+json"

_SIG_FIGS = 6


def _round(x):
    """Round a float to _SIG_FIGS significant figures."""
    if x is None or not math.isfinite(x) or x == 0:
        return x
    magnitude = math.floor(math.log10(abs(x)))
    factor = 10 ** (_SIG_FIGS - 1 - magnitude)
    return round(x * factor) / factor


def _skewness(a):
    n = len(a)
    if n < 3:
        return None
    mean = np.mean(a)
    std = np.std(a, ddof=0)
    if std == 0:
        return 0.0
    return float(np.mean(((a - mean) / std) ** 3))


def _kurtosis(a):
    n = len(a)
    if n < 4:
        return None
    mean = np.mean(a)
    std = np.std(a, ddof=0)
    if std == 0:
        return 0.0
    return float(np.mean(((a - mean) / std) ** 4) - 3.0)


def compute_column_stats(arr):
    """Compute statistics for a numeric array, ignoring NaN values."""
    a = np.asarray(arr, dtype=np.float64).ravel()
    finite = a[np.isfinite(a)]
    if len(finite) == 0:
        return {"count": 0}

    std = float(np.std(finite, ddof=1)) if len(finite) > 1 else 0.0
    positive = finite[finite > 0]
    geometric_mean = float(np.exp(np.mean(np.log(positive)))) if len(positive) > 0 else None
    rms = float(np.sqrt(np.mean(finite ** 2)))

    return {
        "count": int(len(finite)),
        "min": _round(float(np.min(finite))),
        "max": _round(float(np.max(finite))),
        "mean": _round(float(np.mean(finite))),
        "rms": _round(rms),
        "geometric_mean": _round(geometric_mean),
        "std": _round(std),
        "p5": _round(float(np.percentile(finite, 5))),
        "p25": _round(float(np.percentile(finite, 25))),
        "p50": _round(float(np.percentile(finite, 50))),
        "p75": _round(float(np.percentile(finite, 75))),
        "p95": _round(float(np.percentile(finite, 95))),
        "skewness": _round(_skewness(finite)),
        "kurtosis": _round(_kurtosis(finite)),
    }


def _collapse_if_uniform(arr):
    """Replace a list with a scalar if all non-null values are identical."""
    non_null = [v for v in arr if v is not None]
    if non_null and len(set(non_null)) == 1:
        return non_null[0]
    return arr


def compute_mag_stats(mag_data):
    """Compute statistics for a MAG dataset."""
    df = mag_data.data.reset_index()

    stats = {
        "line_count": len(df["line"].unique()) if "line" in df.columns else 1,
        "total_soundings": len(df),
    }

    crs = mag_data.meta.get("crs")
    if crs is not None:
        stats["crs"] = str(crs)

    columns_stats = {}
    for col in df.columns:
        try:
            s = df[col]
            if hasattr(s, "dtype") and s.dtype.kind in ("f", "i", "u"):
                finite = s.values[np.isfinite(s.values.astype(np.float64))]
                if len(finite) > 0 and float(np.max(finite)) == float(np.min(finite)):
                    columns_stats[col] = {"constant": True, "value": _round(float(finite[0]))}
                else:
                    columns_stats[col] = compute_column_stats(s.values)
        except Exception:
            pass
    stats["columns"] = columns_stats

    return stats


def compute_grid_stats(ds):
    """Compute statistics for an xarray grid Dataset."""
    stats = {}

    if "epsg_code" in ds.attrs:
        stats["crs"] = f"EPSG:{ds.attrs['epsg_code']}"
    if "z_crs" in ds.attrs:
        stats["z_crs"] = ds.attrs["z_crs"]

    stats["dims"] = {dim: int(size) for dim, size in ds.dims.items()}

    coords_out = {}
    for name, coord in ds.coords.items():
        vals = coord.values
        coords_out[name] = [_round(float(v)) for v in vals.ravel()] if vals.size <= 1000 else None
    stats["coords"] = coords_out

    variables_stats = {}
    for var_name in ds.data_vars:
        arr = np.asarray(ds[var_name].values, dtype=np.float64)
        var_stats = {"all": compute_column_stats(arr.ravel())}
        if arr.ndim >= 3:
            per_slice = [compute_column_stats(arr[..., i].ravel()) for i in range(arr.shape[-1])]
            stat_keys = list(per_slice[0].keys()) if per_slice else []
            slices = {k: [s.get(k) for s in per_slice] for k in stat_keys}
            var_stats["slices"] = {k: _collapse_if_uniform(v) for k, v in slices.items()}
        variables_stats[var_name] = var_stats
    stats["variables"] = variables_stats

    return stats

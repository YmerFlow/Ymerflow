# Detect real CPU availability for parallel forward simulations

## Goal

Right-size the multiprocessing pool used by SimPEG's stitched 1D forward simulations to the
CPU the pod is *actually* allowed to use, instead of the whole node's core count.

Today `simulation__n_cpu` (default `3`) is passed straight through to
`tdem.Simulation1DLayeredStitched(n_cpu=...)`, which eventually calls `Pool(self.n_cpu)`. The two
"auto" paths are both broken for our Kubernetes jobs:

- `n_cpu=None` → `Pool(None)` → Python uses `os.cpu_count()`, which reports the **node's** total
  logical cores, ignoring the pod's CFS CPU quota. On a big node this forks dozens of workers
  against a small quota → heavy CFS throttling + per-worker memory blow-up (OOM risk). Note also
  that SimPEG's own `base_1d.py` only auto-detects when `n_cpu is None` **and** `verbose` is True
  (the `cpu_count()` call is nested under `if self.verbose:`), so in non-verbose runs `None` reaches
  `Pool(None)` unmodified.
- `n_cpu=0` → `Pool(0)` → `ValueError: Number of processes must be at least 1` (hard crash). `0` is
  never interpreted as "auto" anywhere.

Belts-and-suspenders fix, in two independently-versioned repos:

1. **Backend (Nagelfluh)** — the job pod already runs with `limits == requests`
   (`job_orchestrator.py:154-156`), so the CPU/memory limit is known at job-creation time. Expose it
   to the pod as `CPU_LIMIT` and `RAM_LIMIT` env vars.
2. **SimPEG fork (`deps/simpeg`, `git@github.com:redhog/simpeg.git`)** — add
   `detect_cpu_availability()` and use it whenever `simulation__n_cpu` is `None` **or** `0`.

## Design decisions (agreed with user)

- **`CPU_LIMIT` format:** whole cores as a **decimal string**, e.g. `"3.5"`. This cannot come from
  the K8s Downward API (`resourceFieldRef` only emits integers and rounds fractional cores *up*), so
  the **backend sets the value itself** by parsing the known CPU request into cores. `RAM_LIMIT`
  likewise set by the backend.
- **`RAM_LIMIT` role:** *just exposed* for now, as **raw bytes (integer string)**, e.g.
  `"8589934592"` for `8Gi`. `detect_cpu_availability()` stays CPU-only; nothing consumes `RAM_LIMIT`
  yet (it's there for a future memory-aware worker cap).
- **Empty `CPU_LIMIT` falls through:** a present-but-empty (or whitespace-only) `CPU_LIMIT` is treated
  the same as absent — it falls through to cgroup detection. Only a present, non-empty, non-numeric
  value is a real misconfiguration and raises.
- **Detection precedence (in `detect_cpu_availability`):**
  `os.environ["CPU_LIMIT"]` → cgroup CFS quota → `os.cpu_count()`.
- **Both `None` and `0`** for `simulation__n_cpu` trigger detection. Any positive value is used
  verbatim (explicit override always wins).
- **Result is always a usable pool size:** an integer `>= 1` (so `Pool(n)` never raises). Fractional
  cores are floored (`3.5 → 3`), with a floor of 1.

## Current state

- `deps/simpeg/.../static_instrument/base.py:393` — `simulation__n_cpu = 3`; `make_simulation()`
  (lines 395-414) passes `n_cpu=self.simulation__n_cpu` to both the Pardiso and default-solver
  `Simulation1DLayeredStitched(...)` constructions. `os` is already imported at the top of the file.
- `deps/simpeg/.../static_instrument/utils.py` — sibling module, natural home for the helper.
- `deps/simpeg/.../electromagnetics/base_1d.py:587-650` — stores `n_cpu`, only auto-detects on
  `None` under `verbose` (see Goal). We do **not** modify SimPEG core; static_instrument resolves the
  effective value before it ever reaches here.
- `deps/simpeg/.../time_domain/simulation_1d.py:545,584,623,683` (+ FDEM equivalents) — `Pool(self.n_cpu)`.
- `backend/services/job_orchestrator.py:60-69` — `env_vars` list; `:154-157` — container `resources`
  with `requests=limits=resource_requests`. `resource_requests` is a dict like
  `{"cpu": "2000m", "memory": "8Gi"}` or `None` (falls back to K8s namespace defaults).
- `backend/services/k8s_client.py:19-25` — existing `_parse_cpu_cores(value)` helper
  (`"2000m" → 2.0`, `"4" → 4.0`) to reuse for the decimal conversion.

## Change

### 1. SimPEG fork — `static_instrument/utils.py`: add `detect_cpu_availability()`

```python
import os

def detect_cpu_availability():
    """Return the number of CPUs this process may actually use, as an int >= 1.

    Precedence: CPU_LIMIT env var (decimal cores, e.g. "3.5") -> cgroup CFS quota
    (v2 cpu.max, then v1 cfs_quota_us/cfs_period_us) -> os.cpu_count(). Fractional
    core counts are floored; the result is clamped to a minimum of 1 so Pool() never
    raises. Set by the Kubernetes job launcher (limits == requests) so parallel
    forward simulations size their process pool to the pod's real quota, not the
    whole node's core count.
    """
    # 1. Explicit env var from the pod launcher (authoritative).
    #    Absent OR empty/whitespace-only -> fall through (not an error).
    raw = os.environ.get("CPU_LIMIT")
    if raw and raw.strip():
        cores = float(raw)          # non-empty but non-numeric should surface, not be swallowed
        if cores >= 1:
            return int(cores)       # floor; >=1 guaranteed
        return 1

    # 2. cgroup CFS quota
    #    v2: /sys/fs/cgroup/cpu.max  -> "<quota> <period>" or "max <period>"
    try:
        with open("/sys/fs/cgroup/cpu.max") as f:
            quota, period = f.read().split()
        if quota != "max":
            cores = int(quota) / int(period)
            return max(1, int(cores))
    except FileNotFoundError:
        #    v1: cpu.cfs_quota_us / cpu.cfs_period_us  (quota == -1 means unlimited)
        try:
            with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as f:
                quota = int(f.read())
            with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as f:
                period = int(f.read())
            if quota > 0 and period > 0:
                return max(1, int(quota / period))
        except FileNotFoundError:
            pass

    # 3. Fallback: node core count (last resort — over-counts under a CFS quota)
    return os.cpu_count() or 1
```

Notes:
- Per repo rule 8 (never swallow errors): a *present, non-empty, non-numeric* `CPU_LIMIT` raises
  `ValueError` from `float()` — that's a real misconfiguration and should surface. *Absence*, an
  *empty/whitespace-only* value, or a missing cgroup file is normal control flow (caught / guarded),
  not an error, and falls through to the next detection layer.
- cgroup reads guard against the "max"/`-1` unlimited sentinels (fall through to `os.cpu_count()`).

### 2. SimPEG fork — `static_instrument/base.py`: use it for `None` and `0`

- Add import near the top (matching the file's absolute-import style):
  ```python
  from SimPEG.electromagnetics.utils.static_instrument.utils import detect_cpu_availability
  ```
  (or relative `from .utils import detect_cpu_availability` — pick whichever matches the sibling
  imports already used in this package).
- In `make_simulation()`, resolve the effective value once before constructing the simulation:
  ```python
  n_cpu = self.simulation__n_cpu
  if n_cpu is None or n_cpu == 0:
      n_cpu = detect_cpu_availability()
  ```
  and pass `n_cpu=n_cpu` in both `Simulation1DLayeredStitched(...)` calls (Pardiso + default).
- Update the `simulation__n_cpu` docstring (line 394) to document that `None`/`0` mean "auto-detect
  from the pod's CPU limit (CPU_LIMIT env / cgroup / node count)".

### 3. Backend — `job_orchestrator.py`: export `CPU_LIMIT` / `RAM_LIMIT`

- Reuse `_parse_cpu_cores` from `k8s_client.py` to turn the CPU request into a decimal-cores string.
- `RAM_LIMIT` must be **integer bytes**, so it needs a bytes parser. `k8s_client.py` only has
  `_parse_memory_gb` (returns GB float — lossy), so add a `_parse_memory_bytes(value)` helper there
  (handling the K8s binary suffixes `Ki/Mi/Gi/Ti/Pi/Ei`, decimal `k/M/G/T/P/E`, and plain byte
  counts) and export it alongside `_parse_cpu_cores`.
- After the base `env_vars` list is built (around line 69), when `resource_requests` is present:
  ```python
  from backend.services.k8s_client import _parse_cpu_cores, _parse_memory_bytes
  if resource_requests:
      cpu = resource_requests.get("cpu")
      if cpu:
          env_vars.append(client.V1EnvVar(
              name="CPU_LIMIT", value=str(_parse_cpu_cores(str(cpu)))))
      mem = resource_requests.get("memory")
      if mem:
          env_vars.append(client.V1EnvVar(
              name="RAM_LIMIT", value=str(_parse_memory_bytes(str(mem)))))
  ```
  - `CPU_LIMIT` is decimal cores (e.g. `"3.5"`) — the format `detect_cpu_availability()` expects.
  - `RAM_LIMIT` is integer bytes (e.g. `"8589934592"` for `8Gi`), exposed for future use (no
    consumer yet).
  - When `resource_requests` is `None` the vars are omitted; the pod falls back to cgroup detection,
    which is exactly the belts-and-suspenders second layer.

## Rollout / ordering

The two repos ship independently, and the change is safe in either order:
- Backend-first: `CPU_LIMIT` is set but nothing reads it until the SimPEG bump lands (harmless).
- SimPEG-first: `detect_cpu_availability()` finds no `CPU_LIMIT`, falls through to cgroup detection
  (already correct for CFS quotas) — strictly better than today even before the backend change.

The runner image must be rebuilt (`docker/build.sh`) with the updated SimPEG fork for the
static_instrument change to take effect in pods.

## Verification

- Unit-test `detect_cpu_availability()` with: `CPU_LIMIT="3.5"` → 3; `CPU_LIMIT="1"` → 1;
  `CPU_LIMIT="0.5"` → 1; unset + monkeypatched cgroup v2 `cpu.max="200000 100000"` → 2;
  unset + no cgroup → `os.cpu_count()`.
- In a running inversion pod, confirm the logged pool size / `Pool(n)` matches the pod's CPU limit,
  not the node core count.
- Confirm `simulation__n_cpu = 0` no longer raises `ValueError`.

## Out of scope

- Memory-aware worker capping (using `RAM_LIMIT` to bound pool size by per-worker RAM). `RAM_LIMIT`
  is only *exposed* here.
- Any change to SimPEG core (`base_1d.py` / `simulation_1d.py`).

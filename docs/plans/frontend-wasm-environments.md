# Front-end (WebAssembly) Environments — Plan

## Goal

Let some process types run **in the user's browser** via WebAssembly (Pyodide) instead of as a
Kubernetes Docker job. For light, non-geo, non-inversion processing (data import/transform/filter on
`libaarhusxyz` + pandas/numpy/scipy) this is:

- **Faster** — no queue wait, no pod spin-up, no image pull; result is visible on the client the
  instant it finishes computing, before anything is persisted.
- **Free** — the compute runs on the client, not on a billed cluster node.

The output is still persisted as a **normal process output**: the same `Dataset` rows, the same
`processes/{id}/{version}/datasets/*/info.json` storage layout, reachable by every other consumer
(plots, downloads, downstream processes) exactly as a K8s-run output would be. The only difference is
*where the Python ran* and that the client already has the data in hand before the server confirms it.

The Python that runs in the browser is the **same process-type code** (`process_class.run(storage_context,
**params)`) — no per-process browser port. Only the *environment* differs: its runtime is a Pyodide
wheel bundle instead of a Docker image, with the dependency limits that implies (see Feasibility).

## Feasibility — which process types can run in WASM (verified against real deps)

| Package | Deps | Verdict |
|---|---|---|
| `libaarhusxyz` | numpy, pandas, matplotlib, msgpack-numpy | **WASM-feasible** — all Pyodide-provided or pure-python |
| `emerald-processing-em` | scipy (ok), **geopandas** (GDAL/Fiona) | Feasible **only** for the geopandas-free filter subset |
| `aem-processes` | numpy, pandas, scipy, utm, **SimPEG** | **No** — SimPEG is heavy/native; inversion stays server-side |

So the initial WASM-runnable slice is exactly the "smaller/less complex processing" from the brief:
import/transform/filter steps on `libaarhusxyz` + pandas/numpy/scipy. Inversion and geo-filters remain
Docker/K8s environments. An environment simply *is or isn't* WASM; whether a given process type fits is
decided when its environment is built (its dep closure must be Pyodide-satisfiable), not at run time.

**Widening the slice:** the buildable subset can be grown by making heavy, browser-hostile dependencies
**optional extras** in the process packages. E.g. move `geopandas` in `emerald-processing-em` to an
`extras_require` group so the base install (and the filters that don't touch it) is Pyodide-satisfiable;
only the geo-dependent filters pull the extra and stay Docker-only. This is a cheap, incremental way to
migrate more process types into WASM environments over time without an all-or-nothing dep split.

**Note on packaging effort (MVP):** our own process packages are **pure-Python**, and numpy/scipy/pandas
already ship *inside* Pyodide (C-compiled-to-wasm, loaded from the Pyodide distribution — not rebuilt). So
the first images require **no emscripten cross-compile**: the build just assembles the pinned Pyodide
runtime + our packages + a bootstrap entrypoint into one self-contained Emscripten image (see §2). Much
lighter than the Docker/kaniko build. Cross-compiling *new* C extensions to wasm is a later, harder step
the image format already accommodates (D7).

## Decisions (agreed with operator)

- **D1 — Output bytes reach storage via a backend proxy, not direct-to-storage.** The browser POSTs each
  produced file to a new authenticated endpoint that writes it into the process-version's `datasets/`
  layout (backend holds the storage credentials). No bucket CORS, no storage credentials in the browser,
  no s3fs-in-Pyodide. Reuses the existing streaming upload machinery (`backend/routers/uploads.py`
  `_stream_upload`). Justified by the premise: WASM handles *small* datasets, so proxying bytes is fine.
- **D2 — WASM environments are built by a build-job analog of `create_environment`.** Symmetric with the
  Docker model: a `create_wasm_environment` process type builds a Pyodide wheel bundle, stores it, and
  writes an `environment.json` (carrying `wasm_image_url` instead of `docker_image`) that the backend's
  existing `_create_outputs` handoff picks up to register the Environment row. A bootstrap hand-registration path
  (mirroring `docker/update_bootstrap_environment.py`) stands up the first WASM environment before the
  build process itself is usable.
- **D3 — State model: create → RUNNING → DONE, browser-driven.** A WASM version is created (`QUEUED`),
  immediately driven to `RUNNING` by the browser, then flipped to `DONE` with outputs once uploads
  complete. The node appears in the flow graph while computing. If the tab closes mid-run the version
  stays `RUNNING` until the user retries (there is no job to monitor — accepted; an optional
  heartbeat/timeout is future work).
- **D4 — Runtime is *derived* from which image field is set — no stored discriminator column.** A new
  nullable `wasm_image_url` (the wheel bundle in storage) sits alongside `docker_image` (relaxed to
  nullable). Exactly one is non-null per environment: `docker_image` set ⇒ Kubernetes, `wasm_image_url`
  set ⇒ WASM. A computed `runtime` property (`"wasm"` if `wasm_image_url` else `"kubernetes"`) is exposed
  in `to_dict()` for frontend convenience but is **not** a column — nothing to backfill, no way for the
  flag to drift out of sync with the actual image. The frontend reads `runtime`/`wasm_image_url` to decide
  "run in-browser" vs "submit to K8s" — transparent to the user, who just picks an environment as today.
- **D5 — Dataset registration reuses `_create_outputs` unchanged.** The browser lands files (including each
  dataset's `info.json`) in the exact `processes/{id}/{version}/datasets/` layout, then calls a `complete`
  endpoint that runs the **existing** storage-scan registration. Byte-identical result shape to a K8s run.
- **D6 — Storage I/O is bridged through the image's own Emscripten virtual FS.** The process code is
  unmodified: it does `fsspec.open("{storage_base}/...")` as always, with `storage_base` pointing at a
  directory inside the image's FS (a local path, not remote storage). The generic harness reaches that
  same FS from JS via Emscripten's `Module.FS`: it (a) pre-stages input dataset bytes into it before the
  entrypoint runs, and (b) reads the produced `datasets/` tree out of it after the entrypoint exits and
  uploads each file per D1. This keeps the browser off direct storage while leaving process code identical
  to the server path, and needs no Python-side `memory://` the JS side can't see.
- **D7 — A WASM image is a self-contained Emscripten build output, run once per process by a generic,
  Python-agnostic harness — the Docker model, with Emscripten (not WASI) as the substrate.**
  `wasm_image_url` points at one self-contained image = an Emscripten build output: `wasm` + **its own JS
  glue** + optional packed FS/data + a small manifest (entrypoint + args). It is opaque to the backend,
  the Environment model, and the upload/state endpoints — they only move the URL, never look inside.
  - **The runtime is not a shared singleton and there is no "loader kind" / per-image dispatch.** There is
    no monolithic Emscripten VM (unlike WASI's `wasmtime`); an Emscripten module carries its own glue. So
    the "runtime" is: the browser's wasm engine + **the glue the image itself ships**, orchestrated by one
    thin generic **per-run harness** we write. The harness never mentions Python.
  - **Execution contract (mirrors the pod runner exactly):** per process run the harness spawns a fresh
    Web Worker, instantiates the image's Emscripten module using the image's own glue, feeds input via the
    same convention `runner.py` already uses (env vars in — `PROCESS_TYPE`, `PARAMETERS_JSON`,
    `STORAGE_BASE`, …; output files written to a known FS path; stdout = logs; exit code = status), runs
    the entrypoint, collects outputs, and tears the worker down. This env/FS convention is the image ABI
    (like Docker's env/argv/mounts/exit-code) — universal across images, **not** a per-image switch.
  - **Pyodide is just what a Python image contains.** A Python image's entrypoint is a tiny bootstrap that
    boots Pyodide *inside the image* and runs `ymerflow_runner` — identical to today's `runner.py`. The
    packages (pure-Python code **and** C-extension packages — Pyodide runs C-compiled-to-wasm, e.g. numpy/
    scipy/pandas, and later emscripten-cross-compiled wheels; there is no pure-python restriction) live
    inside the image. A future **non-Python** Emscripten image honors the same ABI with **zero platform
    change and no Pyodide** — that is the real forward-compat property (emscripten cross-compilation and
    other image contents are deliberately not built now, just not precluded).
  - **Isolation is per-process** — a fresh Emscripten instance per run, no shared-interpreter state
    leakage, matching Docker's one-container-per-job semantics.
  - **Cold-start mitigation — a two-tier strategy, part of the design (not deferred):** a naive fresh boot
    per run re-instantiates ~9MB of CPython wasm and reloads stdlib + numpy/scipy/pandas each time —
    approximate, highly variable: interpreter ready ~3–5s cold / ~1–2s warm, **first meaningful process
    line ~5–15s cold / ~2–5s warm** once scipy/pandas load. So instead:
    - **Tier 1 (always on): wasm module compile-cache.** The ~9MB core module is compiled once and reused,
      not recompiled per run.
    - **Tier 2 (optional, capability-gated): a per-image memory snapshot, taken once after boot and before
      the entrypoint runs.** On an image's *first* run the harness boots it fully (glue → Pyodide →
      packages/modules loaded) and, at the post-boot / pre-entrypoint point (the state that is *identical
      across every run of that image, before any per-run input is applied*), captures a **memory snapshot
      cached for that image**. Every *subsequent* run **restores that snapshot into a fresh instance — a
      memory copy — and jumps straight to the entrypoint**, skipping boot and package load entirely.
    - **Both caches persist in IndexedDB, keyed by `(image id + runtime version)`, so they survive browser
      restart** — even the *first run after a restart* is fast, not just the first of a session. Both
      artifacts are binary blobs: the memory snapshot is a plain `ArrayBuffer` (trivially IDB-storable);
      the compiled wasm `Module` is structured-cloneable and IDB-storable in major browsers (feature-detect;
      safe fallback = store the raw wasm bytes in IDB/Cache API, which still skips re-download). Request
      `navigator.storage.persist()` to resist eviction; the `(image id + runtime version)` key guarantees a
      rebuilt image never restores a stale snapshot/module. **Caveat — snapshot size:** with numpy/scipy/
      pandas loaded a snapshot is tens-to-low-hundreds of MB, so it is subject to storage **quota +
      eviction** (the compiled module is far smaller). On a cache miss/eviction the harness just falls back
      to a full boot — never a failure.
    - **Isolation is preserved by Tier 2**, not sacrificed: each run gets its own fresh copy of the
      snapshot heap, so nothing leaks between runs. This is strictly better than reusing a live worker
      (which would leak state) — the snapshot *is* the per-run-isolation-compatible warm start.
    - **Graceful degradation (layered):** feature-detect at harness start. Best case → restore a
      persisted snapshot from IDB (skip boot). No snapshot support, or snapshot evicted → compile-cache-only
      (Tier 1: persisted compiled module or raw bytes from IDB, boot per run but no recompile/redownload).
      Nothing in IDB (first ever run / cleared storage) → full cold boot, then populate the caches. Never a
      hard failure — the caches are a speed-up, not a correctness dependency.
    - **Net:** an image's very first run (ever, or after storage is cleared) pays full cold start (~5–15s);
      every run after — *including across browser restarts* — is ≈a memory copy + the entrypoint
      (sub-second to low-seconds) with isolation intact. Even the fully-degraded path still beats K8s
      (queue + pod schedule + image pull is 10–60s+). Numbers approximate; the spike (risk #1) measures
      ours.
- **D8 — Front-end processes run on the virtual cluster `frontend`: no resources, no cost, any plan.** A
  WASM environment forces the process onto a seeded virtual `Cluster` named `frontend` (a distinct
  `cluster_type`, no real k8s connection). A `frontend`-cluster version has **no cpu/ram configuration**
  (`resource_requests` empty, resource/node-capacity validation skipped) and is **always zero-cost
  regardless of the user's plan** — the balance pre-check and completion billing are bypassed entirely
  (the browser burns the user's own compute, not a billed node). `get_allowed_clusters` always includes
  `frontend`. The editor hides cluster/resource controls when a WASM environment is selected.

## Background — blast radius (confirmed by reading the code)

### Execution today (what we branch off)
- `Process.create_queued` (`backend/models/process.py:185`) creates a `ProcessVersion` in `QUEUED` and
  `asyncio.create_task(version_obj.run_task(...))` — always the K8s path.
- `run_task` (`process.py:861`) resolves cluster/storage/registry creds and calls `create_job`
  (`process.py:1040`) with `environment.docker_image`. This is what a WASM version must **skip**.
- State enum `QUEUED/STARTING/RUNNING/DONE/FAILED` (`process.py:37`); all transitions go through
  `update_state` (`process.py:472`) which commits and broadcasts a bare `{"refetch": True}` on
  `/ws/processes/updates`.
- `_handle_job_completion` (`process.py:792`) is the *only* caller of `_create_outputs` +
  `update_state(DONE)`, and it is gated on a real K8s job succeeding. **No externally-computed-outputs
  path exists** — this plan adds one.
- `_create_outputs` (`process.py:1087`) registers `Dataset` rows purely by scanning
  `{storage_base}/processes/{id}/{version}/datasets/*/info.json` — **who wrote the files is irrelevant**.
  The same method also handles the `environment.json` → `Environment` handoff (`process.py:1232`).

### Environment model (what gets the `runtime` field)
- `backend/models/environment.py`: columns `id, name, docker_image (NOT NULL), process_id, process_types,
  created_at, created_by`. `to_dict(include_schemas, minimal)` at `:31`.
- `docker_image` is `nullable=False` today — must relax to nullable so WASM environments (which set
  `wasm_image_url` instead) can leave it null. Runtime is derived from which field is set (D4).

### `create_environment` (the model for `create_wasm_environment`)
- `ymerflow_runner/create_environment.py` (live SDK `~/Projects/beta/Ymerflow-process-sdk`): builds+pushes
  a Docker image with in-pod kaniko, `crane export`s `app/process_schemas.json`, then writes
  `{storage_base}/processes/{id}/environment.json` = `{name, docker_image, process_id, process_types}`
  (`:239`). Registered via the `ymerflow.process_types` entrypoint in that repo's `setup.py:20`. The WASM
  analog writes the same shape with `wasm_image_url` in place of `docker_image`.
- `docker/update_bootstrap_environment.py` UPSERTs the initial "Bootstrap" environment straight into the
  DB at image-build time — the model for a WASM bootstrap registration.

### Frontend (what learns about `runtime` and runs Pyodide)
- Create: `useCreateProcess` (`frontend/src/datamodel/useQueries.js:257`) → `createProcess`
  (`api.js:359`) → `POST /projects/{id}/process`. Body built in `ProcessEditor.jsx:206-229`
  (`{name, type, environment: {id}, params, resource_requests, deadline_seconds, cluster, ...}`).
  Deliberately no optimistic cache write; success calls `invalidateProject()` then `setActiveProcess`.
- Results display is **fully generic**: the WS consumer (`ProcessContext.jsx:421`) ignores the message
  body and just refetches; `useProcessOutputDatasets` (`useQueries.js:228`) reads `versions[x].outputs`
  and loads each dataset. **Once a WASM version flips to DONE with an `outputs` map, the entire existing
  display path works unchanged** — no new results plumbing beyond optimistic injection (D3/step 5).
- Environment selection (`EnvironmentSelect.jsx`, `ProcessEditor.jsx:42-120`) consumes only `id/name/
  created_at` today; it must additionally read `runtime` (+ `wasm_image_url` for wasm).
- Upload primitive already exists: `uploadFile` (`api.js:484`) → `POST /projects/{id}/upload`. The new
  dataset-layout upload endpoint mirrors it.
- Frontend build is **Vite** (`frontend/package.json`); no Pyodide/worker code exists yet.

## Implementation steps

### 1. Environment: add `wasm_image_url`, derive `runtime` (backend + frontend)
- `backend/models/environment.py`: add `wasm_image_url = Column(String(1024), nullable=True)` and relax
  `docker_image` to `nullable=True` (exactly one of the two is set per environment). Add a computed
  property `runtime` → `"wasm" if self.wasm_image_url else "kubernetes"` — **not a column**. `to_dict()`
  emits the derived `runtime` always, and `wasm_image_url` when set.
- Alembic migration (hand-authored → **generate the revision id with real entropy**, `python3 -c "import
  uuid; print(uuid.uuid4().hex[:12])"`, and `grep -rn "revision = '<id>'"` across *all* migration dirs to
  confirm uniqueness — CLAUDE.md rule 9): add the `wasm_image_url` column and relax the `docker_image`
  NOT NULL. No backfill needed (runtime is derived, existing rows keep their `docker_image`).
- Frontend: surface `runtime` (+ `wasm_image_url`) through `useEnvironments`/`api.js` and into the editor
  so the run path can branch. Optionally badge WASM environments in `EnvironmentSelect`.

### 2. `create_wasm_environment` build process (SDK)
New process type in the SDK (`ymerflow_runner/create_wasm_environment.py`), registered in that repo's
`setup.py` `ymerflow.process_types` entrypoints. Runs as a **normal** (K8s) job on an existing Docker
environment. It assembles a **self-contained Emscripten image** (D7) for the target process packages:
1. Params: `environment_name`, `python_packages` (the process packages + any pure-Python deps to include),
   and `pyodide_packages` (names of Pyodide-provided packages the image needs: numpy, scipy, pandas, …).
2. `pip install` the packages into the build pod and run the existing schema extraction (`get_schema`
   logic) to produce `process_schemas.json`. Schema extraction needs only `schema()` (lightweight
   metadata) — **no Pyodide required** to extract schemas.
3. Assemble the image: the pinned Pyodide runtime files (`wasm` + JS glue + stdlib) + the process
   packages/deps (Pyodide-provided C packages and/or wheels of our code) + `process_schemas.json` + a tiny
   **entrypoint bootstrap** (boot Pyodide inside the image, then run `ymerflow_runner` against the env/FS
   ABI from D7) + a small **manifest** (entrypoint + args). Fail loudly if any requested package can't be
   loaded by the target Pyodide runtime (the geopandas/SimPEG guard — the guard is "loadable in this
   runtime", not "pure-python"). The image's *internals* are the build's private business; the platform
   only ever sees one opaque, addressable artifact honoring the D7 execution contract.
4. Upload that single artifact to `{storage_base}/processes/{id}/wasm-image/...` and record its URL as
   `wasm_image_url`. The backend treats it as opaque.
5. Write `{storage_base}/processes/{id}/environment.json` = `{name, wasm_image_url, process_id,
   process_types}`.
- Backend handoff: extend the `environment.json` reader in `_create_outputs` (`process.py:1232-1274`) to
  set `wasm_image_url` when present (falling back to `docker_image` for existing Docker `environment.json`
  files — back-compat). Runtime is then derived from whichever field ended up set.
- **Bootstrap:** a small script (mirroring `docker/update_bootstrap_environment.py`) that builds the
  image for the initial WASM environment and UPSERTs the row directly, so the platform has a usable WASM
  environment before `create_wasm_environment` itself can be run.

### 3. Backend: virtual `frontend` cluster, skip K8s, externally-computed-outputs endpoints
- **Seed the virtual `frontend` cluster (D8):** a `Cluster` row `name="frontend"`, a distinct
  `cluster_type` (e.g. `"frontend"`) with no real k8s connection. `get_allowed_clusters`
  (`backend/models/cluster.py:55`) always includes it (free, plan-independent). It defines the
  no-resource, zero-cost semantics that WASM versions inherit.
- `create_queued` (`process.py:185`): after building the version, check its environment. If
  `environment.wasm_image_url` is set (runtime `wasm`):
  - assign `k8s_cluster_id` = the `frontend` cluster;
  - **skip the resource/node-capacity validation block** (`process.py:252-289`) — `resource_requests` is
    empty, there is no node to fit; and **skip the `job_pre_run` balance pre-check** (D8: zero cost);
  - **do not** `asyncio.create_task(run_task(...))` — leave the version `QUEUED` for the browser to drive.
- New authenticated, project-scoped endpoints (normal user JWT/session auth + project membership — *not*
  the runner-only opaque-token internal endpoints), all gated on `environment.runtime == "wasm"` and on
  the caller owning the project (so a client can never forge outputs for a K8s version):
  - `POST /projects/{id}/process/{pid}/versions/{v}/running` — mark `RUNNING` (D3). Optional; the browser
    may also fold this into the first upload.
  - `POST /projects/{id}/process/{pid}/versions/{v}/dataset-file?path=...` — stream one file into
    `{storage_base}/processes/{pid}/{v}/datasets/{path}` using the existing `_stream_upload` machinery
    (`uploads.py:58`), *without* creating an `Upload` row. This is the D1 proxy.
  - `POST /projects/{id}/process/{pid}/versions/{v}/complete` — body carries the captured logs. Runs the
    **existing** `_create_outputs` scan against the now-populated layout, appends logs, flips to `DONE`,
    broadcasts refetch. This factors `_create_outputs` + `update_state(DONE)` out of the K8s-only
    `_handle_job_completion` path so both paths share it — but this path **does not invoke billing** (D8:
    `frontend`-cluster versions are free; no `started_at`/runtime clock, no completion charge).
  - `POST /projects/{id}/process/{pid}/versions/{v}/fail` — body carries logs + error; append + `FAILED`.
    (May reuse the existing `cancel_process_version` mechanics.)
- Logs: batch — the harness captures the image's stdout/stderr (the D7 ABI: stdout = logs) and posts them
  with `complete`/`fail` for the MVP (streaming is future work).

### 4. Frontend: generic Emscripten-image harness (Web Worker)
- A generic `wasmRunner` module + a **Web Worker** per run (the image blocks the thread; it must be off
  the main thread). The harness is **Python-agnostic** — it runs whatever Emscripten image the URL points
  at, never referencing Pyodide (D7). Per process run:
  1. **Obtain a ready instance in a fresh worker (D7 two-tier cold-start strategy; caches in IndexedDB
     keyed by `image id + runtime version`, surviving browser restart):**
     - If a **persisted per-image memory snapshot** is present (in IDB) and snapshots are supported →
       **restore it** into a fresh instance (a memory copy) and skip straight to step 2. Fast path for
       every run after the first, across restarts.
     - Else **instantiate the image** (`wasm` + its own JS glue) — from the persisted compiled `Module` /
       raw bytes in IDB if present (skip re-download/recompile), else fetch + compile and store them — then
       boot it fully (for a Python image: glue → Pyodide → packages/modules loaded), and *if snapshots are
       supported* **capture a snapshot at this post-boot / pre-entrypoint point and persist it for the
       image**.
     - Feature-detect each cache; on absence/eviction fall through gracefully (down to a full cold boot).
       No "kind" dispatch — one path for all images; snapshot/restore is content-agnostic.
  2. **Stage inputs (D6):** resolve the process's input dataset URLs, fetch their bytes through the
     existing backend dataset endpoints (the same path `loadDataset`/`fetchData` already use), and write
     them into the image's Emscripten FS (`Module.FS`) at the paths the entrypoint expects; point
     `STORAGE_BASE` at that FS directory. Set the rest of the env ABI (`PROCESS_TYPE`, `PARAMETERS_JSON`, …).
  3. **Run the image's entrypoint** (D7 ABI). For a Python image that means: the entrypoint boots Pyodide
     *inside the image* and runs `ymerflow_runner` (load class by entrypoint name → `process_class.run`)
     exactly as `runner.py` does in the pod — but the harness neither knows nor cares that it's Python.
  4. **Collect outputs (D6/D1):** read the produced `datasets/` tree out of `Module.FS`, POST each file
     (including `info.json`) to the `dataset-file` endpoint; capture stdout/exit code for logs/status.
     Discard the worker (per-run isolation, D7).
- Editor UI (`ProcessEditor.jsx`): when the selected environment is `wasm`, **hide the cluster and
  cpu/ram/deadline controls** (D8 — no resource config) and send an empty `resource_requests` + no
  explicit cluster (the backend forces `frontend`).
- Editor run path (`ProcessEditor.jsx`): after `createProcess` returns, branch on the selected
  environment's `runtime`. For `wasm`, kick the worker (which posts `running`, uploads, then `complete`/
  `fail`); for `kubernetes`, behave exactly as today.

### 5. Frontend: immediate display (optimistic injection)
- The harness already holds the produced dataset files (read out of `Module.FS` in step 4.4).
  Before/independently of the upload+`complete` round-trip, build dataset objects from those bytes and
  inject them into the TanStack Query dataset cache in the same shape `loadDataset` produces,
  keyed so `ProcessContext`'s `datasetObjects` and the plot views pick them up. This delivers "available
  on the client immediately, even before the post returns." The subsequent `complete` → refetch is
  idempotent with the optimistic data.
- Matching the exact `loadDataset` output shape is the fiddliest part; if it slips, the fallback is the
  fast local `complete` → refetch (still far faster than a K8s round-trip), so this step degrades
  gracefully.

## Testing / verification
- Build a WASM environment via bootstrap; confirm the Environment row has `docker_image` null,
  `wasm_image_url` set (so derived `runtime="wasm"`), and `process_types` schemas. Confirm the process
  editor offers it and lists its types.
- Run a `libaarhusxyz` import/filter process in it: version goes `QUEUED→RUNNING→DONE`; a `Dataset` row
  appears identical in shape to the same process run in a Docker environment; plots render.
- Confirm **no K8s job** is created for the WASM run (orchestrator path skipped), the version is on the
  `frontend` cluster, and its recorded cost is **zero on every plan** (including a plan that would bill a
  K8s run) — verify the balance pre-check and completion billing are both bypassed.
- Confirm the produced storage layout (`datasets/*/info.json`) is byte-compatible with `_create_outputs`
  (run the same input through a Docker env and diff the registered dataset metadata).
- Immediacy: verify the dataset is visible on the client before the `complete` request resolves.
- Negative: request a WASM environment build with a geopandas/SimPEG-dependent package → build fails
  loudly at the purity/Pyodide-availability guard.
- Security: a non-member (or a member targeting a `runtime="kubernetes"` version) cannot hit the
  `dataset-file`/`complete`/`fail` endpoints.
- Tab-close mid-run leaves the version `RUNNING`; a fresh run (new version) succeeds.
- Back-compat: existing Docker `environment.json` (no `wasm_image_url`) still registers with
  `docker_image` set, deriving `runtime="kubernetes"`.

## Risks / open questions
- **Pyodide bring-up of the real packages** is a spike: even pure-python `libaarhusxyz` may pull a
  transitive dep that isn't Pyodide-provided. First implementation task should be a throwaway spike that
  boots Pyodide and imports `libaarhusxyz` + one target filter before any of the above is built.
- **Input staging cost:** large input datasets fetched into the browser undercut the "small only" premise;
  the editor should only offer WASM environments for reasonably-sized inputs (soft guard, future).
- **Zombie `RUNNING`** versions (D3) accumulate if users close tabs mid-run; acceptable for MVP, revisit
  with a heartbeat/timeout if it becomes noisy.
- **Cold start (D7 two-tier strategy):** compile-cache is always on; the per-image memory snapshot
  (captured post-boot / pre-entrypoint, restored as a fresh memory copy per run) is what makes runs after
  the first near-instant *while keeping isolation*. Both caches persist in IndexedDB (keyed by image id +
  runtime version) to survive restarts. Risks to confirm in the spike: (a) snapshot support-detection +
  round-trip correctness across Pyodide/browser versions; (b) whether `WebAssembly.Module` persists in IDB
  in target browsers (else raw-bytes fallback); (c) snapshot size vs storage quota/eviction (request
  `navigator.storage.persist()`); (d) the compile-cache-only degraded path is acceptable where snapshots
  are unavailable.
- **Generic-harness/ABI validation:** the "one harness runs any Emscripten image" claim only holds if the
  env/FS/stdout/exit-code ABI is nailed down and the Pyodide image's bootstrap honors it. Prove it with a
  trivial non-Pyodide Emscripten image alongside the first Pyodide one, so the ABI isn't accidentally
  Pyodide-shaped.

## Out of scope
- Inversion or any SimPEG/geopandas/GDAL-dependent process type in the browser.
- Direct browser→storage credentials, presigned URLs, or bucket CORS (explicitly rejected — D1).
- Streaming logs from the browser (batch on complete/fail for now).
- Automatic fallback that reruns a failed WASM version as a K8s job (user retries manually).
- Emscripten cross-compilation of C-extension packages, and any non-Python Emscripten image — **not
  implemented now**, but the opaque self-contained-image + fixed env/FS ABI (D7) is designed so adding
  either is only a new/extended build process type emitting an image that honors the same ABI, with **no
  change to the generic harness, the storage format, the `wasm_image_url` handoff, the Environment model,
  or the upload/state endpoints.** (The harness is already image-content-agnostic — there is no per-image
  loader to add.)

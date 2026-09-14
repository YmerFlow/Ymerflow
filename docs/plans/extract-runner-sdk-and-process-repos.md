# Plan: Extract the runner side into its own repos and make `build.sh` build environments the same way `create_environment` does

## Goal

Today two code paths build a runner image, extract `process_schemas.json`, and register it as an
environment — `docker/build.sh` (host, static Dockerfile) and the `create_environment` process type
(in-pod, kaniko, a Dockerfile synthesized from parameters). They share **zero** code and drift
independently.

Unify them by:

1. Reducing the base-runner image to a **default parameter set** — a `base_image` plus a list of
   pip packages plus a block of Dockerfile instructions — instead of a hand-written Dockerfile with
   source trees `COPY`'d in from a build context.
2. Introducing a single, dependency-free `params_to_dockerfile(base_image, python_packages,
   dockerfile_instructions)` function that both `build.sh` and `create_environment` call.
3. Moving all the Python that currently lives under `docker/base-runner/` out into their own git
   repos, installed via `pip git+https://…` (exactly how the heavy process deps and the plugin SDK
   already install).
4. Making `docker/build.sh` take `--base-image` / `--python-packages` / `--dockerfile-instructions`
   (the same knobs `create_environment` exposes) and, with no args, build the default image — with
   **no build-context directory** at all.
5. Fixing the `python_packages` form field, which claims `x-format: textarea` but renders
   single-line, and documenting its syntax.

## Background — current state

`docker/base-runner/` contains, all baked into one image via a static `Dockerfile`:

- **Process libraries** (each already a pip-installable package with `ymerflow.process_types`
  entry points): `ymerflow_processes` (`create_environment`, `build_frontend_plugin`,
  `compound_filter`), `aem_processes`, `mag_processes`. `nagelfluh_processes/` holds only stale
  `.py~` backups from January — dead.
- **Runner harness** (`COPY`'d, not pip-installed): `runner.py` (the `ENTRYPOINT`), `get_schema.py`
  (run at build time to bake `process_schemas.json`), `storage_credentials_client.py`,
  `storage_credential_refresher.py`, and `backend/utils/xyz_utils.py` (copied in as
  `ymerflow_runner/xyz_utils.py`).
- **Binaries**: kaniko executor (multi-stage `COPY --from=kaniko`), crane (curl'd), Node.js (apt),
  and the C++ toolchain for pyinterp (apt).
- **Test fixture**: `docker/base-runner/plugin-npm-source/cluster-test-widget/`, a pure-frontend
  test plugin `npm pack`'d into `PLUGIN_NPM_SOURCE_DIR` at build time and used by a warmup
  smoke-test of the plugin-build routine. Consumed at runtime only by `build_frontend_plugin`;
  real production plugins come from an admin-populated PVC (`plugin_npm_source_volume_*` in
  `backend/config.py`), not from this baked copy.

`docker/build.sh` hardcodes `docker/base-runner/Dockerfile` + context `.`, builds with the host
Docker daemon via `backend/bin/yf-build-and-push`, extracts schemas with `docker run --entrypoint
cat`, and registers the environment via `docker/update_bootstrap_environment.py` (dev: direct;
prod: a k8s Job). `create_environment` (`docker/base-runner/ymerflow_processes/fake_processes.py`)
synthesizes a Dockerfile from parameters (lines 87–115), builds+pushes with kaniko, extracts with
`crane export`, and registers by writing `environment.json` to storage for `_create_outputs`.

The `params_to_dockerfile` logic and the build-engine/registration steps are genuinely different
concerns: the Dockerfile synthesis is pure text and fully shareable; the build engine (host Docker
daemon vs in-pod kaniko) and registration path (DB-reachable host vs storage round-trip) are not,
and stay separate.

## Design decisions

### 1. New repo `Ymerflow-process-sdk` — the runner side

Parallel to `Ymerflow-plugin-sdk` (which is for *plugin authoring*), `Ymerflow-process-sdk` owns the
*process/runner* side. It contains:

- The runner harness: `runner.py`, `get_schema.py`, `storage_credentials_client.py`,
  `storage_credential_refresher.py`, and `xyz_utils.py`, packaged as an importable
  `ymerflow_runner` package (no more `COPY`). The `ENTRYPOINT` becomes `python -m ymerflow_runner`
  (or a console_script); the build-time schema bake becomes `python -m ymerflow_runner.get_schema`.
- `params_to_dockerfile(base_image, python_packages, dockerfile_instructions, install_kaniko=False)`
  — the single, dependency-free (stdlib-only) text function, lifted from `fake_processes.py` lines
  87–115 and extended with the `install_kaniko` flag (see decision 5). Both `build.sh` (host `env/`)
  and `create_environment` (pod) import it, so the two never drift.
- The `create_environment` process type (moved out of `ymerflow_processes`), now importing
  `params_to_dockerfile` from its own repo.

Rationale for a new repo rather than reusing `Ymerflow-plugin-sdk`: the plugin SDK's purpose is
plugin authoring (`registerHook` shim, Vite federation preset). The runner harness + dockerfile
synthesis are a different audience (the platform runtime / image builders). Folding them into the
plugin SDK would conflate audiences and couple release cycles. The harness and the synthesis
function *do* belong together — the default Dockerfile the function emits ends in the harness's own
`get_schema`/`ENTRYPOINT`, so they version as a unit.

### 2. New repo `Ymerflow-plugin-processes` — the image-building process types that need the plugin SDK

`build_frontend_plugin` is an image/artifact-building process type that depends on
`ymerflow_plugin_build` (the plugin SDK). It moves to its own repo, `Ymerflow-plugin-processes`,
together with its test fixture `cluster-test-widget/` and the warmup smoke-test (which becomes this
repo's CI, not something baked into every production runner). `Ymerflow-plugin-processes` depends on
`Ymerflow-plugin-sdk`; `Ymerflow-process-sdk` stays free of that dependency.

### 3. `aem-processes` and `mag-processes` become standalone repos; `compound_filter` moves into `aem-processes`; `ymerflow-processes` is deleted

Each process library becomes its own GitHub repo under the YmerFlow org (independent versioning).
`compound_filter` is XYZ/libaarhusxyz InUse-diff work — it belongs in `aem-processes`. With
`create_environment` → `Ymerflow-process-sdk`, `build_frontend_plugin` → `Ymerflow-plugin-processes`,
and `compound_filter` → `aem-processes`, **nothing remains in `ymerflow-processes` and it is deleted
entirely.** `docker/base-runner/nagelfluh_processes/` (stale `.py~` only) is removed too.

Final repo set: `Ymerflow-process-sdk`, `Ymerflow-plugin-processes`, `aem-processes`,
`mag-processes` (plus the existing `Ymerflow-plugin-sdk`).

### 4. The default image is a checked-in parameter set; `build.sh` needs no build context

`config.env`'s `BASE_RUNNER_PARAMS_JSON` is the single source of truth for the default parameters —
there is **no** default constant in `Ymerflow-process-sdk`. The value shipped in
`config.env.example` reproduces today's image. `build.sh` reads it and (a) passes its fields as the
arguments to `params_to_dockerfile` for the host build, and (b) bakes it into the image build env so
`create_environment.schema()` fills its field defaults from the very same value (decision 7). The
values it encodes:

- `base_image = python:3.11-slim-trixie`
- `python_packages` = the four repos above (git+https) + `Ymerflow-plugin-sdk`, with the same
  extras (`aem-processes[all]`, the `CC=clang` note for pyinterp preserved as an instruction/env).
- `dockerfile_instructions` = apt build toolchain + Node.js, crane, **kaniko fetched via curl**
  (see decision 5), the `PLUGIN_NPM_SOURCE_DIR` env, `RUN python -m ymerflow_runner.get_schema`, and
  the `ENTRYPOINT`.

`build.sh` with no args builds this default; `--base-image` / `--python-packages` /
`--dockerfile-instructions` override it. Because every input is now pip-installed or curl'd, the
build context is a temp dir containing only the synthesized `Dockerfile` — no `COPY` from the repo,
no directory argument. `build.sh` keeps everything else unchanged: kubeconfig materialization,
`yf-build-and-push`, schema extraction, and the dev/prod environment-registration paths.

### 5. `params_to_dockerfile` takes an `install_kaniko: bool` that emits the real multi-stage form

Kaniko's executor is not something a trailing instruction block can express: it lives in the kaniko
container image (there is no standalone binary release — verified against its GitHub releases), and
the normal way to obtain it is a multi-stage `FROM …/executor AS kaniko` prelude plus
`COPY --from=kaniko /kaniko/executor …`. A prelude stage has to precede the base `FROM`, so it can't
come from the appended `dockerfile_instructions`.

Rather than contort this into a `RUN`-step extraction, `params_to_dockerfile` owns it explicitly:

```
params_to_dockerfile(base_image, python_packages, dockerfile_instructions, install_kaniko=False)
```

When `install_kaniko=True`, the function emits the multi-stage `FROM …/executor:<ver> AS kaniko`
prelude before the base `FROM` and the matching `COPY --from=kaniko /kaniko/executor /kaniko-executor`
after it. The default base-runner param set (decision 4) sets `install_kaniko=True`;
`create_environment` may expose it as a parameter for environments that themselves build images.
This keeps the produced Dockerfile identical to today's (proper multi-stage kaniko copy) while
staying fully parameter-driven.

### 6. The `cluster-test-widget` fixture leaves the production image

The fixture and its warmup move to `Ymerflow-plugin-processes` as test material. The default prod
image stops baking it (no `COPY docker/base-runner/plugin-npm-source`), which is what lets `build.sh`
be context-free. Production `build_frontend_plugin` is unaffected: it resolves real plugins from the
admin-populated PVC (`plugin_npm_source_volume_*`), never from the baked fixture.

### 7. Fix the `python_packages` textarea + document syntax + seed defaults from the shared param set

`CustomStringField.jsx` only wires `x-format` values `processVersion` / `datasetPath` / `dataset` /
`upload`; `x-format: textarea` is dead metadata and falls through to RJSF's single-line
`StringField`. Wire up `x-format: textarea` to render a real multi-line widget (RJSF's
`ui:widget: "textarea"`), and document the syntax ("one package per line, requirements.txt format;
git URLs allowed") in the field title/description of `create_environment`'s schema. This lands as
its own git commit (Q4).

Additionally, `create_environment`'s schema sets each field's `default` (`base_image`,
`python_packages`, `dockerfile_instructions`, `install_kaniko`) from `config.env`'s
`BASE_RUNNER_PARAMS_JSON` — the same value `build.sh` feeds to `params_to_dockerfile`. `build.sh`
bakes that value into the image build env (build ARG → ENV) so `get_schema.py` reads it when it
generates `process_schemas.json`. The create_environment form therefore opens pre-populated with the
deployment's actual base-runner params. Because both consumers read the one `config.env` value baked
by the same build, they never diverge — no SDK-side default constant is involved.

## Implementation steps (high level — sequencing across repos)

1. **Create `Ymerflow-process-sdk`**: move the harness into a `ymerflow_runner` package
   (`__main__` entrypoint, `get_schema` module); add `params_to_dockerfile(…, install_kaniko=False)`;
   move `create_environment` (importing the new function); register its `ymerflow.process_types`
   entry point; add tests.
2. **Create `Ymerflow-plugin-processes`**: move `build_frontend_plugin` + `cluster-test-widget/`;
   depend on `Ymerflow-plugin-sdk`; make the warmup smoke-test its CI.
3. **Create `aem-processes` and `mag-processes` repos** from the existing package dirs; move
   `compound_filter` into `aem-processes`. (All four repos public, `git+https` — decision Q2.)
4. **Update `docker/build.sh`**: import `params_to_dockerfile`, add the `--base-image` /
   `--python-packages` / `--dockerfile-instructions` flags, read the default params from
   `BASE_RUNNER_PARAMS_JSON` in `config.env` (built-in fallback), synthesize into a context-free
   temp dir. Install `Ymerflow-process-sdk` into the host `env/`.
5. **Delete** the `docker/base-runner/` source trees, static `Dockerfile`, and dead
   `nagelfluh_processes`; point the default `python_packages` at the `git+https` URLs.
6. **Verify** (after the delete, per Q4): rebuild the default image, confirm schema extraction +
   environment registration in dev — a true test now that no in-tree copies can shadow the git-URL
   installs.
7. **Update `create_environment`** to import `params_to_dockerfile` (no inline synthesis) and add
   the `python_packages` syntax docs. **Separately** (its own commit): wire `x-format: textarea` in
   `CustomStringField.jsx`.

## Open questions

- **Defaults file** (decision 4): RESOLVED — a JSON env var in `config.env` (e.g.
  `BASE_RUNNER_PARAMS_JSON`) holding `{base_image, python_packages, dockerfile_instructions,
  install_kaniko}`, matching the existing `REGISTRY_CONFIG_JSON` / `CLUSTER_CONFIG_JSON` /
  `STORAGE_CONFIG_JSON` convention — the single source of truth, no default constant in the SDK.
  The value shipped in `config.env.example` reproduces today's image. `build.sh` feeds it to
  `params_to_dockerfile` (host build) and bakes it into the image build env so
  `create_environment.schema()` fills its field defaults from the same value (decision 7).
- **Repo visibility**: RESOLVED — all four new repos are public and install via `git+https`, no
  build credentials, consistent with every existing YmerFlow/Sagebrush dependency.
- **Version pinning**: RESOLVED — keep branch-tracking for the default `python_packages` git URLs
  (status quo; the runner image is already non-reproducible, tag = `bootstrap` slug). Reproducible
  pinning is a deferred, known gap.
- **Migration/verification order**: RESOLVED —
  1. Push the four repos from the existing code.
  2. **Delete** the `docker/base-runner/` source trees + static `Dockerfile` (+ dead
     `nagelfluh_processes`) and point the defaults' `python_packages` at the `git+https` URLs.
  3. Rebuild the default image and verify schema extraction + environment registration in dev.
     Deleting *before* verifying is deliberate: leaving the in-tree copies risks the build
     resolving them instead of the git URLs, masking a broken git-URL install/extraction (false
     positive).
  4. The frontend `x-format: textarea` fix (decision 7) is independent and lands as its **own git
     commit**.

# Plan: run ymerflow-processing pipelines in the platform

## Goal

Two process types that run `ymerflow-processing` pipelines on an AEM dataset inside the platform: one for processing (dataset in, processed dataset out) and one for QC (dataset in, the same dataset with verdict columns and a report). They sit alongside the existing `process_tem`; nothing is retired here.

This is the first platform step of the migration in #79, and the platform half of `YmerFlow/ymerflow-processing#6` ("nothing from this library is installed in the platform"). It is also what makes single-moment processing and acquisition QC (#64) possible in the platform: the library handles one to N moments by design and carries the QC checks, and the existing processing path was never checked on single-moment data (#61).

## Background: current state

- **The library is complete and not installed.** `ymerflow-processing` on branch `remove-channel-renumbering` (59 commits ahead of `main`, none behind) registers about 45 steps in three entry-point groups, `ymerflow.processing.filters`, `ymerflow.processing.qc` and `ymerflow.processing.compare`, with a runner per group, a `StepReport` per step, a `RunReport` per run, three bundled pipelines (`standard-processing`, `acquisition-qc`, `synthetic-data`) and a CLI, `yf-process`. It registers no `ymerflow.process_types` entry point, so no environment shows anything from it.
- **The library reads files and never touches storage.** `ymerflow_processing.core.dataset.load(xyz_path, gex_path)` takes two local paths and returns a `Dataset` whose `survey` is a `libaarhusxyz.Survey`. The layering is deliberate: the platform materialises, the library reads.
- **Process types live in pip-installed repos** since the runner extraction (`docs/plans/done/extract-runner-sdk-and-process-repos.md`): `aem-processes` (`import_skytem`, `process_tem`, `invert_tem`, `forward_tem`, ...), `mag-processes`, and `Ymerflow-process-sdk` (runner harness, `create_environment`).
- **AEM datasets are written by `aem_processes.dataset_utils.write_dataset(xyz, gex, ...)`**: `root.msgpack` (XYZ with the GEX embedded), `root.xyz`, `root.gex`, `root.geojson`, `stats.json`, one part per flight line, and an `info.json` listing the files by MIME type.
- **The model to copy is `mag_processes.processing_process.MagProcessing`**: `swaggerspect` builds the steps form from an entry-point group, `localize_urls` fetches the input, the library's pipeline runs, `write_dataset` stores the result. About 120 lines.
- **Environments** are built by running `create_environment` with a base image, Python packages and Dockerfile instructions (`docs/architecture/environment.md`).

## Design

### Two process types

| process type | entry-point group | runner | writes |
|---|---|---|---|
| `yf_process_tem` | `ymerflow.processing.filters` | `ProcessingRunner` | a new dataset |
| `yf_qc_tem` | `ymerflow.processing.qc` | `QCRunner` | the input dataset plus verdict columns, and the report |

Named `yf_process_tem` and `yf_qc_tem`: permanent names that never collide with `process_tem`, with the prefix grouping this library's types together. Two types rather than one with a mode switch, because the library keeps the groups apart on purpose: a QC pipeline run through the processing runner changes nothing and reports nothing.

### Form (`schema()`)

- `input_data`: a dataset (`x-format: dataset`).
- `steps`: the step list, built by `swaggerspect` from the process type's own entry-point group (`multi=True`), as `MagProcessing` does, with the same fallback to a bare array if introspection fails.
- **Defaults from the bundled pipeline**: the form opens with `standard-processing` (processing) or `acquisition-qc` (QC) already filled in, read from the bundled YAML at schema time, so a user starts from the standard chain and edits it rather than building one from nothing.
- `label` (optional): the run's identity in the report; defaults to the input dataset's name.

### Run (`run()`)

1. **Validate before touching data.** Build a `Pipeline` from `{"kind": <group>, "steps": steps}`, resolve the group and `validate()` it, so an unknown step fails at once rather than after the download.
2. **Materialise two files.** Read the input dataset's `info.json` and localize its `text/x-aarhusxyz` and `text/x-aarhusxyz-gex` files (`root.xyz`, `root.gex`) to a temporary directory. If a dataset has no text forms, load `root.msgpack` with `libaarhusxyz` and dump both.
3. **Load and run.** `load(xyz, gex)`, then the group's runner. Library logging goes to stdout, so the platform streams it live (the log channel in `docs/architecture/pipelines.md` §7).
4. **Write the dataset** with `write_dataset(dataset.survey.xyz, dataset.survey.gex, ...)`, which also writes `stats.json` (the statistics channel). Confirm the XYZ is normalized, as `write_dataset` requires.
5. **Write the run report** (`RunReport.to_dict()`) as `report.json` beside the dataset and list it in that dataset's `info.json` under `application/vnd.ymerflow.run-report+json` (the report channel). This is how `stats.json` is already stored, so the report travels with the data it describes through export, import and publication.
6. **A finding is not a failure.** An out-of-spec or ungraded verdict completes the process normally, with the worst verdict and any ungraded checks summarized in the log and the report. Only a step that raises fails the version.

### Where the code lives

In `aem-processes`, with the other AEM process types. The alternatives considered:

- **A. In `aem-processes`, next to `process_tem` (chosen).** Reuses `dataset_utils`, `utils.localize_urls` and `stats` as they are, and one environment then carries the old and the new processing side by side, which is what the equivalence gate in #79 needs: the same input through both, in one project. Only `processing_process.py` uses the old library, and only through an optional extra, so retiring it later removes that module, its entry point and the extra, and leaves these types untouched.
- **B. A new repo, `ymerflow-processing-processes`.** A clean unit to keep when `process_tem` is retired; either depends on `aem-processes` for the helpers or copies them.
- **C. Inside `ymerflow-processing`.** Rejected: it would put platform code into a library whose design keeps the platform out.

### Dependencies

The chosen package adds `ymerflow-processing @ git+https://github.com/YmerFlow/ymerflow-processing@main`, branch-tracking like the other git dependencies (pinning is the known deferred gap). `libaarhusxyz` must resolve to one source for both packages (see `YmerFlow/ymerflow-processing#3`), and the library's numpy range must admit the version the AEM stack resolves.

### Environment

Built with `create_environment` in the project that needs it, by whoever needs it: any project member can run it, so building and rebuilding environments does not wait on one person. Builds run on the default cluster.

The recipe follows the pattern the existing experiment environments use: launch `create_environment` from the Bootstrap environment, whose form is prefilled with the default image parameters (`BASE_RUNNER_PARAMS_JSON` in `config.env.example`: `python:3.11-slim-trixie`, the plugin SDK, the process SDK, plugin processes, `aem-processes[all]` and `mag-processes`, with the standard Dockerfile instructions and kaniko), and change only the package lines:

- `aem-processes[all] @ git+https://github.com/YmerFlow/aem-processes.git@<branch>`: the branch carrying the two new process types. It starts from `measured-synthetic-tem` (one commit ahead of `master`: the Measured and Synthetic TEM systems registered, and the Geosoft importer's component filter), unless that commit is merged to `master` first.
- `simpeg @ git+https://github.com/YmerFlow/simpeg.git@measured-synthetic-tem-fast-exact`: the single-moment, central-loop instrument with the exact fast-coefficient rescale.
- `ymerflow-processing @ git+https://github.com/YmerFlow/ymerflow-processing.git@main`.

Builds install from the GitHub remotes, so a change reaches an environment only once it is pushed to a branch. Once validated, the same packages go into the default image.

## Implementation steps

1. Merge `remove-channel-renumbering` into `ymerflow-processing` `main` by pull request.
2. Add the two process types in the chosen home, registered under `ymerflow.process_types`. Tests: `schema()` builds with the library installed and falls back without it; `run()` end to end on a synthetic dataset (the `synthetic-data` pipeline) against a local `file://` storage base, for both types, including an out-of-spec QC result completing normally.
3. Build an environment with `create_environment` in a test project and confirm both process types appear with their forms. Write the tutorial below from this build, as it happens.
4. Run the checks under Verification.
5. Write the rest of the documentation below, and move this plan to `done/`.

## Verification

1. **The wrapper adds nothing.** On the public benchmark line (LPNNRD2018 line 300901), `standard-processing` through the process type gives the same dataset as `yf-process run standard-processing` on the same `root.xyz` and `root.gex`.
2. **Hand-off to inversion.** `invert_tem` runs on the processed output: column names, in-use masks and STD are what it expects. (How `invert_tem` treats the STD is #98, separate.)
3. **QC.** `acquisition-qc` on a delivered flight: verdict columns appear in the plots, `report.json` is listed in `info.json` and reads as JSON, the worst verdict is in the log.
4. **Single-moment.** A single-moment delivery through `standard-processing` and `invert_tem` in the environment from step 3.

## Documentation

Part of the work, not a follow-up. Each item is written from a real run, per `docs/tutorials/WRITING.md`: web interface only, real values, failure modes included, nothing unverified.

- **Tutorial: build an environment from a package branch** (`docs/tutorials/`). How to launch `create_environment` from the Bootstrap environment, which package lines to change and the syntax for a git branch, how long a build takes, how to tell it worked (the environment appears in the project and lists its process types), and what a failed build looks like in the log. Written from step 3. Today this knowledge exists only in the default recipe in `config.env.example` and in experiment notes outside this repo.
- **Tutorial or user-guide section: processing and QC with ymerflow-processing.** Running `yf_process_tem` and `yf_qc_tem` on a dataset: the prefilled standard chains, editing steps, where the run report and verdict columns appear, and how an out-of-spec QC result reads. Written from the Verification runs.
- **User guide:** link "Creating Custom Environments" to the new tutorial, and list the two process types where process types are described.
- **`docs/tutorials/README.md`:** add both tutorials to the index.

## Out of scope

- Retiring `process_tem` or any old entry point: that is the per-entry-point gate in #79.
- Rendering the run report in the UI. This plan stores it; a widget is a later plan.
- A process type for the comparison group.
- Reference inputs such as terrain and flight plans (#69). The QC checks that need them report as ungraded until then.
- `forward_tem`'s missing single-moment system type (#106).

## Decisions (2026-10-12)

1. **Home:** `aem-processes`, with the other AEM process types.
2. **Names:** `yf_process_tem` and `yf_qc_tem`.
3. **Form:** the bundled pipeline prefilled and editable.
4. **Run report:** stored with the dataset and listed in its `info.json`, as `stats.json` is.
5. **Out-of-spec QC:** completes normally with the verdict reported; only a raised step fails the version.
6. **Who:** a separate implementation session writes the process types and their tests as a pull request to `aem-processes`; Egil reviews it. Environments are built by whoever needs them with `create_environment`.

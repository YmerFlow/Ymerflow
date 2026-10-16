# Pipelines: how a YmerFlow processing chain is built, run and reported

This describes the pattern behind every step chain on the platform: `process_tem` (emerald-processing today, ymerflow-processing next), `process_mag` (AirMagTools), and the QC and comparison runners in ymerflow-processing. It is written so a new tool library can be shaped the same way from the start, whether or not it ever runs inside the platform. For the platform-side mechanics of a process type (the `schema()` / `run()` class, entry points, Docker image), see [processes.md](processes.md); this document is about what happens inside `run()`.

## 1. The idea in one paragraph

A pipeline is a document, not code. It is an ordered list of step names with their parameters, written as YAML on disk or JSON in a process record, and it is the complete description of what was done to the data. A runner walks the document against a data object, looking each step name up in a registry of plain Python functions. Every step takes the data, changes or inspects it, and returns the data plus a structured report of what it did and to how much. Nothing about what happened lives only in a notebook cell or a print statement. That is what makes a result reproducible: the document plus the library version plus the input is enough to get the same output, and the reports are enough to judge whether the output is any good without re-running it.

## 2. The three layers

| layer | what it is | where it lives | example |
|---|---|---|---|
| step library | plain functions, one decision each, registered under an entry-point group | an installable package | AirMagTools `magfilters.py`; ymerflow-processing `core/cull/*.py` |
| runner | reads a pipeline document, resolves names against the registry, calls the steps in order, collects reports, writes outputs | the same package, plus a CLI | `AirMagTools.pipeline.MagPipeline`; `ymerflow_processing.core.pipeline` |
| process type | the platform wrapper: turns the step registry into a JSON Schema form, localizes input URLs, runs the runner, writes datasets and statistics, streams the log | `docker/base-runner/*_processes/` | `aem_processes.processing_process.Processing`; `mag_processes.processing_process.MagProcessing` |

The step library is the part worth getting right, because it is the part that gets reused. The runner is small. The process type is boilerplate and is the same for every library.

## 3. The pipeline document

A YAML list. Each entry is either a bare step name or a single-key mapping of name to parameters.

```yaml
name: standard-processing
description: >
  Delivered data to inversion-ready: corrections, a noise model, uncertainties, culling, then averaging.
kind: filters          # which runner this is for; validated against the steps, not trusted

steps:
  - set_meta: {crs: 32604}
  - lowpass_filter_butterworth: {cutoff_freq: 2}
  - diurnal_qc_for_15s_chord
  - noise_qc: {mag_4th_diff_oos_threshold: 0.05}
  - write_noise_summary
```

Rules that have earned their place:

- **Order is the content.** Corrections before anything derived from them; estimate before assign; assign before average; cull before average; manual edits replay last. A wrong order does not fail, it produces plausible nonsense, so the bundled documents carry comments explaining the order.
- **Ship standard chains with the library.** Most users should load a standard chain and adjust it, never assemble one from the step list. Bundled documents live in the package (`pipelines/*.yaml`) and are read through `importlib.resources` so they exist in an installed wheel, not only a checkout.
- **A real file always wins over a bundled name.** If `standard-processing.yaml` exists in the working directory, that is what runs.
- **Validate before running.** Unknown step names are rejected at submission, not at step nine after a job has reserved its budget.
- **On the platform the same list is JSON in the process version's parameters**, one object per step keyed by the step's title, and it is stored with the outputs. That record is the provenance: [`process.versions[n].parameters.steps`](../frontend/queries.md).

## 4. The step contract

A step is a function. Its signature is its form and its docstring is its help.

```python
def cull_by_uncertainty(data, *, channel: int = 1, std_threshold: float = 0.20,
                        disable_sounding_tails: bool = True):
    """Disable gates whose relative uncertainty exceeds a threshold.

    After averaging, the STD reflects how well each stack agreed with itself;
    this is the cull that decides how deep the model is trusted.
    """
    report = StepReport(step="cull_by_uncertainty",
                        params={"channel": channel, "std_threshold": std_threshold,
                                "disable_sounding_tails": disable_sounding_tails})
    ...
    return data, report
```

- **One decision per step.** Not "process", not "qc_everything". A step that does two things cannot be reordered, swapped or turned off independently, and its report cannot say which half did the damage.
- **Parameters are keyword arguments with type hints and defaults.** The platform (via swaggerspect) turns the signature into the JSON Schema form the user sees: the name becomes the field, the annotation its type, the default its default, the docstring the description. A parameter without a default is required. Nested objects come from dict-typed parameters. Anything not expressible in the signature does not exist to the UI.
- **Every value the step used goes in the report**, including the defaults nobody typed. "What parameters actually ran" is the first question a year later.
- **Take the data object, return the data object.** Mutating in place and returning `None` is tolerated by the AirMagTools runner and is the source of "which step changed this column" mysteries. Return it.
- **Add columns, do not remove data.** A cull writes a mask (`InUse_Ch01`, `mag_4th_diff_oos_mask`), it does not delete rows. Downstream steps and the inversion read the mask. A dropped row cannot be undone and cannot be counted.
- **Declare what you wrote.** A step that writes a per-sounding verdict names the column in its report (`verdict_column`), so a later step or a UI can find it without sniffing dtypes.
- **Do not judge without a threshold, and say so.** A QC step with no thresholds supplied measures and reports the distribution, and marks itself `ungraded: "unjudged"`. Silent "pass" is the failure mode this exists to prevent.
- **Distinguish absent-and-fine from absent-and-wrong.** An input that is legitimately missing (a data-misfit check on data that was never inverted) is `ungraded: "optional"`. An input that should have been there and was not is `ungraded: "missing"`, which is a finding about the run, not about the flight. Six checks once failed to find their columns on a real delivery while the run exited 0 and read as a clean survey.
- **Stable names.** The entry-point name is the step's identity in every stored document. Renaming a step breaks every pipeline that mentions it.
- **Steps are for the library, not the project.** Anything with a client's name, path or threshold baked in is a pipeline document, not a step.

## 5. Registration

Steps are found through entry points, so any installed package can contribute and there is no central registry file to edit.

```python
# setup.py
entry_points={
    "ymerflow.processing.filters": [
        "cull_by_uncertainty = mylib.cull:cull_by_uncertainty",
    ],
    "ymerflow.processing.qc": [
        "drape_qc = mylib.qc:drape_qc",
    ],
    "console_scripts": [
        "mylib = mylib.cli:main",
    ],
}
```

One group per runner shape. ymerflow-processing uses three because there are three genuinely different shapes and the report each produces is different:

| group | shape |
|---|---|
| `ymerflow.processing.filters` | dataset → dataset (changes the data) |
| `ymerflow.processing.qc` | dataset → dataset + verdicts (adds masks and reports, changes no values) |
| `ymerflow.processing.compare` | N reports → one report (a drift or outlier verdict across runs) |

AirMagTools uses one group, `mag_pipeline.filters`, for everything. emerald-processing uses `emeraldprocessing.pipeline_step`. The runner loads the group with `importlib.metadata.entry_points(group=...)` and the platform's process type calls swaggerspect on the same group to build the form. Adding a step is a function plus one line in `setup.py`; nothing else changes. Keeping QC separate from filters is worth the second group: a QC pipeline run through the filter runner silently changes nothing and reports nothing, and the separation is what lets the runner refuse.

## 6. The runner

Small, and the same in every library.

```python
def run(pipeline: Pipeline, data, registry: dict[str, Callable]) -> tuple[Any, RunReport]:
    pipeline.validate(registry)                       # fail before step one
    run_report = RunReport(pipeline=pipeline.document, identity=data.identity(), ...)
    for name, params in pipeline.steps:
        log.info("step %s %s", name, params)          # diagnostics, streamed live
        data, report = registry[name](data, **params)
        run_report.steps.append(report)               # the record
    return data, run_report
```

It logs a line per step so a watcher can follow progress, collects the reports so the record is complete, and never interprets the data itself. A CLI wraps it: `mylib run <pipeline> --in <file> --out <dir>`, plus `mylib list --group qc` and `mylib show <pipeline>` so a user can see the standard chain and copy it before editing.

## 7. Output: three channels, and what goes in each

This is the part the question was really about. Every step produces something in each of three places, and they are not interchangeable.

### 7.1 The log

`print()` or `logging`. Streamed live to the process log in the UI and kept with the version. This is for diagnostics and progress: which step is running with which parameters, a column that was missing and filled, a warning from a library, timing. It is for a human watching the job. It is not the record, because nobody parses it later.

Minimum per step: one line at the start with the name and the parameters actually used, and one line at the end with the headline count ("disabled 4,182 of 61,250 gates").

### 7.2 The step report

A structured value the step returns and the runner stores. In ymerflow-processing it is a `StepReport` dataclass; the shape is what matters, not the class:

| field | what it holds | why |
|---|---|---|
| `step` | the registered name | ties the report to the document |
| `params` | every parameter used, defaults included | "what actually ran" |
| `soundings_total` / `soundings_affected` | how much was touched out of how much, per sounding | the headline count |
| `points_total` / `points_affected` | the same per gate or sample | a cull of 2% of gates on 90% of soundings is a different thing from the reverse |
| `verdict_column` | the mask or verdict column this step wrote, if any | so the next thing can find it |
| `finding` | what kind of problem a verdict describes: `flight`, `instrument`, environmental | a dead sensor must not read as a badly flown line |
| `ungraded` | why no verdict was produced: `unjudged`, `optional`, `missing` | the three look identical in a table and are not |
| `distributions` | the distribution of the thresholded quantity, before and after | turns "disabled 4,182 gates" into something a user can judge |
| `notes` | anything worth surfacing that is not a failure: an overwritten column, a series dropped for a missing input | the things that otherwise end up only in the log |

A `RunReport` collects the step reports in order and adds identity: a human label for the run (normally the delivered file name), and, read from the data rather than the invocation, the flights it contains and its time range. The second pair is what a drift check orders by, because a file name changes on re-export and the flight dates do not.

The report is what the process record stores and the UI renders. It is also what the comparison runner reads, so it must be JSON: `to_dict()` on every report class, nothing that needs the library installed to read.

The older form of the same idea is AirMagTools' summary files: `oos_drape.csv`, `oos_diurnal.csv`, `oos_4th_difference.csv`, one row per out-of-spec line or segment with counts, lengths and averages. Those are step reports written to disk instead of returned, and they are why a mag QC run can be handed to a client. A new library should return the report and let the runner decide where it goes; a CSV writer is then one step at the end of the chain, not something every QC step does for itself.

### 7.3 Dataset statistics

Computed by the runner on the output dataset after the last step, stored beside it, served as `application/vnd.ymerflow.stats+json`. Per column and, for layered or gated arrays, per layer: count, min, max, mean, RMS, geometric mean, standard deviation, the 5/25/50/75/95 percentiles, skewness, kurtosis, all to six significant figures, with constant columns collapsed to a single value. See `aem_processes/stats.py`.

This is what makes an output inspectable without downloading it. "Did the cull remove the late gates" is a per-gate count. "Did the noise floor take over at gate 20" is a per-gate median of the STD column. An agent or a user reads the JSON, not the msgpack. Every step library's runner should compute the same statistics on its own output format, for the same reason.

### 7.4 What each channel is for

| question | channel |
|---|---|
| is it still running, what is it doing | log |
| what did step 7 do, to how much, with what parameters | step report |
| what does the output look like, column by column | dataset statistics |
| what was the chain | the pipeline document, stored with the version |

If something is only in the log, it will be lost. If something is only in the statistics, nobody will know which step did it. If something is only in a notebook, it did not happen.

## 8. The data object

One container class per method, holding the per-sample table, the per-line or per-sounding metadata, and the survey description. `MagData` wraps a pandas frame indexed by line with `meta` for CRS, diurnal station and sample rate. The AEM `XYZ` holds `flightlines` (one row per sounding), `layer_data` (one frame per gated or layered array, one column per gate), `model_info`, and the GEX. The conventions that matter:

- **Load and save are methods on the container**, to one on-disk format that round-trips everything including metadata (`.mag.zip`, msgpack). A pipeline that starts from a CSV and ends in a CSV loses its provenance at both ends.
- **Column naming is a standard, applied at import.** The AEM side normalizes to the ALC names (`Gate_Ch01`, `STD_Ch01`, `InUse_Ch01`, `TxAltitude`), so every step can rely on them. Do the equivalent once, at import, and never again in a step.
- **Identity is read from the data.** Lines, flights and time range are properties of the container, not arguments to the run.
- **Masks are columns.** `InUse_*`, `*_oos_mask`. Integer or boolean, same length as the data, written by the step that decided them, read by whatever comes after.

## 9. A template for a new library

```
mylib/
  mylib/
    __init__.py
    data.py          # the container: load, save, identity, columns, masks
    steps/           # one module per family: geometry.py, filters.py, qc.py, summaries.py
    report.py        # StepReport, RunReport, to_dict
    pipeline.py      # Pipeline (parse/load/validate/steps), run(), load_steps(group)
    stats.py         # column and per-layer statistics on the output
    cli.py           # run / list / show
    pipelines/       # bundled standard chains, YAML with comments explaining the order
  tests/
    test_steps.py    # each step on a small synthetic dataset: result plus report fields
    test_pipeline.py # a bundled chain runs end to end and its reports are JSON
  setup.py           # entry points: one group per runner shape, plus the CLI
  README.md
```

Checklist for a step before it is registered:

1. One decision. Name is `verb_object`.
2. Keyword parameters with type hints, defaults and a docstring that says what the threshold means and where the default came from.
3. Takes the container, returns the container and a report.
4. Writes columns or masks; deletes nothing.
5. Report has: name, every parameter used, total and affected counts, the verdict column if it wrote one, the distribution it thresholded on, and `ungraded` set when it could not judge.
6. One log line at start with parameters, one at end with the headline count.
7. Has a test on synthetic data that checks the report, not only the output.
8. Appears in at least one bundled pipeline document, with a comment on where in the order it belongs and why.

## 10. Where the existing libraries deviate, so you do not copy the deviations

- AirMagTools steps take `(pipeline, data, **params)` and many mutate in place and return `None`; the runner tolerates it. New code should return the data.
- AirMagTools reports through CSV writers and a `print`; there is no returned report object. The summaries are good, the mechanism is the old one.
- emerald-processing's step titles are prose ("STD error: Add from noise model") rather than identifiers, so the stored JSON is keyed by a display string. Use the entry-point name as the key and let the UI carry a title.
- `process_tem` prints the whole parameter dict on every run. Fine for a job log, not a substitute for the report.

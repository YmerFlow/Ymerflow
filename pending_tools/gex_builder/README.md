# GEX builder — working framework

Prototype for building a system geometry file (`.gex`) from a manufacturer's
reference waveform and gate report. The goal is that **any** system gets a
geometry file, not only the SkyTEM systems already in `gex/SkyTEM/`.

The worked example throughout is the **Xcalibur HeliTEM 21m** system, at base
frequencies of 7.5, 15 and 30 Hz. Nominal transmitter current 220 A, nominal
dipole moment 304,480 A·m², 4 turns, 25 gates.

This is a lift of exploratory notebooks, not a finished tool. The maths works;
the packaging does not exist yet.

## What is here

| | |
|---|---|
| `waveform_resampling.py` | the library — waveform downsampling, gate/trapezoid plotting, ASCII parsing |
| `notebooks/Waveform.ipynb` | walk a reference waveform to 21 GEX waveform points |
| `notebooks/Gate_times.ipynb` | gate table → `GateTime01..25` lines, plus averaging-window plot |
| `examples/` | example inputs and the reference outputs to check against |

## The problem it solves

A GEX wants the transmitter waveform as **21 points**. A vendor reference
waveform is thousands of samples. Picking those 21 by hand is tedious and
inconsistent, and the turn-off ramp is where accuracy actually matters — that
is the part the early gates see.

`max_error_downsampling` does an Iterative Max Error walk: start with the
endpoints, repeatedly insert the sample with the largest perpendicular
deviation from the current polyline, stop at 21. A `tail_weight` multiplier
biases insertions toward the turn-off, so the ramp gets points in proportion to
how much it matters rather than how long it lasts.

An RDP variant (`rdp_split_downsampling`) is retained for comparison. IER is the
one to use — it hits the point budget exactly, which RDP can only approach.

## Running it

```
cd notebooks && jupyter lab Waveform.ipynb
```

Inputs resolve to `../examples`. Defaults are set for the 15 Hz example. For the
others, change the filename and the turn-off sample:

| base frequency | reference waveform | `zero_time_index` |
|---|---|---|
| 7.5 Hz | `HeliTEM21m_reference_waveform_7_5Hz.txt` | 2791 |
| 15 Hz | `HeliTEM21m_reference_waveform_15Hz.txt` | 1430 |
| 30 Hz | `HeliTEM21m_reference_waveform_30Hz.txt` | 739 |

`HeliTEM21m_reference_gex_7_5Hz.gex` and `..._15Hz.gex` are GEX files that
were built by hand from these same inputs. They are the check: the 21
`WaveformPoint` lines the notebook prints should land close to theirs. The 30 Hz
GEX has not been located.

Requires `pandas`, `numpy`, `matplotlib`, `rdp`.

## Input formats

**Reference waveform** — ASCII, `/`-escaped header, parsed by
`read_ascii_file_custom`. It needs `Base Frequency` and `Sample Interval` in the
header, the last header line as column names, and a `T_Current[A]` column.
Sample interval here is 8.1380208 µs.

**Gate report** — plain text; the gate table is currently pasted into
`Gate_times.ipynb` as a literal rather than parsed. See TODO.

**Channels archive** — `HeliTEM21m_channels_archive.txt` lists the channel names, units and
descriptions from the survey archive. Not used by the notebooks yet, but it is
the natural basis for generating an **ALC** alongside the GEX, since it already
carries the mapping from archive column to physical meaning.

## What still needs doing

The notebooks are a working sketch. To become a GUI tool:

1. **Parse the gate report** instead of pasting the table. The format is regular
   — a metadata block, then a fixed-width table. `Gate_times.ipynb` currently
   carries the numbers as literals for 7.5 and 15 Hz, which does not scale.
2. **Emit a GEX**, rather than printing `WaveformPoint01 = ...` lines to be
   copied by hand. Nothing writes a file today.
3. **Pull `[General]` from the gate report and the archive.** Nominal current
   (220 A), dipole moment, loop geometry and turns are all available across the
   two inputs; today they are typed in.
4. **Pick the turn-off automatically.** `zero_time_index` is found by eye from a
   plot. `find_zero_crossings` gets close but the last crossing before the ramp
   still needs judgement.
5. **Generalise beyond one vendor's ASCII layout.** `read_ascii_file_custom`
   assumes a `/` escape and a specific header shape.
6. **ALC generation** from the channels archive, so import mapping ships with
   the geometry.
7. **Decide the versioning story** — a geometry file is an input to every
   downstream process, so building one in the GUI has the same reproducibility
   requirements as replacing one.

## Provenance and scrubbing

The example data derives from a commercial survey flown with this system. The
**system identity is deliberately retained** — a geometry file is meaningless
without knowing which instrument it describes, and the instrument is a
commercial product, not confidential. What was removed is everything that
identifies the *survey*:

- Client name, site name and project number removed from every filename and
  path.
- `/Calibration Data [FLT n Cal# n Start FID nnnnn End Fid nnnnn]` headers
  stripped from all three reference waveforms — those were flight numbers and
  fiducial ranges from the actual acquisition.
- dB/dt X/Y/Z columns dropped from the reference waveforms. They were the
  measured calibration response and the tool does not use them; only
  `T_Current[A]` is needed.
- All notebook outputs stripped, including a directory listing of a working
  folder.
- Files re-encoded latin-1 → UTF-8.

`make_example_waveform.py` generates a synthetic waveform in the same format. It
is a fallback for running the notebooks with no vendor data at all.

# GateAnomalyPlot: an optional correction for transmitter height

**Status:** implemented. Decisions made 2026-10-29. The height variable was revised the same day, from log10(height) to height in meters; see [Why height in meters](#why-height-in-meters). Builds on the `GateAnomalyPlot` layer (#123; plan in `docs/plans/done/gate-diff-section.md`).

## Motivation

GateAnomalyPlot colors each cell by the gate's departure from its own running median along the line. The running median absorbs height changes slower than its window, but not fast ones. A climb over a powerline or another obstacle lowers the signal at the early gates, and the section shows it as a brown column that reads like a feature. An optional correction removes the part of each gate's anomaly that the transmitter height explains.

## Decisions

| | |
|---|---|
| **Height enters in meters, detrended like the data** | the height anomaly is the height minus its running median over the same ±`window_m`; height enters the response only through a factor e^(−2λh), so to first order log amplitude is linear in height in meters |
| **One slope per gate per line, fitted by least squares on in-use cells** | a fit local to the window would also absorb real features wherever height happens to correlate with them |
| **A toggle, off by default** | the uncorrected section stays the reference; a corrected pane beside an uncorrected one shows what the correction removed |

## What it computes

For each line (a run of non-decreasing `xdist`, as for the median) and each gate *g*:

- *a*(i) is the anomaly the layer draws today: log10(value) − log10(running median of the gate's in-use values).
- *η*(i) = *h*(i) − the running median of *h* over ±`window_m`, in meters, where *h* is the transmitter height above ground. Height has no in-use flag, so its median uses every sounding with a positive height.
- *b_g* = Σ *a*(i) *η*(i) / Σ *η*(i)², in decades per meter, over the line's in-use cells of gate *g* where both are finite. Both terms are median-centered, so the fit goes through the origin. A line with no height variation (Σ *η*² = 0) gets *b_g* = 0.
- The corrected anomaly is *a*(i) − *b_g* *η*(i), for every cell that has a value, in use or not, as today. A cell whose sounding has no positive height has no corrected value and is drawn grey.

The slopes should come out negative, since a higher transmitter means a weaker signal, and largest in magnitude at the early gates.

**Known limitation.** Pilots climb over powerlines, so the highest soundings are often also coupled. Coupled cells that are still in use bias the slope toward explaining coupling as height, and the correction then partly hides real coupling. Fitting in-use cells only limits this; the toggle being off by default, and a corrected pane next to an uncorrected one, are the check.

## Why height in meters

In a 1D forward model the transmitter height enters the earth's response through a single per-sounding factor. In the Hankel transform

$$G(\omega) = \int_0^\infty r_{TE}(\omega,\lambda) \left[ C_0(\lambda)\, J_0(\lambda r) + C_1(\lambda)\, J_1(\lambda r) \right] \lambda\, d\lambda, \qquad C_k(\lambda) = A_k(\lambda)\, e^{-\lambda c}\, e^{-2\lambda h}$$

the reflection coefficient $r_{TE}$ carries the earth model, the coupling kernels $A_k$ and the offset $c$ depend only on the system geometry, and $h$ is the transmitter height. The frequency-to-time transform, the waveform convolution and the gate integration that follow are linear and do not involve $h$. Each gate's response $d_t$ is therefore a weighted sum over $\lambda$ of $e^{-2\lambda h}$, and expanding its logarithm about a reference height $h_0$ gives

$$\ln d_t(h) = \ln d_t(h_0) - 2\langle\lambda\rangle_t\, \Delta h + 2\, \mathrm{Var}_t(\lambda)\, \Delta h^2 + O(\Delta h^3), \qquad \Delta h = h - h_0$$

where $\langle\lambda\rangle_t$ and $\mathrm{Var}_t(\lambda)$ are the mean and variance of $\lambda$ under that gate's weights (effective values, since the weights need not be positive). To first order, log amplitude is linear in height in meters, with a per-gate slope of $-2\langle\lambda\rangle_t / \ln 10$ decades per meter. It is steepest at the early gates, which short wavelengths dominate. A fit in log10(height) is also first order, but in a variable that matches only when a gate's spectrum makes the response a power law in height.

The first-order error grows as $\mathrm{Var}_t(\lambda)\, \Delta h^2$: small height changes are corrected well, and large climbs keep a residual. If corrected panes still show columns at large climbs, the next step is a squared term, two coefficients per gate at the same cost; it is out of scope here.

## Which height

The transmitter height above ground, not its elevation. The layer finds it the way libaarhusxyz's `alt_column` does: the first of `tx_altitude`, `alt`, `TxAltitude`, `tx_alt`, in any capitalization, among the dataset's flightline columns. The `altitude_column` parameter overrides that. If the correction is on and no height column is found, the layer draws nothing and logs an error naming the columns it looked for, so a pane never looks corrected when it is not.

Some deliveries derive the transmitter height as the bird's GPS elevation minus a DEM, so DEM errors carry into it. For the fast climbs this correction targets, measured and derived heights agree.

## Layer parameters

| Parameter | Default | |
|---|---|---|
| `altitude_correction` | `false` | remove the height term from each gate's anomaly |
| `altitude_column` | `""` | the transmitter height column; empty means look it up as libaarhusxyz does |

The correction is recomputed when the dataset, the window, the in-use mask, the toggle or the column changes, not on every edit, as for the median.

## Work

1. `frontend/src/widgets/PlotView/gateAnomaly.js`: the height anomaly, the per-gate slope fit and the corrected column, kept free of gladly like the median.
2. `frontend/src/widgets/PlotView/elements/GateAnomalyPlot.js`: the two parameters, the column lookup, and the cache key extended with the toggle and the column.
3. `docs/frontend/widgets.md`: the parameters and the known limitation.

## Tests

- Unit: on a synthetic part of two lines, with a height bump, known per-gate slopes and noise, the fitted slopes and corrected anomalies match a numpy least-squares reference; culled cells are left out of the fit; a line at constant height gets a slope of 0; with the toggle off the anomaly is unchanged.
- Unit: the column lookup finds each candidate name in any capitalization, and `altitude_column` overrides it.

## Out of scope

- The exact correction: forwarding each sounding at its measured height and at a reference height. Since $r_{TE}$ does not depend on $h$, the second height costs little beyond the first forward, but it needs a model for every sounding (a half-space fit, or the last inversion) and the forward model, so it belongs in a processing job, not in a browser view.
- A squared height term in the fit (see [Why height in meters](#why-height-in-meters)).
- Showing the fitted slopes in the UI.
- Corrections for transmitter pitch and roll.

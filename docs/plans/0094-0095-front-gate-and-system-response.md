# Front gate and measured system response in the TEM forward model

Tickets: https://github.com/YmerFlow/Ymerflow/issues/94 (front gate) and https://github.com/YmerFlow/Ymerflow/issues/95 (measured system response).

Scoping, 2026-10-22, updated the same day from the AarhusInv manual (version 8, sections 6.1, 6.2 and 6.5), which answers most of what was open; what it does not answer is under "Unknowns". Not yet a plan. Order agreed earlier: the parametric off-time forward first, the system response after.

## Where the forward stands

Measured on the public benchmark, line 300901: our forward of AGF's published model divided by Aarhus Workbench's forward response of the same model, which ships with the demo data (`inversion_forward_response_line_300901.xyz`), median over soundings, per gate. Details and history are on #94.

| LM gate (time) | no receiver filters | receiver filters on |
|---|---|---|
| 5 (8 µs) | 0.81 | 0.95 |
| 6 (10 µs) | 0.78 | 0.91 |
| 7 (13 µs) | 0.81 | 0.92 |
| 12 (42 µs) | 0.92 | 0.96 |
| 20 (275 µs) | 0.97 | 0.98 |
| HM 10–31 | 0.94–0.98 | 0.98 |

The receiver low-pass filters the GEX declares are now applied on simpeg `ymerflow-master` (ported 2026-10-14). Two things remain:

1. **5–9% low at 8–16 µs, gone by about 40 µs.** The shape the front gate would leave.
2. **A flat ~2% low at every gate on both moments.** Not a filter and not the front gate.

## What the AarhusInv manual settles

- **The receiver chain is as assumed:** filters before the front gate, the front gate, filters after it (section 6.2). The front gate requires at least one filter before it, and each front gate is given as a time in seconds.
- **Times are measured from the start of the turn-off ramp,** for gate centers and, by the manual's convention, the front gate.
- **AarhusInv integrates over the gate window** when gate open and close times are given, rather than sampling the gate center. Check whether the fork samples centers; at 8–16 µs the response changes fast enough across a gate for this to matter.
- **The SkyTEM coil filter is not the filter we model.** A filter order that is a real number between 0 and 1 means a Gaussian RLC filter with that damping factor, and it is only allowed before the front gate. `RxCoilLPFilter1 = 0.99 210E+3` is therefore a second-order RLC filter with damping 0.99 at 210 kHz. The fork passes 0.99 to SimPEG as `lp_power_1`, a fractional-order Butterworth-type filter. Different shape and different delay, at exactly the earliest gates. **Cheapest single fix on this list; measure it first.**
- **The primary-field damping factor** belongs to the front gate. The SkyTEM GEX carries it per channel as `PrimaryFieldDampingFactor` (1e-6 LM, 0.01 HM on the 304).
- **System response (waveform type 5)** is the convolution of the **step** response with a measured response that contains the waveform, the receiver and the amplifier. With it, **no waveform, no filters and therefore no front gate** are modeled. Output is always dB/dt. It is only allowed for source type 73, so **`LoopType` 73 is a segmented loop used with a system response.** AarhusInv also has type 6, a synthetic system response built from the waveform and filters and convolved the same way, which is the parametric case expressed as an operator.
- **AarhusInv's own system-response file (`.ssr`)** holds, per response: number of waves, the period (start of one wave to the start of the next), an amplitude pattern multiplying each wave, then the sample times and values. Several samples may share a time, so square pulses are written as repeated times; the manual notes instability for time steps near 1e-16 s. The SkyTEM `.sr2` maps onto it: its repetitions are the number of waves, `SignPattern` the amplitude pattern, the samples the response. The period presumably comes from `RepFreq`; to confirm.
- **Convolution sampling** is a coarsest step refined by powers of two (`SRConvCoarsestSampling`, `SRConvNSamplingSteps` in AarhusInv's settings). A starting point for ours.

## One mechanism for both: a linear system operator per channel

Everything between the earth and a gate value is linear in the earth response: the waveform convolution, the coil filter, the front gate, the board filter, and the averaging over each gate window. So each channel's whole system is one matrix that takes the earth response, sampled densely in time through turn-off, to the channel's gate values.

- The forward is that matrix times the dense response.
- The Jacobian is that matrix times the dense Jacobian.
- The parametric description (waveform, filters, front gate) and the measured system response are two ways of building the matrix. Nothing downstream needs to know which one a channel uses.

This belongs in the simpeg fork's `static_instrument`, beside the waveform and filters it already builds from the GEX. It models the instrument; it does not transform data, so it is consistent with the channel-identity plan's rule that the inversion applies nothing to its inputs.

**Cost:** the response is computed at roughly 100–200 times instead of the ~28 gate times, for the forward and the Jacobian. To be measured on the benchmark line before it becomes the default.

## Front gate (#94)

**What the GEX declares.** `FrontGateDelay` in `[General]` (2.5 µs on the SkyTEM 304) and `FrontGateTime` per channel (−0.5 µs LM, 70 µs HM on the 304 we ship). Every SkyTEM GEX we ship declares both; the fork reads neither.

**What it is.** A switch at the receiver input that keeps the electronics blocked through turn-off and opens at a set time. The coil filter (`RxCoilLPFilter1`, a Gaussian RLC filter) acts before it and the board filter (`TiBLowPassFilter`, Butterworth) after it, with the primary field that reaches the gate scaled by `PrimaryFieldDampingFactor`. The chain for a parametric channel is:

    earth response ∗ waveform → coil filter → front gate opens → board filter → average over each gate window

**Why SimPEG cannot do it as is.** SimPEG applies the receiver filters as factors in the frequency domain. A switch at an instant in time, between two filters, has no such form. It has to be applied to a time-sampled signal, which is what the operator above does.

**Steps.**

1. Replace the coil filter with the Gaussian RLC filter the GEX declares, and measure on the benchmark before anything else.
2. Pin down how the GEX's `FrontGateTime` (per channel) and `FrontGateDelay` (general) become AarhusInv's single front-gate time. The manual describes AarhusInv's input, not the GEX. Build each reading and keep the one that reproduces the Workbench forward on line 300901.
3. Build the operator for parametric channels: waveform, coil filter, front gate with primary-field damping, board filter, integration over each gate window.
4. Wire it into `make_system`, behind an option that reproduces today's results when off.
5. Release note: every forward and inversion result changes at the earliest gates.

## The flat ~2% (also #94)

The leading suspect is the transmitter: `make_system` models it as one point dipole at the frame center, while the SkyTEM receiver sits 0.7 m outside the loop wire (`RxCoilPosition1 = -13.25 0.00 -2.00`, rear wire at x = −12.55). A point dipole is a poor stand-in for a 342 m² loop that close to the wire.

**Cheap check, first:** model the loop as many small dipoles over its area (exact for a closed loop, and possible in the 1D code as a sum of sources), compare with the point dipole at the receiver position, and see whether the difference is a flat ~2%. Then the loop area and turns, and the ramp.

## Measured system response (#95)

### What a system-response GEX changes

In a SkyTEM 304 system-response GEX compared with the ordinary XYZ GEX of the same system, everything is identical, waveforms included, except five keys, and only on the LM channel. HM stays parametric.

| key | ordinary | system response |
|---|---|---|
| `SystemResponseConvolution` (LM) | 0 | 1 |
| `LoopType` | 72 | 73 |
| `GateTimeShift` (LM) | about −1.8 µs | 0 |
| `RemoveInitialGates` (LM) | 5 | 1 |
| `SignPattern` (LM) | absent | `1 -1` |

`RemoveInitialGates` dropping from 5 to 1 is the payoff: four more early LM gates usable, which is where the top few meters are resolved, and where the benchmark inversions put their artifact.

### The `.sr2` file

- Line 1: a comment.
- Line 2: channel number, number of repetitions, number of data points, and a begin and end date and time between which the measured response is valid.
- Then one `time amplitude` pair per line: times from the on-time (about −0.8 ms) through turn-off to a few µs after it, in seconds.

libaarhusxyz already reads it (`libaarhusxyz/sr2.py`, 2021): header fields plus the sampled response as an array.

### Modeling

For a channel with `SystemResponseConvolution=1`, the gate values are the gate integrals of the measured response convolved with the earth's **step** response, summed over the repetitions with the signs given by `SignPattern` (the bipolar stacking), and with no waveform, filters or front gate applied on top. In the operator above that is simply a different matrix for that channel.

### Platform

- A system carries its `.sr2` file(s) alongside the GEX.
- **A survey can have several `.sr2` files, each valid for a date range.** Each sounding uses the one whose range covers its timestamp, and a sounding no file covers is refused, not modeled with the nearest.
- Import and the system picker take the GEX and its `.sr2` together and show which channels use the measured response.

## Unknowns the manual does not settle

The manual describes AarhusInv's own input files, not the GEX, so what remains is the GEX-to-AarhusInv translation that Workbench performs:

- **Front gate:** how `FrontGateTime` and `FrontGateDelay` combine into AarhusInv's single front-gate time.
- **System response:** the units and normalization of the `.sr2` samples (amplitudes run to about 10¹¹), and whether the period is taken from `RepFreq`.
- **Previous pulses:** AarhusInv's waveform and system-response inputs carry the repetitions explicitly; whether the fork models earlier pulses at all. A late-time effect, to check separately.

All three can be settled against a Workbench forward response, which is why each step below is accepted against one.

## Order and acceptance

1. **The flat ~2%:** point dipole against the distributed loop.
2. **Operator layer and front gate,** validated against the Workbench forward on line 300901. Accepted when our forward matches it within the data uncertainty at every gate, LM gates 5–7 included.
3. **Measured system response** on the same layer, once the specification is in hand and a validation set exists.

**Needed from outside:** one survey with a system-response GEX, its `.sr2`, and a Workbench forward or inversion run that used them, to validate step 3 the way line 300901 validates step 2.

## Effort

Focused working days with an AI coding assistant, for someone who knows the fork. Calendar time at evening pace is roughly two to three times longer.

| piece | days | main risk |
|---|---|---|
| Gaussian RLC coil filter, measured on the benchmark | 0.5 | none |
| Distributed-loop check for the flat ~2% | 0.5–1 | if the loop is not the cause, the search continues |
| Operator layer (dense response, waveform, filters, front gate, gate integration, Jacobian) | 2–4 | Jacobian wiring into the stitched simulation |
| Front-gate convention matched to the Workbench forward on line 300901 | 1–3 | no reading matches, and Aarhus has to be asked |
| Performance, inversion path, tests, release note | 1–2 | dense sampling too slow for whole surveys |
| **Front gate total** | **5–10** | |
| `.sr2` to operator (period, pattern, convolution sampling) | 2–3 | units and normalization |
| Platform: `.sr2` stored with the system, date-range selection per sounding, import and system picker | 3–5 | none technical |
| Validation against a Workbench system-response run | 1–3 | blocked until such a dataset exists |
| **System response total, after the operator layer** | **6–11** | |

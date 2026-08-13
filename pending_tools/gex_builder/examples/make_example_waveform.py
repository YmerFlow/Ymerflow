#!/usr/bin/env python3
"""Generate a synthetic reference-waveform file in the ASCII format that
``waveform_resampling.read_ascii_file_custom`` expects.

Fallback for running the notebooks with no vendor data present at all. The shape is a
generic bipolar transmitter pulse — negative tail from the previous half
cycle, exponential rise, a slightly drooping on-time, and a convex turn-off
ramp. It is illustrative, not any manufacturer's actual waveform.

The 15 Hz file is built so that the turn-off lands on sample 1430, which is
what ``Waveform.ipynb`` uses for ``zero_time_index``.
"""
import numpy as np, pathlib

DT_US = 1.0                       # sample interval, microseconds
I_NOM = 250.0                     # nominal on-time current, amperes


def build(n_samples, i_rise, i_flat, i_off_end, tail_n=20):
    i = np.arange(n_samples, dtype=float)
    cur = np.zeros(n_samples)

    tail = i < tail_n                                   # previous half cycle
    cur[tail] = -6.0 * np.exp(-i[tail] / 8.0)

    rise = (i >= tail_n) & (i < i_flat)                 # ramp on
    cur[rise] = I_NOM * (1.0 - np.exp(-(i[rise] - tail_n) / i_rise))

    flat = (i >= i_flat) & (i < i_off_end - 30)         # on-time, slight droop
    cur[flat] = I_NOM * (1.0 - 0.01 * (i[flat] - i_flat) / (i_off_end - 30 - i_flat))

    off = (i >= i_off_end - 30) & (i <= i_off_end)      # turn-off ramp
    cur[off] = cur[i_off_end - 31] * ((i_off_end - i[off]) / 30.0) ** 1.35

    cur[i > i_off_end] = 0.0
    return cur


def write(path, base_freq_hz, cur):
    with open(path, "w", encoding="utf8") as f:
        f.write("/ Synthetic reference waveform — illustrative only\n")
        f.write(f"/ Base Frequency: {base_freq_hz:.7f} Hz\n")
        f.write(f"/ Sample Interval: {DT_US:.7f} µs\n")
        f.write("/ Sample T_Current[A] dB/dt_X[nT/s] dB/dt_Y[nT/s] dB/dt_Z[nT/s]\n")
        for k, c in enumerate(cur):
            f.write(f"{k:6d} {c: .7e} {0.0: .7e} {0.0: .7e} {0.0: .7e}\n")
    print(f"  wrote {path.name}  ({len(cur)} samples, turn-off at "
          f"{int(np.argmax(cur <= 0.0) if (cur<=0).any() else -1)})")


if __name__ == "__main__":
    here = pathlib.Path(__file__).parent
    write(here / "synthetic_waveform_15Hz.txt", 15.0,
          build(1501, i_rise=45.0, i_flat=200, i_off_end=1430))
    write(here / "synthetic_waveform_7_5Hz.txt", 7.5,
          build(3001, i_rise=60.0, i_flat=260, i_off_end=2900))

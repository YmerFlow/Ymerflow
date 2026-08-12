#!/usr/bin/env python3
"""Noise envelopes before and after lateral averaging — vector SVG for the decks.

Answers: what uncertainty should a raw sounding carry, and what should an averaged
one carry?

The error model has two terms that behave completely differently under stacking:

    sigma_abs(t) = noise_level_1ms * (t / 1ms)^-0.5 / dipole_moment     ambient noise
    sigma_rel(t) = r * |d(t)|                                           calibration/geometry

Combined in quadrature. Stacking N soundings averages down the *random* ambient term
by sqrt(N); it does nothing to the relative term, which is correlated between
neighbouring soundings.

    raw          sigma = sqrt( sigma_abs^2            + sigma_rel^2 )
    averaged(N)  sigma = sqrt( (sigma_abs/sqrt(N))^2  + sigma_rel^2 )

Consequence, and the point of the figure: stacking buys usable late-time gates and
buys nothing early, where you are already sitting on the relative floor.

Signal is the real forward response from the Arbuckle v2 model (background sounding,
SkyTEM 306HP high moment), not an idealised decay.
"""
import sys, pathlib
import numpy as np
import matplotlib
matplotlib.use("svg")
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker

FM = pathlib.Path("/Users/bbloss/Library/CloudStorage/Dropbox-BlossGeo/Benjamin Bloss/"
                  "Arbuckle_Working/Forward_Model")
sys.path.insert(0, str(FM / "scripts"))
import xyzcodec as C

OUT = pathlib.Path(__file__).parent

NOISE_1MS = 1e-9     # V/m^2 at 1 ms, as applied in processing
NOISE_EXP = -0.5
R_REL     = 0.03     # GEX UniformDataSTD — the relative floor
STACKS    = [(3, "#3987e5"), (11, "#199e70")]   # 3-sounding (~9 m), 11-sounding (~33 m)


def as2d(dd):
    ks = sorted(dd.keys(), key=lambda k: int(k))
    return np.column_stack([np.asarray(dd[k], dtype=float) for k in ks])


def main():
    d = C.load(str(FM / "data" / "prop_fwd2.msgpack"))
    x = np.asarray(d["flightlines"]["xdist"], dtype=float)
    t = np.asarray(d["system"]["General"]["GateTimeHM"], dtype=float)[:, 0]
    moment = float(d["system"]["Channel2"]["ApproxDipoleMoment"])

    # background sounding, well away from both faults
    g = np.abs(as2d(d["layer_data"]["Gate_Ch02"]))
    i = int(np.argmin(np.abs(x - 1000.0)))
    sig = g[i]
    ok = np.isfinite(sig) & (sig > 0) & (t > 0)   # drop front-gate times before turn-off
    t, sig = t[ok], sig[ok]
    tms = t * 1e3

    sig_abs = NOISE_1MS * (t / 1e-3) ** NOISE_EXP / moment   # ambient floor
    sig_rel = R_REL * sig                                     # relative floor

    def envelope(n):
        return np.sqrt((sig_abs / np.sqrt(n)) ** 2 + sig_rel ** 2)

    fig, (ax, axr, ax2) = plt.subplots(
        3, 1, figsize=(11.6, 9.4), height_ratios=[1.5, 0.14, 1.0],
        gridspec_kw=dict(hspace=0.0))
    fig.subplots_adjust(hspace=0.0)

    raw = envelope(1)
    CULL = 20.0   # % — the cull threshold the crossings are measured against

    def frac(n):
        return envelope(n) / sig * 100

    def cross_at(n, pct=CULL):
        """(time_ms, signal_amplitude) where the assigned uncertainty reaches pct."""
        f = frac(n)
        k = np.where(f >= pct)[0]
        if not len(k) or k[0] == 0:
            return None, None
        j = k[0]
        w = (pct - f[j - 1]) / (f[j] - f[j - 1])            # log-linear interp
        tc = np.exp(np.log(tms[j - 1]) + w * (np.log(tms[j]) - np.log(tms[j - 1])))
        sc = np.exp(np.log(sig[j - 1]) + w * (np.log(sig[j]) - np.log(sig[j - 1])))
        return tc, sc

    LEVELS = [(1, "#6b6b66", "Raw sounding"),
              (3, "#3987e5", "Averaged over 3  (~9 m)"),
              (11, "#199e70", "Averaged over 11  (~33 m)")]

    # ── top: absolute amplitudes ────────────────────────────────────────────────
    ax.plot(tms, sig, color="#111", lw=2.4, zorder=7, label="Signal (forward response)")
    # every plotted point is an HM gate — mark them
    ax.plot(tms, sig, ls="none", marker="|", ms=9, mew=1.1, color="#111", zorder=8)
    ax.plot(tms, sig_abs, color="#d95926", lw=1.8, ls="--", zorder=5,
            label=r"Ambient floor  $\sigma_{abs}\propto t^{-1/2}$")
    ax.fill_between(tms, sig - sig_rel, sig + sig_rel, color="#9085e9", alpha=.55, lw=0,
                    zorder=4, label=f"Relative component  ±{R_REL:.0%} — thinner than the line here")

    ax.fill_between(tms, sig - raw, sig + raw, color="#898781", alpha=.30, lw=0,
                    zorder=2, label="Raw sounding  ±1σ")
    for n, c in STACKS:
        e = envelope(n)
        ax.fill_between(tms, sig - e, sig + e, color=c, alpha=.28, lw=0, zorder=3,
                        label=f"Averaged over {n} soundings  ±1σ")

    # 20% crossings, marked on both axes
    for n, c, _ in LEVELS:
        tc, sc = cross_at(n)
        if tc is None:
            continue
        ax.plot([tc, tc], [ax.get_ylim()[0], sc], color=c, lw=1.1, ls="--", alpha=.85, zorder=6)
        ax.plot([tc * 0.55, tc], [sc, sc], color=c, lw=1.1, ls="--", alpha=.85, zorder=6)
        ax.plot([tc], [sc], marker="o", ms=5, color=c, zorder=9)
        ax.annotate(f"{tc:.2f} ms", (tc, ax.get_ylim()[0]), xytext=(3, 12),
                    textcoords="offset points", fontsize=8.5, color=c, rotation=90)

    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_ylim(sig.min() * 0.12, sig.max() * 4)
    ax.set_ylabel(r"|dB/dt|   V/(A m$^4$)", fontsize=10)
    ax.set_title(
        "Noise envelope before and after lateral averaging\n"
        rf"SkyTEM 306HP high moment · background sounding · relative component {R_REL:.0%}"
        "\n"
        rf"noise_level_1ms = {NOISE_1MS:.0e} V/m² (receiver-area normalised) "
        rf"÷ moment {moment:,.0f} A·m²  =  {NOISE_1MS/moment:.2e} V/(A·m⁴) at 1 ms",
        fontsize=11, loc="left")
    ax.grid(True, which="major", lw=.5, alpha=.35)
    ax.grid(True, which="minor", lw=.3, alpha=.18)
    from matplotlib.lines import Line2D
    h, l = ax.get_legend_handles_labels()
    h.append(Line2D([], [], color="#555", lw=1.2, ls="--", marker="o", ms=5))
    l.append(f"{CULL:.0f}% cull crossing — last usable gate")
    h.append(Line2D([], [], color="#555", lw=1.0, ls="-."))
    l.append("ambient overtakes relative")
    ax.legend(h, l, fontsize=8.5, loc="upper right", framealpha=.94, ncol=1)

    f1 = NOISE_1MS / moment          # the floor at exactly t = 1 ms
    ax.plot([1.0], [f1], marker="o", ms=5, color="#d95926", zorder=7)
    ax.annotate(rf"{f1:.2e} V/(A·m$^4$)  at 1 ms",
                (1.0, f1), xytext=(-14, -26), textcoords="offset points",
                fontsize=8.5, color="#d95926", fontweight="bold", ha="right")

    # The ±3% band is ~0.026 decades — unrenderable against an eight-decade axis, so
    # it is left to the legend and to the lower panel, where the y-axis is fractional.

    # the crossing geometry: 20% cull sits where ambient ~ signal/5, since
    # sqrt(0.20^2 - 0.03^2) = 0.198 — the relative term contributes ~1% at this threshold
    kk = int(len(tms) * 0.62)
    ax.annotate("20% cull lands where the ambient floor\nsits ~5× below signal — the 3%\n"
                "term shifts it by ~1% at this threshold",
                xy=(tms[kk], sig_abs[kk]), xytext=(-150, -66), textcoords="offset points",
                fontsize=8.5, color="#7a4a2a",
                arrowprops=dict(arrowstyle="->", color="#7a4a2a", lw=1.0))

    # where the ambient term overtakes the relative one — the error budget switches here
    ix = np.where(sig_abs > sig_rel)[0]
    if len(ix):
        txo = tms[ix[0]]
        ax.axvline(txo, color="#555", lw=1.0, ls="-.", alpha=.7, zorder=4)
        ax.annotate(f"ambient overtakes relative\n{txo:.2f} ms", (txo, sig_rel[ix[0]]),
                    xytext=(8, 18), textcoords="offset points", fontsize=8.5, color="#555")
        ax2.axvline(txo, color="#555", lw=1.0, ls="-.", alpha=.7)

    # gate rug — its own strip between the panels
    tl = np.asarray(d["system"]["General"]["GateTimeLM"], dtype=float)[:, 0]
    tl = tl[tl > 0] * 1e3
    for tt, col, lab, yv in ((tl, "#c98500", "LM", 0.70), (tms, "#111", "HM", 0.28)):
        axr.plot(tt, np.full_like(tt, yv), ls="none", marker="|", ms=11, mew=1.2,
                 color=col, alpha=.95)
        axr.annotate(lab, (tt[-1], yv), xytext=(8, 0), textcoords="offset points",
                     fontsize=9, color=col, ha="left", va="center", fontweight="bold")
    axr.set_xscale("log"); axr.set_ylim(0, 1)
    axr.set_yticks([]); axr.set_xticks([])
    for sp in ("top", "right", "bottom", "left"):
        axr.spines[sp].set_visible(False)
    axr.annotate("gate centres", (1.0, 0.5), xycoords=("axes fraction", "axes fraction"),
                 xytext=(-4, 0), textcoords="offset points", fontsize=8,
                 color="#898781", ha="right", va="center")

    # ── bottom: as a fraction, which is what the pipeline stores ────────────────
    for n, c, lab in LEVELS:
        f = frac(n)
        ax2.plot(tms, f, color=c, lw=2.2,
                 label=lab + ("" if n == 1 else f"  —  {np.sqrt(n):.1f}× on the ambient term"))
        ax2.plot(tms, f, ls="none", marker="|", ms=7, mew=1.0, color=c, alpha=.8)
    ax2.axhline(R_REL * 100, color="#9085e9", lw=1.6, ls=":",
                label=f"Relative component — ±{R_REL:.0%}, unaffected by stacking")
    ax2.axhline(CULL, color="#d95926", lw=1.5, ls="--",
                label=f"{CULL:.0f}% cull threshold")

    for n, c, _ in LEVELS:
        tc, _sc = cross_at(n)
        if tc is None:
            continue
        ax2.plot([tc, tc], [ax2.get_ylim()[0], CULL], color=c, lw=1.1, ls="--", alpha=.85)
        ax2.plot([tc], [CULL], marker="o", ms=5, color=c, zorder=6)
        dy = {1: 26, 3: 15, 11: 6}.get(n, 6)
        ax2.annotate(f"{tc:.2f} ms", (tc, CULL), xytext=(4, dy),
                     textcoords="offset points", fontsize=8.5, color=c, fontweight="bold")

    ax2.set_xscale("log"); ax2.set_yscale("log")
    ax2.set_ylim(1, 400)
    xlo, xhi = tms.min() * 0.55, tms.max() * 1.9
    for a in (ax, axr, ax2):
        a.set_xlim(xlo, xhi)
    ax2.set_xlabel("time after turn-off (ms)   ·   ticks mark gate centres", fontsize=10)
    ax2.set_ylabel("assigned uncertainty (% of signal)", fontsize=10)
    ax2.yaxis.set_major_formatter(ticker.FuncFormatter(lambda v, _: f"{v:g}%"))
    ax2.grid(True, which="major", lw=.5, alpha=.35)
    ax2.grid(True, which="minor", lw=.3, alpha=.18)
    ax2.legend(fontsize=8.5, loc="upper left", framealpha=.92)

    ax2.annotate("stacking benefits marginally here —\nthe relative component dominates",
                 xy=(tms[2], R_REL * 100 * 1.2), fontsize=9, color="#555",
                 ha="left", va="bottom")
    ax2.annotate("stacking buys usable gates here",
                 xy=(tms[int(len(tms) * .80)], 90), fontsize=9, color="#555", ha="center")

    for f in ("noise_envelope_stacking.svg", "noise_envelope_stacking.png"):
        fig.savefig(OUT / f, bbox_inches="tight", dpi=200)
        print("  wrote", f)

    # numbers for the caption / the pipeline
    print("\n  gate    t(ms)      signal      raw σ%    3-snd σ%   11-snd σ%")
    for k in list(range(0, len(tms), max(1, len(tms) // 9))):
        print(f"  {k+1:4d}  {tms[k]:8.4f}  {sig[k]:.3e}   "
              f"{raw[k]/sig[k]*100:7.2f}   {envelope(3)[k]/sig[k]*100:8.2f}   "
              f"{envelope(11)[k]/sig[k]*100:8.2f}")


if __name__ == "__main__":
    main()

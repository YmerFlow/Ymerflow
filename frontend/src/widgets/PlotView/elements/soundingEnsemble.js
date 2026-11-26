import { toFloat32Array } from '../colorUtils.js';

// Shared bits for the always-on sounding ensemble overlay that SoundingPlot and
// SoundingResistivityPlot draw BENEATH the current (black) sounding: all soundings as one
// instanced draw of the existing per-sounding topology, translucent red, filtered by xdist.
// See docs/plans/sounding-ensemble-heatmap.md.
//
// How the pieces fit the gladly machinery:
//  - instanceCount = nSoundings; gladly's built-in per-instance `a_pickId` runs 0..nSoundings-1,
//    so it IS the sounding index in the vert (replacing the current layer's u_currentSounding
//    uniform) — no extra per-instance index attribute needed.
//  - the layer declares `filterAxisQuantityKinds: { '': 'xdist_m' }`; gladly injects a
//    `bool filter_(float)` helper + its `filter_range` uniform wired to the xdist filterbar.
//    Each instance carries its xdist as the per-instance `fval` attribute, culled by the snippet
//    below. The uniform is injected into the current-sounding sublayer too but, never called
//    there, is linked out as inactive (regl drives uniforms from the program, so it is ignored) —
//    the current sounding is unfiltered and always shows.

// How opaque a fully-saturated stack of overlapping ensemble lines reads. Internal constant (not
// exposed): `saturationCount` overlapping lines reach this accumulated opacity.
export const ENSEMBLE_SATURATION_TARGET = 0.9;

// Mid red (rgb 200, 30, 30); operator-overridable via the ensembleColor schema field.
export const DEFAULT_ENSEMBLE_COLOR = '#c81e1e';

export const DEFAULT_SATURATION_COUNT = 25;

// How many overlapping soundings saturate the overlay to full red. An ABSOLUTE count, NOT a
// fraction of the survey: perceived saturation is driven by how many lines overlap at a pixel,
// which does not scale with the total sounding count — a fraction·N model makes big surveys fade
// to a uniform faint pink (every line equally faint, no heatmap).
export const saturationCountSchema = {
  type: 'integer',
  default: DEFAULT_SATURATION_COUNT,
  minimum: 1,
  description: 'Number of overlapping soundings at which the ensemble overlay saturates to full red (lower = stronger heatmap)',
};

export const ensembleColorSchema = {
  type: 'string',
  default: DEFAULT_ENSEMBLE_COLOR,
  description: 'Color of the translucent ensemble overlay (all soundings behind the current one)',
};

// Per-line alpha from the source-over saturation model: with K overlapping lines, accumulated
// opacity 1−(1−a)^K reaches the target T, so a = 1 − (1 − T)^(1/K). Fewer overlaps stay
// translucent; more clamp at full. K = saturationCount is an absolute overlap count (see above),
// so the heatmap looks the same whatever the survey size.
export function ensembleAlpha(saturationCount, target = ENSEMBLE_SATURATION_TARGET) {
  const K = Math.max(1, saturationCount > 0 ? saturationCount : DEFAULT_SATURATION_COUNT);
  const a = 1 - Math.pow(1 - target, 1 / K);
  return Math.min(1, Math.max(1e-3, a));
}

// Per-instance xdist [m] — the filtered quantity, one value per sounding. Falls back to the
// sounding index when the dataset carries no xdist, so a scrub still culls a contiguous range.
export function ensembleXdist(flightlines, nS) {
  const xd = flightlines?.xdist;
  if (xd && xd.length >= nS) return toFloat32Array(xd).slice(0, nS);
  return Float32Array.from({ length: nS }, (_, i) => i);
}

export function ensembleXdistDomain(fval) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < fval.length; i++) {
    const v = fval[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!(hi >= lo)) { lo = 0; hi = 1; }
  return [lo, hi];
}

// Standard source-over blend for the overlapping translucent lines (the saturation model needs
// it; the base sounding layers are otherwise opaque). gladly adds `enable` (a prop so picking
// can force it off).
export const ENSEMBLE_BLEND = {
  func: { srcRGB: 'src alpha', dstRGB: 'one minus src alpha', srcAlpha: 0, dstAlpha: 1 },
};

// Vert snippet (string): cull an instance whose xdist is outside the filterbar window. `filter_`
// and its `filter_range` uniform are injected by gladly for the layer's filter axis. Open bounds
// (the default) pass everything, so the whole line shows until the operator scrubs.
export const ENSEMBLE_FILTER_SNIPPET =
  'if (!filter_(fval)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }';

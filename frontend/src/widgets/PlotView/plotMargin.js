import { AXIS_GEOMETRY } from 'gladly-plot';

// Pixel room around the plot area, per side. Gladly draws an axis's tick labels and
// title at fixed fractions of that side's margin (0.40 and 0.75 of it), so a side with
// an axis needs the full room: below 48 px an x axis's labels touch its title, and a y
// axis needs 80 px for labels as wide as "1.5e-3". A side with no axis only needs room
// for the end labels of the neighboring axes, which overhang the plot corners.
const AXIS_SIDE = { xaxis_top: 'top', yaxis_right: 'right', xaxis_bottom: 'bottom', yaxis_left: 'left' };
const WITH_AXIS = { top: 48, right: 80, bottom: 48, left: 80 };
const WITHOUT_AXIS = { top: 12, right: 24, bottom: 12, left: 24 };

// Gladly's default axes, assumed until a first render shows which axes the plot draws.
const DEFAULT_AXES = ['xaxis_bottom', 'yaxis_left'];

// 3D axes project anywhere on the canvas, so a 3D plot keeps the same room on every side.
const MARGIN_3D = { top: 50, right: 80, bottom: 60, left: 80 };

/**
 * Margin for a plot, in pixels per side.
 *
 * @param {string[]|null} axes - spatial axes the plot draws (gladly slot names), or null
 *   before the first render, which assumes a bottom and a left axis.
 * @param {object} [override] - layoutConfig.margin: `{top, right, bottom, left}` in
 *   pixels; a side given here replaces the default for that side.
 * @returns {{top: number, right: number, bottom: number, left: number}}
 */
export function plotMargin(axes, override) {
  const drawn = axes ?? DEFAULT_AXES;
  let margin = MARGIN_3D;
  if (drawn.every(a => a in AXIS_SIDE)) {
    const sides = new Set(drawn.map(a => AXIS_SIDE[a]));
    margin = Object.fromEntries(
      Object.keys(WITH_AXIS).map(side => [side, sides.has(side) ? WITH_AXIS[side] : WITHOUT_AXIS[side]]));
  }
  const set = Object.entries(override ?? {})
    .filter(([side, px]) => side in WITH_AXIS && Number.isFinite(px) && px >= 0);
  return { ...margin, ...Object.fromEntries(set) };
}

/**
 * Spatial axes the plot drew on its last render, or null before the first one.
 * An axis set to `visible: false` in layoutConfig.axes has a scale but is not drawn.
 */
export function drawnAxes(plot) {
  const registry = plot.axisRegistry;
  if (!registry) return null;
  const axes = plot.currentConfig?.axes ?? {};
  return Object.keys(AXIS_GEOMETRY).filter(a => registry.getScale(a) && axes[a]?.visible !== false);
}

/** True when two margins have the same room on every side. */
export function sameMargin(a, b) {
  return Object.keys(WITH_AXIS).every(side => a[side] === b[side]);
}

export const MARGIN_SCHEMA = {
  type: 'object',
  title: 'Margin',
  description: 'Pixels around the plot area. A side left empty gets room for an axis if it has one, '
    + 'and a narrow edge if it does not.',
  properties: Object.fromEntries(
    Object.keys(WITH_AXIS).map(side => [side, { type: 'number', minimum: 0 }])),
};

// Shared current-sounding marker for xdist profile plots that draw with an (x, y) line
// primitive (ChannelPlot, MagLinePlot, …). The marker is a full-height vertical line at the
// current sounding's distance-along-line, drawn by the plot's OWN shader via an isMarker
// branch — no separate layer type, so it can't be dropped by gladly's build/epoch race, and
// it is y-axis-agnostic (y is pinned in clip space) so it works whatever the plot's y quantity
// kind is. Toggle with the layer's showCurrentSounding parameter (default true).
//
// Usage in a line LayerType:
//   vert: splice MARKER_VERT_IN into the `in`/`out` block, MARKER_VERT_BRANCH at the top of
//         main() (needs `in float x, y;`).
//   frag: splice MARKER_FRAG_IN into the `in` block, MARKER_FRAG_BRANCH at the top of main().
//   createLayer: add an `isMarker` tiled attribute (0 for data tiles), then append the tile
//         from currentSoundingMarkerTile() to every per-vertex attribute array.
import { soundingIndex } from '../soundingMatch.js';

export const MARKER_VERT_IN = 'in float isMarker;\n    out float vMarker;';
export const MARKER_FRAG_IN = 'in float vMarker;';

// Full-height vertical bar at x; the marker vertices carry their clip-space y (±1) in `y`.
export const MARKER_VERT_BRANCH = `
      vMarker = isMarker;
      if (isMarker > 0.5) {
        gl_Position = vec4(plot_pos(vec2(x, 1.0)).x, y, 0.0, 1.0);
        return;
      }`;

export const MARKER_FRAG_BRANCH =
  'if (vMarker > 0.5) { fragColor = gladly_apply_color(vec4(1.0, 0.0, 0.0, 1.0)); return; }';

// One marker tile (two vertices = a single vertical line segment) to append to a tiled
// 'lines' layer, or null when the marker should not be drawn. `fill` supplies length-2 arrays
// for the plot's other per-vertex attributes (so every attribute has a matching marker tile).
export function currentSoundingMarkerTile(parameters, rawData, xdist, fill = {}) {
  if (parameters.showCurrentSounding === false) return null;
  const cs = soundingIndex(rawData);
  if (cs == null || cs < 0 || cs >= xdist.length) return null;
  const xc = Number(xdist[cs]);
  if (!Number.isFinite(xc)) return null;
  return {
    x: new Float32Array([xc, xc]),
    y: new Float32Array([-1, 1]),         // clip-space top/bottom
    isMarker: new Float32Array([1, 1]),
    ...fill,
  };
}

// The boolean schema property every marker-drawing layer exposes.
export const showCurrentSoundingSchema = {
  type: 'boolean', default: true, title: 'Show current sounding line',
};

// ─── Instanced-quad marker (ResistivityCurtain, GateAnomalyPlot, …) ───────────────────
// These plots draw their cells as one instanced quad draw. The marker is one extra instance
// carrying isMarker=1; the plot's vert branches on isMarker to draw a thin vertical bar (its
// x via plot_pos, its height pinned in clip space or spanning the cells' y extent). Drawing it
// in the same instanced draw (not a trailing layer) is deliberate — a separate trailing layer
// gets dropped by gladly's build/epoch race after the expensive cell compile.

// Half-width of the marker bar, in clip-space units (WebGL can't widen a line primitive).
export const MARKER_HALF_WIDTH = 0.003;

// The current sounding (flightlines row) to mark, or null if the marker should not be drawn
// (hidden via showCurrentSounding:false, no selection, or out of range / no xdist value).
export function markerSounding(parameters, rawData, xdist) {
  if (parameters.showCurrentSounding === false) return null;
  const cs = soundingIndex(rawData);
  if (cs == null || cs < 0 || cs >= xdist.length || !Number.isFinite(Number(xdist[cs]))) return null;
  return cs;
}

// Append one marker instance to an instanced draw: grows every per-instance attribute by one,
// taking the marker's value for each from `markerValues`. Returns the new instanceCount.
export function appendMarkerInstance(attributes, instanceCount, markerValues) {
  const grow = (arr, v) => { const out = new Float32Array(arr.length + 1); out.set(arr); out[arr.length] = v; return out; };
  for (const [name, markerVal] of Object.entries(markerValues)) attributes[name] = grow(attributes[name], markerVal);
  return instanceCount + 1;
}

// Shared current-sounding marker for the profile/section plots. The marker is drawn by each
// plot's OWN shader via an isMarker branch — no separate layer type, so it can't be dropped by
// gladly's build/epoch race after the expensive cell compile.
//
// Fast path: the marker geometry is ALWAYS present (built once in createLayer and never
// rebuilt); its position and visibility come from uniform closures that read
// parameters.currentSounding / parameters.showCurrentSounding live on every draw. A sounding
// change mutates those params in place (gladly's LayerHandle.set fast path) and the closures
// pick up the new value on the next render — no _initialize(), no geometry rebuild. See
// docs/plans/current-sounding-uniform-fast-path.md.
//
// Usage in a line LayerType (ChannelPlot-style, 'lines' primitive):
//   vert: splice MARKER_VERT_IN into the `in`/`uniform`/`out` block, MARKER_VERT_BRANCH at the
//         top of main() (needs `in float y;` for the clip-space top/bottom).
//   frag: splice MARKER_FRAG_IN into the `in` block, MARKER_FRAG_BRANCH at the top of main().
//   createLayer: add an `isMarker` tiled attribute (0 for data tiles), append markerLineTile()
//         to every per-vertex attribute array, and add markerXUniforms(...) to layer.uniforms.

// The current-sounding schema property every opted-in layer exposes. x-format:'currentSounding'
// is how PlotView discovers the layer and which property to write; x-uniform:true is what makes
// gladly fast-path a change to it. Kept out of the editor and the saved layout by PlotView
// (stripped from the rjsf schema and before every persist).
export const currentSoundingSchema = {
  type: 'integer',
  'x-format': 'currentSounding',
  'x-uniform': true,
  default: null,
};

// The boolean toggle every marker-drawing layer exposes. x-uniform so toggling the marker is
// fast-pathed too; it stays a normal, user-visible, persisted toggle (no x-format).
export const showCurrentSoundingSchema = {
  type: 'boolean', default: true, title: 'Show current sounding line', 'x-uniform': true,
};

export const MARKER_VERT_IN =
  'in float isMarker;\n    uniform float u_markerX;\n    uniform float u_markerVisible;\n    out float vMarker;';
export const MARKER_FRAG_IN = 'in float vMarker;';

// Full-height vertical bar at u_markerX; the marker vertices carry their clip-space y (±1) in
// `y`. Offscreen when hidden (toggle off, no selection, or out of range).
export const MARKER_VERT_BRANCH = `
      vMarker = isMarker;
      if (isMarker > 0.5) {
        if (u_markerVisible < 0.5) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
        gl_Position = vec4(plot_pos(vec2(u_markerX, 1.0)).x, y, 0.0, 1.0);
        return;
      }`;

export const MARKER_FRAG_BRANCH =
  'if (vMarker > 0.5) { fragColor = gladly_apply_color(vec4(1.0, 0.0, 0.0, 1.0)); return; }';

// One always-present marker tile (two vertices = a single vertical line segment) to append to a
// tiled 'lines' layer. `fill` supplies length-2 arrays for the plot's other per-vertex
// attributes (so every attribute has a matching marker tile). Position comes from u_markerX;
// the placeholder `x` here is unused by the marker branch.
export function markerLineTile(fill = {}) {
  return {
    x: new Float32Array([0, 0]),
    y: new Float32Array([-1, 1]),         // clip-space top/bottom
    isMarker: new Float32Array([1, 1]),
    ...fill,
  };
}

// ─── Instanced-quad marker (ResistivityCurtain, GateAnomalyPlot, …) ───────────────────
// These plots draw their cells as one instanced quad draw. The marker is one extra instance
// carrying isMarker=1; the plot's vert branches on isMarker to draw a thin vertical bar at
// u_markerX. Drawing it in the same instanced draw (not a trailing layer) is deliberate — a
// separate trailing layer gets dropped by gladly's build/epoch race after the cell compile.

// Half-width of the marker bar, in clip-space units (WebGL can't widen a line primitive).
export const MARKER_HALF_WIDTH = 0.003;

// Append one always-present marker instance to an instanced draw: grows every per-instance
// attribute by one, taking the marker's value for each from `markerValues`. Returns the new
// instanceCount. The marker's position is supplied at draw time by u_markerX, so the per-instance
// position values here are placeholders.
export function appendMarkerInstance(attributes, instanceCount, markerValues) {
  const grow = (arr, v) => { const out = new Float32Array(arr.length + 1); out.set(arr); out[arr.length] = v; return out; };
  for (const [name, markerVal] of Object.entries(markerValues)) attributes[name] = grow(attributes[name], markerVal);
  return instanceCount + 1;
}

// ─── Marker uniform-closure builders ──────────────────────────────────────────────────
// Each returns regl uniforms that are functions, so they are re-evaluated every draw and pick
// up a sounding change (parameters.currentSounding mutated in place by the fast path) without
// a rebuild. `parameters` is the live config object; the position arrays are captured once in
// createLayer. Visibility folds together showCurrentSounding, no-selection, and out-of-range.

// 1D xdist marker (ChannelPlot, RC2D, RCLines, GateAnomaly): position from xdist[cs].
export function markerXUniforms(parameters, xdist) {
  const valid = (cs) => cs != null && cs >= 0 && cs < xdist.length && Number.isFinite(Number(xdist[cs]));
  return {
    u_markerX: () => { const cs = parameters.currentSounding; return valid(cs) ? Number(xdist[cs]) : 0; },
    u_markerVisible: () => {
      const cs = parameters.currentSounding;
      return (parameters.showCurrentSounding !== false && valid(cs)) ? 1 : 0;
    },
  };
}

// 2D geo marker (FlightlinePlot): position from (x[cs], y[cs]).
export function markerXYUniforms(parameters, x, y) {
  const valid = (cs) => cs != null && cs >= 0 && cs < x.length && Number.isFinite(x[cs]) && Number.isFinite(y[cs]);
  return {
    u_markerX: () => { const cs = parameters.currentSounding; return valid(cs) ? x[cs] : 0; },
    u_markerY: () => { const cs = parameters.currentSounding; return valid(cs) ? y[cs] : 0; },
    u_markerVisible: () => {
      const cs = parameters.currentSounding;
      return (parameters.showCurrentSounding !== false && valid(cs)) ? 1 : 0;
    },
  };
}

// 3D geo marker (RC3D): position from (gx[cs], gz[cs]).
export function markerGeoUniforms(parameters, nS, gxFull, gzFull) {
  const valid = (cs) => cs != null && cs >= 0 && cs < nS && Number.isFinite(gxFull[cs]) && Number.isFinite(gzFull[cs]);
  return {
    u_markerGx: () => { const cs = parameters.currentSounding; return valid(cs) ? gxFull[cs] : 0; },
    u_markerGz: () => { const cs = parameters.currentSounding; return valid(cs) ? gzFull[cs] : 0; },
    u_markerVisible: () => {
      const cs = parameters.currentSounding;
      return (parameters.showCurrentSounding !== false && valid(cs)) ? 1 : 0;
    },
  };
}

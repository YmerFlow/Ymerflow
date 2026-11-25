// Reading and setting the selected sounding for a plot layer. The selection is a plain row
// index into the current line of the current dataset — a pure index, nothing more. A layer
// indexes its own dataset at that same row.
//
// Translating a sounding between datasets of different processing stages (pinned datasets,
// averaged/culled rows) is deliberately NOT done here — that is a deferred problem with real
// wrinkles, and when it is solved it will route via xdist (distance along line), never via
// row number or any synthetic id.
import { getLayerType } from 'gladly-plot';
import { resolveDataPath } from './colorUtils.js';

// The current sounding is a layer *parameter* (config, not data) so gladly can fast-path a
// selection change as a uniform update — no plot rebuild. A layer opts in by exposing one
// schema property carrying x-format:'currentSounding' (discovery) + x-uniform:true (fast path);
// PlotView injects the value into that property before plot.update() and strips it everywhere
// else. createLayer reads it with soundingParam(parameters); the uniform closures read
// parameters.currentSounding live on every draw.

// The property name a layer type uses for the current sounding (the one carrying
// x-format:'currentSounding'), or null if the layer type does not opt in. Discovery is by
// x-format, not by name, though the name is conventionally 'currentSounding'.
export function soundingParamName(typeName, data) {
  const type = getLayerType(typeName);
  const props = type?.schema?.(data)?.properties ?? {};
  for (const [name, def] of Object.entries(props)) {
    if (def && def['x-format'] === 'currentSounding') return name;
  }
  return null;
}

// The selected sounding row index read from a layer's parameters, or null when unset.
export function soundingParam(parameters) {
  const v = parameters?.currentSounding;
  return v == null ? null : v;
}

// Nearest flightlines row to an xdist value; null if none/invalid.
export function nearestSoundingByXdist(xdist, xval) {
  const v = Number(xval);
  if (!xdist?.length || !Number.isFinite(v)) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < xdist.length; i++) {
    const d = Math.abs(Number(xdist[i]) - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Map a pick on an xdist-axis layer to a row index, for use inside a layer type's pickInfo.
// The picked primitive carries its own data coordinate in a GPU attribute (`x` by default;
// e.g. `x0` for cell layers) — read it at the hit (tile, index) and find the nearest row by
// xdist. Returns a row index, or null (e.g. a 3D variant with no xdist column).
export function soundingFromPickX(parameters, plot, layer, { tile, index }, xAttr = 'x') {
  const fl = resolveDataPath(plot?._rawData, parameters?.dataset)?.flightlines;
  const xa = layer?.attributes?.[xAttr];
  const xval = Array.isArray(xa) ? xa[tile]?.[index] : xa?.[index];
  return nearestSoundingByXdist(fl?.xdist, xval);
}

// Map a picked primitive straight to the flightlines row it belongs to, read from a
// per-primitive attribute the layer fills (soundingId). Used by layers whose instance index
// can't be decoded arithmetically (invalid cells skipped) and that have no xdist coordinate to
// resolve the click from — e.g. the 3D curtain on geo axes. Returns a row index or null.
export function soundingFromPickId(layer, { tile, index }, attr = 'soundingId') {
  const a = layer?.attributes?.[attr];
  const v = Array.isArray(a) ? a[tile]?.[index] : a?.[index];
  return v == null ? null : Math.round(Number(v));
}

// Shared layer-type onClick for sounding-selecting layers: select the row index the pick
// resolved to (result.dataIndex, produced by the layer's own pickInfo).
export function selectSoundingOnClick(result, parameters, plot) {
  const sounding = result?.dataIndex;
  if (sounding != null) plot?._rawData?._setCurrentSounding?.(sounding);
}

// Reading and setting the selected sounding for a plot layer. The selection
// (_currentSounding) is a plain row index into the current line of the current dataset — a
// pure index, nothing more. A layer indexes its own dataset at that same row.
//
// Translating a sounding between datasets of different processing stages (pinned datasets,
// averaged/culled rows) is deliberately NOT done here — that is a deferred problem with real
// wrinkles, and when it is solved it will route via xdist (distance along line), never via
// row number or any synthetic id.
import { resolveDataPath } from './colorUtils.js';

// The selected sounding as a row index into the current dataset. A pure index.
export function soundingIndex(rawData) {
  return rawData?._currentSounding;
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

// Shared layer-type onClick for sounding-selecting layers: select the row index the pick
// resolved to (result.dataIndex, produced by the layer's own pickInfo).
export function selectSoundingOnClick(result, parameters, plot) {
  const sounding = result?.dataIndex;
  if (sounding != null) plot?._rawData?._setCurrentSounding?.(sounding);
}

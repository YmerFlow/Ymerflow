// In-use editing shared by the ChannelPlot and GateAnomalyPlot layers: how a lasso
// selection becomes edit entries, and how a layer reads pending edits back. Both layers
// key edits the same way (dataset path, channel, gate key, global sounding index), so an
// edit made in either one shows in both and Save writes one diff.

// Part-local → global sounding index. apply_idx is set by libaarhusxyz split_by_line()
// and absent where local = global. It is int64 on disk, which msgpack-numpy-js decodes to
// a BigInt64Array; edits are keyed by Number, since a BigInt key never matches a number
// in a Map and BigInts cannot be sorted with (a, b) => a - b or put in a Float32Array.
export function globalSoundingIndex(applyIdx, localIdx) {
  return applyIdx ? Number(applyIdx[localIdx]) : localIdx;
}

// inuse_state encoding, drawn by both layers:
//   0 = auto-enabled, 1 = manually enabled, 2 = auto-disabled, 3 = manually disabled.
// A pending edit wins over the dataset's own InUse flag. `channelDiff` is the in-memory
// diff of one channel, Map<gateKey, Map<globalSoundingIndex, 0|1>>, or null; `inuseArr`
// is the dataset's InUse column for this gate, indexed by part-local sounding.
export function soundingState(localIdx, globalIdx, gateKey, inuseArr, channelDiff) {
  const edit = channelDiff?.get(gateKey)?.get(globalIdx);
  if (edit !== undefined) return edit === 1 ? 1 : 3;
  const origInUse = inuseArr ? Number(inuseArr[localIdx]) : 1;
  return origInUse === 0 ? 2 : 0;
}

// ChannelPlot's lasso: arrays[t] is the selection mask of tile t (gate gateKeys[t]), one
// value per line vertex. Vertices 2*i and 2*i+1 of a tile are the ends of the segment from
// sounding i to i+1, so each selected vertex selects one of those two soundings.
export function segmentEditEntries(arrays, gateKeys, applyIdx) {
  const entries = [];
  arrays.forEach((tileArr, t) => {
    const seen = new Set();
    for (let vi = 0; vi < tileArr.length; vi++) {
      if (tileArr[vi] <= 0.5) continue;
      const si = vi % 2 === 0 ? vi / 2 : (vi + 1) / 2;
      if (seen.has(si)) continue;
      seen.add(si);
      entries.push({ soundingIndex: globalSoundingIndex(applyIdx, si), gateIndex: gateKeys[t] });
    }
  });
  return entries;
}

// GateAnomalyPlot's lasso: one value per cell, cells laid out gate by gate, so cell
// t * nSoundings + i is sounding i of gate gateKeys[t]. Returns null when the mask is not
// that shape, i.e. it came from some other layer sharing the selection channel.
export function cellEditEntries(mask, nSoundings, gateKeys, applyIdx) {
  if (mask.length !== nSoundings * gateKeys.length) return null;
  const entries = [];
  for (let c = 0; c < mask.length; c++) {
    if (mask[c] <= 0.5) continue;
    const t = Math.floor(c / nSoundings);
    entries.push({ soundingIndex: globalSoundingIndex(applyIdx, c - t * nSoundings), gateIndex: gateKeys[t] });
  }
  return entries;
}

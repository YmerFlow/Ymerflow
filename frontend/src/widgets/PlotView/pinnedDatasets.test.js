import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Dataset per loadDataset call: its parts are lines, and fetchData records the part asked for.
const fetches = [];
vi.mock('../../datamodel/dataset', () => ({
  loadDataset: vi.fn(async dsId => ({
    getParts: () => ['1060', '1070', 'L1.5'],
    fetchData: async part => { fetches.push([dsId, part]); return { dsId, part }; },
  })),
}));
import { loadPinnedData } from './pinnedDatasets';

// A block of several lines with an averaged and an inverted process pinned beside the
// edited one. The inversion's name has a dot, which paths carry encoded as ','.
const PROCESSES = [
  { name: 'averaged', versions: [{ version: 2, outputs: { data: 'http://h/projects/p/dataset/ds-avg' } }] },
  { name: 'inversion 1.0', versions: [{ version: 1, outputs: { model: 'http://h/projects/p/dataset/ds-model' } }] },
];

// One run of PlotView's lazy-load effect.
function load(layers, loaded = new Map()) {
  return loadPinnedData(layers, PROCESSES, 'p', loaded, (key, entry) => loaded.set(key, entry)).then(() => loaded);
}

beforeEach(() => { fetches.length = 0; });

describe('loadPinnedData', () => {
  it('fetches the part a pinned path names, keyed by the path, and no current dataset', async () => {
    const loaded = await load([
      { ChannelPlot: { dataset: 'current.data', channel: 'Ch01' } },
      { ChannelPlot: { dataset: 'averaged.2.data@1070', channel: 'Ch01' } },
      { ResistivityCurtain: { dataset: 'inversion 1,0.1.model@1060', resistivity: 'inversion 1,0.1.model@1060.rho' } },
    ]);
    expect(fetches).toEqual([['ds-avg', '1070'], ['ds-model', '1060']]);
    expect(loaded.get('averaged.2.data@1070').rawData).toEqual({ dsId: 'ds-avg', part: '1070' });
  });

  it("fetches 'all' for a pinned path without a part, as before", async () => {
    await load([{ ChannelPlot: { dataset: 'averaged.2.data', channel: 'Ch01' } }]);
    expect(fetches).toEqual([['ds-avg', 'all']]);
  });

  it('loads one dataset pinned at two parts twice, and nothing again on a rerun', async () => {
    const layers = [
      { ChannelPlot: { dataset: 'averaged.2.data@1060' } },
      { ChannelPlot: { dataset: 'averaged.2.data@1070' } },
    ];
    const loaded = await load(layers);
    await load(layers, loaded);
    expect(fetches).toEqual([['ds-avg', '1060'], ['ds-avg', '1070']]);
    expect([...loaded.keys()]).toEqual(['averaged.2.data@1060', 'averaged.2.data@1070']);
  });

  it('matches a part with a dot in encoded space', async () => {
    await load([{ ChannelPlot: { dataset: 'averaged.2.data@L1,5' } }]);
    expect(fetches).toEqual([['ds-avg', 'L1.5']]);
  });

  it('warns and loads nothing for a part the dataset does not have', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = await load([{ ChannelPlot: { dataset: 'averaged.2.data@1080' } }]);
    expect(fetches).toEqual([]);
    expect(loaded.size).toBe(0);
    expect(warn).toHaveBeenCalledWith('Failed to lazily load averaged.2.data@1080:', expect.any(Error));
    warn.mockRestore();
  });
});

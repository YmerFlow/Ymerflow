import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Dataset per loadDataset call, whose fetchData records the part it was asked for.
const fetches = [];
vi.mock('../../datamodel/dataset', () => ({
  loadDataset: vi.fn(async dsId => ({
    fetchData: async part => { fetches.push([dsId, part]); return { dsId, part }; },
  })),
}));
import { loadPinnedData, pinnedDataKey } from './pinnedDatasets';

// A block of several lines with an averaged and an inverted process pinned beside the
// edited one. The inversion's name has a dot, which pinned paths carry encoded as ','.
const PROCESSES = [
  { name: 'averaged', versions: [{ version: 2, outputs: { data: 'http://h/projects/p/dataset/ds-avg' } }] },
  { name: 'inversion 1.0', versions: [{ version: 1, outputs: { model: 'http://h/projects/p/dataset/ds-model' } }] },
];
const LAYERS = [
  { ChannelPlot: { dataset: 'current.data', channel: 'Ch01' } },
  { ChannelPlot: { dataset: 'averaged.2.data', channel: 'Ch01' } },
  { ResistivityCurtain: { dataset: 'inversion 1,0.1.model', resistivity: 'inversion 1,0.1.model.rho' } },
];

// One run of PlotView's lazy-load effect for the part selected in the top bar.
function selectPart(part, loaded) {
  return loadPinnedData(LAYERS, PROCESSES, part, 'p', loaded, (key, entry) => loaded.set(key, entry));
}

beforeEach(() => { fetches.length = 0; });

describe('loadPinnedData', () => {
  it('fetches each pinned dataset with the selected part, and no current dataset', async () => {
    const loaded = new Map();
    await selectPart('line_100', loaded);
    expect(fetches).toEqual([['ds-avg', 'line_100'], ['ds-model', 'line_100']]);
    expect(loaded.get(pinnedDataKey('averaged.2.data', 'line_100'))).toMatchObject({
      dsPath: 'averaged.2.data', part: 'line_100', rawData: { dsId: 'ds-avg', part: 'line_100' },
    });
  });

  it('refetches when the part changes, and keeps each part keyed by path and part', async () => {
    const loaded = new Map();
    await selectPart('line_100', loaded);
    await selectPart('line_100', loaded);   // a rerun for the same part loads nothing
    expect(fetches).toHaveLength(2);

    await selectPart('line_200', loaded);
    expect(fetches.slice(2)).toEqual([['ds-avg', 'line_200'], ['ds-model', 'line_200']]);
    expect(loaded.get(pinnedDataKey('inversion 1,0.1.model', 'line_100')).rawData.part).toBe('line_100');
    expect(loaded.get(pinnedDataKey('inversion 1,0.1.model', 'line_200')).rawData.part).toBe('line_200');

    await selectPart('line_100', loaded);   // back to a part already loaded
    expect(fetches).toHaveLength(4);
  });

  it("fetches 'all' when no part is selected, as before", async () => {
    await selectPart('all', new Map());
    expect(fetches).toEqual([['ds-avg', 'all'], ['ds-model', 'all']]);
  });
});

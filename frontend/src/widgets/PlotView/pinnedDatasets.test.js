import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataGroup } from 'gladly-plot';

// Fake datasets by id, with their part names. A part's name is its line's name.
const PARTS = {
  'ds-avg':   ['1060', '1070', 'L1.5'],
  'ds-model': ['1060', '1070'],
};
const fetches = [];
vi.mock('../../datamodel/dataset', () => ({
  loadDataset: vi.fn(async dsId => {
    let fetched;
    return {
      getParts: () => PARTS[dsId],
      fetchData: async part => { fetches.push([dsId, part]); fetched = part; return { dsId, part }; },
      columns: () => ['Line'],
      getData: col => `${dsId}/${fetched}/${col}`,
      getQuantityKind: col => col,
    };
  }),
}));
import { ALL_PARTS, addPinnedData, loadPinnedData, pinnedEntries } from './pinnedDatasets';
import { resolveDataPath } from './colorUtils.js';

// A block of several lines with an averaged and an inverted process pinned beside the edited one.
const PROCESSES = [
  { name: 'averaged', versions: [{ version: 2, outputs: { data: 'http://h/projects/p/dataset/ds-avg' } }] },
  { name: 'inversion', versions: [{ version: 1, outputs: { model: 'http://h/projects/p/dataset/ds-model' } }] },
];
const FOLLOWING = [
  { ChannelPlot: { dataset: 'current.data', channel: 'Ch01' } },
  { ChannelPlot: { dataset: 'averaged.2.data', channel: 'Ch01' } },
  { ResistivityCurtain: { dataset: 'inversion.1.model', resistivity: 'inversion.1.model.rho' } },
];

// One run of PlotView's lazy-load effect for the selected part.
function load(layers, selectedPart, loaded = new Map()) {
  return loadPinnedData(layers, PROCESSES, 'p', selectedPart, loaded, (key, entry) => loaded.set(key, entry))
    .then(() => loaded);
}
const shown = (loaded, selectedPart) =>
  pinnedEntries(loaded, selectedPart).map(e => [e.path, e.message ?? e.rawData.part]);

beforeEach(() => { fetches.length = 0; });

describe('pinned paths that follow the selected line', () => {
  it("show the pinned dataset's part with the selected part's name", async () => {
    const loaded = await load(FOLLOWING, '1070');
    expect(fetches.sort()).toEqual([['ds-avg', '1070'], ['ds-model', '1070']]);
    expect(shown(loaded, '1070').sort()).toEqual([['averaged.2.data', '1070'], ['inversion.1.model', '1070']]);
  });

  it('load again for another part, keep both, and show the selected one', async () => {
    const loaded = await load(FOLLOWING, '1070');
    await load(FOLLOWING, '1060', loaded);
    await load(FOLLOWING, '1070', loaded);   // back to a part already loaded
    expect(fetches.length).toBe(4);
    expect(shown(loaded, '1060').sort()).toEqual([['averaged.2.data', '1060'], ['inversion.1.model', '1060']]);
  });

  it('show nothing, with a message, when the dataset has no part of that name', async () => {
    const loaded = await load(FOLLOWING, '1080');
    expect(fetches).toEqual([]);
    expect(shown(loaded, '1080').sort()).toEqual([
      ['averaged.2.data', 'averaged.2.data has no part 1080.'],
      ['inversion.1.model', 'inversion.1.model has no part 1080.'],
    ]);
  });

  it('load every part when every part is selected', async () => {
    await load(FOLLOWING, ALL_PARTS);
    expect(fetches.sort()).toEqual([['ds-avg', 'all'], ['ds-model', 'all']]);
  });

  it('read a fourth segment that is not a part as a column of the followed part', async () => {
    const loaded = await load([{ ChannelPlot: { dataset: 'averaged.2.data', x: 'averaged.2.data.Line' } }], '1070');
    expect(shown(loaded, '1070')).toEqual([['averaged.2.data', '1070']]);
  });
});

describe('pinned paths that name a fixed part', () => {
  const FIXED = [{ ChannelPlot: { dataset: 'averaged.2.data.1060', x: 'averaged.2.data.1060.Line' } }];

  it('stay on that part whatever is selected', async () => {
    const loaded = await load(FIXED, '1070');
    await load(FIXED, '1080', loaded);
    await load(FIXED, ALL_PARTS, loaded);
    expect(fetches).toEqual([['ds-avg', '1060']]);
    expect(shown(loaded, '1080')).toEqual([['averaged.2.data.1060', '1060']]);
  });

  it('match a part name with a dot in encoded space', async () => {
    await load([{ ChannelPlot: { dataset: 'averaged.2.data.L1,5' } }], '1070');
    expect(fetches).toEqual([['ds-avg', 'L1.5']]);
  });

  it('sit beside a followed part of the same dataset', async () => {
    const loaded = await load([...FIXED, { ChannelPlot: { dataset: 'averaged.2.data' } }], '1070');
    expect(shown(loaded, '1070').sort()).toEqual([['averaged.2.data', '1070'], ['averaged.2.data.1060', '1060']]);
  });
});

describe('addPinnedData', () => {
  it('puts each part where its path resolves, for custom layers and for gladly', async () => {
    const layers = [{ ChannelPlot: { dataset: 'averaged.2.data' } }, { ChannelPlot: { dataset: 'averaged.2.data.1060' } },
      { ChannelPlot: { dataset: 'inversion.1.model' } }];
    const loaded = await load(layers, '1080');   // the inversion has no part 1080: its entry is a message
    await load(layers, '1070', loaded);
    const data = new DataGroup({});
    addPinnedData(data, pinnedEntries(loaded, '1070'));

    expect(resolveDataPath(data, 'averaged.2.data').part).toBe('1070');
    expect(resolveDataPath(data, 'averaged.2.data.1060').part).toBe('1060');
    expect(data.getData('averaged.2.data.Line')).toBe('ds-avg/1070/Line');
    expect(data.getData('averaged.2.data.1060.Line')).toBe('ds-avg/1060/Line');
    expect(data.getData('inversion.1.model.Line')).toBe('ds-model/1070/Line');
    // The loaded data itself is left as it was.
    const followedRaw = pinnedEntries(loaded, '1070').find(e => e.path === 'averaged.2.data').rawData;
    expect(Object.keys(followedRaw)).toEqual(['dsId', 'part']);
  });
});

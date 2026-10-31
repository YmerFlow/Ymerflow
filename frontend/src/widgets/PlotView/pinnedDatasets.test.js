import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake datasets: each part's statistics sidecar gives its Line value. The model's part names
// look like line numbers but hold other lines, so a match by part name would pick the wrong one.
const PART_LINES = {
  'ds-avg':     { p1: 1060, p2: 1070, 'L1.5': 1090, block: 'several' },
  'ds-model':   { 1070: 1060, 1060: 1070 },
  'ds-nostats': { a: null, b: null },
};
const fetches = [];
let statsCalls = 0;
vi.mock('../../datamodel/dataset', () => ({
  loadDataset: vi.fn(async dsId => ({
    getParts: () => Object.keys(PART_LINES[dsId]),
    fetchStats: async part => {
      statsCalls++;
      const v = PART_LINES[dsId][part];
      if (v == null) return null;
      return { flightlines: { Line: v === 'several' ? { count: 2, min: 1060, max: 1070 } : { constant: true, value: v } } };
    },
    fetchData: async part => { fetches.push([dsId, part]); return { dsId, part }; },
  })),
}));
import { ALL_LINES, followsLine, loadPinnedData, pinnedDataKey, pinnedEntries, selectedLine } from './pinnedDatasets';

// A block of several lines with an averaged and an inverted process pinned beside the edited one.
const PROCESSES = [
  { name: 'averaged', versions: [{ version: 2, outputs: { data: 'http://h/projects/p/dataset/ds-avg' } }] },
  { name: 'inversion', versions: [{ version: 1, outputs: { model: 'http://h/projects/p/dataset/ds-model' } }] },
  { name: 'old import', versions: [{ version: 1, outputs: { data: 'http://h/projects/p/dataset/ds-nostats' } }] },
];
const FOLLOWING = [
  { ChannelPlot: { dataset: 'current.data', channel: 'Ch01' } },
  { ChannelPlot: { dataset: 'averaged.2.data', channel: 'Ch01' } },
  { ResistivityCurtain: { dataset: 'inversion.1.model', resistivity: 'inversion.1.model.rho' } },
];

// One run of PlotView's lazy-load effect for the followed line.
function load(layers, line, loaded = new Map()) {
  return loadPinnedData(layers, PROCESSES, 'p', line, loaded, (key, entry) => loaded.set(key, entry)).then(() => loaded);
}

beforeEach(() => { fetches.length = 0; });

describe('pinned paths that follow the selected line', () => {
  it("show the pinned dataset's part with the same Line value, never the part with the same name", async () => {
    const loaded = await load(FOLLOWING, '1070');
    expect(fetches).toEqual([['ds-avg', 'p2'], ['ds-model', '1060']]);
    expect(loaded.get(pinnedDataKey('averaged.2.data', '1070'))).toMatchObject({
      dsPath: 'averaged.2.data', line: '1070', rawData: { dsId: 'ds-avg', part: 'p2' },
    });
  });

  it('load again for another line, keep both, and read the part statistics once', async () => {
    const loaded = await load(FOLLOWING, '1070');
    const calls = statsCalls;
    await load(FOLLOWING, '1060', loaded);
    await load(FOLLOWING, '1070', loaded);   // back to a line already loaded
    expect(fetches).toEqual([['ds-avg', 'p2'], ['ds-model', '1060'], ['ds-avg', 'p1'], ['ds-model', '1070']]);
    expect(statsCalls).toBe(calls);
    expect(pinnedEntries(loaded, '1060').map(e => e.rawData.part)).toEqual(['p1', '1070']);
  });

  it('show nothing, with a message, when no part has that Line', async () => {
    const loaded = await load(FOLLOWING, '1080');
    expect(fetches).toEqual([]);
    expect(pinnedEntries(loaded, '1080').map(e => [e.dsObj, e.message])).toEqual([
      [undefined, 'averaged.2.data has no part with Line 1080.'],
      [undefined, 'inversion.1.model has no part with Line 1080.'],
    ]);
  });

  it('say so when the parts have no statistics to match a Line by', async () => {
    const loaded = await load([{ ChannelPlot: { dataset: 'old import.1.data' } }], '1070');
    expect(fetches).toEqual([]);
    expect([...loaded.values()][0].message).toMatch(/no part statistics to find Line 1070 by; name a part with @<part>/);
  });

  it("load every part when every part is selected, and wait while the line is not known", async () => {
    await load(FOLLOWING, null);
    expect(fetches).toEqual([]);
    await load(FOLLOWING, ALL_LINES);
    expect(fetches).toEqual([['ds-avg', 'all'], ['ds-model', 'all']]);
  });
});

describe('pinned paths that name a fixed part', () => {
  const FIXED = [{ ChannelPlot: { dataset: 'averaged.2.data@p1', channel: 'Ch01' } }];

  it('stay on that part whatever line is selected', async () => {
    const loaded = await load(FIXED, '1070');
    await load(FIXED, '1060', loaded);
    await load(FIXED, null, loaded);
    expect(fetches).toEqual([['ds-avg', 'p1']]);
    expect(pinnedEntries(loaded, '1070')).toEqual(pinnedEntries(loaded, '1060'));
    expect(pinnedEntries(loaded, '1060')[0]).toMatchObject({ dsPath: 'averaged.2.data@p1', line: undefined });
  });

  it('match a part name with a dot in encoded space', async () => {
    await load([{ ChannelPlot: { dataset: 'averaged.2.data@L1,5' } }], '1070');
    expect(fetches).toEqual([['ds-avg', 'L1.5']]);
  });

  it('show nothing, with a message, for a part the dataset does not have', async () => {
    const loaded = await load([{ ChannelPlot: { dataset: 'averaged.2.data@p9' } }], '1070');
    expect(fetches).toEqual([]);
    expect([...loaded.values()][0].message).toBe('averaged.2.data has no part "p9".');
  });
});

describe('selectedLine', () => {
  it("follows every part when 'all' is selected", () => {
    expect(selectedLine('all', undefined)).toEqual({ line: ALL_LINES });
  });

  it("reads the selected part's Line value, as a string", () => {
    expect(selectedLine('1070', { Line: BigInt64Array.from([1070n, 1070n]) })).toEqual({ line: '1070' });
  });

  it('gives an error for a part with several lines or no line column, and waits for data', () => {
    expect(selectedLine('block', { Line: [1060, 1070] }).error).toMatch(/holds 2 lines/);
    expect(selectedLine('p1', { gtime: [1] }).error).toMatch(/no line column/);
    expect(selectedLine('p1', undefined)).toBeUndefined();
  });
});

describe('followsLine', () => {
  it('is true only when some pinned path has no fixed part', () => {
    expect(followsLine(FOLLOWING)).toBe(true);
    expect(followsLine([{ ChannelPlot: { dataset: 'averaged.2.data@p1' } }])).toBe(false);
    expect(followsLine([{ ChannelPlot: { dataset: 'current.data' } }])).toBe(false);
  });
});

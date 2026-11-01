import { describe, expect, it, vi } from 'vitest';
import XYZ from './libaarhusxyz';
import {
  acceptsEdits, appendDiff, buildDiffColumns, diffFromColumns, editedParameters, editedVersionRequest,
  inUseDiffReducer, resolveEditTarget, saveIntermediateStep,
} from './inUseDiffs';

describe('buildDiffColumns', () => {
  it('serializes edits keyed by BigInt sounding indices (int64 apply_idx)', () => {
    // As the lasso stored them before keys were normalized: BigInts from a BigInt64Array.
    const diff = { Ch01: new Map([[0, new Map([[18340n, 0], [18333n, 0]])], [1, new Map([[18333n, 1]])]]) };
    const { applyIdx, layerData } = buildDiffColumns(diff);
    expect(applyIdx).toEqual([18333, 18340]);
    expect(Float32Array.from(applyIdx)).toEqual(new Float32Array([18333, 18340]));
    expect(Array.from(layerData.InUse_Ch01.get(0))).toEqual([0, 0]);
    expect(layerData.InUse_Ch01.get(1)[0]).toBe(1);
    expect(Number.isNaN(layerData.InUse_Ch01.get(1)[1])).toBe(true);
  });

  it('treats the same sounding keyed as a BigInt and as a number as one row', () => {
    const diff = { Ch01: new Map([[0, new Map([[5n, 0]])], [1, new Map([[5, 1]])]]) };
    const { applyIdx, layerData } = buildDiffColumns(diff);
    expect(applyIdx).toEqual([5]);
    expect(layerData.InUse_Ch01.get(0)[0]).toBe(0);
    expect(layerData.InUse_Ch01.get(1)[0]).toBe(1);
  });
});

describe('resolveEditTarget', () => {
  const v1 = { version: 1, outputs: { processed_data: 'u1' } };
  const v2 = { version: 2, outputs: { processed_data: 'u2', 'qc 1.0': 'u3' } };
  const proc = { id: 'p1', name: 'Manual cull 1.0', versions: [v1, v2] };
  const processes = [proc];

  it('resolves "current.<dataset>" to the active process and version', () => {
    const t = resolveEditTarget('current.processed_data', { processId: 'p1', version: 1 }, processes);
    expect(t.process).toBe(proc);
    expect(t.versionObj).toBe(v1);
    expect(t.datasetName).toBe('processed_data');
  });

  it('resolves "<process>.<version>.<dataset>" with encoded segments', () => {
    const t = resolveEditTarget('Manual cull 1,0.2.qc 1,0', null, processes);
    expect(t.versionObj).toBe(v2);
    expect(t.datasetName).toBe('qc 1.0');
  });

  it('is null when the path no longer resolves', () => {
    expect(resolveEditTarget('current.processed_data', null, processes)).toBe(null);
    expect(resolveEditTarget('current.missing', { processId: 'p1', version: 2 }, processes)).toBe(null);
    expect(resolveEditTarget('Other.1.processed_data', null, processes)).toBe(null);
  });
});

describe('editedVersionRequest', () => {
  const proc = { id: 'p1', name: 'Manual cull' };
  const edited = {
    type: 'yf_process_tem',
    environment: { id: 'env1', name: 'Env' },
    parameters: { input_data: 'u0', diff: ['d1'] },
    resource_requests: { cpu: '16000m', memory: '24Gi', 'ephemeral-storage': '10Gi' },
    deadline_seconds: 14400,
    cluster: { id: 'c2', name: 'Big node' },
  };
  const edits = [{ datasetName: 'processed_data', diffUrl: 'd2' }];

  it('keeps the edited version\'s cluster, CPU, memory and deadline', () => {
    const request = editedVersionRequest(proc, edited, edits);
    expect(request.cluster).toEqual({ id: 'c2' });
    expect(request.resource_requests).toEqual({ cpu: '16000m', memory: '24Gi', 'ephemeral-storage': '10Gi' });
    expect(request.deadline_seconds).toBe(14400);
  });

  it('re-runs the same process, type, environment and parameters with the new diff added', () => {
    expect(editedVersionRequest(proc, edited, edits)).toEqual({
      id: 'p1', name: 'Manual cull', type: 'yf_process_tem', environment: { id: 'env1' },
      params: { input_data: 'u0', diff: ['d1', 'd2'] },
      resource_requests: edited.resource_requests, deadline_seconds: 14400, cluster: { id: 'c2' },
    });
  });

  it('leaves what the version does not have to the server defaults, never sending a null deadline', () => {
    const bare = { type: 'yf_process_tem', environment: { id: 'env1' }, parameters: {} };
    const request = editedVersionRequest(proc, bare, [{ datasetName: 'processed_data', diffUrl: 'd1' }]);
    expect(request.resource_requests).toBe(null);
    expect(request.cluster).toBe(null);
    expect('deadline_seconds' in request).toBe(false);
  });
});

// Save points as the two libraries write them: the step key differs, the args do not.
const yfPoint = (name, diff) => ({ save_intermediate_and_apply_diff: { name, diff } });
const emPoint = (name, diff) => ({ 'Save intermediate results and apply manual edits': { name, diff } });
const otherStep = { average_soundings: { spacing_m: 20 } };

describe('saveIntermediateStep', () => {
  it('matches a ymerflow save point by its name and diff field', () => {
    const steps = [otherStep, yfPoint('raw_edited', 'u1'), yfPoint('averaged_edited', null)];
    const match = saveIntermediateStep(steps, 'raw_edited');
    expect(match.step).toBe(steps[1]);
    expect(match.key).toBe('save_intermediate_and_apply_diff');
    expect(match.args).toEqual({ name: 'raw_edited', diff: 'u1' });
    expect(saveIntermediateStep(steps, 'averaged_edited').args.diff).toBe(null);
  });

  it('matches an emerald save point under its human-readable key', () => {
    const steps = [otherStep, emPoint('raw_edited', null)];
    const match = saveIntermediateStep(steps, 'raw_edited');
    expect(match.step).toBe(steps[1]);
    expect(match.key).toBe('Save intermediate results and apply manual edits');
  });

  it('is null for another name, a step with no diff field, or no list of steps', () => {
    expect(saveIntermediateStep([yfPoint('raw_edited', 'u1')], 'processed_data')).toBe(null);
    expect(saveIntermediateStep([{ write_intermediate: { name: 'raw_edited' } }], 'raw_edited')).toBe(null);
    expect(saveIntermediateStep(undefined, 'raw_edited')).toBe(null);
    expect(saveIntermediateStep({ save_intermediate_and_apply_diff: { name: 'raw_edited', diff: null } }, 'raw_edited')).toBe(null);
  });
});

describe('diffFromColumns', () => {
  const diff = {
    Ch01: new Map([[0, new Map([[18333, 0], [18340, 1]])], [3, new Map([[18340, 0]])]]),
    Ch02: new Map([[5, new Map([[2, 1]])]]),
  };

  it('reads back what buildDiffColumns wrote', () => {
    const { applyIdx, layerData } = buildDiffColumns(diff);
    expect(diffFromColumns({ flightlines: { apply_idx: Float32Array.from(applyIdx) }, layer_data: layerData })).toEqual(diff);
  });

  it('reads back a saved diff file, the way Save writes it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});  // the XYZ reader logs what it decodes
    const { applyIdx, layerData } = buildDiffColumns(diff);
    const binary = XYZ.fromData({
      flightlines: { apply_idx: Float32Array.from(applyIdx) },
      layer_data: layerData,
      model_info: { diff_dummy: NaN },
    }).dump();
    expect(diffFromColumns(new XYZ(binary))).toEqual(diff);
    vi.restoreAllMocks();
  });

  it('keys soundings by Number from an int64 apply_idx, and leaves out gates with no edit', () => {
    const xyz = {
      flightlines: { apply_idx: BigInt64Array.from([7n, 9n]) },
      layer_data: {
        InUse_Ch01: new Map([[0, Float32Array.from([1, NaN])], [1, Float32Array.from([NaN, NaN])]]),
        InUse_Ch02: new Map([[0, Float32Array.from([NaN, NaN])]]),
        Gate_Ch01: new Map([[0, Float32Array.from([1e-6, 2e-6])]]),
      },
    };
    const read = diffFromColumns(xyz);
    expect(read).toEqual({ Ch01: new Map([[0, new Map([[7, 1]])]]) });
    expect(typeof [...read.Ch01.get(0).keys()][0]).toBe('number');
  });
});

describe('editedParameters', () => {
  const pipeline = () => ({
    type: 'yf_process_tem',
    parameters: {
      input_data: 'u0',
      steps: [otherStep, yfPoint('raw_edited', 'old1'), { cull_sparse_soundings: { min_gates: 3 } }, yfPoint('averaged_edited', 'old2')],
    },
  });

  it('replaces the matching save point\'s diff and leaves everything else as it was', () => {
    const ver = pipeline();
    const before = structuredClone(ver);
    const params = editedParameters(ver, [{ datasetName: 'raw_edited', diffUrl: 'new1' }]);
    expect(params).toEqual({
      input_data: 'u0',
      steps: [otherStep, yfPoint('raw_edited', 'new1'), { cull_sparse_soundings: { min_gates: 3 } }, yfPoint('averaged_edited', 'old2')],
    });
    expect('diff' in params).toBe(false);
    expect(ver).toEqual(before);
  });

  it('sets two save points of one pipeline in one call, and clears an emptied one', () => {
    const params = editedParameters(pipeline(), [
      { datasetName: 'raw_edited', diffUrl: 'new1' },
      { datasetName: 'averaged_edited', diffUrl: null },
    ]);
    expect(params.steps[1]).toEqual(yfPoint('raw_edited', 'new1'));
    expect(params.steps[3]).toEqual(yfPoint('averaged_edited', null));
  });

  it('replaces, not appends, on a second save of the same save point', () => {
    const first = { ...pipeline(), parameters: editedParameters(pipeline(), [{ datasetName: 'raw_edited', diffUrl: 'new1' }]) };
    const second = editedParameters(first, [{ datasetName: 'raw_edited', diffUrl: 'new2' }]);
    expect(second.steps[1]).toEqual(yfPoint('raw_edited', 'new2'));
  });

  it('sets an emerald save point the same way, keeping its other args', () => {
    const ver = { type: 'process_tem', parameters: { steps: [{ 'Save intermediate results and apply manual edits': { name: 'raw_edited', diff: null, extra: 1 } }] } };
    expect(editedParameters(ver, [{ datasetName: 'raw_edited', diffUrl: 'new1' }]).steps[0])
      .toEqual({ 'Save intermediate results and apply manual edits': { name: 'raw_edited', diff: 'new1', extra: 1 } });
  });

  it('appends to the process-level diff list when the dataset has no save point', () => {
    const ver = { type: 'apply_manual_edits', parameters: { input_data: 'u0', diff: ['d1'] } };
    const params = editedParameters(ver, [{ datasetName: 'processed_data', diffUrl: 'd2' }]);
    expect(params).toEqual({ input_data: 'u0', diff: ['d1', 'd2'] });
    expect(ver.parameters.diff).toEqual(['d1']);
  });
});

describe('acceptsEdits', () => {
  const types = {
    apply_manual_edits: { schema: { properties: { input_data: {}, diff: {} } } },
    process_tem: { schema: { properties: { input_data: {}, steps: {} } } },
  };
  const pipelineVer = { type: 'process_tem', parameters: { steps: [otherStep, emPoint('raw_edited', null)] } };

  it('is true for a pipeline output with a save point, though the type declares no diff', () => {
    expect(acceptsEdits(types, pipelineVer, 'raw_edited')).toBe(true);
  });

  it('is true for a process type whose form declares diff', () => {
    expect(acceptsEdits(types, { type: 'apply_manual_edits', parameters: {} }, 'processed_data')).toBe(true);
  });

  it('is false for a pipeline output with no save point and no process-level diff', () => {
    expect(acceptsEdits(types, pipelineVer, 'processed_data')).toBe(false);
  });

  it('is false for a type the environment does not list', () => {
    expect(acceptsEdits(types, { type: 'import_skytem', parameters: {} }, 'processed_data')).toBe(false);
    expect(acceptsEdits(undefined, { type: 'apply_manual_edits', parameters: {} }, 'processed_data')).toBe(false);
  });
});

describe('inUseDiffReducer dirty tracking', () => {
  const PATH = 'current.raw_edited';
  const empty = { diffs: {}, history: {}, dirty: {} };
  const loaded = { Ch01: new Map([[0, new Map([[4, 0]])]]) };
  const edit = (state, soundingIndex, value = 0) =>
    inUseDiffReducer(state, { type: 'APPLY_EDIT', datasetName: PATH, channel: 'Ch01', entries: [{ soundingIndex, gateIndex: 0 }], value });
  const load = (state, diff = loaded) => inUseDiffReducer(state, { type: 'LOAD', datasetName: PATH, diff });

  it('loads a saved edit clean, with nothing to undo', () => {
    const state = load(empty);
    expect(state.diffs[PATH]).toBe(loaded);
    expect(state.history[PATH]).toEqual([]);
    expect(state.dirty[PATH]).toBe(false);
  });

  it('marks a path dirty on an edit and on an undo', () => {
    const edited = edit(load(empty), 5);
    expect(edited.dirty[PATH]).toBe(true);
    const undone = inUseDiffReducer({ ...edited, dirty: { [PATH]: false } }, { type: 'UNDO', datasetName: PATH });
    expect(undone.dirty[PATH]).toBe(true);
    expect(undone.diffs[PATH]).toEqual(loaded);
  });

  it('marks a path edited from scratch dirty from its first edit', () => {
    expect(edit(empty, 5).dirty[PATH]).toBe(true);
  });

  it('drops the flag on CLEAR and CLEAR_ALL', () => {
    const edited = edit(load(empty), 5);
    expect(PATH in inUseDiffReducer(edited, { type: 'CLEAR', datasetName: PATH }).dirty).toBe(false);
    expect(inUseDiffReducer(edited, { type: 'CLEAR_ALL' })).toEqual(empty);
  });

  it('replaces a clean path\'s edit with a newer load', () => {
    const newer = { Ch01: new Map([[1, new Map([[8, 1]])]]) };
    const state = load(load(empty), newer);
    expect(state.diffs[PATH]).toBe(newer);
    expect(state.dirty[PATH]).toBe(false);
  });

  it('keeps edits made before the load finished on top of the loaded edit, in every undo step', () => {
    let state = edit(edit(empty, 5), 4, 1);  // sounding 4 enabled, over the loaded disable
    state = load(state);
    expect(state.dirty[PATH]).toBe(true);
    expect(state.diffs[PATH]).toEqual({ Ch01: new Map([[0, new Map([[4, 1], [5, 0]])]]) });
    state = inUseDiffReducer(state, { type: 'UNDO', datasetName: PATH });
    expect(state.diffs[PATH]).toEqual({ Ch01: new Map([[0, new Map([[4, 0], [5, 0]])]]) });
    state = inUseDiffReducer(state, { type: 'UNDO', datasetName: PATH });
    expect(state.diffs[PATH]).toEqual(loaded);
  });

  it('puts a loaded path before the edited ones, so Undo still finds the last edited path', () => {
    const state = load(edit(empty, 5, 0), loaded);
    const other = inUseDiffReducer(state, { type: 'LOAD', datasetName: 'current.averaged_edited', diff: {} });
    expect(Object.keys(other.diffs).at(-1)).toBe(PATH);
  });
});

describe('appendDiff', () => {
  it('starts a list on the first save', () => {
    expect(appendDiff(undefined, 'b')).toEqual(['b']);
    expect(appendDiff(null, 'b')).toEqual(['b']);
    expect(appendDiff('', 'b')).toEqual(['b']);
  });

  it('keeps a single diff saved before diffs accumulated', () => {
    expect(appendDiff('a', 'b')).toEqual(['a', 'b']);
  });

  it('appends to the earlier rounds, in order', () => {
    expect(appendDiff(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('does not modify the earlier version\'s parameters', () => {
    const previous = ['a'];
    appendDiff(previous, 'b');
    expect(previous).toEqual(['a']);
  });
});

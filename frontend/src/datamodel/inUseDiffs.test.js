import { describe, expect, it } from 'vitest';
import { acceptsEdits, appendDiff, resolveEditTarget } from './inUseDiffs';

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

describe('acceptsEdits', () => {
  const types = {
    yf_process_tem: { schema: { properties: { input_data: {}, steps: {}, diff: {} } } },
    process_tem: { schema: { properties: { input_data: {}, steps: {} } } },
  };

  it('is true for a process type whose form declares diff', () => {
    expect(acceptsEdits(types, 'yf_process_tem')).toBe(true);
  });

  it('is false for one whose form does not', () => {
    expect(acceptsEdits(types, 'process_tem')).toBe(false);
  });

  it('is false for a type the environment does not list', () => {
    expect(acceptsEdits(types, 'import_skytem')).toBe(false);
    expect(acceptsEdits(undefined, 'yf_process_tem')).toBe(false);
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

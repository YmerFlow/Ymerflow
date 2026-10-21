import { describe, expect, it } from 'vitest';
import { acceptsEdits, appendDiff } from './inUseDiffs';

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

import { describe, expect, it } from 'vitest';
import { appendDiff } from './inUseDiffs';

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

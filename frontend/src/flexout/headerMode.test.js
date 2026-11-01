import { describe, expect, it } from 'vitest';
import { resolveGlobalCompact, isCompact } from './headerMode';

describe('resolveGlobalCompact', () => {
  it('reads the root node field when the inherited prop is undefined (the root pane)', () => {
    expect(resolveGlobalCompact({ globalCompact: true }, undefined)).toBe(true);
    expect(resolveGlobalCompact({ globalCompact: false }, undefined)).toBe(false);
    expect(resolveGlobalCompact({}, undefined)).toBe(false);
  });

  it('uses the inherited prop for non-root panes, ignoring the node field', () => {
    expect(resolveGlobalCompact({ globalCompact: true }, false)).toBe(false);
    expect(resolveGlobalCompact({ globalCompact: false }, true)).toBe(true);
  });
});

describe('isCompact', () => {
  const call = (o) => isCompact({ node: {}, inheritedCompact: undefined, globalCompact: false, isMobile: false, ...o });

  it('is never compact on mobile, even under global compact or node.compact', () => {
    expect(call({ isMobile: true, globalCompact: true })).toBe(false);
    expect(call({ isMobile: true, node: { compact: true } })).toBe(false);
  });

  it('is always compact under global compact (overriding node and inheritance)', () => {
    expect(call({ globalCompact: true, node: { compact: false }, inheritedCompact: false })).toBe(true);
  });

  it("uses the node's own compact when set, over the inherited value", () => {
    expect(call({ node: { compact: true }, inheritedCompact: false })).toBe(true);
    expect(call({ node: { compact: false }, inheritedCompact: true })).toBe(false);
  });

  it('inherits the parent value when the node has no compact field', () => {
    expect(call({ node: {}, inheritedCompact: true })).toBe(true);
    expect(call({ node: {}, inheritedCompact: false })).toBe(false);
  });

  it('defaults to shown (false) at the root with nothing set', () => {
    expect(call({ node: {}, inheritedCompact: undefined })).toBe(false);
  });
});

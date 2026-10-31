import { describe, expect, it } from 'vitest';
import { headerMode, inheritedHeader } from './headerMode';

describe('inheritedHeader', () => {
  it('defaults to shown at the root', () => {
    expect(inheritedHeader({ id: 'root' }, undefined)).toBe('shown');
  });

  it('takes the parent value when the node has none', () => {
    expect(inheritedHeader({ id: 'a' }, 'compact')).toBe('compact');
  });

  it('lets a node override its parent', () => {
    expect(inheritedHeader({ id: 'a', header: 'shown' }, 'compact')).toBe('shown');
    expect(inheritedHeader({ id: 'a', header: 'compact' }, 'shown')).toBe('compact');
  });

  it('ignores an unknown value', () => {
    expect(inheritedHeader({ id: 'a', header: 'hidden' }, 'compact')).toBe('compact');
  });

  it('carries a Grid setting down to its cells', () => {
    const grid = { id: 'g', header: 'compact', children: [{ id: 'c1' }, { id: 'c2', header: 'shown' }] };
    const fromGrid = inheritedHeader(grid, 'shown');
    expect(grid.children.map(c => headerMode(c, fromGrid, false, false))).toEqual(['compact', 'shown']);
  });
});

describe('headerMode', () => {
  it('draws the inherited mode without flex view', () => {
    expect(headerMode({ id: 'a' }, 'compact', false, false)).toBe('compact');
  });

  it('draws no header in flex view, whatever the node says', () => {
    expect(headerMode({ id: 'a', header: 'shown' }, 'shown', true, false)).toBe('none');
    expect(headerMode({ id: 'a', header: 'compact' }, 'shown', true, false)).toBe('none');
  });

  it('keeps headers on mobile in flex view', () => {
    expect(headerMode({ id: 'a', header: 'compact' }, 'shown', true, true)).toBe('compact');
    expect(headerMode({ id: 'a' }, undefined, true, true)).toBe('shown');
  });
});

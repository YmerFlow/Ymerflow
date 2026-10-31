import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DndProvider } from 'react-dnd';
import { LayoutProvider } from '../LayoutContext';
import { MainLayout } from '../Layout';

// The config form pulls in the API client, which needs a browser; the header is all we look at.
vi.mock('../../jsoneditor', () => ({ CustomForm: () => null }));

// Pane and TabSet only need drag and drop to exist, not to work.
const stubBackend = () => ({
  setup() {}, teardown() {}, profile() { return {}; },
  connectDragSource() { return () => {}; },
  connectDragPreview() { return () => {}; },
  connectDropTarget() { return () => {}; },
});

const Leaf = () => <div className="leaf" />;
Leaf.title = 'Leaf';

// A compact Grid holding a leaf, a leaf that asks for a full header, a Split and a TabSet:
// seven panes draw a header (the TabSet's tab does not), six of them compact.
const layout = (extra = {}) => ({
  id: 'root', widget: 'Grid', rows: 2, cols: 2, header: 'compact', ...extra,
  children: [
    { id: 'a', widget: 'Leaf' },
    { id: 'b', widget: 'Leaf', header: 'shown' },
    { id: 's', widget: 'VerticalSplit', children: [{ id: 's1', widget: 'Leaf' }, { id: 's2', widget: 'Leaf' }] },
    { id: 't', widget: 'TabSet', children: [{ id: 't1', widget: 'Leaf' }] },
  ],
});

const render = (l) => renderToStaticMarkup(
  <DndProvider backend={stubBackend}>
    <LayoutProvider widgets={{ Leaf }} initial_layout={l}>
      <MainLayout />
    </LayoutProvider>
  </DndProvider>
);

const count = (html, re) => (html.match(re) || []).length;
const HEADER = /class="[^"]*pane-header[ "]/g;

describe('pane headers', () => {
  it('carries a compact setting down through Grid, Split and TabSet', () => {
    const html = render(layout());
    expect(count(html, HEADER)).toBe(7);
    expect(count(html, /pane-header-compact/g)).toBe(6);
    expect(count(html, /class="leaf"/g)).toBe(5);
    expect(html).not.toContain('flex-view');
  });

  it('draws no headers in flex view', () => {
    const html = render(layout({ flexView: true }));
    expect(count(html, HEADER)).toBe(0);
    expect(html).toContain('class="flex-view"');
    expect(count(html, /class="leaf"/g)).toBe(5);
  });

  it('draws full headers on a layout saved before this change', () => {
    const { header, ...saved } = layout();
    const html = render(saved);
    expect(count(html, HEADER)).toBe(7);
    expect(count(html, /pane-header-compact/g)).toBe(0);
  });
});

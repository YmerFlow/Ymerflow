// @vitest-environment jsdom
// jsdom provides `window` — buildWorkspaceSchema imports the flexout builtins, whose
// component import chain touches browser-only modules (api.js reads window.location).
import { describe, expect, it } from 'vitest';
import { buildWorkspaceSchema } from './workspaceSchema';

// A PlotView-shaped mock: get_schema returns a full node schema whose
// properties.layoutConfig holds the config, and the layers union lives under
// layoutConfig.layers.items.anyOf (as gladly emits it). Carries its own $defs.
function makePlotViewMock() {
  const PlotView = () => null;
  PlotView.title = 'Plot';
  PlotView.get_schema = () => ({
    type: 'object',
    $defs: { expression: { type: 'string' } },
    properties: {
      id: { type: 'string' },
      widget: { type: 'string' },
      layoutConfig: {
        type: 'object',
        properties: {
          layers: {
            type: 'array',
            items: {
              anyOf: [
                { title: 'LayerA', properties: { LayerA: { type: 'object' } } },
                { title: 'LayerB', properties: { LayerB: { type: 'object' } } },
              ],
            },
          },
        },
      },
    },
    required: ['layoutConfig'],
  });
  return PlotView;
}

// A plain leaf widget with no config schema.
function makeLeafMock() {
  const FlowView = () => null;
  FlowView.title = 'Flow';
  return FlowView;
}

const BUILTINS = ['VerticalSplit', 'HorizontalSplit', 'TabSet', 'Grid', 'Empty'];
const CONTAINERS = ['VerticalSplit', 'HorizontalSplit', 'TabSet', 'Grid'];

describe('buildWorkspaceSchema', () => {
  const schema = buildWorkspaceSchema({ PlotView: makePlotViewMock(), FlowView: makeLeafMock() });
  const defs = schema.$defs;

  it('is a draft-07 document rooted at #/$defs/Node', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$ref).toBe('#/$defs/Node');
  });

  it('Node.oneOf lists every widget (flexout builtins + app widgets)', () => {
    const referenced = defs.Node.oneOf.map(r => r.$ref.replace('#/$defs/', '').replace(/Node$/, ''));
    for (const name of [...BUILTINS, 'PlotView', 'FlowView']) {
      expect(referenced).toContain(name);
      expect(defs[`${name}Node`]).toBeDefined();
    }
    // exactly those widgets, no stray defs in the union
    expect(referenced.sort()).toEqual([...BUILTINS, 'PlotView', 'FlowView'].sort());
  });

  it('every node def carries the generic envelope (id, widget const, customTitle, compact)', () => {
    for (const name of [...BUILTINS, 'PlotView', 'FlowView']) {
      const props = defs[`${name}Node`].properties;
      expect(props.id).toBeDefined();
      expect(props.widget).toEqual({ const: name });
      expect(props.customTitle).toBeDefined();
      expect(props.compact).toBeDefined();
      expect(defs[`${name}Node`].additionalProperties).toBe(false);
      expect(defs[`${name}Node`].required).toEqual(expect.arrayContaining(['id', 'widget']));
    }
  });

  it('container defs carry children recursing to #/$defs/Node, plus globalCompact', () => {
    for (const name of CONTAINERS) {
      const nodeDef = defs[`${name}Node`];
      expect(nodeDef.properties.children).toEqual({
        type: 'array',
        items: { $ref: '#/$defs/Node' },
        minItems: 1,
      });
      expect(nodeDef.properties.globalCompact).toBeDefined();
      expect(nodeDef.required).toContain('children');
    }
  });

  it('leaf defs have no children and never require it', () => {
    for (const name of ['PlotView', 'FlowView', 'Empty']) {
      expect(defs[`${name}Node`].properties.children).toBeUndefined();
      expect(defs[`${name}Node`].required).not.toContain('children');
    }
  });

  it('declares each container\'s structural fields (size / activeTab / colWidths / rowHeights)', () => {
    expect(defs.VerticalSplitNode.properties.size).toBeDefined();
    expect(defs.HorizontalSplitNode.properties.size).toBeDefined();
    expect(defs.TabSetNode.properties.activeTab).toBeDefined();
    expect(defs.GridNode.properties.colWidths).toBeDefined();
    expect(defs.GridNode.properties.rowHeights).toBeDefined();
  });

  it('Grid merges its get_schema config (rows/cols) as top-level node fields', () => {
    // Grid's get_schema is a bare object schema, so its properties become top-level node
    // fields (that is how the widget stores them), not nested under layoutConfig.
    expect(defs.GridNode.properties.rows).toBeDefined();
    expect(defs.GridNode.properties.cols).toBeDefined();
    expect(defs.GridNode.properties.layoutConfig).toBeUndefined();
  });

  it('PlotViewNode embeds the full layoutConfig with its layer union intact', () => {
    const pv = defs.PlotViewNode;
    const layers = pv.properties.layoutConfig.properties.layers;
    expect(layers.items.anyOf).toHaveLength(2);
    expect(layers.items.anyOf.map(m => m.title)).toEqual(['LayerA', 'LayerB']);
  });

  it('a widget\'s own $defs ride along on its node def', () => {
    expect(defs.PlotViewNode.$defs).toEqual({ expression: { type: 'string' } });
    expect(defs.FlowViewNode.$defs).toBeUndefined();
  });
});

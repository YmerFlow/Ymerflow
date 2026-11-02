// Single source of truth for the workspace-layout JSON Schema.
//
// A workspace layout is a recursive tree of nodes. Every node is an object with a
// generic flexout envelope (`id`, `widget`, optional `customTitle` / `compact`), and —
// depending on the widget — either a widget-specific config (`layoutConfig` or, for a
// few widgets, top-level config fields) or, for container widgets, a `children` array of
// nested nodes. `buildWorkspaceSchema` assembles one full recursive JSON Schema for the
// whole tree: every widget gets a `<Widget>Node` def, containers recurse into
// `#/$defs/Node`, and `Node` is the `oneOf` union of them all.
//
// This is flexout's own code, so it is allowed to know special things about itself: the
// generic node fields and the set of container widgets are declared here, once. The
// backend MCP tools (backend/routers/workspaces.py) only slice and chunk the document
// this produces — they never construct schema. See
// docs/plans/done/frontend-owned-workspace-schema.md.

import { builtinWidgets } from './LayoutContext';

// The flexout node types that hold a `children` array of nested nodes rather than being
// leaves. The one place that hardcodes "these widgets are containers" — fine, because this
// is flexout's own code describing its own nodes.
const CONTAINER_WIDGETS = ['VerticalSplit', 'HorizontalSplit', 'TabSet', 'Grid'];

// Generic flexout node fields any node may carry (handled by flexout itself, not by any
// widget's config schema). Declared once here so a future generic field is a one-line
// change that flows straight to the MCP schema.
const ID_PROP = { type: 'string', description: 'Unique pane identifier (UUID recommended)' };
const CUSTOM_TITLE_PROP = { type: 'string', description: "Overrides the pane's displayed title." };
const COMPACT_PROP = {
  type: 'boolean',
  description: 'Draw the compact corner-arrow header; inherited by descendant panes.',
};
const GLOBAL_COMPACT_PROP = {
  type: 'boolean',
  description: 'Root node only: force every pane to the compact header.',
};

// Structural fields specific to each container type (beyond `children`). flexout owns these,
// so they are declared alongside the container set; `additionalProperties: false` would
// otherwise mark a real `size` / `activeTab` / `colWidths` as invalid.
const CONTAINER_STRUCTURAL_PROPS = {
  VerticalSplit: {
    size: { type: 'number', minimum: 0.1, maximum: 0.9, description: 'Fraction of space given to the first child (0.1–0.9, default 0.5).' },
  },
  HorizontalSplit: {
    size: { type: 'number', minimum: 0.1, maximum: 0.9, description: 'Fraction of space given to the first child (0.1–0.9, default 0.5).' },
  },
  TabSet: {
    activeTab: { type: 'string', description: 'Id of the currently selected child tab; defaults to the first child.' },
  },
  Grid: {
    colWidths: { type: 'array', items: { type: 'number' }, description: 'Column width fractions (one per column); normalized at render time.' },
    rowHeights: { type: 'array', items: { type: 'number' }, description: 'Row height fractions (one per row); normalized at render time.' },
  },
};

// Property keys that make up the generic envelope / structure, never a widget "param".
const ENVELOPE_KEYS = new Set(['id', 'widget', 'customTitle', 'compact', 'globalCompact', 'children']);

// Normalize a widget's get_schema() output to `{ layoutConfig, topLevelProps, defs }`.
//
// A widget's get_schema() may be either a full node schema whose `properties.layoutConfig`
// holds the config (PlotView), or a bare object schema whose `properties` ARE the config
// — and for some widgets (e.g. Grid's rows/cols) those live as top-level node fields, which
// is exactly how the widget stores them on the node. We honour both: a `layoutConfig`
// property nests under `layoutConfig`; a bare schema's properties merge in at the top level.
function normalizeWidgetSchema(Widget) {
  if (typeof Widget?.get_schema !== 'function') return { layoutConfig: null, topLevelProps: null, defs: null };
  const schema = Widget.get_schema({});
  if (!schema || typeof schema !== 'object') return { layoutConfig: null, topLevelProps: null, defs: null };
  const defs = schema.$defs || null;
  const props = schema.properties || {};
  if ('layoutConfig' in props) {
    return { layoutConfig: props.layoutConfig, topLevelProps: null, defs };
  }
  // Bare config schema → its properties (minus anything already in the envelope) are
  // top-level node fields.
  const topLevelProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ENVELOPE_KEYS.has(k)) topLevelProps[k] = v;
  }
  return { layoutConfig: null, topLevelProps: Object.keys(topLevelProps).length ? topLevelProps : null, defs };
}

function buildNodeDef(widgetName, Widget) {
  const isContainer = CONTAINER_WIDGETS.includes(widgetName);
  const { layoutConfig, topLevelProps, defs } = normalizeWidgetSchema(Widget);

  const properties = {
    id: ID_PROP,
    widget: { const: widgetName },
    customTitle: CUSTOM_TITLE_PROP,
    compact: COMPACT_PROP,
  };

  if (layoutConfig) properties.layoutConfig = layoutConfig;
  if (topLevelProps) Object.assign(properties, topLevelProps);

  const required = ['id', 'widget'];

  if (isContainer) {
    properties.children = {
      type: 'array',
      items: { $ref: '#/$defs/Node' },
      minItems: 1,
    };
    properties.globalCompact = GLOBAL_COMPACT_PROP;
    Object.assign(properties, CONTAINER_STRUCTURAL_PROPS[widgetName] || {});
    required.push('children');
  }

  const nodeDef = {
    type: 'object',
    title: Widget?.title || widgetName,
    properties,
    required,
    additionalProperties: false,
  };
  if (Widget?.description) nodeDef.description = Widget.description;
  // A widget's own $defs ride along on its node def so a sliced-out node response is
  // self-contained (its `#/$defs/...` refs resolve against the slice root).
  if (defs) nodeDef.$defs = defs;
  return nodeDef;
}

// Build the full recursive workspace-layout schema from the app's leaf widgets merged with
// flexout's own built-in node types. Pass the leaf-widget map (as App.jsx builds it from the
// `widgets` hook); the flexout builtins are added here.
export function buildWorkspaceSchema(appWidgets = {}) {
  // Builtins first (containers + Empty), then app leaf widgets — this order is preserved in
  // the emitted $defs and drives the terse widget index the backend derives.
  const allWidgets = { ...builtinWidgets, ...appWidgets };

  const defs = {};
  const nodeRefs = [];
  for (const [widgetName, Widget] of Object.entries(allWidgets)) {
    defs[`${widgetName}Node`] = buildNodeDef(widgetName, Widget);
    nodeRefs.push({ $ref: `#/$defs/${widgetName}Node` });
  }
  defs.Node = { oneOf: nodeRefs };

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Workspace Layout',
    description:
      'Recursive layout tree for a YmerFlow workspace. ' +
      'The root is typically a VerticalSplit or TabSet container.',
    $defs: defs,
    $ref: '#/$defs/Node',
  };
}

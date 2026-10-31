// Pane header modes. Any layout node may set `header: "shown" | "compact"`; a node
// without it takes its parent's, and the root defaults to "shown". Flex view, saved as
// `flexView: true` on the root node, turns every header off, except on mobile, where the
// headers are the only way to tell stacked panes apart.

export const HEADER_MODES = ['shown', 'compact'];

// The mode a node hands down to its children: its own setting, else the inherited one.
export function inheritedHeader(node, inherited) {
  if (HEADER_MODES.includes(node?.header)) return node.header;
  return inherited || 'shown';
}

// The header a pane draws: "shown", "compact" or "none".
export function headerMode(node, inherited, flexView, isMobile) {
  if (flexView && !isMobile) return 'none';
  return inheritedHeader(node, inherited);
}

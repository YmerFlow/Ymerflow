// Pure header-mode rules for a flexout pane — no React, so they can be unit tested.
//
// A pane draws one of two chromes:
//   shown   — the full header row (title, drag handle, menu toggle)
//   compact — no header row; a single corner arrow overlays the widget content
//
// The choice is inherited down the layout tree. See docs/frontend/layout.md.

/**
 * Resolve the global-compact flag for a pane.
 *
 * Global compact originates once at the root node (the only pane whose
 * `inheritedGlobalCompact` prop is undefined) from its own `globalCompact`
 * field, and is then threaded unchanged to every descendant. A non-root node's
 * own `globalCompact` field is ignored — only the root's value matters.
 */
export function resolveGlobalCompact(node, inheritedGlobalCompact) {
  if (inheritedGlobalCompact !== undefined) return inheritedGlobalCompact;
  return node?.globalCompact ?? false;
}

/**
 * Whether a pane is compact.
 *
 * Order of precedence:
 *   1. mobile wins — always shown (headers are the only way to tell stacked panes apart)
 *   2. global compact — always compact, overriding each node's own setting and inheritance
 *   3. otherwise `node.compact ?? inheritedCompact ?? false`
 *
 * `globalCompact` is the value from resolveGlobalCompact().
 */
export function isCompact({ node, inheritedCompact, globalCompact, isMobile }) {
  if (isMobile) return false;
  if (globalCompact) return true;
  return node?.compact ?? inheritedCompact ?? false;
}

# Compact and hidden pane headers

**State:** open, waiting on design decisions
**Labels:** enhancement, frontend, layout

## Motivation

Every node in a flexout layout is rendered through `Pane.jsx`, containers included, and every `Pane` draws a header row of about 24 px: the title (click to rename), the drag handle for moving the pane, and the menu toggle (configure, remove, change widget). A Grid of four stacked plots therefore spends five header rows, about 120 px, before any plot is drawn. On a short plot, such as a loop-height strip in an editing workspace, the header and the PlotView status bar together take about as much height as the data.

Today the header can only be hidden inside a TabSet, where `TabSet.jsx` passes `hideHeader` because the tab strip carries the title and menu instead. There is no way to hide or shrink the header anywhere else.

The PlotView margin change (#133) covers the space inside a plot. This plan covers the header around it.

## Proposal

A generic option on any layout node controls its header. The repo's rule that `flexout/` holds no project-specific code stands: the option knows nothing about the widget inside the pane.

```js
{ id, widget: "PlotView", header: "hidden", layoutConfig: { ... } }
```

| `header` | header row | title, drag, menu |
|---|---|---|
| absent or `"shown"` | as today, ~24 px | always visible |
| `"compact"` | ~14 px, smaller font, no padding | always visible |
| `"hidden"` | 0 px | in an overlay that appears when the pointer reaches the top edge of the pane |

The hidden header is an overlay, positioned over the top of the pane, so it takes no layout height. A thin hot zone, about 6 px, along the top edge of the pane shows the overlay; the overlay stays while the pointer is on it and goes when it leaves. Hovering the rest of the pane does nothing, so lasso editing and pan/zoom near the top of a plot are not interrupted. The overlay holds the same title, drag handle and menu as the normal header, so nothing becomes unreachable.

The pane menu gains a three-way control (shown / compact / hidden) that writes the field, so the option can be set without editing JSON. On mobile, where the layout already stacks panes and there is no hover, the header is always shown.

The content padding below the header (`pt-1`, 4 px) is dropped for compact and hidden headers.

## Decisions needed

1. Compact, hidden, or both. The table offers both. Compact is simpler and always discoverable; hidden saves the whole row. Recommendation: both, since they cost about the same once the field exists.
2. How a hidden header is reached. Options: (a) hot zone on the top edge shows the overlay, as above; (b) hovering anywhere in the pane shows the overlay; (c) no overlay, a small menu button always visible in a corner, with title and drag only available by switching the header back on. Recommendation: (a). (b) puts the overlay over the top of a plot whenever the pointer is in it. (c) loses drag-to-move and rename.
3. Per node, inherited, or workspace-wide. Options: (a) per node only; (b) per node, with a container's setting applying to its descendants unless they set their own, so one setting on a Grid covers it and its cells; (c) one switch for the whole workspace, in the menu bar. Recommendation: (b). (a) means five settings for a four-plot Grid; (c) cannot keep a header on the one pane that needs it.
4. PlotView status bar. PlotView draws its own 20 px status bar (cursor coordinates and the last picked point) under every plot. Should a `layoutConfig.statusBar: false` option come with this, or stay out of scope? It is PlotView's, not flexout's, so it would be a separate small change either way.

## Implementation (for decisions 1a, 2a, 3b)

- `Pane.jsx`: read `node.header` (or the inherited value) and render the header in one of three modes. Hidden mode renders the existing header markup inside an absolutely positioned overlay, plus the hot zone. The drag source and the menu move with it unchanged.
- `Split.jsx`, `Grid.jsx`, `TabSet.jsx`: pass the effective header mode down to the child `Pane`s as an `inheritedHeader` prop. TabSet keeps `hideHeader` for its own tabs.
- `PaneMenuDropdown` content in `Pane.jsx`: the shown / compact / hidden control.
- `frontend/src/styling.scss`: `.pane-header-compact`, `.pane-header-overlay`, `.pane-header-hotzone`.
- `backend/routers/workspaces.py`: the node schemas use `additionalProperties: false` and list only `id`, `widget`, `children` / `layoutConfig`, so `header` (and the existing `customTitle`, which is missing today) need adding to `_container_node_def` and `_leaf_node_def_raw` for workspaces written through the API to validate.
- `docs/frontend/layout.md`: document the field.
- Tests: vitest for the inheritance rule (a small pure function, effective mode from node and parent).

About half a day once the decisions are made.

## Not changing

Saved workspaces without the field look exactly as they do now. TabSet tabs keep their tab strip. Widgets are not told about the header and need no changes.

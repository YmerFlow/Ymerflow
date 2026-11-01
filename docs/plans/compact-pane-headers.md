# Compact pane headers, flex view and a workspace status bar

**State:** decided 2026-10-30; compact look and inheritance revised after review 2026-10-31; ready to implement
**Labels:** enhancement, frontend, layout

## Motivation

Every node in a flexout layout is rendered through `Pane.jsx`, containers included, and every `Pane` draws a header row of about 24 px: the title (click to rename), the drag handle for moving the pane, and the menu toggle (configure, remove, change widget). A Grid of four stacked plots therefore spends five header rows, about 120 px, before any plot is drawn. Each PlotView also draws its own 20 px status bar under the plot. On a short plot, such as a loop-height strip in an editing workspace, header and status bar together take about as much height as the data.

Today the header can only be hidden inside a TabSet, where `TabSet.jsx` passes `hideHeader` because the tab strip carries the title and menu instead.

The PlotView margin change (#133) covers the space inside a plot. This plan covers the header and status bar around it.

## Decisions (2026-10-30)

1. Compact headers, set per node and inherited down the layout. No hidden-header mode and no hover overlay.
2. A page-wide flex view tick box. When it is on, every pane header is off and panes are separated by a thin line. Untick it to rename, move or configure panes.
3. One status bar for the whole workspace, showing the readout of the plot under the pointer. Each plot's own status bar becomes optional.

Two details were left open. This plan recommends one answer for each, below, to be confirmed when the plan is merged:

- Flex view is saved with the workspace, not kept per viewer (see [Flex view](#flex-view)).
- The per-plot status bar is a PlotView setting, `layoutConfig.statusBar`, off by default (see [Status bar](#status-bar)).

Review, 2026-10-31: a compact header is not a thinner row but a small arrow over the pane's top-right corner, and containers thread the inherited value into each child's config. Both are written up under [Compact headers](#compact-headers).

## Compact headers

A generic `header` field on any layout node:

```js
{ id, widget: "Grid", header: "compact", children: [ ... ] }
```

| `header` | what the pane shows |
|---|---|
| `"shown"` | the header row as today, ~24 px |
| `"compact"` | no header row; a small arrow over the top-right corner of the pane |

The pane menu gets a shown / compact control that writes the field, so it can be set without editing JSON. The field knows nothing about the widget inside the pane, so `flexout/` stays free of project-specific code.

### How a compact header looks

The header row is gone and the widget gets the full height of the pane, including the 4 px of padding (`pt-1`) under today's header. A small dropdown arrow, about 14 px square, sits over the widget's top-right corner on a translucent white background, grey until hovered. In a PlotView that corner is the empty margin above and to the right of the plot area, unless the plot draws a top or right-hand axis.

Clicking the arrow opens the pane menu as today (configure, remove, change widget), with the pane's title at the top. Clicking the title edits it, the way clicking the title in the header does now.

On mobile, where panes are stacked and the title is what tells them apart, every pane shows its header row whatever its `header` field says.

### Moving a pane

The arrow is also the drag handle. Today the whole header row is the drag source (the `useDrag` ref in `Pane.jsx`); in compact mode that ref goes on the arrow instead. Pressing on the arrow and moving drags the pane, and pressing and releasing without moving opens the menu. React-dnd's HTML5 backend only starts a drag once the pointer moves, so the two do not get in each other's way. The arrow shows a `grab` cursor and the tooltip "Click for menu, drag to move". Dropping is unchanged: the whole pane stays a drop target.

### Nested arrows

A compact container and its compact top-right child would put their arrows on the same spot, for example a Grid and its top-right cell. Each arrow is therefore moved 16 px to the left per level of nesting, counted from the root: the root's arrow sits in the corner, a direct child's 16 px to its left, and so on. Only a pane and its ancestors can share a corner, and they are always at different depths, so arrows never overlap.

### Inheritance

Containers already render their children (`Split.jsx`, `Grid.jsx`, `TabSet.jsx`), so they thread the value down. When a container renders a child `Pane`, it adds its own effective mode and the child's depth to the child's config as `inherited: { header, depth }`. The child's mode is its own `header` if set, otherwise `inherited.header`, otherwise `"shown"`. A Grid set to compact therefore makes every cell compact, and a cell can still set `"shown"` for itself.

The inherited value goes under its own key, not into `header`, so that it never ends up in the saved layout. If it did, a cell that was renamed or reconfigured would keep `compact` after the Grid went back to `shown`. Everything a child writes back already passes through its container's `handleChildUpdate`: renames, configure, widget changes, drops, and a widget's own `parentUpdate`, such as PlotView saving its config with the rest of its props. Each container removes `inherited` there before storing the node, and the root update in `Layout.jsx` does the same for a pane dropped at the root. The removal goes down through `children` too, because changing a pane into a Split, Grid or TabSet wraps the old node, `inherited` and all, as the new container's first child.

## Flex view

A tick box in the workspace menu, "Flex view". When it is on:

- no pane draws a header row or a corner arrow, whatever its `header` field says;
- the 5 px resize dividers between panes in Splits and Grids, transparent today, draw a 1 px line along their middle; the 5 px grab area for resizing stays;
- TabSets keep their tab strip, since that is how a tab is chosen.

Renaming, moving, configuring or removing a pane needs its header or arrow, so the user unticks flex view, makes the change and ticks it again. Resizing still works in flex view.

### Saved with the workspace or per viewer

| | saved with the workspace | kept per viewer |
|---|---|---|
| where | `flexView: true` on the root layout node | browser storage |
| a workspace built for editing or for showing | opens in flex view for everyone, including read-only publication viewers | opens with headers until each viewer ticks the box |
| applies to | that workspace | every workspace that viewer opens |
| a quick untick to rename a pane | changes the layout; if the user saves before ticking it again, headers come back for everyone | changes nothing shared |

Recommendation: save it with the workspace. Workspaces here are built for one task, and the person building an editing or display workspace is the one who knows it should open without headers. It is also the simpler build: one more field in the layout tree that the existing Save already stores, and no new storage. A viewer who cannot save, such as a publication viewer, can still tick and untick it for the session.

Flex view is off on mobile, where panes are already stacked and the headers are the only way to tell them apart.

## Status bar

### Workspace status bar

One status bar along the bottom of the workspace page, under the layout. It shows the cursor coordinates of whichever plot the pointer is over, and the last point picked by a click in any plot, as each PlotView's bar does today for its own plot. It is drawn only when the workspace has at least one plot.

It does not belong to flexout, because it is about plots. It lives next to the other plot-wide state:

- `PlotGroupContext.jsx` (app-level, already shared by every PlotView for axis linking) gains a small readout store: `publish({ coords, pick })` and `subscribe(listener)`.
- PlotView calls `publish` from its existing mousemove and click handlers.
- A `PlotStatusBar` component, rendered in `App.jsx` under `<MainLayout />`, subscribes and writes the text straight into its DOM nodes.

The store must not be React state on the context. Mousemove fires many times a second, and a context value change re-renders every PlotView that reads the context. PlotView already avoids this for its own bar by writing `textContent` through refs; the store keeps the same pattern.

### Per-plot status bar

A PlotView setting, `layoutConfig.statusBar` (boolean), in PlotView's schema and so in `get_widget_schema`. Recommendation: off by default, so the workspace bar replaces the per-plot bars and every plot gains 20 px, and `statusBar: true` keeps a bar under a plot that needs its own. A workspace-wide switch was the other option. It was not chosen because it would put a plot setting in flexout or the menu bar, and it cannot keep one plot's bar.

Existing saved workspaces lose the per-plot bars and gain the workspace bar, so the readout is still there.

## Implementation

- `frontend/src/flexout/components/Pane.jsx`: effective header mode from the node's `header`, `inherited`, flex view and mobile; render the header row, the corner arrow, or nothing. In compact mode the drag ref moves to the arrow, offset by `inherited.depth`. The pane menu gets the title row (click to rename) and the shown / compact control.
- `frontend/src/flexout/components/Split.jsx`, `Grid.jsx`, `TabSet.jsx`: add `inherited: { header, depth }` to each child's config when rendering it, and remove `inherited` from nodes in `handleChildUpdate`. TabSet keeps `hideHeader` for its tabs. `frontend/src/flexout/Layout.jsx`: remove `inherited` in the root update.
- `frontend/src/flexout/headerMode.js`: the pure pieces, so they can be tested without React: the mode rule (node value, inherited value, flex view, mobile) → `"shown" | "compact" | "none"`, the arrow offset for a depth, and `withoutInherited(node)`, which removes `inherited` from a node and its descendants.
- Flex view: read from the root node through `LayoutContext`; the tick box in `frontend/src/WorkspaceMenu.jsx` writes `flexView` on the root with `updateLayout`. Corner arrow and divider line styles in `frontend/src/styling.scss`.
- `frontend/src/PlotGroupContext.jsx`: the readout store. `frontend/src/PlotStatusBar.jsx`: the workspace bar. `frontend/src/App.jsx`: render it under `<MainLayout />`.
- `frontend/src/widgets/PlotView/index.jsx`: publish to the store; draw its own bar only when `layoutConfig.statusBar` is true; add `statusBar` to the schema.
- `backend/routers/workspaces.py`: the node schemas use `additionalProperties: false` and list only `id`, `widget`, `children` / `layoutConfig`. Add `header`, `flexView` and the existing `customTitle`, which is missing today, to `_container_node_def` and `_leaf_node_def_raw`, so workspaces written through the API validate.
- `backend/widget_schemas.json`: regenerate with `npm run export-schemas` for `statusBar`.
- Docs: `docs/frontend/layout.md` (header field, inheritance, flex view), `docs/frontend/widgets.md` (PlotView `statusBar` and the workspace bar), `docs/user-guide.md` (the tick box).
- Tests (vitest): the header-mode rule, including inheritance, a node's own value overriding the inherited one, flex view and mobile; the arrow offset per depth; `withoutInherited` removing `inherited` at every level and nothing else; the readout store's publish and subscribe.

About two days: a day for compact headers (corner arrow, drag, title in the menu, inheritance), half a day for flex view, half a day for the status bars.

## Not changing

Saved workspaces without `header` or `flexView` keep their headers exactly as now. The per-plot status bar is the one visible change to existing workspaces, as described above. Widgets other than PlotView are not touched.

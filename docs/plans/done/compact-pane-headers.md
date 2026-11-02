# Compact pane headers, global compact and a workspace status bar

**State:** decided 2026-10-30, ready to implement
**Labels:** enhancement, frontend, layout

## Motivation

Every node in a flexout layout is rendered through `Pane.jsx`, containers included, and every `Pane` draws a header row of about 24 px: the title (click to rename), the drag handle for moving the pane, and the menu toggle (configure, remove, change widget). A Grid of four stacked plots therefore spends five header rows, about 120 px, before any plot is drawn. Each PlotView also draws its own 20 px status bar under the plot. On a short plot, such as a loop-height strip in an editing workspace, header and status bar together take about as much height as the data.

Today the header can only be hidden inside a TabSet, where `TabSet.jsx` passes `hideHeader` because the tab strip carries the title and menu instead.

The PlotView margin change (#133) covers the space inside a plot. This plan covers the header and status bar around it.

## Decisions (2026-10-30, revised 2026-10-31)

1. Two header modes per node, set by a boolean `compact` field inherited down the layout. Shown (`compact: false` or absent) is the full header row as today; compact (`compact: true`) draws no header row: a single small dropdown-arrow overlays the top-right corner of the widget's own area. Clicking it opens the pane menu (widget title and rename at the top, then configure / remove / change widget, plus a compact checkbox); dragging it moves the pane. `compact` is a generic node field like `customTitle`, not part of any widget's config schema. No hidden-header mode and no hover overlay beyond this corner arrow.
2. A "Compact" checkbox in the pane menu dropdown, shown only on the top-level (root) pane, stored as `globalCompact` on the root layout node. It is inherited down the tree like the per-node `compact`, but child nodes cannot override it, and wherever it is on it overrides each node's own `compact`, forcing compact. Untick it to return to the per-node settings.
3. One status bar for the whole workspace, showing the readout of the plot under the pointer. Each plot's own status bar becomes optional.

Recommendations below, to be confirmed when the plan is merged:

- The look of a compact header is the corner arrow described above (see [Compact headers](#compact-headers)).
- Both the per-node `compact` and the global compact flag are threaded down as props that each container forwards to its child panes; a child's own `compact` wins over the inherited value, but a child cannot change the inherited global compact flag (see [Inheritance](#inheritance)).
- Global compact lives on the root node as `globalCompact`, saved with the workspace (see [Global compact](#global-compact)).
- The per-plot status bar is a PlotView setting, `layoutConfig.statusBar`, off by default (see [Status bar](#status-bar)).

## Compact headers

A generic boolean `compact` field on any layout node:

```js
{ id, widget: "Grid", compact: true, children: [ ... ] }
```

| `compact` | what the pane draws |
|---|---|
| `false` / absent | the full header row, as today (~24 px): title, drag handle, menu toggle |
| `true` | no header row at all. A single small dropdown-arrow sits in the top-right corner, overlaying the widget's own content. The widget gets the full pane height. |

### The compact look

A compact pane has no header strip. Instead, one small chevron button is absolutely positioned in the top-right corner of the pane's content area (the content wrapper gets `position: relative`; the button gets a high `z-index` and a faint background so it stays legible over a plot).

- **Click** the arrow: opens the existing `PaneMenuDropdown`. It gains a title row at the top showing the widget title with the same click-to-rename input the shown header uses, followed by the current configure / remove buttons and the change-widget list. Everything the shown header offers is reachable from the arrow; it just isn't on screen until asked for.
- **Drag** the arrow: moves the pane. The `useDrag` ref that today sits on the header row moves onto the arrow button. Click and drag disambiguate naturally — a drag only starts once the pointer moves, so a stationary press-and-release is still a click that opens the menu.

Because the arrow overlaps content, it is the only chrome a compact pane shows; no title or drag strip takes vertical space. The old `pt-1` content padding under a header is not drawn for a compact pane.

### Inheritance

A node without a `compact` field inherits its parent's effective value; the root defaults to shown (`false`). One setting on a Grid therefore covers the Grid and every cell in it, and a cell can still set its own `compact: false` to opt back out.

Threading is done entirely by flexout containers, which already render both the header (`Pane.jsx`) and the child panes (`Split.jsx`, `Grid.jsx`, `TabSet.jsx`). Two values flow down, both as props:

- **`inheritedCompact`** — `Pane` receives it from its parent container (the root `Pane`, rendered by `MainLayout`, receives none and treats it as `false`). `Pane` computes its effective mode — `node.compact ?? inheritedCompact ?? false`, after the global-compact and mobile overrides — and passes that effective value down to the widget it renders as `inheritedCompact`. So the parent hands its own resolved value to the child, and the child's own `compact` field, if present, wins over it: the "value in the child config unless hardcoded in the child config" rule, carried by a prop rather than written into the saved node.
- **`inheritedGlobalCompact`** — the global compact flag ([below](#global-compact)), threaded the same way but *not* overridable per node. The root `Pane` seeds it from the root node's `globalCompact` field (it is the only `Pane` whose `inheritedGlobalCompact` prop is undefined, so it reads `node.globalCompact`); every other `Pane` uses the prop it was given and ignores any `globalCompact` on its own node. Each `Pane` forwards the (now always defined) flag to the widget it renders, and the containers forward it unchanged to their children. It therefore originates once at the root and reaches every pane without a child being able to change it.

The container widgets (`Split`, `Grid`, `TabSet`) forward both props they received, unchanged, to every child `<Pane>`.

`compact` is a generic node field handled by flexout itself, not by any widget — like `customTitle`, it is not part of any widget's config schema and never appears in the config form. It is set by a checkbox in the pane menu dropdown, next to the delete button, which writes `node.compact` directly. `globalCompact` works the same way and is likewise outside every widget schema; its checkbox appears only in the top-level (root) pane's dropdown, where it writes `node.globalCompact` on the root (see [Global compact](#global-compact)).

The fields and the props know nothing about the widget inside the pane, so `flexout/` stays free of project-specific code.

## Global compact

A "Compact" checkbox in the pane menu dropdown, shown only on the top-level (root) pane, stored as `globalCompact: true` on the root layout node. When it is on, every pane is forced to the compact look above, overriding each node's own `compact` and the inheritance between nodes — so a workspace built for showing opens with nothing but data and the corner arrows. It is threaded down like the per-node `compact` (see [Inheritance](#inheritance)) but cannot be overridden by a child node; only the root's value matters. When it is off, each node's `compact` takes effect again.

Like `compact`, `globalCompact` is a generic node field, not a widget config parameter — it is in no widget's config schema and never in a config form. It differs only in where it is set and how it is read: its checkbox sits in the root pane's dropdown alongside the root's own `compact` checkbox, and it is read straight off the root node. The root pane's corner arrow stays reachable even when global compact is on, so the checkbox can always be found to untick it.

- `headerMode.js` returns compact for every pane while global compact is on, regardless of `node.compact` or `inheritedCompact`.
- The 5 px resize dividers between panes in Splits and Grids, transparent today, draw a 1 px line along their middle while global compact is on, so panes that no longer have a header row are still told apart; the 5 px grab area for resizing stays.
- TabSets keep their tab strip, since that is how a tab is chosen.

Renaming, moving and configuring still work through each pane's corner arrow, so global compact is a presentation convenience rather than a lock. Resizing works throughout.

### Saved with the workspace or per viewer

| | saved with the workspace | kept per viewer |
|---|---|---|
| where | `globalCompact: true` on the root layout node | browser storage |
| a workspace built for editing or for showing | opens compact for everyone, including read-only publication viewers | opens with headers until each viewer ticks the box |
| applies to | that workspace | every workspace that viewer opens |
| a quick untick to edit with full headers | changes the layout; if the user saves before ticking it again, compact comes back for everyone | changes nothing shared |

Recommendation: save it with the workspace, as `globalCompact: true` on the root node. Workspaces here are built for one task, and the person building an editing or display workspace is the one who knows it should open compact. It is also the simpler build: one more field in the layout tree that the existing Save already stores, and no new storage. A viewer who cannot save, such as a publication viewer, can still tick and untick the root pane's checkbox for the session.

Global compact is off on mobile, where panes are already stacked and the headers are the only way to tell them apart.

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

- `frontend/src/flexout/components/Pane.jsx`: compute the effective mode from `node.compact`, the `inheritedCompact` prop, the `inheritedGlobalCompact` prop (falling back to `node.globalCompact` only when the prop is undefined, i.e. at the root) and mobile; render either the full header row (shown) or the corner-arrow overlay (compact). Move the `useDrag` ref onto the arrow button for the compact case, and give the content wrapper `position: relative`. Pass the effective `compact` and the resolved global-compact flag to the rendered widget as `inheritedCompact` / `inheritedGlobalCompact`. In `PaneMenuDropdown`, add the title / rename row at the top, a `compact` checkbox next to the delete button (writes `node.compact`), and — only when this is the root pane (`inheritedGlobalCompact === undefined`) — a `globalCompact` checkbox (writes `node.globalCompact`). Both write node fields directly; neither touches any widget schema. Corner-arrow and 1 px divider-line styles in `frontend/src/styling.scss`.
- `frontend/src/flexout/components/Split.jsx`, `Grid.jsx`, `TabSet.jsx`: forward the `inheritedCompact` and `inheritedGlobalCompact` props they receive, unchanged, to every child `Pane`. TabSet keeps `hideHeader` for its tab content; its tab strip is unaffected.
- `frontend/src/flexout/headerMode.js`: the pure rule (`node.compact`, `inheritedCompact`, `inheritedGlobalCompact`, mobile) → boolean "is this pane compact", so it can be tested without React. Mobile wins first (always shown), then global compact (always compact), then `node.compact ?? inheritedCompact ?? false`.
- `frontend/src/PlotGroupContext.jsx`: the readout store. `frontend/src/PlotStatusBar.jsx`: the workspace bar. `frontend/src/App.jsx`: render it under `<MainLayout />`.
- `frontend/src/widgets/PlotView/index.jsx`: publish to the store; draw its own bar only when `layoutConfig.statusBar` is true; add `statusBar` to the schema.
- `backend/routers/workspaces.py`: the node schemas use `additionalProperties: false` and list only `id`, `widget`, `children` / `layoutConfig`. Add `compact` and the existing `customTitle`, which is missing today, to both `_container_node_def` and `_leaf_node_def_raw`, since any node can carry them. Add `globalCompact` to `_container_node_def` only — it lives on the root node, which is always a container, and is not a leaf-widget config field — so workspaces written through the API validate.
- `backend/widget_schemas.json`: regenerate with `npm run export-schemas` for `statusBar`. (`compact` and `globalCompact` are generic node fields, not in any widget schema, so they are not part of this export.)
- Docs: `docs/frontend/layout.md` (header field, the compact look, inheritance, global compact), `docs/frontend/widgets.md` (PlotView `statusBar` and the workspace bar), `docs/user-guide.md` (the compact checkboxes in the pane menu).
- Tests (vitest): the header-mode rule, including inheritance, global compact and mobile; the readout store's publish and subscribe.

About a day and a half: half a day for compact headers and inheritance, half a day for global compact, half a day for the status bars.

## Not changing

Saved workspaces without `compact` or `globalCompact` keep their headers exactly as now. The per-plot status bar is the one visible change to existing workspaces, as described above. Widgets other than PlotView are not touched.

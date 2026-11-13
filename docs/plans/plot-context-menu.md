# Plot context menu: wire up gladly's axis menu

**State:** draft 2026-11-10, re-split 2026-11-13
**Labels:** enhancement, frontend, gladly
**Tracking:** follows business#145 (compact margins); the reset is item 12 of
business#116; the range lock was asked for on 2026-11-10; related bug business#168

## Motivation

Stacked plots (a short strip above a profile sharing its distance axis) spend
much of their height on axis labels. A right-click menu on every PlotView plot
shows and hides each axis — and separately its tick labels and its title — so a
plot can drop a label to regain room and get it back with one click. The same
menu locks an axis's range and resets the view.

**Almost all of this is generic plotting functionality and lives in gladly**, not
Ymerflow. A plot pane's stored config **is** `plot.getConfig()` — PlotView writes
it straight back into the layout node after every `update()` — so "save a switch
into the layout config" is just setting a gladly `axes.<slot>` key. The menu, its
layout, the right button it opens on, the axis-part hiding, the margin reclaim,
the range lock, the lock mark and the reset are therefore all gladly's, specified
in `deps/gladly/docs/plans/axis-context-menu.md`.

What is genuinely Ymerflow's is small: turn the menu on, feed it the one
app-specific item (the status-bar toggle), persist its changes — including the
workspace-wide fan-out for lock and reset — and regenerate the form schema for
the new axis keys.

This plan is implemented **after the gladly release** carrying the menu.

## What gladly provides (see the gladly plan)

- `axes.<slot>.tickLabelsVisible`, `axes.<slot>.titleVisible`, `axes.<slot>.locked`
  config keys (in `Plot.schema()`), beside the existing `visible`.
- A `'contextmenu'` plot event for a right-click gladly did not use (it carries
  which axis strip the click was on).
- The menu widget itself: per-axis rows with Axis / Labels / Title / Lock
  checkboxes and a Reset view item; context-sensitive (axis strip → that axis
  only; plot area → full menu); grey-out of a hidden axis's Labels/Title.
- `plot.resetAxes()`, `plot.isAxisLocked(slot)`, `plot.setAxisLocked(slot, on)`,
  the lock mark, and the margin reclaim.
- A `'menuchange'` event emitted after any menu-driven change (for persistence),
  and a menu-item hook for the host to inject extra rows.

## What exists in Ymerflow

- Axis settings live in `layoutConfig.axes.<slot>` and are edited in the config
  form, whose schema comes from gladly's `Plot.schema()`. After every
  `plot.update()` PlotView writes `plot.getConfig()` back into the layout node,
  pinning each axis's current range as its `min`/`max`. This is the persistence
  path the menu reuses — no new per-switch config code is needed.
- The per-plot status bar is `layoutConfig.statusBar`, PlotView's own field (not
  part of `plot.getConfig()`), off by default and set only in the config form.
- Every PlotView in a workspace joins one gladly `PlotGroup` with `autoLink`
  (`PlotGroupContext.jsx`), linking every axis to every other of the same quantity
  kind. Locking distance on one plot locks it on every plot of the workspace.
- Ymerflow#143 (typed limits, open) adds `saveConfig()` per PlotView and
  `saveAllPlots()` in `PlotGroupContext`, which write every PlotView's config back
  at once — used here to persist a lock/reset across the linked workspace.
- business#168 (open): zooming one plot drops another's linked explicit-limit axis
  to 0..1. Fixed on the gladly side before the lock lands (see the gladly plan).
- `PlotView`'s `plot.on('click')` moves the current sounding; a right-click fires
  no `click`, so it leaves the sounding alone.
- `CLAUDE.md` keeps project-specific code out of `flexout/`; this plan adds none —
  the menu is gladly's, not a flexout dropdown.

## Design

One PR after the gladly release.

- **`frontend/package.json`:** bump `gladly-plot` to the release carrying the
  menu (`npm install --save gladly-plot@<version>` — a registry version, never a
  `file:` path). During development, run against the gladly branch with
  `npm install --no-save` from the local `deps/gladly` checkout.
- **`frontend/src/widgets/PlotView/index.jsx`:**
  - Enable gladly's menu on the plot (whatever the gladly API is — a config flag
    or leaving the default `'contextmenu'` handler on).
  - On gladly's `'menuchange'` event, persist: write the plot's new
    `plot.getConfig()` back via the existing update effect for an axis-part
    change, and call `saveAllPlots()` (#143) for a lock or reset so every linked
    plot saves the shared range rather than the one it last wrote.
  - Inject the **Status bar** row through gladly's menu-item hook: a checkbox
    bound to `layoutConfig.statusBar`, toggling it through the normal layout
    update. This is the only app-specific menu item.
- **`backend/widget_schemas.json`:** regenerated, picking up the three new axis
  keys (`tickLabelsVisible`, `titleVisible`, `locked`) for the config form.
- **Docs:** `docs/user-guide.md` (right-click a plot or an axis to show/hide axis
  parts, lock a range, toggle the status bar, reset); `docs/frontend/widgets.md`
  (PlotView enables gladly's axis menu, injects the status-bar item, and persists
  menu changes — axis parts via the per-plot write-back, lock/reset via
  `saveAllPlots()`).

No `PlotMenu.jsx`, no `plotMenuConfig.js`, no `PaneMenuDropdown` positioning prop
— the menu body, its rows, its context-sensitivity and its positioning are all in
gladly now.

## Checked in the running app

- Each switch on a profile and on a short strip; the strip's room shrinking and
  coming back; two stacked strips kept aligned when the same part is hidden on
  each.
- A right-click on each of the four axis strips opening that axis's switches; in
  the plot area the full menu.
- A polygon closed by a right-click without the menu opening, and the menu on the
  next right-click; a right drag rotating a 3D curtain and a right-click there
  opening the menu.
- Reset on a zoomed profile with a linked strip and sounding plot following only
  on their shared axes.
- Distance locked on the profile; zoom, wheel and drag on the profile, the strip
  and a 3D curtain leave distance alone while their other axes move; a typed
  distance limit moves all of them; reset leaves distance; the lock mark on every
  distance axis; the lock switched off from the strip clears it everywhere.
- The status-bar item toggling `layoutConfig.statusBar`.
- Save and reload keeping the switches and the lock; the current sounding left
  alone by a right-click.
- Zooming also checked on a workspace with linked explicit limits with nothing
  locked, against business#168.

## Not in this plan

- Everything in the gladly plan's "Not in this plan" (touch, color/filter bars,
  3D axis rows, per-plot margins, a reset that follows the data line to line).
- Switching a part on a whole stack at once (one menu toggle still acts on one
  plot; a workspace fan-out of axis-part hiding was dropped).
- Typed limits and the selection shape in the menu.
- The fix for business#168 (gladly side).

## Implementation steps

1. gladly PR + release (see `deps/gladly/docs/plans/axis-context-menu.md`).
2. Ymerflow PR: the bump, enabling the menu, the `'menuchange'` persistence
   (per-plot write-back + `saveAllPlots()` for lock/reset), the injected
   status-bar item, the regenerated schema, docs; checked in the running app.

About three quarters of a day, most of it the check in the running app, plus the
wait for the gladly review and release.

# Plot context menu: wire up gladly's axis menu

**State:** draft 2026-11-10, questions resolved and split into the gladly plan
2026-11-13; two side points decided 2026-11-12 (Enter also closes a polygon, and
no Mac-only right-click) carried into the gladly plan. The gladly side is now
**built and merged** (2026-11-14) — three plans in `deps/gladly/docs/plans/done/`
(`axis-visibility-lock-reset.md`, `axis-context-menu.md`,
`menu-customization-hook.md`); this plan is updated below to the API gladly
actually shipped (`'axisoptions'`/`'axislimit'` events, the `'contextmenu_open'`
hook, the `axis_menu`/`plot_menu` gates), and the gladly release carrying the
menu is out as **gladly-plot 0.0.21** (2026-11-14). A follow-up release,
**gladly-plot 0.0.22** (2026-11-14), broadens the `'axisoptions'` event to also
cover `scale` / `colorscale` / `colorbar` / `filterbar` / `enabled` changes and
2D colour-pair changes (carried with `axis: null` + an `axis2d` key); this plan
now targets 0.0.22.
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
in the three gladly plans now in `deps/gladly/docs/plans/done/`
(`axis-visibility-lock-reset.md` — the axis keys, lock, reset, lock mark and the
title-click toggle; `axis-context-menu.md` — the `'contextmenu'` event and the
menu widget; `menu-customization-hook.md` — the `'contextmenu_open'` hook).

What is genuinely Ymerflow's is small: turn the menu on, feed it the one
app-specific item (the status-bar toggle), persist its changes — including the
workspace-wide fan-out for lock and reset — and regenerate the form schema for
the new axis keys.

This plan is implemented against **gladly-plot 0.0.22** (the menu shipped in
0.0.21; 0.0.22 broadens the `'axisoptions'` event the persistence path relies on).

## What gladly provides (as built, see the gladly plans)

- `axes.<slot>.tickLabelsVisible`, `axes.<slot>.titleVisible`, `axes.<slot>.locked`
  config keys (in `Plot.schema()`), beside the existing `visible`.
- A `'contextmenu'` plot event for a right-click gladly did not use (its callback
  is `(e, coords, region)`; `region` carries which axis strip the click was on —
  `region?.type === 'axis'` with `region.axes[0]` the slot, or `null` for the plot
  area / a corner).
- The menu widget itself (`AxisMenu`, a `data-gladly-control` float): per-axis rows
  with Axis / Labels / Title / Lock checkboxes and a Reset view item;
  context-sensitive (axis strip → that axis only; plot area → full menu); grey-out
  of a hidden axis's Labels/Title. Opening is gated by two top-level config
  booleans `axis_menu` (single-axis menu) and `plot_menu` (full menu), **both
  default `true`** — so the menu is on with no opt-in; set one to `false` only to
  suppress the built-in menu and bind your own on `'contextmenu'`.
- `plot.resetAxes()`, `plot.isAxisLocked(slot)`, `plot.setAxisLocked(slot, on)`,
  the lock mark (red axis line + lock glyph), the title-click lock toggle, and the
  margin reclaim. Plus per-axis accessors `axis.getConfig()` / `axis.setConfig()`
  and static `Axis.schema()`.
- An **`'axisoptions'`** event emitted from the config write path, keyed by *what*
  changed, not who, so it fires for a menu toggle, a `setAxisLocked()` call or a
  direct `plot.update({config})` alike. As of **0.0.22** it covers two groups of
  keys:
  - **Per-slot keys** (`axes.<slot>`): `visible` / `tickLabelsVisible` /
    `titleVisible` / `locked`, plus (new in 0.0.22) `scale` (`"log"`/`"linear"`),
    `colorscale`, `colorbar` and `filterbar`. For these, `event.axis` is the slot
    string and `event.axis2d` is absent — `{ type: 'axisoptions', axis: slot, key,
    value }`.
  - **2D colour-pair keys** (`colorbars[]`, new in 0.0.22): `colorscale`,
    `colorbar` and `enabled`. A pair has no single slot, so `event.axis` is `null`
    and `event.axis2d` is the ordered quantity-kind pair key `"<qkX>__<qkY>"` —
    `{ type: 'axisoptions', axis: null, axis2d, key, value }`.
  Domain/range changes keep using the existing **`'axislimit'`** event. These two
  events are the persistence hook; there is no `'menuchange'` event.
- A **`'contextmenu_open'`** event for injecting extra rows: `cb(e, coords, region,
  menuEl)` fires just before the built-in menu is placed, handing the host the
  fully-built menu `<div>` to mutate in place (append rows/buttons, wire handlers).
  It augments the built-in menu rather than replacing it; mark added interactive
  DOM with `data-gladly-control`.

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
  to 0..1. The three merged gladly plans do **not** cover this; it still needs a
  gladly-side fix before (or alongside) the lock lands, tracked separately.
- `PlotView`'s `plot.on('click')` moves the current sounding; a right-click fires
  no `click`, so it leaves the sounding alone.
- `CLAUDE.md` keeps project-specific code out of `flexout/`; this plan adds none —
  the menu is gladly's, not a flexout dropdown.

## Questions

All eleven design questions have been decided and moved into the gladly plans
(now in `deps/gladly/docs/plans/done/`), where the menu now lives: the
right-click event (1a), the three axis-part switches (2a), reclaiming the space
from hidden parts (3b), saving switches with the workspace (4a), per-plot scope
(5a), the extra menu items — status bar, reset, lock (6a/b/e), the reset (7a),
the context-sensitive layout (8c), and the range lock (9a, 10a, 11a). The two
side points decided 2026-11-12 are recorded with them: Enter also closes a
polygon (into #37 or the gladly PR), and no Mac-only Ctrl+click.

## Design

One PR, against gladly-plot 0.0.22.

- **`frontend/package.json`:** bump `gladly-plot` to `0.0.22` (`npm install
  --save gladly-plot@0.0.22` — a registry version, never a `file:` path). During
  development, run against the gladly branch with `npm install --no-save` from the
  local `deps/gladly` checkout.
- **`frontend/src/widgets/PlotView/index.jsx`:**
  - Nothing to enable — gladly's menu is on by default (`axis_menu`/`plot_menu`
    both default `true`). Leave them unset.
  - Persist on gladly's **`'axisoptions'`** event (axis-part and lock changes) and
    **`'axislimit'`** event (typed/reset range changes). For an axis-part change
    (`visible`/`tickLabelsVisible`/`titleVisible`) write the plot's new
    `plot.getConfig()` back via the existing update effect. For a `locked` change
    or a reset, call `saveAllPlots()` (#143) so every linked plot saves the shared
    range rather than the one it last wrote. Because `'axisoptions'` is keyed by
    *what* changed, the handler branches on `event.key` (`locked` → `saveAllPlots`,
    else per-plot write-back); the reset (via `'axislimit'` from the data refit, or
    a dedicated signal) also fans out through `saveAllPlots()`. As of 0.0.22 the
    event also fires for `scale`/`colorscale`/`colorbar`/`filterbar`/`enabled` and
    for 2D colour pairs (`axis: null`, `axis2d` set); the handler treats every
    non-`locked` key as a plain per-plot write-back of `plot.getConfig()`, so it
    needs no per-key enumeration and must not assume `event.axis` is a slot.
  - Inject the **Status bar** row through gladly's **`'contextmenu_open'`** hook:
    `plot.on('contextmenu_open', (e, coords, region, menuEl) => …)` appends a
    checkbox (wrapped in a `data-gladly-control` element) bound to
    `layoutConfig.statusBar`, toggling it through the normal layout update. This is
    the only app-specific menu item; the callback runs on every open, so it appends
    fresh each time and owns its own state.
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

- Everything in the gladly plan's "Not in this plan" (touch and long-press, a Mac
  Ctrl+click as a right-click, color/filter bars and a lock on color/filter axes,
  3D axis rows, per-plot margins, a reset that follows the data line to line,
  color items such as a color map picker — business#116 item 17).
- Switching a part on a whole stack at once (one menu toggle still acts on one
  plot; a workspace fan-out of axis-part hiding was dropped).
- Typed limits and the selection shape in the menu.
- The fix for business#168 (gladly side).

## Implementation steps

1. gladly PR — **done, merged, and released** as gladly-plot 0.0.21, with the
   broadened `'axisoptions'` event following in 0.0.22
   (see `deps/gladly/docs/plans/done/`).
2. Ymerflow PR: the bump (to gladly-plot 0.0.22), the
   `'axisoptions'`/`'axislimit'` persistence (per-plot write-back + `saveAllPlots()`
   for lock/reset), the `'contextmenu_open'`-injected status-bar item, the
   regenerated schema, docs; checked in the running app. No menu enabling needed —
   `axis_menu`/`plot_menu` default on.

About three quarters of a day, most of it the check in the running app. The
gladly release (gladly-plot 0.0.22) is out, so no wait remains.

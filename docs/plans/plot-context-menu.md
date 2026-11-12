# Plot right-click menu: axis parts, range lock, status bar and reset

**State:** draft 2026-11-10, questions 1 to 11 open; two side points decided 2026-11-12 (Enter also closes a polygon, and no Mac-only right-click)
**Labels:** enhancement, frontend, gladly
**Tracking:** follows YmerFlow/ymerflow-business#145 (compact margins); the reset is item 12 of YmerFlow/ymerflow-business#116; the range lock was asked for on 2026-11-10; related bug YmerFlow/ymerflow-business#168

## Motivation

Stacked plots, such as a short strip above a profile that shares its distance axis, spend much of their height on axis labels. gladly#38 gives an axis side's room back when that axis is hidden with `visible: false`, but the switch is reached only through the pane's configuration form, and it hides the whole axis: line, ticks, tick labels and title together. This plan adds a right-click menu to every PlotView plot that shows and hides each axis, and separately its tick labels and its title, so a plot can drop a label to regain room and get it back with one click. The same menu carries the plot's own status bar switch and a reset of the view.

The menu also locks an axis's range. While the lock is on, that axis and every axis linked to it keep their range through zooming, scrolling and panning in any plot, and through a reset, until it is switched off. A range set for a review then stays put while other plots are zoomed.

It spans two repositories. The axis parts, their layout and the right button belong to gladly (`redhog/gladly`, published as `gladly-plot`); the menu and where its choices are saved belong to Ymerflow.

## What exists

Read against gladly master at 1e1c983 with the three open gladly PRs from the fork (#36 typed axis limits, #37 selection shapes, #38 `marginWithoutAxis`), and Ymerflow master at 6f9f382.

### gladly

- `axes.<slot>.visible: false` hides an axis whole: `Axis.prepareAtlas()` and `Axis.render()` return before drawing anything (`src/axes/Axis.js`). There is no switch for the tick labels alone or the title alone. The title text is `axes.<slot>.label`, falling back to the quantity kind's label. As read, an empty `label` already draws no title, but the text is then gone and no room is freed.
- In 2D the tick marks, tick labels and title are placed at fixed fractions of the distance from the axis to the canvas edge: 0.12, 0.40 and 0.75 of the margin. This is why an axis side cannot shrink below about 48 px (x) or 80 px (y) without the labels and title colliding (business#145).
- #38: a side's margin is `margin[side]` when the side draws an axis and `marginWithoutAxis[side]` when it draws none, including an axis hidden with `visible: false`. `_layoutMargin()` recomputes it on every `update()`, so hiding an axis gives its room back at the next update. A 3D plot keeps `margin` on every side. PlotView's values were decided on 2026-11-10 and are not yet coded: 48 px on a side with an x axis, 80 px on a side with a y axis, 24 px on a side with no axis, and no per-plot margins.
- The right button: `ZoomController` blocks the browser's own menu on the plot canvas (`contextmenu` is `preventDefault`ed). On a 2D plot a right press does nothing; on a 3D plot a right drag rotates the camera. With #37, a right press while a polygon has corners placed closes the polygon (`LassoInteraction._onMouseDown`, `e.button === 2`), and the lasso ignores right presses otherwise. The polygon closes on the mousedown, so by the time a `contextmenu` event arrives the polygon is gone and nothing records that the press was used.
- `plot.on(type, cb)` passes any DOM event type through as a window capture listener for events inside the plot's container and calls `cb(e, coords)`, where `coords` from `lookup()` holds a value for every axis that has a scale. `'error'`, `'no-error'` and, with #36, `'axislimit'` are synthetic plot events.
- Every `update()` reruns `_initialize()`, which rebuilds every layer of that plot. A resize does the same (`ResizeObserver` calls `forceUpdate()`).
- Linked axes (`linkAxes`) pass a domain on to each other in `Axis.setDomain()`; making a link does not sync their domains. Auto-fit (`AxisRegistry.applyAutoDomainsFromLayers`) computes each quantity kind's data range from the layers, but keeps it (`dataExtent`) only for filter axes, and it sets domains on the registry without going through `Axis.setDomain()`, so a refit does not reach linked plots. A slot's `min` and `max` in the config take priority over the data range, and a quantity kind with no range at all falls back to 0 to 1.
- Within one plot the range belongs to the quantity kind, so two slots showing the same quantity kind share it.
- Every zoom and pan gesture ends in `Axis.setDomain()`, called by `ZoomController` once per axis it moves: a left drag (pan), the wheel, and touch pan and pinch. A gesture on an axis's strip of margin moves that axis only; one in the plot area moves every axis the plot has. `ZoomController._getRegion2D()` works out which axis strip, if any, a point is in, counting an axis hidden with `visible: false` as well; #36 uses it to show the limit boxes. A corner, or a margin with no axis, is in no region.
- With #36, a typed limit is set through the same `Axis.setDomain()` (`AxisLimitEditor._commit()`), so linked axes follow it, and the plot then emits `'axislimit'`.

### Ymerflow

- Nothing handles a right-click on a plot. The only frontend code that touches the browser's menu is `AEMModelSimulator/ModelCanvas.jsx`, which suppresses it.
- The only menu on a pane is its header menu: `flexout/components/PaneMenuContent.jsx`, shown in a `PaneMenuDropdown` portal (31 lines: fixed position under an anchor element, closed by a mousedown outside it). `flexout/MenuContext.jsx` is the registry for the top menu bar. `CLAUDE.md` keeps project-specific code out of `flexout/`.
- Axis settings live in the pane's `layoutConfig.axes.<slot>` and are edited in the configuration form, whose schema comes from gladly's `Plot.schema()`. #38 adds `visible` to that schema, which reaches the form when `backend/widget_schemas.json` is regenerated. After every `plot.update()` PlotView writes `plot.getConfig()` back into the layout node, which also pins each axis's current range as its `min` and `max`.
- The per-plot status bar is `layoutConfig.statusBar`, PlotView's own field, off by default and set only in the configuration form.
- PlotView has 3D plots: the curtain and grid layers take a `zAxis`.
- Every PlotView in a workspace joins one gladly `PlotGroup` with `autoLink` (`PlotGroupContext.jsx`), which links every axis to every other axis of the same quantity kind in the workspace. Locking the distance axis on one plot therefore locks distance on every plot of the workspace.
- business#168 (open): zooming or scrolling one plot drops another plot's axis to 0 to 1 in a workspace with linked explicit limits. Its cause is not yet known.
- Ymerflow#143 (typed limits, open) adds a `saveConfig()` per PlotView and `saveAllPlots()` in `PlotGroupContext`, which write every PlotView's config back at once.
- business#116 item 12 asks for a per-plot reset: one plot's axes go back to the minimum and maximum of its data, and the axes linked to them in other plots follow, and only those.
- The InUse editor's shape picker (`docs/plans/inuse-rectangle-triangle-selection.md`, Ymerflow#141) holds one shape for the whole editor, in the editor's own row, with keys 1 to 7.
- `PlotView`'s `plot.on('click')` handler moves the current sounding. A right-click fires no `click` event, so it leaves the sounding alone.

## Questions

Each question is decided by picking one of its options by letter, for example "1a, 2a, 3b". The recommendation after each table gives the suggested option and the reason for it.

### 1. How should the menu open, given that a right-click already closes a polygon?

| | option | trade-off |
|---|---|---|
| a | right-click: a right-click that closes a polygon in progress only closes it; any other right-click opens the menu. gladly tells the two apart and emits a plot event only for a right-click it did not use | the polygon closes as decided in the shapes plan (its question 2a); to open the menu part way through a polygon, close it or press Escape first; on a 3D plot a right drag still rotates and a right-click without a drag opens the menu |
| b | right-click always opens the menu; a polygon closes some other way, with Enter or a double-click | reverses the decided way of closing a polygon; a right-click part way through a polygon opens a menu over it |
| c | no right button: a small menu button that appears in a plot corner on hover, or the plot's items added to the pane header menu through a new widget hook | no collision, and it works on touch; two clicks away and far from the axis; a corner button sits over the plot and next to a compact pane's corner chevron; the pane menu route needs a new flexout hook |

Recommendation: a, because a right-click goes on closing a polygon as the shapes plan decided, so the menu needs no new way to close one.

Decided 2026-11-12: Enter also closes a polygon, as a second way beside the right-click. It goes into #37 (about one line), or into this plan's gladly PR if #37 is merged first. It also covers Firefox, which opens its own menu on a Shift+right-click whatever the page does.

### 2. Which parts of an axis should get their own on/off switch?

| | option | trade-off |
|---|---|---|
| a | three independent switches per axis: the whole axis (`visible`, which exists), its tick labels and its title. The two new ones are booleans in `axes.<slot>` beside `visible`, proposed as `tickLabelsVisible` and `titleVisible` (names for the gladly review) | what was asked; a title with no tick labels is possible, though rarely wanted |
| b | one level per axis: full, no title, line and ticks only, hidden (one enum key) | one choice per axis in the menu; no title without labels; a second key that overlaps `visible` |
| c | the title through the existing `label: ""`, with no new key for it | no gladly change for the title; the text is lost while hidden, so the menu has to keep it somewhere to restore it; no room is freed |

Recommendation: a, because it is what was asked for: each part switches on its own, and the whole-axis switch is the `visible` key that already exists.

### 3. Should hiding the tick labels or the title give the space back?

| | option | trade-off |
|---|---|---|
| a | no: only a whole hidden axis frees room, as #38 does now; the label and title switches only declutter | the smallest gladly change, two checks in `Axis.js`; on a stacked plot the two new switches gain nothing |
| b | yes, from the parts drawn: gladly places the tick marks, tick labels and title at fixed pixel distances out from the axis line instead of fractions of the margin, and a side's margin shrinks by the band of each part it does not draw, never below `marginWithoutAxis`. The constructor options from #38 stay as they are | changes the 2D axis layout for every gladly user, since labels and titles move by a few pixels, which is the gladly maintainer's call; a strip gains about 20 px for each hidden x title |
| c | yes, from margins given per state: the constructor takes a margin for each case (full, no title, no labels, no axis), with the fractions retuned for each | plots that hide nothing look exactly as now; four margin objects to pass; y tick labels vary in width, which fractions of a smaller margin do not follow |

Recommendation: b, because on a stacked plot the space is the reason to hide a title, and fixed pixel distances are the layout business#145 already pointed to. With a tick band of about 8 px and a title band of about 20 px (one 16 px text row and a gap), and the decided 48 / 80 / 24 px kept as the totals with every part and with no axis, an x side is 48 px in full, 28 px without its title and 24 px with neither labels nor title. A y side is 80, 60 and 24 px.

### 4. Should the switches be saved with the workspace, or last only for this session?

| | option | trade-off |
|---|---|---|
| a | saved: a switch writes into `layoutConfig.axes.<slot>`, and the status bar into `layoutConfig.statusBar`, where `visible` and `statusBar` already live; the form and the menu always agree, and the layout is kept when the workspace is saved | each switch is a layout change and a `plot.update()`, which rebuilds that plot's layers: the same pause as resizing the pane |
| b | session only: kept in PlotView's state and gone on reload | a collapsed stack has to be collapsed again every time the workspace is opened; the form and the menu can disagree |

Recommendation: a, because a collapsed stack should stay collapsed when the workspace is opened again, and the menu and the form then always agree. The new layout config is built from `plot.getConfig()`, as the write-back after an update already is, so a zoomed range is kept.

### 5. Should a switch act on this plot only, or on every plot that shares that axis?

| | option | trade-off |
|---|---|---|
| a | this plot only | predictable; stacked plots stay aligned only when the same part is hidden on each, since a y title hidden on one plot narrows its left side by about 20 px and its x axis no longer lines up with the plot above |
| b | every plot in the workspace with an axis in the same slot showing the same quantity kind | one click collapses a whole stack; it also changes plots elsewhere in the workspace that happen to share the quantity kind |

Recommendation: a, because a switch then changes only the plot that was right-clicked, and plots elsewhere in the workspace that happen to share the quantity kind are left alone.

### 6. What else should the menu hold?

| | item | trade-off |
|---|---|---|
| a | the status bar: one checkbox for `layoutConfig.statusBar` | one line of menu; today it is only in the form |
| b | reset view (question 7) | the per-plot reset asked for in business#116 item 12, in the place a user would look for it |
| c | typed limits: a min and a max field on each axis row | #143 already makes the two ends of each axis click-to-type on the axis itself, so this is a second place to type the same numbers |
| d | the selection shape | the InUse editor's row holds the picker and the keys 1 to 7, one shape for the whole editor; a menu on each plot would suggest a shape per plot, and it would also show on plots with no editing layer |
| e | lock range: a switch for each axis (questions 9 to 11) | asked for on 2026-11-10 |

Recommendation: a, b and e in, c and d out, because typed limits already have their place on the axis ends and the selection shape belongs to the editor, while the status bar, the reset and the lock have no place on the plot today.

### 7. If reset view is in, how should it work?

| | option | trade-off |
|---|---|---|
| a | in gladly: a new `plot.resetAxes()` sets each of the plot's 2D spatial axes to the range of its data through `Axis.setDomain()`, so the axes linked to them in other plots follow and nothing else moves; gladly keeps the data range of every quantity kind, not only of filter axes | what item 12 asks for; a small gladly addition in the same PR as the axis parts |
| b | in Ymerflow only: clear this plot's `min` and `max` in `layoutConfig.axes` and update, so gladly refits it | no gladly change; the refit does not go through the links, so linked plots keep their old range until the next zoom or pan snaps them together |
| c | left to its own plan | the menu ships without a reset |

Recommendation: a, because only a reset that goes through the links makes the linked plots follow at once, as business#116 item 12 asks. After a reset PlotView writes every plot's config back at once with #143's `saveAllPlots()`, so a Save straight after keeps it. Like a zoomed or typed range, the reset range is kept when the next line loads, and a second reset fits the new line. A reset that keeps following the data from line to line would mean changing how ranges are written back, which neither this plan nor #143 does. Color ranges are not reset, and neither are locked axes (question 11).

### 8. How should the menu be laid out, and should it change with where the click lands?

| | option | trade-off |
|---|---|---|
| a | one flat menu, the same wherever the click lands: a row for each axis the plot has, named by its side and title ("Bottom: Distance [m]"), with four checkboxes under the heads Axis, Labels, Title and Lock; under the rows, Status bar and Reset view. The menu stays open while switches are clicked and closes on Escape, a click outside it, or Reset view | every switch is one click; several can be changed in one visit; a hidden axis keeps its row, so it is brought back the same way it was hidden |
| b | a submenu for each axis | a shorter first level; two moves for every switch |
| c | where the click lands decides. On an axis's strip of margin, the menu holds that axis's four switches only, so the left and right y axes and the bottom and top x axes each get their own. Anywhere else (the plot area, a corner, a margin with no axis, a 3D plot) it is the full menu of (a). gladly says in the event which axis the click was on | the common case is short and right where the pointer already is; a hidden axis keeps its strip, since gladly still counts the margin where it was as that axis, and it is in the full menu too; the event has to carry the axis, which `_getRegion2D()` already works out |

Recommendation: c, with the full menu laid out as in (a), because a right-click on an axis is almost always about that axis, and a short menu at the pointer is the quickest to use. While an axis is hidden its Labels and Title boxes are grayed out and keep their state, so showing the axis again brings back what it had. Lock stays live on a hidden axis, since the range is kept whether or not the axis is drawn. Items for the plot area alone, such as the color items in business#116 item 17, would go in the full menu.

### 9. Lock range: where should the lock be kept, and what should it stop?

| | option | trade-off |
|---|---|---|
| a | a gladly axis key `locked` in `axes.<slot>`, saved on the axis it was switched on. gladly treats an axis as locked when it holds the key, when an axis linked to it holds it (directly or through other links), or when another slot of the same plot with the same quantity kind holds it. Switching the lock off on any of them clears it wherever it is held | one key in one saved config, kept through Save and reload; a linked plot's form shows that plot's own key off while its axis obeys the lock, though the menu shows it locked |
| b | the same key, written on every axis of the link group when the lock is switched on | every plot's form agrees with the menu; a plot added to the workspace later is linked but carries no key, so it still needs the rule in (a); one click writes many configs |
| c | in Ymerflow, a list of locked quantity kinds kept for the whole workspace | matches how Ymerflow links axes, by quantity kind; gladly still needs a way to refuse a gesture, so the lock is known in two places; there is no workspace-wide PlotView config to keep it in, and the layout's root belongs to flexout |

Recommendation: a, because the lock is then saved in one place and gladly alone decides what obeys it, so one click locks every linked axis, including on plots added later. The lock stops the gestures: a left drag on the axis or the plot area, the wheel, and touch pan and pinch. A gesture in the plot area of a plot whose x axis is locked and whose y axis is free moves y only. The reset is question 11. The fit to the data never reaches a locked axis anyway, because its config carries `min` and `max`, which win over the data range. In gladly the lock is state on the axis, read from the config at `update()` and returned by `getConfig()`, so switching it needs no `update()` and rebuilds no layers. Switching it on also writes every plot's config back with #143's `saveAllPlots()`, so every linked plot saves the locked range rather than the range it last wrote.

### 10. How should a locked axis show on the plot?

| | option | trade-off |
|---|---|---|
| a | a small lock mark drawn by gladly beside the title of every axis that obeys a lock, on every plot, with a tooltip saying it is locked; switched off from the menu | an axis that will not zoom says why, on each linked plot; one more thing to place in the margin, including when the title is hidden |
| b | the axis line and ticks drawn in a muted color while locked | nothing new to place; drawing an axis in its series' color is wanted separately, and the two would clash; a muted axis reads as switched off |
| c | the menu's checkbox only, with a not-allowed cursor over a locked axis | nothing drawn; a plot that refuses to zoom gives no sign until the pointer is over the axis or the menu is open |

Recommendation: a, because an axis that will not zoom should say why on every plot that obeys the lock. Where the mark goes when the title is hidden is for the gladly review. A hidden axis draws no mark, and its lock shows in the menu. The mark could also unlock on a click; it is left display-only at first, since the menu is one right-click away.

### 11. How should the lock behave with typed limits and with reset?

| | option | trade-off |
|---|---|---|
| a | a typed limit (#36) still applies to a locked axis: typing is deliberate, it moves the locked axis and every axis linked to it, and the lock stays on. Reset view leaves a locked axis alone | the lock stops accidents only, and a locked range changes with one typed value; the check sits in the gestures and the reset, not in `Axis.setDomain()`, which #36 also goes through, so #36 needs no change |
| b | the limit boxes do not open on a locked axis | the strictest; a new range takes unlock, type and lock again; #36's editor has to know about the lock |
| c | typing a limit locks the axis | a typed range survives the next zoom without a second step; every typed limit then has to be unlocked before zooming, which changes what #36 does today |

Recommendation: a, because the lock is there to stop accidental zooms and typing a limit is deliberate; #36 then needs no change.

The lock is not a fix for business#168, and is built so that it cannot hide it. It refuses a gesture before the gesture sets any domain, and adds no check to `Axis.setDomain()`, the link callbacks or `update()`, so any other path that sets a domain still reaches a locked axis. If business#168's 0 to 1 comes through one of those paths, a locked axis shows it just as an unlocked one does. A gladly test pins this: `setDomain()` still moves a locked axis. business#168 is found and fixed before the lock lands (Order and releases).

## Design

As recommended above. To be revised once the questions are decided.

### gladly

One PR to `redhog/gladly`.

- Axis parts (question 2a): `tickLabelsVisible` and `titleVisible` in each `axes.<slot>` item, default `true`, in the axes schema beside `visible` and in `docs/configuration/PlotConfiguration.md`. `Axis.prepareAtlas()` and `Axis.render()` skip the tick labels or the title when it is `false`. This works on 3D plots too, where margins do not change.
- Layout (question 3b): in 2D, tick marks, tick labels and the title are placed at fixed pixel distances from the axis line. Tick marks are about 6 px long. Tick labels start about 2 px past them: an x axis's labels are centered on their tick with their near edge there, and a y axis's labels are aligned on that edge, using each label's width from the label atlas. The title is centered in a band about 20 px deep at the outer edge of the margin. `_layoutMargin()` starts from `margin[side]` for a side that draws every part, takes off the title band when the title is hidden and the label band (what is left between the tick band and the title band) when the labels are hidden, and never goes below `marginWithoutAxis[side]`. A side that draws only its line and ticks therefore gets `marginWithoutAxis`, like a side with no axis. The exact pixel values are for the review.
- The right button (question 1a): a synthetic `'contextmenu'` plot event, `cb(e, coords)` like the DOM events, for a right press and release less than 5 px apart that gladly did not use: one that closed a polygon (`LassoInteraction` marks that press) or ended a 3D rotation does not count. It fires on the release, so it behaves the same on every system: the browser's own `contextmenu` event comes at the press on some (macOS) and at the release on others (Windows). gladly keeps blocking the browser's own menu on the canvas, and presses on elements marked `data-gladly-control` (#36's limit boxes) are ignored as for other events. This replaces the plain DOM pass-through for the name `'contextmenu'`; a new name such as `'menu'` works as well if the maintainer prefers to keep the pass-through. For question 8c the event also says which axis strip the press was on, from `_getRegion2D()`, or none for the plot area, a corner, a margin with no axis and any 3D plot; how it is passed (a third argument or a field) is for the review.
- Range lock (questions 9a to 11a): a `locked` key in each `axes.<slot>` item, default `false`, in the axes schema and `docs/configuration/PlotConfiguration.md`. It is read into the axis at `update()` and returned by `getConfig()`. `plot.isAxisLocked(slot)` is true when the slot holds the lock, when an axis reached through `_linkedAxes` (followed with a visited set) holds it, or when another slot of the same plot with the same quantity kind does. `plot.setAxisLocked(slot, on)` sets it on that slot, or clears it on every axis that `isAxisLocked` looks at, then renders again without `update()`. `ZoomController`'s drag, wheel and touch handlers skip a locked axis before calling `setDomain()`, so the free axes of the same gesture still move; this covers 3D plots too, which obey a lock set on a linked 2D axis. `resetAxes()` skips locked axes. A small lock mark is drawn beside the title of each 2D axis that `isAxisLocked`, with a tooltip. Nothing in `Axis.setDomain()`, `AxisLink`, `AxisLimitEditor` or `update()` changes for the lock.
- Reset (question 7a): `plot.resetAxes()` sets each 2D spatial axis that has a scale to its data range through `Axis.setDomain()`, keeping a reversed axis reversed (the gate anomaly section's gate axis runs from late to early) and a log axis above zero, as auto-fit does. `applyAutoDomainsFromLayers()` keeps `dataExtent` for every quantity kind. Color and filter axes are left alone. On a 3D plot it does nothing.
- Docs: `docs/user-api/Plot.md` (the `'contextmenu'` event, `resetAxes()`, `isAxisLocked()` and `setAxisLocked()`), `docs/configuration/PlotConfiguration.md` (the three keys, the margin rule, what a lock stops and what it does not), `docs/architecture/` where the axis layout is described.
- Tests (web-test-runner, `test/`): a hidden title or tick labels draw nothing of that part; each hidden part narrows its side by its band and no side goes below `marginWithoutAxis`; a plot that hides nothing keeps #38's margins; a right press and release emits `'contextmenu'` once with coordinates; a right press that closes a polygon emits nothing; a right drag on a 3D plot emits nothing; `resetAxes()` sets the data range on a zoomed axis, keeps a reversed axis reversed, refuses zero on a log axis, moves a linked axis on a second plot and leaves its unlinked axis alone; the event names the axis strip a right-click was on and none for the plot area and a corner. For the lock: a locked axis ignores the wheel, a drag and touch; so does an axis linked to it on a second plot, and one linked through a third; a wheel in the plot area of a plot with x locked moves y only; a typed limit moves a locked axis and its linked axes; `setDomain()` still moves a locked axis; `resetAxes()` leaves a locked axis; switching it off from a linked plot clears it everywhere; `getConfig()` returns `locked` and `update()` restores it.

### Ymerflow

One PR after the gladly release.

- `frontend/src/widgets/PlotView/PlotMenu.jsx` (new): the menu body. One row for each 2D axis present in the event's `coords` (`AXES_2D` from `gladly-plot`), named by its side and the axis title from `plot.getConfig().axes[slot].label`, with the four checkboxes; then Status bar and Reset view. A right-click on an axis strip shows that axis's row only. The Lock box reads `plot.isAxisLocked(slot)`, so it shows a lock held by a linked plot as well. The checkboxes read the pane's `layoutConfig`, so the menu shows what the plot draws even as it rebuilds behind it. On a 3D plot the menu shows the status bar only. Plain Bootstrap markup and the existing `.pane-menu-dropdown` styling; no `react-bootstrap`, which is being removed (`docs/plans/remove-react-bootstrap.md`).
- `frontend/src/widgets/PlotView/plotMenuConfig.js` (new) with `plotMenuConfig.test.js`: the one function that sets a switch in a copy of the layout config, keeping `statusBar`, every other axis, and the current ranges.
- `frontend/src/flexout/components/PaneMenuDropdown.jsx`: a generic `position` prop (a point in window coordinates) beside `anchorRef`, so the same portal opens at the pointer and stays on screen near the window's right and bottom edges. Nothing about plots goes into `flexout/`.
- `frontend/src/widgets/PlotView/index.jsx`: `plot.on('contextmenu', …)` opens the menu at the pointer and is removed with the other handlers. A switch builds the new config with `plotMenuConfig.js` from `plot.getConfig()` and calls `parentUpdate('replace', id, …)`; the existing update effect applies it. Reset view calls `plot.resetAxes()` and then `saveAllPlots()` from #143. Lock calls `plot.setAxisLocked(slot, on)` and then `saveAllPlots()`, with no `parentUpdate` of its own. Escape closes the menu.
- `frontend/package.json`: `gladly-plot` bumped to the release carrying this with `npm install --save gladly-plot@<version>`, a registry version and never a `file:` path. During development the Ymerflow side runs against the gladly branch with `npm install --no-save` from a local gladly checkout.
- `backend/widget_schemas.json`: regenerated, which picks up the three new axis keys for the form.
- Docs: `docs/user-guide.md` (right-click a plot or one of its axes to show or hide axis parts, lock an axis's range, switch the status bar and reset), `docs/frontend/widgets.md` (PlotView: the menu, and that it writes to `layoutConfig.axes` and `layoutConfig.statusBar`).
- Checked in the running app: each switch on a profile and on a short strip, the strip's room shrinking and coming back; two stacked strips kept aligned; a right-click on each of the four axis strips opening that axis's switches, and in the plot area the full menu; a polygon closed by a right-click without the menu opening, and the menu on the next right-click; a polygon closed with Enter; a right drag rotating a 3D curtain and a right-click there opening the menu; reset on a zoomed profile with a linked strip and sounding plot following only on their shared axes; the distance axis locked on the profile, then zoom, wheel and drag on the profile, the strip and a 3D curtain leaving distance alone on all of them while their other axes move, a typed distance limit moving all of them, reset leaving distance, the lock mark on every distance axis, and the lock switched off from the strip; Save and reload keeping the switches and the lock; the current sounding left alone by a right-click. The zooming is also checked on a workspace with linked explicit limits with nothing locked, against business#168.

### Order and releases

The gladly PR builds on #37 (the polygon's right press) and #38 (`_layoutMargin()`), and touches `Axis.js`, which #36 also changes. It is opened once those three are merged, or stacked on them if their review takes long. Whether it goes into the same gladly release as #36 to #38 is the maintainer's call; one release and one Ymerflow bump would be simplest, and the bump can be shared with the compact-margins switch-on in PlotView.

business#168 is found and fixed first. The lock works on the same zoom path, and checking it in the running app on a workspace where an axis can still drop to 0 to 1 would mix the two. If the fix lands in gladly's zoom or link code, the lock is written on top of it.

## Not in this plan

- Touch input and long-press.
- A Mac Ctrl+click as a right-click, left out for good (decided 2026-11-12): the menu works the same on every system and gets no case for one. A two-button mouse and a trackpad's two-finger click both give the right button, and the menu event fires on the release on every system.
- Color bars and filter bars in the menu, which have their own `colorbar` and `filterbar` settings, and a right-click on a color bar or filter bar, which opens nothing.
- Typed limits and the selection shape in the menu (question 6).
- Switching a part on a whole stack of plots at once (question 5b).
- Per-plot margins, dropped on 2026-11-10.
- Axis rows, reset and the lock mark on 3D plots; a 3D plot only obeys a lock set on a linked 2D axis.
- A lock on color and filter axes.
- A reset that keeps following the data from line to line.
- Color items in the menu (a color map picker, reversed maps, custom maps from files), which are on the wish list as business#116 item 17.
- The fix for business#168.

## Implementation steps

1. gladly, one PR to `redhog/gladly`: the three axis keys, the pixel layout and margin rule, the `'contextmenu'` event with the axis it was on, `resetAxes()`, the range lock and its mark, tests and docs.
2. A gladly release (the maintainer's step).
3. Ymerflow, one PR: the bump, `PlotMenu.jsx`, `plotMenuConfig.js` and its test, the `position` prop on `PaneMenuDropdown`, the wiring in `index.jsx`, the regenerated schema, docs; checked in the running app.

About a day and three quarters for gladly, most of it the pixel layout, the lock and their tests, and three quarters of a day for Ymerflow with the check in the running app, plus the wait for review and release.

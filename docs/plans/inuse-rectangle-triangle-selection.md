# InUse editor: one row, and six new selection shapes

**State:** draft 2026-11-05; questions 1, 2 (with 2a) and 3 decided 2026-11-05, questions 4 and 6 to 10 on 2026-11-06; question 5 open (the gladly maintainer's call)
**Labels:** enhancement, frontend, gladly
**Tracking:** YmerFlow/ymerflow-business#156 (shapes), YmerFlow/ymerflow-business#157 (one row)

## Motivation

The InUse editor selects gates with a free-hand lasso (Shift+drag) in the plots it edits: the gate profile (`ChannelPlot`) and the gate anomaly section (`GateAnomalyPlot`). Long straight cuts along a profile are slow and uneven to draw free-hand, a wedge of late gates in a decay section is easier to fit with a triangle, and an outline with straight sides of any shape is easier to place corner by corner. A blob in the anomaly section fits an ellipse, and a bad stretch of line, such as a power-line crossing, is a full-height band of distance. This plan adds rectangle, triangle, clicked-polygon, circle, ellipse and band selection beside the lasso. The shapes live in gladly's lasso interaction, so every gladly plot with a selection channel gets them, maps included. It spans two repositories: the drawing lives in gladly (`redhog/gladly`, published as `gladly-plot`), and the shape picker lives in Ymerflow.

The editor also takes more height than it needs: five stacked rows for a handful of buttons. This plan puts it on one row, the row the shape picker joins, so the two are planned together.

## What exists

Read against gladly master at 1e1c983 (2026-09-27), which is 12 commits past the latest release, 0.0.19 (2026-06-12). Ymerflow pins `gladly-plot` at `^0.0.19`, which for a 0.0.x version means exactly 0.0.19.

- `SelectionPipeline.runLasso(vertices, selectionColumns)` tests every point and segment against an arbitrary polygon given in canvas pixels: a winding-number test for points, and for segments an endpoint inside or an edge crossing. A rectangle (4 vertices), a triangle (3), a clicked polygon, or a circle or ellipse given as a ring of points needs no change to the selection itself; the lasso texture takes up to 256 vertices.
- `PositionCapture` records each point's position by its pick id, not by where it lands on screen, so the test pass sees points outside the zoomed view as well. As read, a polygon that runs past the plot's edges selects the points out there too; a test in the gladly PR confirms it.
- `LassoInteraction` (`src/selection/LassoInteraction.js`) records a free-hand polygon on a Shift (or Ctrl) drag, draws its outline as a line loop each frame, and calls `plot.selectLasso(vertices)` on release. Its constructor takes a `mode` option, defaulting to `'lasso'`, that is stored and never read, and the user API docs say only `'lasso'` is implemented.
- `Plot._initialize()` builds the lasso interactions from `interactions.lasso`. `true` makes one per selection name found in the layers, with trigger Shift; an array gives `{ selection, trigger }` per item. There is no `mode` field in the config schema, and `mode` is not passed to the constructor.
- Every config change goes through `Plot.update()` to `_initialize()`, which rebuilds every layer. In Ymerflow that is the same pause each in-use edit already costs (see `inuse-flag-editor-gpu.md`).
- gladly's `ZoomController` ignores a left mousedown with Shift held, so Shift-clicks on a plot do not pan. It also blocks the browser's context menu on the plot canvas, and on a 2D plot a right-click does nothing (it starts a rotation only in 3D). Nothing in gladly or Ymerflow's plot code listens for a double-click.
- Ymerflow's `PlotView` forces `interactions.lasso: true` and registers editing layers under the `inuse_brush` selection channel. Both editing layers plot distance on x as `xdist_m`, in meters. Its `plot.on('click')` handler, a capture listener on the window, picks the nearest sounding on every click in the plot, Shift-clicks included. As read, a Shift+drag that starts and ends inside the plot also fires a click, so finishing a lasso probably moves the current sounding to the release point today. To be confirmed in the browser.
- `InUseEditor.jsx` stacks five rows in a column: its own "InUse Editor" title, the edit count (`minHeight: 32`), Enable (E) / Disable (D) / Clear (C), Undo (Ctrl+Z) with Save at the right, and a hint line that names only `ChannelPlot`. The action is React state in `ProcessContext` (`inUseAction`), which `PlotView` reads through a ref, so changing it never rebuilds a plot.
- A compact pane (`done/compact-pane-headers.md`) draws no header row: a small chevron overlays the top-right corner of the widget's own area, 2 px in from the edge. In a compact pane the editor's own title is its only label, and whatever sits at the right end of its first row is under the chevron.
- `docs/user-guide.md` has no InUse editor section today; `docs/frontend/widgets.md` describes the editor and its layers.

## Open questions

### 1. How the triangle is drawn (decided: D)

| | gesture | covers | notes |
|---|---|---|---|
| A | three Shift-clicks, one per corner; the outline follows the pointer between clicks; the third click selects | any triangle | the simplest to explain; three separate clicks |
| B | Shift+drag the first edge, release, then Shift-click the third corner | any triangle | fewer moves when one edge runs along the profile; two kinds of action in one shape |
| C | one Shift+drag between two corners; the triangle is half the box, cut along the diagonal | right triangles with legs along the axes only | one gesture like the rectangle; needs a rule for which half (for example the half on the press point's side) |
| D | Shift+press at the apex, drag to a second corner, release; the third corner is the second mirrored across the vertical line through the apex, at (2 x_apex - x, y); the outline follows the pointer during the drag | triangles symmetric about a vertical line through the apex, with a horizontal base, the apex above or below it | one gesture like the rectangle; a lopsided triangle cannot be drawn |

Decided 2026-11-05: D. The triangles to be cut are symmetric about a vertical. It is one gesture with the outline in view the whole time, and the least code of the four. With A or B a triangle would stay in progress between clicks, and a pan or zoom part way through would move the data under the corners already placed; D has nothing in progress to abandon. A lopsided triangle cannot be drawn this way; the clicked polygon of question 2 covers it.

### 2. A clicked polygon (decided: yes)

Decided 2026-11-05: a fourth mode, `'polygon'`, alongside the lasso, rectangle and triangle. It gives straight-sided cuts of any shape, a lopsided triangle included. Each Shift+left-click places a corner, and the outline runs through the placed corners and the pointer, closing back to the first corner, so the shape that would be selected is always in view. Corners are Shift-clicks like every other shape, so a plain click or drag still pans and picks as today.

A polygon stays in progress between clicks, so it is abandoned by Escape, a click or drag without Shift, a wheel zoom, or a shape change: its corners are screen positions, and a pan or zoom part way through would move the data under them. Closing with fewer than three corners selects nothing.

#### 2a. How the polygon is closed (decided: right-click)

| | gesture | notes |
|---|---|---|
| right-click | right-click anywhere on the plot closes the polygon; the right-click adds no corner | the QGIS digitizing habit; gladly already blocks the context menu and right-click is unused on 2D plots; Firefox opens its menu anyway on a Shift+right-click, so there Shift has to be released first; on a trackpad it is a two-finger tap |
| double-click | the first click of the pair places the last corner, the second (within 5 px of it) is dropped, and the double-click closes | the ArcGIS habit; works the same on any mouse or trackpad and in every browser |
| both | either closes | a few lines more than one alone, and neither habit has to be unlearned |

Decided 2026-11-05: right-click only. A double-click places corners like any other two clicks.

### 3. How a shape change reaches the plots (decided: b)

| | how | cost |
|---|---|---|
| a | through the config: gladly gains a `mode` field on `interactions.lasso` items; `PlotView` writes the current shape into it | each shape change reruns `plot.update()` and rebuilds every layer in every plot, the same pause as an edit today, which the GPU-diff plan removes for edits but not for this |
| b | at run time: gladly also gains `plot.setLassoMode(mode)`, which changes the mode of the plot's lasso interactions in place and keeps it for interactions a later `update()` builds; `PlotView` calls it when the shape changes | instant; one more public method on `Plot` for the gladly maintainer to accept |

Decided 2026-11-05: b, subject to the gladly maintainer accepting `setLassoMode` in review. Switching shape is part of the editing rhythm, and the pause would land on every plot in the workspace at once. The `mode` config field is added as well, so gladly's declarative form stays complete.

### 4. Shift-click and the current sounding (decided: ignore Shift-clicks)

Shift is the selection modifier. Every shape ends in a Shift+press and release inside the plot, which as read fires a click and moves the current sounding, and the sounding plot with it, to the release point. Polygon corners are Shift-clicks, so without a change each corner would move it as well.

Decided 2026-11-06: `PlotView`'s click handler ignores clicks with Shift held, so selecting never moves the current sounding.

### 5. Which gladly release

The release that carries the new modes also carries everything merged since 0.0.19: the single shared WebGL context and its viewport engine, offscreen compositing, and fixes to the selection schema, stencil handling and maps. Ymerflow's bump takes all of it.

| | release | Ymerflow side |
|---|---|---|
| from master | 0.0.20 with the engine changes and the shapes | the bump needs a pass over every PlotView layer type, the two editing layers in particular |
| patch | a branch from `release-0.0.19` with only the shapes | a small bump; the engine changes arrive in a later, separate bump |

Recommendation: from master, which is the gladly maintainer's call, with the layer pass done as part of the Ymerflow bump.

A second gladly change is in progress beside this one: typed axis and color-scale limits, in the axis code rather than the lasso. The two should not touch the same files, and one release can carry both if their timing lines up; that is also the maintainer's call.

### 6. Which lands first, the one row or the shapes (decided: a)

| | order | effect |
|---|---|---|
| a | the one row first, as its own small Ymerflow PR; the shape picker joins the row in the shapes PR after the gladly release | the height comes back now, without waiting on the gladly review and release; `InUseEditor.jsx` is changed twice |
| b | both in the shapes PR | one change to the editor; the row waits on the gladly release |

Decided 2026-11-06: a. The row needs nothing from gladly, so it lands first as its own PR.

### 7. The shape picker in the row (decided: b)

| | picker | notes |
|---|---|---|
| a | four letter buttons, L / R / T / P, styled like E / D / C | nothing to draw; the letter on the button is its key; seven single letters in one row, the two groups told apart only by the gap between them |
| b | four small drawn buttons: a loop, a box, a triangle and a pentagon, each an inline SVG of one path | the shape reads at a glance and does not look like another action; the tooltip gives the name, the key and the gesture |
| c | a dropdown | the narrowest; switching with the mouse takes two clicks, with the keys still one |

Decided 2026-11-06: b, small drawn buttons. The shapes are the one thing in the row that a picture says better than a letter. With question 9 the picker has seven of them.

### 8. Where the hint goes (decided: a)

The hint line is for someone who has not used the editor yet: it says which layer setting to turn on and that Shift+drag selects.

| | hint | cost |
|---|---|---|
| a | a "?" at the row's end with the hint as its tooltip; each shape button's tooltip gives that shape's gesture | a few characters wide; no new state |
| b | the hint line shows only while no plot has an editing layer | each `PlotView` reports its `inUseMode` layers into `ProcessContext` and withdraws them on unmount: shared state for a line that matters only before the first edit |

Decided 2026-11-06: a, a "?" at the row's end with the hint as its tooltip.

### 9. Circle, ellipse and band (decided: add all three)

Decided 2026-11-06: three more modes, since gladly's shapes serve every plot and these cost little once the others exist. The editor's picker shows all seven; an ellipse fits a blob in the anomaly section, and one picker for every plot needs no per-pane setting.

- Circle: Shift+press at the center, drag out to the radius, release, with the outline following the drag, the same feel as the triangle.
- Ellipse: three Shift-clicks. The first places the center; the second the end of the first axis, which sets its direction and length; the third sets the second axis's length, measured square to the first axis, so it need not land on a perpendicular. Any angle. Between clicks it is in progress like the polygon and abandoned the same way.
- Band: a full-height strip of the x axis, every point in it from top to bottom, including points zoomed out of view. A Shift+drag sets its two edges; a Shift+click with no drag selects a strip of the set width centered on the click. The width is set in the editor, in meters for the two editing layers.

Circles and ellipses are drawn in screen pixels. On a map with equal axes a circle is round in map units; on a profile with unequal or log axes it is an ellipse in data units.

### 10. Shape keys and their memo (decided: number keys, digit beside the icon)

C and E are already Clear and Enable, so the shapes take the number keys, 1 to 7 in picker order: lasso, rectangle, triangle, polygon, circle, ellipse, band. They cannot collide with an action key now or later. Each shape button shows its digit beside the icon, chosen 2026-11-06 from a mockup of three forms (a digit in the button's corner, beside the icon, or tooltips only), so the key is in view without hovering.

## Design

### gladly

`LassoInteraction` gets real modes. All of them share the trigger check, the outline drawn each frame from `this._vertices` as a line loop, and the call to `plot.selectLasso(vertices)` at the end, so the selection pipeline is untouched. An unknown mode throws in the constructor.

- `'lasso'`: unchanged.
- `'rectangle'` (confirmed 2026-11-05): the trigger press records one corner and the release the opposite corner, the same gesture as the triangle. The sides run parallel to the plot axes, so all four corners are right angles. While dragging, the outline is the box between the press and the pointer. Release selects with its four corners. A release less than 5 px from the press horizontally or vertically (the lasso's own step) gives a flat box and selects nothing.
- `'triangle'` (question 1, D): the trigger press records the apex. While dragging, the vertices are the apex, the pointer, and the pointer mirrored across the apex's vertical (x' = 2 x_apex - x). Release selects with those three. A release less than 5 px from the apex horizontally or vertically gives a flat triangle and selects nothing.
- `'polygon'` (question 2): each trigger click adds a corner; the outline runs through the corners and the pointer back to the first corner. A right-click (question 2a) selects with the corners placed and adds no corner; a right-click with no polygon open does nothing, as today. Escape, a mousedown without the trigger, a wheel event, a mode change and `destroy()` abandon a polygon in progress, and fewer than three corners select nothing. This mode listens for `mousemove` while no button is held, and for `keydown` (Escape) on the window while a polygon is open.
- `'circle'` (question 9): the trigger press records the center; while dragging, the outline is the circle through the pointer. Release selects with a ring of 64 points. A radius under 5 px selects nothing.
- `'ellipse'` (question 9): three trigger clicks. After the first (the center) the outline is the line from the center to the pointer; after the second (the end of the first axis) it is the ellipse whose second semi-axis is the pointer's distance from the first axis's line. The third click selects with a ring of 64 points. It is abandoned exactly like the polygon, and either semi-axis under 5 px selects nothing.
- `'band'` (question 9): a trigger drag selects the strip between the press and release x positions; a trigger click (a release within 5 px of the press) selects a strip `bandWidth` wide centered on it, with the width given in the x axis's data units and converted to pixels through the axis at that moment. The strip's top and bottom run far past the plot's edges, so points zoomed out of view in y are caught. While the trigger is held, the outline shows the strip under the pointer at the set width, so a click's cut is in view before it lands; while dragging, it shows the strip between the press and the pointer.

Config: each `interactions.lasso` item gains `mode`, an enum of `lasso`, `rectangle`, `triangle`, `polygon`, `circle`, `ellipse` and `band`, default `lasso`, and `bandWidth`, a number in the x axis's data units, both passed to the constructor. With `lasso: true` the interactions take the plot's current mode and band width.

Run time (question 3b): `plot.setLassoMode(mode, { bandWidth })` sets the mode, and the band width when given, on each of the plot's lasso interactions, abandoning a shape in progress, and stores both on the plot so that interactions built by a later `update()` start with them.

`selectLasso` keeps its name; it already takes any polygon.

### Ymerflow

- `ProcessContext`: `selectionShape` and `setSelectionShape`, React state beside `inUseAction`, default `'lasso'`, and `selectionBandWidth` with its setter, in meters, default 100. One shape and one band width for the whole editor, as there is one action. Neither is saved; a reload starts with the lasso and 100 m.
- `InUseEditor.jsx`, one row (business#157): a `flex` row with `flexWrap: 'wrap'` and `alignItems: 'center'`, in this order:
  - the "InUse Editor" title, which the request keeps beside the buttons and which is the only label in a compact pane;
  - E / D / C, the active one highlighted as now, with "Enable (E)", "Disable (D)" and "Clear (C)" as tooltips;
  - Ctrl+Z for Undo, disabled with nothing to undo as now, with "Undo the last edit (Ctrl+Z)" as its tooltip;
  - one thin vertical divider, 1 px wide, about 18 px tall and the buttons' border gray, so the actions and the shapes read as two groups (chosen 2026-11-06);
  - the shape picker (questions 7, 9 and 10): seven drawn buttons, a loop, a box, a triangle, a pentagon, a circle, a tilted ellipse and a strip between two bars for the band, each an inline SVG of one path with its key digit beside it, the active one highlighted like the action buttons. They are Lasso (1), Rectangle (2), Triangle (3), Polygon (4), Circle (5), Ellipse (6) and Band (7), each tooltip giving the name, the key and the gesture, for example "Triangle (3): Shift+press at the apex, drag to a corner of the base". The keys go in the existing keydown handler, which already skips text inputs and Ctrl;
  - while the band is picked, a small number field for its width with "m" beside it;
  - the edit count in the spare width, short: "1,234 edits (↑ 1,000 ↓ 234)", or "No pending edits", with today's full sentence, dataset count included, as its tooltip. It takes `flex: '1 1 40px'` and `minWidth: 0` with an ellipsis, so it gives up width first and moves to a second line only once less than 40 px is left for it;
  - "?" with the hint as its tooltip (question 8): "Turn on inUseMode on a ChannelPlot or GateAnomalyPlot layer, then Shift+drag in it to select. Triangle: start at the apex. Polygon: Shift+click the corners, then right-click. Ellipse: Shift+click the center and the two axes. Band: Shift+drag across, or Shift+click for the set width.";
  - Save at the right end, as now. "?" and Save sit together in one group with `marginLeft: 'auto'`, so they wrap together and stay at the right end of whichever line they are on.

  The padding drops from 12 px to about 4 px, with about 24 px on the right so Save clears a compact pane's corner chevron. The padding is the same whether or not the pane is compact, which is simpler than reading the pane's mode. The buttons keep today's colors, with less side padding to suit single letters. Tooltips are plain `title` attributes.
- `PlotView/index.jsx`: an effect on `selectionShape` and `selectionBandWidth` calls `plotRef.current?.setLassoMode(selectionShape, { bandWidth: selectionBandWidth })`, and the plot is created with both; `interactions.lasso` stays `true`. The click handler returns early when `e.shiftKey` is set (question 4).
- `frontend/package.json`: `gladly-plot` bumped to the new release with `npm install --save gladly-plot@<version>`, a registry version and never a `file:` path. During development the Ymerflow side can run against the gladly branch with `npm install --no-save` from a local gladly checkout, which leaves `package.json` and the lock file alone.

Shapes apply wherever the lasso does, so a later editing layer (for example editing from the sounding plot, or soundings on a map) gets them with no further work. The band width is passed in meters because both editing layers plot `xdist_m`; a later editing layer with another x quantity would need the field's unit to follow it.

## Implementation

The one row lands first (question 6).

0. Ymerflow, one small PR (business#157): the one row in `InUseEditor.jsx` as above, without the shape picker and without the shape sentences in the hint.
   - Docs: the InUseEditor entry in `docs/frontend/widgets.md` (one row, the tooltips).
   - Checked in the running app: the row in a wide and a narrow pane, the wrap, the tooltips, Save clear of the chevron in a compact pane, and E, D, C and Ctrl+Z working as before.
1. gladly, one PR to `redhog/gladly`:
   - `src/selection/LassoInteraction.js`: the rectangle, triangle, polygon, circle, ellipse and band modes, the rule that a click or a flat shape selects nothing, the closing and abandoning of the polygon and the ellipse, the band's width and preview, the mode check.
   - `src/core/Plot.js`: `mode` and `bandWidth` in the `interactions.lasso` item schema and passed to the constructor; `setLassoMode()` and the stored mode and width (3b).
   - Tests (web-test-runner, in `test/`): each mode hands `selectLasso` the expected vertex list from synthetic mouse events (with `selectLasso` stubbed on the plot): the triangle's third corner mirrored across the apex, the circle's and ellipse's rings at the right radius and axes, the ellipse's second axis measured square to the first, a band click's strip at the set width through the axis; a click and a flat shape select nothing; a polygon closed by a right-click, which adds no corner; a polygon and an ellipse abandoned by Escape, a plain click and a mode change; an unknown mode throws. Two end-to-end cases on a points layer: a rectangle around known points selects exactly those, and a band selects the points in its x range that are zoomed out of view in y. gladly has no lasso test today, so these also cover the pipeline.
   - Docs: `docs/configuration/Selection.md` (the `mode` and `bandWidth` fields), `docs/user-api/Selection.md` (the mode table, `setLassoMode`), `docs/architecture/Selection.md` (the `LassoInteraction` row).
2. A gladly release (the maintainer's step).
3. Ymerflow, one PR: the bump, `ProcessContext`, the shape picker and the full hint in `InUseEditor`, `PlotView` as above.
   - Docs: the InUse editor section of `docs/frontend/widgets.md`, and a short InUse editor section in `docs/user-guide.md`, which has none today.
   - Tests: the Ymerflow side is UI wiring with no new pure logic worth a vitest case, and component tests need a DOM environment the frontend does not have. It is checked in the running app instead: each shape with Enable, Disable and Clear on a `ChannelPlot` and a `GateAnomalyPlot` pane, the keys 1 to 7, the band's width field and a band click at a known width, Undo and Save after a shape edit, a Shift+drag leaving the current sounding alone, and a pass over every PlotView layer type for the gladly bump.

About two days of work for the shapes: a day and a quarter for gladly with the polygon, ellipse and band, their tests and docs, three quarters of a day for Ymerflow with the seven-button picker, the band field and the bump's layer pass, plus the wait for review and the release. The one row is about two hours more, with its docs and the check in the running app.

## Not changing

- The selection pipeline (`SelectionPipeline`, the capture and test passes) and how a selection becomes an edit (`inUseEdits.js`).
- Enable / Disable / Clear, Undo, Save and the diff format. The one row moves the buttons and shortens their labels; what they do and their keys stay as they are.
- The GPU-diff plan (`inuse-flag-editor-gpu.md`), which changes what happens after a selection and is independent of how the shape is drawn.
- Touch input: `LassoInteraction` handles mouse events only, as today.

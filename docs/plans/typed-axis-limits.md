# Typed axis and color-scale limits

**State:** decided 2026-11-06, ready to implement
**Labels:** enhancement, frontend, gladly
**Tracking:** YmerFlow/ymerflow-business#158

## Motivation

In the AEM model simulator the two ends of the color scale are click-to-edit: click the value, type a number, press Enter. PlotView has nothing like it. An axis or color range is set by zooming, or by editing `min` and `max` in the pane's configuration form. During manual editing the same ranges get set on line after line (dB/dt decades, loop height, gate time), and dragging to an exact decade is slow and never quite exact. This plan makes the two end values of every PlotView axis and color bar click-to-type, the way the simulator's color scale works. It spans two repositories: the axes and color bars are drawn by gladly (`redhog/gladly`, published as `gladly-plot`), and Ymerflow saves the result into the workspace.

## What exists

Read against gladly master at 1e1c983 (2026-09-27), 12 commits past the latest release, 0.0.19. `src/axes/` is unchanged since 0.0.19. Ymerflow pins `gladly-plot` at `^0.0.19`, which for a 0.0.x version means exactly 0.0.19.

### The simulator

- `EditableValue` in `frontend/src/widgets/AEMModelSimulator/BrushControls.jsx` (lines 4-43) is a span that turns into an `<input type="number">` when clicked. Enter or blur commits a positive number, Escape cancels, and anything else is dropped. It is used for the two ends of the simulator's color bar, which is a CSS gradient drawn by React, so its end values are DOM text to click. The simulator's model axes (`ModelCanvas.jsx`) are not editable.
- The component is bound to resistivity: it refuses zero and below and appends Ω·m. It is a React component, and gladly has no React in it.

### PlotView axes and color bars

- gladly draws axis lines, tick labels and titles in WebGL (`src/axes/Axis.js`). There are no DOM labels to click, and the tick labels are rounded values inside the range, so the two range ends usually carry no label at all.
- A color bar is a float (`src/floats/Colorbar.js`) holding a small gladly `Plot` whose one spatial axis is linked to the parent plot's color axis with `linkAxes`. Zooming the color bar is how a color range is changed interactively today. Anything that works on a plot's 2D spatial axes therefore works on a color bar's axis too, and through the link on the color range. The filter bar (`Filterbar.js`) and the 2D color bar (`Colorbar2d.js`) are built the same way.
- Zoom and pan set a range through `plot._getAxis(id).setDomain(domain)` (`ZoomController.js`). `Axis.setDomain` writes the range into the plot (`Plot.setAxisDomain`, which also writes `min` and `max` into `currentConfig.axes[slot]`) and calls the axis's listeners, which is how linked axes follow.
- Ymerflow's `PlotGroupContext` puts every PlotView in one `PlotGroup` with `autoLink: true`, so every axis with the same quantity kind is linked across the workspace, color axes included (`PlotGroup._updateAutoLinks`).
- Limits live in `layoutConfig.axes.<slot>.min` / `max` for spatial axes and `layoutConfig.axes.<quantity kind>.min` / `max` for color axes. After every `plot.update()` PlotView writes `plot.getConfig()` back into the layout node, and `getConfig()` writes the current range of every axis. A zoomed range therefore becomes a configured range at the plot's next update (a sounding click, a data change), and is saved with the workspace when the workspace is saved. Zooming itself writes nothing back.
- Ranges can run backwards. The gate anomaly section's gate axis is `[late gate, early gate]`, so early gates sit at the top (`GateAnomalyPlot.js`, line 63). A typed value has to keep that.
- `plot.on('click')` is a capture listener on the window that fires for any click inside the plot's container, floats included. PlotView's click handler picks the nearest sounding from the x coordinate, so a click on an axis end would also move the current sounding.
- The InUse editor's E, D and C shortcuts listen on the window but skip `INPUT` targets, so typing `1e-4` into an input does not switch its mode.

## Questions

All five were decided on 2026-11-06 as recommended: option (a) in each.

### 1. Where the editing lives

| | option | trade-off |
|---|---|---|
| a | gladly: a small plain-DOM editor on every 2D `Plot`, copying the simulator's behavior | one mechanism covers axes and color bars, since a color bar is a `Plot`; every gladly user gets it; needs a gladly review and release |
| b | Ymerflow: the simulator's `EditableValue` generalized and positioned over the plot by PlotView | reuses the component and needs no gladly release; positions come from gladly internals (`margin`, `plotWidth`, and the private `_floats` map for color bars, which move when dragged), so it breaks when gladly changes |

Decided: a. The simulator keeps its own `EditableValue` (40 lines with no gladly in it); what carries over is the behavior, listed under Design.

### 2. How an end value is shown and clicked

| | option | trade-off |
|---|---|---|
| a | on hover: pointing at an axis's label band shows its two end values in small boxes at the two ends of that axis; click a box to type | nothing changes until the pointer is on the band; one axis at a time, so the boxes at a corner never overlap |
| b | always shown: the two end values drawn at every axis end | collides with tick labels near the ends and adds clutter to every plot |
| c | double-click the axis band: one small box with both min and max | one more gesture to remember; which number is which end is less obvious |

Decided: a.

### 3. Saved with the workspace, or only for the session

| | option | trade-off |
|---|---|---|
| a | like a zoomed range: the typed value goes into `layoutConfig.axes` and is saved when the workspace is saved; in the open workspace it stays when the plot's data changes (the next line), as a zoomed range does now | none found |
| b | session only: kept out of the layout, gone on reload | `getConfig()` writes every axis's current range back and cannot tell a typed range from a zoomed one, so this means changing how zoom is saved as well |

Decided: a. It is where configured limits already live, so a typed value and a configured one are the same thing.

With (a), PlotView writes its config back as soon as a value is typed, rather than at its next update, so a Save straight after typing keeps it. Linked plots follow on screen at once (question 5) but would otherwise reach the layout only at their own next update, so a typed value asks every PlotView in the workspace to write back. A plot whose config did not change writes nothing; each one that did change rebuilds once, the same pause as a sounding click.

### 4. On a log axis, the value or the exponent

| | option | trade-off |
|---|---|---|
| a | the value: `1e-4`, `0.0001` and `100` all work, since number parsing accepts e-notation; zero and below are refused on a log axis | the box shows the number it sets |
| b | the exponent: `-4` means 1e-4 | the same digits mean different things on a linear and a log axis |

Decided: a. The simulator works this way, and e-notation is as short to type as an exponent.

### 5. Do linked axes follow

| | option | trade-off |
|---|---|---|
| a | follow: a typed value goes through `Axis.setDomain`, like zoom, so every plot linked to that axis moves with it, and a typed color limit moves every plot sharing that color quantity | none found |
| b | this plot only: the value bypasses the link | linked plots show different ranges until the next zoom snaps them together; gladly needs a second path into the axis that skips the links |

Decided: a. It is what zoom does.

## Design

As decided above.

### gladly

A new `src/axes/AxisLimitEditor.js`, one per plot, created once in `_initialize` beside the `ZoomController` and removed in `destroy()`.

- 2D plots only. In a 3D plot it shows nothing, since the axis ends move with the camera.
- Each drawn 2D spatial axis (it has a scale and `visible` is not `false`) gets two boxes, absolutely positioned in `plot.container` on the axis's tick-label row (the offset `Axis.js` uses) and centered on the axis ends. The bottom or left box shows `domain[0]`, the config's `min`; the top or right box shows `domain[1]`, the config's `max`. Positions are computed when the boxes are shown, so resizing needs no tracking.
- The boxes are hidden until the pointer is on that axis's band (the region `ZoomController._getRegion2D` already returns as `type: 'axis'`) or on one of its boxes. A box has a white background, so it covers the tick label under it.
- A box shows its value formatted the way tick labels are (`formatTick`, exported from `Axis.js`), with the tooltip "Click to set min" or "Click to set max".
- A click turns the box into an `<input>` holding the current value to 6 significant digits, selected, so typing replaces it.
- Enter commits. Tab commits and opens the other end of the same axis. Escape cancels. Blur commits a valid value and drops an invalid one, which is the simulator's rule.
- A valid value is a finite number, not equal to the other end, on the same side of the other end as the current value (so a reversed axis stays reversed), and above zero on a log axis. An invalid value on Enter keeps the box open with a red border and a tooltip naming the rule it broke.
- A commit calls `plot._getAxis(id).setDomain(newDomain)`, the zoom path, so linked axes and color bars follow. It then fires a new plot event, `'axislimit'`, with `{ axis, end: 'min' | 'max', value, domain }`.
- `plot.on('axislimit', cb)` joins `'error'` and `'no-error'` as a synthetic plot event. The color bars and the filter bar re-emit their own `'axislimit'` on their parent plot, with `axis` set to the parent's color or filter axis, so a listener on the parent hears typed color limits.
- The boxes carry a `data-gladly-control` attribute, and the window handler in `Plot.on()` ignores DOM events whose target is inside one. Clicking a box therefore never reaches `plot.on('click')` listeners such as PlotView's sounding pick.
- Floats get the editor without extra code, since a color bar's axis is a 2D spatial axis of its own `Plot`. A filter bar's ends are its filter bounds: typing one turns the bounds on, as zooming a filter bar does now.
- Docs: `docs/user-api/Plot.md` (the `'axislimit'` event), `docs/configuration/PlotConfiguration.md` (typed limits beside zoom and pan), `docs/user-api/ColorbarsFilterbars.md`.
- Tests (web-test-runner, `test/`): two boxes per drawn 2D axis, none for a hidden axis or a 3D plot; Enter sets the domain and fires `'axislimit'` once; Escape and an invalid value leave the domain unchanged; a reversed axis refuses a value that would flip it; a log axis refuses 0; a linked axis on a second plot follows; a typed color-bar end changes the parent's color range and fires `'axislimit'` on the parent; a click on a box does not reach a `plot.on('click')` listener.

### Ymerflow

- `frontend/src/widgets/PlotView/index.jsx`: the write-back after `plot.update()` moves into a small `saveConfig()` function. An `'axislimit'` listener calls `saveAllPlots()` from `PlotGroupContext`.
- `frontend/src/PlotGroupContext.jsx`: `addPlot(name, plot, saveConfig)` keeps each PlotView's save function, and a new `saveAllPlots()` calls them all.
- `frontend/package.json`: `gladly-plot` bumped to the new release with `npm install --save gladly-plot@<version>`, a registry version and never a `file:` path. During development the Ymerflow side runs against the gladly branch with `npm install --no-save` from a local gladly checkout, which leaves `package.json` and the lock file alone.
- Docs: `docs/user-guide.md` (click an axis or color-bar end to type it), `docs/frontend/widgets.md` (typed limits are written back at once and land in `layoutConfig.axes`).
- Tests: the Ymerflow side is wiring with no new pure logic worth a vitest case. It is checked in the running app: x and y axes on a `ChannelPlot`, the reversed gate axis on a `GateAnomalyPlot`, a log dB/dt axis, a color bar on a curtain; linked panes follow; Save and reload keep the values; a click on a box leaves the current sounding alone; typing `e` or `d` in a box leaves the InUse editor's mode alone.

### Releasing with the selection-shape change

The InUse editor's rectangle, triangle and polygon selection (`docs/plans/inuse-rectangle-triangle-selection.md`) is a second gladly change in flight. The two touch different files except `src/core/Plot.js`, where the shapes add `setLassoMode` and this change adds the editor's construction and teardown and the `'axislimit'` event in `on()`, so a merge conflict is unlikely and whichever PR merges second rebases on the other.

Recommendation: both gladly PRs against master and one release carrying both, then one Ymerflow bump, done in whichever Ymerflow PR merges first together with the pass over every PlotView layer type the shapes plan already scopes; the other Ymerflow PR rebases on it. Whether that release comes from master or from a patch branch off 0.0.19 is the gladly maintainer's call and is asked in the shapes plan (its question 5). This change follows that answer; since `src/axes/` is unchanged since 0.0.19 it fits either.

## Not in this plan

- Resetting an axis to its data range (ymerflow-business#116 item 12). Typed limits live in `layoutConfig.axes.<slot or quantity kind>.min` / `max`, the place that reset will clear, so the two agree.
- Typed limits on 3D plots, touch input, and wheel zoom while the pointer is over a box.
- When a zoomed range is written back (it stays at the next update).
- The simulator's own `EditableValue`, which is unchanged.

## Implementation steps

1. gladly, one PR to `redhog/gladly` against master: `AxisLimitEditor`, the `'axislimit'` event and the float re-emit, the control filter in `Plot.on()`, tests and docs.
2. A gladly release (the maintainer's step), with the selection shapes if their timing lines up.
3. Ymerflow, one PR: the bump (unless the shapes PR has made it), PlotView's `saveConfig()` and listener, `saveAllPlots()` in `PlotGroupContext`, docs; checked in the running app.

About three quarters of a day for gladly with its tests and docs, and two to three hours for Ymerflow with the check in the running app, plus the wait for review and release.

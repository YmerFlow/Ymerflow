# Show gladly errors in the plot pane

**State:** decided 2026-11-13, ready to implement once committed
**Labels:** enhancement, frontend, gladly
**Tracking:** YmerFlow/ymerflow-business#179
**Related:** redhog/gladly#39 (a layer whose quantity kind clashes is skipped with an error), redhog/gladly#40, YmerFlow/Ymerflow#145

## Motivation

When gladly cannot draw part of a plot, the pane gives no sign of it. A layer that fails to build is dropped and logged to the browser console; an `update()` that fails outright leaves the pane blank, with an uncaught promise error in the console. In a review workspace, a `lines` layer whose column had no quantity kind clashed with a resistivity curtain's elevation axis: the whole curtain pane stayed blank and the cause was only findable in the developer tools. With redhog/gladly#39 that layer is skipped and the rest of the pane draws, which makes the failure quieter still: a line is simply missing.

This plan makes the pane say what went wrong, in the pane, until it is fixed. It spans two repositories: gladly decides when a plot has errors, and PlotView shows them.

## What exists

Read against gladly master at c658e06 and Ymerflow master at be9b141.

### gladly

- `Plot._emitError(error)` logs the error, sets `_hasError` and `_currentRenderHasError`, and calls every `plot.on('error', cb)` listener with `{ type: 'error', error, message }`.
- Errors come from two places. While `update()` builds the plot (`_processLayers`): an unknown layer type, a layer spec with more than one key, a layer whose `createLayer` or draw command fails, and with #39 a layer whose axis quantity kind clashes. While rendering (`_prepareRender`, `_drawSync`): a transform or column refresh that fails, a draw that throws.
- An `update()` that throws (a link quantity-kind mismatch from `_validateLinks`, a WebGL failure, anything outside the per-layer try blocks) rejects its promise and emits no event.
- `plot.on('no-error', cb)` fires after a render with no render errors, once per error episode (`_drawSync`, end). Its docs (`docs/user-api/Plot.md`) suggest showing a banner on `error` and clearing it on `no-error`.
- That pattern does not work for errors from `update()`. `_prepareRender` resets `_currentRenderHasError` at the start of every render, so the first render after a build with a skipped layer has no render errors and fires `no-error`, while the layer is still missing. Checked in a gladly test: `error`, `error`, then `no-error` on the first render.
- The ResizeObserver runs `forceUpdate()` on its own, so the same build error can be emitted more than once.

### PlotView

- `frontend/src/widgets/PlotView/index.jsx` subscribes to `mousemove`, `click` and the `inuse_brush` selection, and not to `error` or `no-error`.
- The update effect calls `plot.update({ data, config }).then(...)` with no `catch`.
- The pane already has a message strip: pinned-dataset messages (`pinnedMessages`) show as an amber `alert alert-warning` box absolutely positioned at the top of the plot, with `pointerEvents: 'none'` so the plot underneath still takes the mouse.
- The workspace status bar (`PlotStatusBar.jsx`) shows cursor and pick readouts for all panes; it does not show errors.

## Decisions

Settled on 2026-11-13:

1. Clearing: fix gladly's `no-error`, so it means the plot as configured draws cleanly. PlotView then follows gladly's documented pattern: show on `error`, clear on `no-error`.
2. Place: a strip in the failing pane, in the same place as the pinned-dataset messages; the mouse passes through it.
3. Text: gladly's message as it is written, for example `Layer 'lines' (index 1) skipped: axis 'yaxis_left' has quantity kind 'elevation_m', the layer has 'current.processed_data.zb'`.
4. No dismiss: a message stays until the cause is fixed and the plot updates cleanly. Long lists are cut to a few lines plus `+N more`.

## Design

### gladly: errors from update() last until the next update

- The plot remembers whether its latest build reported an error (`_buildHasError`). A new build resets it when `_initialize()` starts; `_emitError` calls made while building set it.
- An `update()` that throws also reports through `_emitError` before it rethrows, and counts as a build error. Every failure then arrives as an `error` event, and its recovery as `no-error`.
- `no-error` fires after a render with no render errors only when the latest build had none either. Otherwise unchanged: once per episode, only after an earlier error.
- So a skipped layer keeps the plot in error until an update builds without it; a render error that goes away clears at the next clean render, as now.
- Docs: the `no-error` paragraph in `docs/user-api/Plot.md`.
- Tests, in gladly's suite: a layer error survives clean renders with no `no-error`; an update without the bad layer fires `no-error` after its first render; a failed `update()` emits `error` and still rejects.
- One PR to `redhog/gladly`, for the release after the one that carries #39 and #40.

### PlotView: the strip

- In the effect that creates the plot: `plot.on('error', e => add(e.message))` and `plot.on('no-error', () => clear())`, removed in its cleanup with the other handles.
- The list is React state holding distinct messages. Adding a message already in the list returns the same array, so an error repeated every frame or re-emitted by the ResizeObserver does not re-render the pane.
- The update effect gets a `.catch(err => add(err.message))`, so a failed update shows in the strip as well as through the event; the two carry the same text and the list keeps one.
- The strip shows errors as a red `alert alert-danger` box above the amber pinned-dataset box, in the same absolutely positioned container with `pointerEvents: 'none'`. At most three messages, then `+N more`; the full list stays in the console.
- No new module: about twenty lines in `index.jsx`.

## Order of work

1. The gladly PR, reviewed and released. The release that carries #39 and #40 does not wait for it.
2. The Ymerflow PR, with the bump of `gladly-plot` to that release. Before the bump, the strip would clear a skipped-layer message after one frame, so the two go together.

## Testing

- gladly: the tests above.
- PlotView: in the running app, a pane with a layer that cannot draw (for example a `lines` layer of a column with no quantity kind on a curtain's elevation axis) shows the red strip with gladly's message; removing that layer from the pane's config clears it at the next update; a pane with no errors shows no strip.
- PlotView's change is state wiring and JSX in a component the repo's vitest setup does not render, so it gets no unit test.

## Out of scope

- Errors in color bar and filter bar floats, which are gladly plots of their own.
- Rewriting gladly's messages in plain language, or mapping a layer index to its place in the pane's config form.
- Showing errors in the workspace status bar.

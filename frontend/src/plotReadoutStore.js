// The workspace status bar's readout store — a plain publish/subscribe set, kept out
// of React state on purpose. Mousemove fires many times a second; a context value
// change would re-render every PlotView, so the bar subscribes and writes textContent
// directly. PlotView publishes { coords } on mousemove and { pick } on click.
//
// Each readout slot may also carry a color that travels with its value: `coordsColor`
// (with `coords`) and `pickColor` (with `pick`). The subscriber paints the whole bar's
// background `pickColor ?? coordsColor ?? default`. Publishing a slot's value with no
// color clears that slot's color — e.g. a plain mouse-move { coords } clears coordsColor,
// a plain click { pick } clears pickColor. An incompatible dataset drop publishes
// { pick: <msg>, pickColor: <red> } to flag the rejection until the next pick/append.
export function createReadoutStore() {
  const listeners = new Set();
  return {
    publish: (readout) => { for (const l of listeners) l(readout); },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

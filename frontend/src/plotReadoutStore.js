// The workspace status bar's readout store — a plain publish/subscribe set, kept out
// of React state on purpose. Mousemove fires many times a second; a context value
// change would re-render every PlotView, so the bar subscribes and writes textContent
// directly. PlotView publishes { coords } on mousemove and { pick } on click.
export function createReadoutStore() {
  const listeners = new Set();
  return {
    publish: (readout) => { for (const l of listeners) l(readout); },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

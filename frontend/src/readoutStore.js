// The readout of the plot under the pointer, for the workspace status bar: `coords` is the
// cursor position, `pick` the last point picked by a click, both as display text. A plain
// publish/subscribe store, not React state, because mousemove fires many times a second
// and a context value change would re-render every PlotView.
export function createReadoutStore() {
  let readout = { coords: '', pick: '' };
  const listeners = new Set();
  return {
    publish(update) {
      readout = { ...readout, ...update };
      listeners.forEach(listener => listener(readout));
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(readout);
      return () => listeners.delete(listener);
    },
  };
}

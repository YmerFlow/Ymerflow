// Writes PlotView configs back into the layout one plot at a time.
//
// A typed axis limit moves every linked axis at once, but each PlotView otherwise writes
// its config into the layout only after its own next update; saveAll() asks them all to
// write now, so a Save straight after typing keeps the value in every plot.
//
// The writes cannot all go at once: a flexout container builds a child's replacement
// from the children it last rendered, so a second write before the first has re-rendered
// the layout would put the first plot's old config back. After a plot writes, the queue
// waits until that PlotView reports its new config arrived (saved) before the next.
export function createSaveQueue() {
  const savers = new Map();   // plot name → save(), which returns whether it wrote
  let queue = [];
  let waitingFor = null;

  const drain = () => {
    while (waitingFor === null && queue.length) {
      const name = queue.shift();
      if (savers.get(name)?.()) waitingFor = name;
    }
  };

  return {
    add: (name, save) => { savers.set(name, save); },
    remove: (name) => {
      savers.delete(name);
      queue = queue.filter(n => n !== name);
      if (waitingFor === name) { waitingFor = null; drain(); }
    },
    // A call while writes are still in flight adds to the queue rather than restarting
    // it, so writes never overlap.
    saveAll: () => {
      for (const name of savers.keys()) if (!queue.includes(name)) queue.push(name);
      drain();
    },
    saved: (name) => { if (waitingFor === name) { waitingFor = null; drain(); } },
  };
}

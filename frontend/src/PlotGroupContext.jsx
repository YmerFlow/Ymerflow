import React, { createContext, useEffect, useMemo, useRef, useState } from 'react';
import { PlotGroup } from 'gladly-plot';
import { createReadoutStore } from './plotReadoutStore';

export const PlotGroupContext = createContext(null);

export function PlotGroupProvider({ children }) {
  const groupRef = useRef(null);
  const apiRef = useRef(null);
  // Per-plot "write my current config back into the layout" callbacks, keyed by plot id.
  // Used to fan a persist out across the whole linked workspace (a lock's pinned range, a
  // reset) — see saveAllPlots.
  const saversRef = useRef(new Map());
  const [plotCount, setPlotCount] = useState(0);

  if (!groupRef.current) {
    groupRef.current = new PlotGroup({}, { autoLink: true });
  }
  if (!apiRef.current) {
    // Stable function identities across renders (captured once). plotCount lives in
    // React state only so the workspace status bar can hide when no plot is open.
    const readout = createReadoutStore();
    apiRef.current = {
      addPlot:    (name, plot, save) => {
        groupRef.current?.add(name, plot);
        if (save) saversRef.current.set(name, save);
        setPlotCount(c => c + 1);
      },
      removePlot: (name) => {
        groupRef.current?.remove(name);
        saversRef.current.delete(name);
        setPlotCount(c => Math.max(0, c - 1));
      },
      // Persist every open plot's current config. A reset or a range lock changes the
      // shared range on every linked plot, not just the one acted on, so each must write
      // its own config back. Errors are isolated so one plot cannot block the rest.
      saveAllPlots: () => {
        for (const save of saversRef.current.values()) {
          try { save(); } catch (e) { console.error('[PlotGroup] saveAllPlots:', e); }
        }
      },
      publishReadout:   readout.publish,
      subscribeReadout: readout.subscribe,
    };
  }

  useEffect(() => {
    return () => {
      groupRef.current?.destroy();
      groupRef.current = null;
    };
  }, []);

  const value = useMemo(
    () => ({ ...apiRef.current, hasPlots: plotCount > 0 }),
    [plotCount]
  );

  return (
    <PlotGroupContext.Provider value={value}>
      {children}
    </PlotGroupContext.Provider>
  );
}

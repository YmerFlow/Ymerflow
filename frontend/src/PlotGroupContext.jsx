import React, { createContext, useEffect, useMemo, useRef, useState } from 'react';
import { PlotGroup } from 'gladly-plot';
import { createReadoutStore } from './plotReadoutStore';

export const PlotGroupContext = createContext(null);

export function PlotGroupProvider({ children }) {
  const groupRef = useRef(null);
  const apiRef = useRef(null);
  const [plotCount, setPlotCount] = useState(0);

  if (!groupRef.current) {
    groupRef.current = new PlotGroup({}, { autoLink: true });
  }
  if (!apiRef.current) {
    // Stable function identities across renders (captured once). plotCount lives in
    // React state only so the workspace status bar can hide when no plot is open.
    const readout = createReadoutStore();
    apiRef.current = {
      addPlot:    (name, plot) => { groupRef.current?.add(name, plot); setPlotCount(c => c + 1); },
      removePlot: (name)       => { groupRef.current?.remove(name); setPlotCount(c => Math.max(0, c - 1)); },
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

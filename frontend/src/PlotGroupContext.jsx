import React, { createContext, useEffect, useRef } from 'react';
import { PlotGroup } from 'gladly-plot';
import { createReadoutStore } from './readoutStore';

export const PlotGroupContext = createContext(null);

export function PlotGroupProvider({ children }) {
  const groupRef = useRef(null);
  const readoutRef = useRef(null);

  if (!groupRef.current) {
    groupRef.current = new PlotGroup({}, { autoLink: true });
  }
  if (!readoutRef.current) {
    readoutRef.current = createReadoutStore();
  }

  useEffect(() => {
    return () => {
      groupRef.current?.destroy();
      groupRef.current = null;
    };
  }, []);

  const value = {
    addPlot:    (name, plot) => groupRef.current?.add(name, plot),
    removePlot: (name)       => groupRef.current?.remove(name),
    readout:    readoutRef.current,
  };

  return (
    <PlotGroupContext.Provider value={value}>
      {children}
    </PlotGroupContext.Provider>
  );
}

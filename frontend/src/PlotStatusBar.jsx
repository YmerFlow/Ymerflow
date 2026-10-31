import React, { useContext, useEffect, useRef } from 'react';
import { LayoutContext } from './flexout/LayoutContext';
import { PlotGroupContext } from './PlotGroupContext';

// One status bar along the bottom of the workspace: the cursor readout of the plot under
// the pointer on the left, the last point picked in any plot on the right. Drawn only when
// the workspace has a plot. The text is written through refs, so mousemove re-renders nothing.
export default function PlotStatusBar() {
  const { findWidgetPaths } = useContext(LayoutContext);
  const { readout } = useContext(PlotGroupContext);
  const coordsRef = useRef(null);
  const pickRef = useRef(null);
  const hasPlot = findWidgetPaths('PlotView').length > 0;

  useEffect(() => {
    if (!hasPlot) return undefined;
    return readout.subscribe(({ coords, pick }) => {
      if (coordsRef.current) coordsRef.current.textContent = coords;
      if (pickRef.current) pickRef.current.textContent = pick;
    });
  }, [hasPlot, readout]);

  if (!hasPlot) return null;
  return (
    <div className="plot-status-bar">
      <div ref={coordsRef} className="plot-status-coords" />
      <div ref={pickRef} className="plot-status-pick" />
    </div>
  );
}

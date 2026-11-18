import React, { useContext, useEffect, useRef } from 'react';
import { PlotGroupContext } from './PlotGroupContext';

// One status bar for the whole workspace, under the layout. It shows the live cursor
// coordinates of whichever plot the pointer is over (left) and the last point picked by
// a click in any plot (right) — the same readout each PlotView used to show for itself.
// It subscribes to the PlotGroupContext readout store and writes textContent directly,
// so the many-per-second mousemove updates never re-render React.
const DEFAULT_BG = '#f8f9fa';

export default function PlotStatusBar() {
  const { hasPlots, subscribeReadout } = useContext(PlotGroupContext);
  const barRef = useRef(null);
  const coordsRef = useRef(null);
  const pickRef = useRef(null);
  // Per-slot background color that travels with each slot's value; the bar paints
  // pick ?? coords ?? default.
  const colorsRef = useRef({ coords: undefined, pick: undefined });

  useEffect(() => {
    return subscribeReadout(({ coords, coordsColor, pick, pickColor }) => {
      if (coords !== undefined) {
        if (coordsRef.current) coordsRef.current.textContent = coords;
        colorsRef.current.coords = coordsColor;
      }
      if (pick !== undefined) {
        if (pickRef.current) pickRef.current.textContent = pick;
        colorsRef.current.pick = pickColor;
      }
      if (barRef.current)
        barRef.current.style.background =
          colorsRef.current.pick ?? colorsRef.current.coords ?? DEFAULT_BG;
    });
  }, [subscribeReadout]);

  // Drawn only when the workspace has at least one plot.
  if (!hasPlots) return null;

  return (
    <div ref={barRef} style={{
      display: 'flex',
      fontSize: '12px',
      fontFamily: 'monospace',
      background: DEFAULT_BG,
      borderTop: '1px solid #dee2e6',
      flexShrink: 0,
      minHeight: '20px',
      color: '#495057',
      overflow: 'hidden',
    }}>
      <div ref={coordsRef} style={{ flex: '0 1 auto', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} />
      <div ref={pickRef}   style={{ flex: '1 1 0', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'right', borderLeft: '1px solid #dee2e6' }} />
    </div>
  );
}

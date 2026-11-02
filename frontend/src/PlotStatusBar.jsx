import React, { useContext, useEffect, useRef } from 'react';
import { PlotGroupContext } from './PlotGroupContext';

// One status bar for the whole workspace, under the layout. It shows the live cursor
// coordinates of whichever plot the pointer is over (left) and the last point picked by
// a click in any plot (right) — the same readout each PlotView used to show for itself.
// It subscribes to the PlotGroupContext readout store and writes textContent directly,
// so the many-per-second mousemove updates never re-render React.
export default function PlotStatusBar() {
  const { hasPlots, subscribeReadout } = useContext(PlotGroupContext);
  const coordsRef = useRef(null);
  const pickRef = useRef(null);

  useEffect(() => {
    return subscribeReadout(({ coords, pick }) => {
      if (coords !== undefined && coordsRef.current) coordsRef.current.textContent = coords;
      if (pick !== undefined && pickRef.current) pickRef.current.textContent = pick;
    });
  }, [subscribeReadout]);

  // Drawn only when the workspace has at least one plot.
  if (!hasPlots) return null;

  return (
    <div style={{
      display: 'flex',
      fontSize: '12px',
      fontFamily: 'monospace',
      background: '#f8f9fa',
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

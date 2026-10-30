import { registerAxisQuantityKind } from 'gladly-plot';

let registered = false;

export function registerQuantityKinds() {
  if (registered) return;
  registered = true;

  registerAxisQuantityKind('xdist_m',        { label: 'Distance (m)',          scale: 'linear' });
  registerAxisQuantityKind('dbdt_abs_pT',     { label: '|dB/dt| (pT)',          scale: 'log'    });
  registerAxisQuantityKind('time_s',          { label: 'Time (s)',              scale: 'log'    });
  registerAxisQuantityKind('elevation_m',     { label: 'Elevation (m)',         scale: 'linear' });
  registerAxisQuantityKind('index',           { label: 'Index',                 scale: 'linear' });
  registerAxisQuantityKind('gate_number',     { label: 'Gate',                  scale: 'linear' });
  registerAxisQuantityKind('mag_nT',          { label: 'Magnetic Field (nT)',   scale: 'linear' });
  registerAxisQuantityKind('resistivity',     { label: 'Resistivity (Ωm)',        scale: 'log',    colorscale: 'turbo' });
  registerAxisQuantityKind('depth_m',         { label: 'Depth (m)',               scale: 'linear' });
}

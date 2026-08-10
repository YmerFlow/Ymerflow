import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Plot, DataGroup, LayerType, registerLayerType, registerAxisQuantityKind } from 'gladly-plot';
import { ProcessContext } from '../ProcessContext';
import { useWebSocket } from '../hooks/useWebSocket';
import { WS_API, getProcessLogs } from '../datamodel/api';

export const STATUS_TAG = '##STATUS##';

registerAxisQuantityKind('progress_step',  { label: 'Step',  scale: 'linear' });
registerAxisQuantityKind('progress_value', { label: 'Value', scale: 'linear' });

const LINE_COLOR = [0.122, 0.471, 0.706]; // blue

// WeakMap avoids any dependency on plot._rawData internals.
// Data is stored here before plot.update() is called so createLayer can read it.
const _progressDataCache = new WeakMap();

registerLayerType('ProgressLinePlot', new LayerType({
  name: 'ProgressLinePlot',

  getAxisConfig: () => ({
    xAxis: 'xaxis_bottom',
    xAxisQuantityKind: 'progress_step',
    yAxis: 'yaxis_left',
    yAxisQuantityKind: 'progress_value',
  }),

  vert: `#version 300 es
    precision mediump float;
    in float x, y, r, g, b;
    out vec3 vColor;
    void main() {
      gl_Position = plot_pos(vec2(x, y));
      vColor = vec3(r, g, b);
    }
  `,

  frag: `#version 300 es
    precision mediump float;
    in vec3 vColor;
    void main() { fragColor = gladly_apply_color(vec4(vColor, 1.0)); }
  `,

  schema: () => ({
    type: 'object',
    properties: {
      column: { type: 'string', title: 'Column' },
    },
    required: ['column'],
  }),

  createLayer: function(regl, parameters, data, plot) {
    const pd = plot ? _progressDataCache.get(plot) : null;
    const y = pd?.[parameters.column];
    const x = pd?._x;
    if (!y || !x || y.length === 0) return [];

    const n = y.length;
    const [cr, cg, cb] = LINE_COLOR;
    const r = new Float32Array(n).fill(cr);
    const g = new Float32Array(n).fill(cg);
    const b = new Float32Array(n).fill(cb);

    return [{ attributes: { x, y, r, g, b }, uniforms: { pointSize: 1.0 }, primitive: 'line strip' }];
  },
}));

function extractStatusEntry(logEntry) {
  const msg = logEntry.message || '';
  const idx = msg.indexOf(STATUS_TAG);
  if (idx === -1) return null;
  try {
    return JSON.parse(msg.slice(idx + STATUS_TAG.length).trim());
  } catch {
    return null;
  }
}

function ProcessProgress() {
  const { activeProcess, processes, currentProject } = useContext(ProcessContext);
  const [plotData, setPlotData]                 = useState([]);
  const [state, setState]                       = useState(null);
  const [shouldStreamLogs, setShouldStreamLogs] = useState(false);
  const [selectedKey, setSelectedKey]           = useState(null);

  const containerRef    = useRef(null);
  const plotRef         = useRef(null);
  const lastDomainKeyRef = useRef(null);

  const processId = activeProcess?.processId;
  const version   = activeProcess?.version;

  const allKeys = useMemo(() => {
    const keySet = new Set();
    plotData.forEach(d =>
      Object.entries(d).forEach(([k, v]) => { if (typeof v === 'number') keySet.add(k); })
    );
    return [...keySet];
  }, [plotData]);

  // Auto-select first key when data first arrives or selected key disappears.
  useEffect(() => {
    if (allKeys.length > 0 && (!selectedKey || !allKeys.includes(selectedKey))) {
      setSelectedKey(allKeys[0]);
    }
  }, [allKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create / destroy the Plot instance once (lives for the widget's lifetime).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const plot = new Plot(container, { margin: { top: 20, right: 80, bottom: 40, left: 80 } });
    plotRef.current = plot;
    return () => {
      _progressDataCache.delete(plot);
      plot.destroy();
      plotRef.current = null;
    };
  }, []);

  // Load logs when the active process / version changes.
  useEffect(() => {
    if (!processId || version === null || version === undefined) {
      setPlotData([]); setState(null); setShouldStreamLogs(false); return;
    }
    const proc = processes.find(p => p.id === processId);
    if (!proc) { setPlotData([]); setState(null); setShouldStreamLogs(false); return; }

    const versionObj = proc.versions.find(v => v.version === version);
    if (!versionObj) { setPlotData([]); setState(null); setShouldStreamLogs(false); return; }

    setState(versionObj.state);
    setPlotData([]);
    lastDomainKeyRef.current = null;

    const shouldStream = versionObj.state === 'running' || versionObj.state === 'queued';
    setShouldStreamLogs(shouldStream);

    if (!shouldStream) {
      getProcessLogs(processId, version, currentProject)
        .then(data => {
          if (Array.isArray(data)) setPlotData(data.map(extractStatusEntry).filter(Boolean));
        })
        .catch(err => console.error('ProcessProgress: failed to fetch logs:', err));
    }
  }, [processId, version, processes, currentProject]);

  // Stream live logs while the process is running.
  useWebSocket(
    processId && version !== null && version !== undefined
      ? `${WS_API}/ws/process/${processId}/logs?version=${version}`
      : null,
    {
      enabled: shouldStreamLogs && !!processId && version !== null && version !== undefined,
      name: `Process Progress (${processId}/${version})`,
      onMessage: (logEntry) => {
        const entry = extractStatusEntry(logEntry);
        if (entry) setPlotData(prev => [...prev, entry]);
      },
    }
  );

  // Rebuild the gladly plot whenever the selected key or underlying data changes.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;

    if (plotData.length === 0 || !selectedKey) {
      _progressDataCache.delete(plot);
      plot.update({ data: new DataGroup({}), config: { layers: [], axes: {} } })
        .catch(err => console.error('ProcessProgress: plot.update (empty):', err));
      return;
    }

    const n = plotData.length;
    const yArr = Float32Array.from({ length: n }, (_, i) => plotData[i][selectedKey] ?? 0);
    const pd = {
      _x: Float32Array.from({ length: n }, (_, i) => i),
      [selectedKey]: yArr,
    };
    _progressDataCache.set(plot, pd);

    const isKeyChange = selectedKey !== lastDomainKeyRef.current;
    if (isKeyChange) lastDomainKeyRef.current = selectedKey;

    let axesConfig = {};
    if (isKeyChange) {
      // Compute y bounds only when switching keys so the axis fits the new variable.
      let yMin = yArr[0], yMax = yArr[0];
      for (let i = 1; i < n; i++) {
        if (yArr[i] < yMin) yMin = yArr[i];
        if (yArr[i] > yMax) yMax = yArr[i];
      }
      const yRange = yMax - yMin;
      const yPad = yRange > 0 ? yRange * 0.05 : (Math.abs(yMax) * 0.1 || 1);
      axesConfig = {
        xaxis_bottom: { domain: [0, Math.max(n - 1, 1)] },
        yaxis_left:   { domain: [yMin - yPad, yMax + yPad] },
      };
    }

    plot.update({
      data: new DataGroup({}),
      config: {
        layers: [{ ProgressLinePlot: { column: selectedKey } }],
        axes: axesConfig,
      },
    }).catch(err => console.error('ProcessProgress: plot.update:', err));
  }, [plotData, selectedKey]);

  if (!activeProcess) {
    return (
      <div className="p-3 text-center text-muted">
        <p>No process selected</p>
        <small>Select a process from the flow view to see progress plots</small>
      </div>
    );
  }

  const stateBadge = state && {
    queued:  <span className="badge bg-secondary">Queued</span>,
    running: <span className="badge bg-primary">Running</span>,
    done:    <span className="badge bg-success">Done</span>,
    failed:  <span className="badge bg-danger">Failed</span>,
  }[state];

  return (
    <div className="d-flex flex-column h-100">
      <div className="p-2 border-bottom d-flex justify-content-between align-items-center">
        <small className="text-muted">Process Progress</small>
        {stateBadge}
      </div>

      <div className="px-2 py-1 border-bottom" style={{ flexShrink: 0 }}>
        <select
          className="form-select form-select-sm"
          value={selectedKey || ''}
          onChange={e => setSelectedKey(e.target.value)}
          disabled={allKeys.length === 0}
        >
          {allKeys.length === 0
            ? <option value="">No data yet</option>
            : allKeys.map(key => <option key={key} value={key}>{key}</option>)
          }
        </select>
      </div>

      <div className="flex-grow-1" style={{ position: 'relative', minHeight: 0 }}>
        {/* Canvas is always in the DOM so plotRef stays stable */}
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {plotData.length === 0 && (
          <div
            className="d-flex align-items-center justify-content-center text-muted"
            style={{ position: 'absolute', inset: 0, background: '#f8f9fa' }}
          >
            {state === 'queued' ? 'Waiting for process to start…' : 'No progress data yet'}
          </div>
        )}
      </div>
    </div>
  );
}

ProcessProgress.title = 'Process Progress';

export default ProcessProgress;

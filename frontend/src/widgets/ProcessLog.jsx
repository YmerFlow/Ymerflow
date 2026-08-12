import React, { useContext, useEffect, useRef, useState } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useWebSocket } from '../hooks/useWebSocket';
import { WS_API, getProcessLogs } from '../datamodel/api';

function ProcessLog() {
  const { activeProcess, processes, currentProject } = useContext(ProcessContext);
  const [logs, setLogs] = useState({}); // Changed to object keyed by timestamp
  const [state, setState] = useState(null);
  const [shouldStreamLogs, setShouldStreamLogs] = useState(false);
  const logContainerRef = useRef(null);

  // Extract processId and version from activeProcess for stable dependencies
  const processId = activeProcess?.processId;
  const version = activeProcess?.version;

  // Auto-scroll to bottom when new logs arrive, but only if user was already at bottom
  const isUserAtBottomRef = useRef(true);

  useEffect(() => {
    if (logContainerRef.current && isUserAtBottomRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Track if user is at the bottom of the log view
  const handleScroll = () => {
    if (logContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
      // Consider "at bottom" if within 50px of the bottom
      isUserAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
    }
  };

  // Fetch process state and determine if we should stream logs
  // Only depend on processId and version, NOT the entire processes array
  useEffect(() => {
    if (!processId || version === null || version === undefined) {
      setLogs({});
      setState(null);
      setShouldStreamLogs(false);
      return;
    }

    // Find process and version state
    const process = processes.find(p => p.id === processId);
    if (!process) {
      setLogs({});
      setState(null);
      setShouldStreamLogs(false);
      return;
    }

    const versionObj = process.versions.find(v => v.version === version);
    if (!versionObj) {
      setLogs({});
      setState(null);
      setShouldStreamLogs(false);
      return;
    }

    setState(versionObj.state);

    // Clear logs when switching to a new process/version
    setLogs({});

    // Determine if we should stream logs via WebSocket
    const shouldStream = versionObj.state === 'running' || versionObj.state === 'queued';
    setShouldStreamLogs(shouldStream);

    // If not streaming, fetch logs via REST API
    if (!shouldStream) {
      getProcessLogs(processId, version, currentProject)
        .then(data => {
          if (Array.isArray(data)) {
            // Convert array to object keyed by timestamp
            const logsObj = {};
            data.forEach(log => {
              logsObj[log.timestamp] = log;
            });
            setLogs(logsObj);
          } else {
            setLogs({});
          }
        })
        .catch(err => {
          console.error('Failed to fetch logs:', err);
          setLogs({});
        });
    }
  }, [processId, version, processes, currentProject]); // Only depend on processId, version, processes, currentProject

  // WebSocket for live log streaming with auto-reconnect
  useWebSocket(
    processId && version !== null && version !== undefined
      ? `${WS_API}/ws/process/${processId}/logs?version=${version}`
      : null,
    {
      enabled: shouldStreamLogs && !!processId && version !== null && version !== undefined,
      name: `Process Logs (${processId}/${version})`,
      onMessage: (logEntry) => {
        setLogs(prev => {
          // Only create new object if this is actually a new log entry
          if (prev[logEntry.timestamp]) {
            return prev; // Already have this log entry, don't trigger re-render
          }
          return {
            ...prev,
            [logEntry.timestamp]: logEntry
          };
        });
      }
    }
  );

  if (!activeProcess) {
    return (
      <div className="p-3 text-center text-muted">
        <p>No process selected</p>
        <small>Select a process from the flow view to see its logs</small>
      </div>
    );
  }

  const getStateBadge = () => {
    if (!state) return null;

    const badges = {
      queued: <span className="badge bg-secondary">Queued</span>,
      running: <span className="badge bg-primary">Running</span>,
      done: <span className="badge bg-success">Done</span>,
      failed: <span className="badge bg-danger">Failed</span>
    };

    return badges[state] || null;
  };

  return (
    <div className="d-flex flex-column h-100">
      <div className="p-2 border-bottom d-flex justify-content-between align-items-center">
        <small className="text-muted">Process Logs</small>
        {getStateBadge()}
      </div>
      <div
        ref={logContainerRef}
        className="flex-grow-1 overflow-auto p-3"
        onScroll={handleScroll}
        style={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          backgroundColor: '#f8f9fa'
        }}
      >
        {!logs || Object.keys(logs).length === 0 ? (
          <div className="text-muted text-center">
            {state === 'queued' ? 'Waiting for process to start...' : 'No logs available'}
          </div>
        ) : (
          Object.values(logs)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
            .map((log) => (
              <div key={log.timestamp} className="mb-1">
                <span className="text-muted me-2">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span>{log.message}</span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

ProcessLog.title = "Process Log";

export default ProcessLog;

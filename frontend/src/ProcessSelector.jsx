import React, { useContext, useState, useEffect, useRef } from 'react';
import { ProcessContext } from './ProcessContext';

export default function ProcessSelector() {
  const {
    processes,
    activeProcess,
    setActiveProcess,
    currentPart,
    setCurrentPart,
    currentProject
  } = useContext(ProcessContext);

  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [availableParts, setAvailableParts] = useState(['all']);
  const dropdownRef = useRef(null);

  // Get current process object
  const currentProcess = activeProcess
    ? processes.find(p => p.id === activeProcess.processId)
    : null;

  // Get available versions for current process
  const availableVersions = currentProcess?.versions || [];

  // Filter processes by search term
  const filteredProcesses = processes.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Update display name when active process changes
  useEffect(() => {
    if (currentProcess) {
      setSearchTerm(currentProcess.name);
    } else {
      setSearchTerm('');
    }
  }, [currentProcess]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch available parts from process outputs
  useEffect(() => {
    const fetchParts = async () => {
      if (!currentProcess || !activeProcess?.version) {
        setAvailableParts(['all']);
        return;
      }

      // Find outputs for selected version
      const versionData = currentProcess.versions?.find(v => v.version === activeProcess.version);
      if (!versionData?.outputs) {
        setAvailableParts(['all']);
        return;
      }

      // Fetch parts from all datasets
      const parts = new Set(['all']);

      for (const datasetUrl of Object.values(versionData.outputs)) {
        try {
          // The dataset id is the URL's last path segment (works for both the
          // /projects/{project_id}/dataset/{id} metadata URL and the /files/.../datasets/{id}/...
          // storage URL format).
          const datasetId = datasetUrl.includes('/datasets/')
            ? datasetUrl.match(/\/datasets\/([^/]+)\//)?.[1]
            : datasetUrl.split('/').pop();
          if (!datasetId) continue;

          const { loadDataset } = await import('./datamodel/dataset');
          const datasetObj = await loadDataset(datasetId, currentProject);
          const datasetParts = datasetObj.getParts();
          datasetParts.forEach(part => parts.add(part));
        } catch (error) {
          console.error('Failed to load parts:', error);
        }
      }

      setAvailableParts(Array.from(parts));
    };

    fetchParts();
  }, [currentProcess, activeProcess?.version, currentProject]);

  const handleProcessSelect = (process) => {
    const latestVersion = process.versions?.[process.versions.length - 1]?.version;
    setActiveProcess({
      processId: process.id,
      version: latestVersion || 0
    });
    setSearchTerm(process.name);
    setShowDropdown(false);
  };

  const handleVersionChange = (e) => {
    if (activeProcess) {
      setActiveProcess({
        ...activeProcess,
        version: parseInt(e.target.value)
      });
    }
  };

  return (
    <div className="d-flex align-items-center gap-2 px-2">
      {/* Process search/select */}
      <div className="position-relative" ref={dropdownRef}>
        <input
          type="text"
          className="form-control form-control-sm"
          placeholder="Search process..."
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          style={{ width: '200px' }}
        />
        {showDropdown && filteredProcesses.length > 0 && (
          <div
            className="dropdown-menu show"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              maxHeight: '300px',
              overflowY: 'auto',
              width: '100%'
            }}
          >
            {filteredProcesses.map(process => (
              <button
                key={process.id}
                className="dropdown-item"
                onClick={() => handleProcessSelect(process)}
              >
                {process.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Version selector */}
      <label className="form-label mb-0 text-white-50" style={{ fontSize: '0.875rem' }}>
        Version:
      </label>
      <select
        className="form-select form-select-sm"
        value={activeProcess?.version || 0}
        onChange={handleVersionChange}
        style={{ width: 'auto', minWidth: '80px' }}
      >
        {availableVersions.map(v => (
          <option key={v.version} value={v.version}>
            v{v.version}
          </option>
        ))}
      </select>

      {/* Part selector */}
      <label className="form-label mb-0 text-white-50" style={{ fontSize: '0.875rem' }}>
        Part:
      </label>
      <select
        className="form-select form-select-sm"
        value={currentPart}
        onChange={(e) => setCurrentPart(e.target.value)}
        style={{ width: 'auto', minWidth: '120px' }}
      >
        {availableParts.map(part => (
          <option key={part} value={part}>{part}</option>
        ))}
      </select>
    </div>
  );
}

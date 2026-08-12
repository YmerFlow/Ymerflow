import React, { useContext, useState, useEffect } from 'react';
import { ProcessContext } from '../ProcessContext';
import { Collapse } from 'react-bootstrap';
import { getDataset } from '../datamodel/api';

export default function Export() {
  const { activeProcess, processes, currentProject } = useContext(ProcessContext);
  const [expandedNodes, setExpandedNodes] = useState({});
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(false);

  const toggleNode = (nodeId) => {
    setExpandedNodes(prev => ({
      ...prev,
      [nodeId]: !prev[nodeId]
    }));
  };

  // Fetch datasets from process.versions[x].outputs
  useEffect(() => {
    const fetchDatasets = async () => {
      if (!activeProcess || !processes || processes.length === 0) return;

      const process = processes.find(p => p.id === activeProcess.processId);
      if (!process) return;

      const versionObj = process.versions?.find(v => v.version === activeProcess.version);
      if (!versionObj?.outputs) {
        setDatasets([]);
        return;
      }

      setLoading(true);
      try {
        const datasetPromises = Object.entries(versionObj.outputs).map(async ([name, url]) => {
          // Extract dataset ID from URL
          const datasetId = url.split('/').pop();
          try {
            const dataset = await getDataset(datasetId, currentProject);
            return dataset;
          } catch (error) {
            console.error(`Failed to fetch dataset ${datasetId}:`, error);
            return null;
          }
        });

        const results = await Promise.all(datasetPromises);
        setDatasets(results.filter(ds => ds !== null));
      } catch (error) {
        console.error('Failed to fetch datasets:', error);
        setDatasets([]);
      } finally {
        setLoading(false);
      }
    };

    fetchDatasets();
  }, [activeProcess, processes, currentProject]);

  if (!activeProcess) {
    return (
      <div className="p-3">
        <p className="text-muted">No process selected. Select a process to view its datasets.</p>
      </div>
    );
  }

  const process = activeProcess ? processes.find(p => p.id === activeProcess.processId) : null;

  if (!process) {
    return (
      <div className="p-3">
        <p className="text-muted">Process not found.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-3">
        <h5>{process.name} (v{activeProcess.version})</h5>
        <p className="text-muted">Loading datasets...</p>
      </div>
    );
  }

  if (!datasets || datasets.length === 0) {
    return (
      <div className="p-3">
        <h5>{process.name} (v{activeProcess.version})</h5>
        <p className="text-muted">No datasets available for this process.</p>
      </div>
    );
  }

  return (
    <div className="p-3">
      <h5>{process.name} (v{activeProcess.version})</h5>
      <div className="mt-3">
        {datasets.map(dataset => (
          <DatasetNode
            key={dataset.id}
            dataset={dataset}
            expandedNodes={expandedNodes}
            toggleNode={toggleNode}
          />
        ))}
      </div>
    </div>
  );
}

function DatasetNode({ dataset, expandedNodes, toggleNode }) {
  const nodeId = `dataset-${dataset.id}`;
  const isExpanded = expandedNodes[nodeId];

  // Check if new format (has "files" and "parts" keys) or old format
  const isNewFormat = dataset.parts?.files !== undefined && dataset.parts?.parts !== undefined;
  const rootFiles = isNewFormat ? dataset.parts.files : (dataset.parts?.files || {});
  const childParts = isNewFormat ? dataset.parts.parts : dataset.parts;

  // Count total items (root files + parts)
  const rootFileCount = Object.keys(rootFiles || {}).length;
  const partCount = Object.keys(childParts || {}).filter(key => key !== 'files').length;
  const hasContent = rootFileCount > 0 || partCount > 0;

  return (
    <div className="mb-2">
      <div
        className="d-flex align-items-center"
        style={{ cursor: hasContent ? 'pointer' : 'default' }}
        onClick={() => hasContent && toggleNode(nodeId)}
      >
        {hasContent && (
          <i className={`fa fa-chevron-${isExpanded ? 'down' : 'right'} me-2`} style={{ width: '12px' }}></i>
        )}
        {!hasContent && <span style={{ width: '24px', display: 'inline-block' }}></span>}
        <strong>{dataset.dataset_name}</strong>
        <span className="ms-2 text-muted">
          ({dataset.mime_type})
        </span>
      </div>

      <Collapse in={isExpanded}>
        <div style={{ marginLeft: '24px' }}>
          {/* Root level files */}
          {rootFileCount > 0 && (
            <div className="mt-2">
              <div className="text-muted small mb-1">Root files:</div>
              {Object.entries(rootFiles).map(([mimeType, url]) => (
                <FileNode key={mimeType} mimeType={mimeType} url={url} />
              ))}
            </div>
          )}

          {/* Child parts */}
          {partCount > 0 && (
            <div className="mt-2">
              {Object.entries(childParts)
                .filter(([key]) => key !== 'files')
                .map(([partName, partData]) => (
                  <PartNode
                    key={partName}
                    partName={partName}
                    partData={partData}
                    parentId={nodeId}
                    expandedNodes={expandedNodes}
                    toggleNode={toggleNode}
                  />
                ))}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function PartNode({ partName, partData, parentId, expandedNodes, toggleNode }) {
  const nodeId = `${parentId}-part-${partName}`;
  const isExpanded = expandedNodes[nodeId];

  const files = partData.files || {};
  const childParts = partData.parts || {};

  const fileCount = Object.keys(files).length;
  const partCount = Object.keys(childParts).length;
  const hasContent = fileCount > 0 || partCount > 0;

  return (
    <div className="mb-2">
      <div
        className="d-flex align-items-center"
        style={{ cursor: hasContent ? 'pointer' : 'default' }}
        onClick={() => hasContent && toggleNode(nodeId)}
      >
        {hasContent && (
          <i className={`fa fa-chevron-${isExpanded ? 'down' : 'right'} me-2`} style={{ width: '12px' }}></i>
        )}
        {!hasContent && <span style={{ width: '24px', display: 'inline-block' }}></span>}
        <span className="text-primary">{partName}</span>
      </div>

      <Collapse in={isExpanded}>
        <div style={{ marginLeft: '24px' }}>
          {/* Files */}
          {fileCount > 0 && (
            <div className="mt-1">
              {Object.entries(files).map(([mimeType, url]) => (
                <FileNode key={mimeType} mimeType={mimeType} url={url} />
              ))}
            </div>
          )}

          {/* Child parts (recursive) */}
          {partCount > 0 && (
            <div className="mt-1">
              {Object.entries(childParts).map(([childPartName, childPartData]) => (
                <PartNode
                  key={childPartName}
                  partName={childPartName}
                  partData={childPartData}
                  parentId={nodeId}
                  expandedNodes={expandedNodes}
                  toggleNode={toggleNode}
                />
              ))}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function FileNode({ mimeType, url }) {
  return (
    <div className="ms-3 mb-1">
      <i className="fa fa-file-o me-2" style={{ width: '12px' }}></i>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-decoration-none">
        {mimeType}
      </a>
    </div>
  );
}

Export.title = "Export";

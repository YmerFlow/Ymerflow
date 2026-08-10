import React, { useState, useContext } from 'react';
import DatasetSelector from '../../jsoneditor/DatasetSelector';
import { loadDataset } from '../../datamodel/dataset';
import { XYZ } from '../../datamodel/libaarhusxyz';
import { packBinary } from 'msgpack-numpy-js';
import { ProcessContext } from '../../ProcessContext';

/**
 * Dialog for loading an existing XYZ resistivity model dataset
 */
function LoadModelDialog({ onClose, onLoad }) {
  const { currentProject } = useContext(ProcessContext);
  const [selectedDatasetUrl, setSelectedDatasetUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleLoad = async () => {
    if (!selectedDatasetUrl) {
      setError('Please select a dataset');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Extract dataset ID from URL - handle both old and new formats
      // Old format: http://localhost:8000/dataset/{id}
      // New format: http://localhost:8000/files/.../datasets/{id}/...
      let datasetId = null;

      // Try new format first
      let match = selectedDatasetUrl.match(/\/datasets\/([^/]+)\//);
      if (match) {
        datasetId = match[1];
      } else {
        // Try old format
        match = selectedDatasetUrl.match(/\/dataset\/([^/?]+)/);
        if (match) {
          datasetId = match[1];
        }
      }

      if (!datasetId) {
        throw new Error(`Invalid dataset URL format: ${selectedDatasetUrl}`);
      }

      // Load dataset
      const dataset = await loadDataset(datasetId, currentProject);
      const xyzData = await dataset.fetchData('all');

      if (!xyzData || !xyzData.flightlines || !xyzData.layer_data) {
        throw new Error('Invalid XYZ dataset - missing required data');
      }

      // Create XYZ object from loaded data
      const xyz = new XYZ(packBinary(xyzData));

      // Extract source process info from dataset metadata
      const sourceProcessInfo = {
        id: dataset.metadata.process_id,
        name: dataset.metadata.process_name,
        type: dataset.metadata.process_type
      };

      console.log('Loaded from process:', sourceProcessInfo);
      console.log('Loaded model_info:', xyzData.model_info);

      onLoad(xyz, sourceProcessInfo);
      onClose();
    } catch (err) {
      console.error('Failed to load model:', err);
      setError(err.message || 'Failed to load dataset');
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: 'white',
        padding: '20px',
        borderRadius: '8px',
        maxWidth: '500px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto'
      }}>
        <h2>Load AEM Model</h2>
        <p style={{ color: '#6c757d', fontSize: '14px' }}>
          Select a resistivity model dataset (XYZ format) to load and edit.
        </p>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
            Dataset
          </label>
          <DatasetSelector
            value={selectedDatasetUrl}
            onChange={setSelectedDatasetUrl}
          />
        </div>

        {error && (
          <div style={{
            padding: '10px',
            marginBottom: '15px',
            backgroundColor: '#f8d7da',
            color: '#721c24',
            borderRadius: '4px',
            fontSize: '14px'
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button
            onClick={handleLoad}
            disabled={loading}
            style={{
              padding: '8px 16px',
              backgroundColor: loading ? '#6c757d' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? 'Loading...' : 'Load'}
          </button>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoadModelDialog;

import React, { useState, useContext } from 'react';
import { ProcessContext } from '../../ProcessContext';
import { uploadFile } from '../../datamodel/api';
import { useCreateSystem, queryKeys } from '../../datamodel/useQueries';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Minimal dialog to add a project-scoped survey system by uploading a .gex file.
 * On success, calls onCreate(newSystemId) so the caller can pre-select it.
 */
function AddSystemDialog({ onClose, onCreate }) {
  const { currentProject } = useContext(ProcessContext);
  const queryClient = useQueryClient();
  const createSystem = useCreateSystem();

  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    // Default the name to the filename minus extension, if the user hasn't typed one.
    if (!name.trim()) {
      setName(f.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleSubmit = async () => {
    if (!file) {
      setError('Please choose a .gex file');
      return;
    }
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }

    setBusy(true);
    setError(null);
    setUploadProgress(0);

    try {
      const uploadResp = await uploadFile(file, (p) => setUploadProgress(p), currentProject);
      const newSystem = await createSystem.mutateAsync({
        projectId: currentProject,
        name: name.trim(),
        uploadId: uploadResp.id,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.systems(currentProject) });
      onCreate(newSystem.id);
      onClose();
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || 'Failed to add system';
      setError(msg);
      setBusy(false);
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
      zIndex: 1100
    }}>
      <div style={{
        backgroundColor: 'white',
        padding: '20px',
        borderRadius: '8px',
        maxWidth: '450px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto'
      }}>
        <h2>Add Survey System</h2>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '14px' }}>
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Survey system name"
            disabled={busy}
            style={{ width: '100%', padding: '8px', border: '1px solid #ced4da', borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '14px' }}>
            GEX file
          </label>
          <input
            type="file"
            accept=".gex"
            onChange={handleFileChange}
            disabled={busy}
            style={{ width: '100%', fontSize: '14px' }}
          />
        </div>

        {busy && (
          <div style={{ marginBottom: '15px' }}>
            <div style={{ height: '8px', backgroundColor: '#e9ecef', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${uploadProgress}%`, backgroundColor: '#28a745', transition: 'width 0.2s' }} />
            </div>
            <small style={{ color: '#6c757d' }}>
              {uploadProgress < 100 ? `Uploading… ${Math.round(uploadProgress)}%` : 'Parsing…'}
            </small>
          </div>
        )}

        {error && (
          <div style={{ marginBottom: '15px', color: '#dc3545', fontSize: '14px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            style={{
              padding: '8px 16px',
              backgroundColor: busy ? '#6c757d' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            Add
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddSystemDialog;

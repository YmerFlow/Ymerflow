import React, { useState, useContext } from 'react';
import { ProcessContext } from '../../ProcessContext';
import { uploadFile } from '../../datamodel/api';
import { useCreateProcess } from '../../datamodel/useQueries';
import { XYZ } from '../../datamodel/libaarhusxyz';

/**
 * Dialog for saving model to backend as a process
 */
function SaveModelDialog({ onClose, flightlines, sourceProcess }) {
  const {
    environments,
    currentProject,
    selectedEnvironment,
    setSelectedEnvironment,
    setActiveProcess,
    processes,
    invalidateProject
  } = useContext(ProcessContext);

  // For updates, get the full process object to extract environment
  const fullSourceProcess = sourceProcess
    ? processes.find(p => p.id === sourceProcess.id)
    : null;

  const isUpdate = !!sourceProcess;

  const [processName, setProcessName] = useState(
    sourceProcess ? sourceProcess.name : ''
  );
  const [environment, setEnvironment] = useState(
    fullSourceProcess?.environment?.id || selectedEnvironment || ''
  );
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  const createProcessMutation = useCreateProcess();

  const handleSave = async () => {
    if (!processName.trim()) {
      setError('Please enter a process name');
      return;
    }

    if (!environment) {
      setError('Please select an environment');
      return;
    }

    // If updating existing process, always use its project_id
    // Otherwise use current project for new process
    const projectId = fullSourceProcess?.project_id || currentProject;

    if (!projectId) {
      setError('No project selected');
      return;
    }

    setSaving(true);
    setError(null);
    setProgress(0);

    try {
      // Step 1: Merge XYZ objects and generate msgpack file (10%)
      setProgress(10);
      const { binary, filename } = generateMsgpackFile(flightlines);

      // Step 2: Create File object for upload (20%)
      setProgress(20);
      const file = new File([binary], filename, { type: 'application/octet-stream' });

      // Step 3: Upload file (20% -> 70%)
      setProgress(20);
      const uploadResult = await uploadFile(file, (uploadProgress) => {
        setProgress(20 + (uploadProgress * 0.5)); // 20% to 70%
      }, projectId);

      const fileUrl = uploadResult.url;

      // Step 4: Create process (80%)
      setProgress(80);

      // Check if we're updating an existing process
      const isUpdate = sourceProcess && sourceProcess.type === 'import_ymerflow_aem';

      const proc = {
        name: processName,
        type: 'import_ymerflow_aem',
        environment: { id: environment },
        params: {
          msgpack_file: fileUrl
        },
        resource_requests: {
          cpu: '1000m',
          memory: '2Gi',
          'ephemeral-storage': '10Gi'
        },
        deadline_seconds: 10 * 60
      };

      // If updating, add the id to create a new version
      if (isUpdate) {
        proc.id = sourceProcess.id;
      }

      setProgress(90);
      const createdProcess = await createProcessMutation.mutateAsync({
        proc,
        projectId: projectId
      });

      // Step 5: Invalidate cache to update UI (95%)
      setProgress(95);
      // Use centralized invalidation helper - THE ONLY way to invalidate
      await invalidateProject(projectId);

      // Update selected environment if it changed
      if (environment !== selectedEnvironment) {
        setSelectedEnvironment(environment);
      }

      // Set the newly created/updated process as active
      const latestVersion = Math.max(...createdProcess.versions.map(v => v.version));
      setActiveProcess({
        processId: createdProcess.id,
        version: latestVersion
      });

      setProgress(100);
      onClose();

    } catch (err) {
      console.error('Failed to save model:', err);
      setError(err.message || 'Failed to save model');
      setSaving(false);
      setProgress(0);
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
        <h2>{isUpdate ? 'Update Model' : 'Save New Model'}</h2>
        <p style={{ color: '#6c757d', fontSize: '14px', marginBottom: '20px' }}>
          {isUpdate
            ? `Creating new version of process "${sourceProcess.name}"`
            : 'Create a new import process with this model'
          }
        </p>

        {isUpdate ? (
          // When updating: show read-only info
          <>
            <div style={{
              marginBottom: '15px',
              padding: '12px',
              backgroundColor: '#e7f3ff',
              borderRadius: '4px',
              border: '1px solid #b3d9ff'
            }}>
              <div style={{ marginBottom: '8px' }}>
                <strong>Process:</strong> {sourceProcess.name}
              </div>
              <div>
                <strong>Environment:</strong>{' '}
                {environments.find(e => e.id === environment)?.name || 'Unknown'}
              </div>
            </div>
          </>
        ) : (
          // When creating new: show input fields
          <>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                Process Name <span style={{ color: '#dc3545' }}>*</span>
              </label>
              <input
                type="text"
                value={processName}
                onChange={(e) => setProcessName(e.target.value)}
                disabled={saving}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid #ced4da',
                  fontSize: '14px'
                }}
                placeholder="Enter process name (e.g., my_model)"
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                Environment <span style={{ color: '#dc3545' }}>*</span>
              </label>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                disabled={saving}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid #ced4da',
                  fontSize: '14px'
                }}
              >
                <option value="">Select environment...</option>
                {environments.map(env => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {saving && (
          <div style={{ marginBottom: '15px' }}>
            <div style={{
              width: '100%',
              height: '20px',
              backgroundColor: '#e9ecef',
              borderRadius: '10px',
              overflow: 'hidden'
            }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                backgroundColor: '#007bff',
                transition: 'width 0.3s ease'
              }} />
            </div>
            <p style={{ fontSize: '12px', color: '#6c757d', marginTop: '5px', textAlign: 'center' }}>
              {progress < 20 ? 'Generating msgpack...' :
               progress < 70 ? 'Uploading file...' :
               progress < 100 ? 'Creating process...' :
               'Complete!'}
            </p>
          </div>
        )}

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
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '8px 16px',
              backgroundColor: saving ? '#6c757d' : (isUpdate ? '#28a745' : '#007bff'),
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: saving ? 'not-allowed' : 'pointer'
            }}
          >
            {saving ? 'Saving...' : (isUpdate ? 'Create New Version' : 'Create Process')}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: saving ? 'not-allowed' : 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Generate msgpack file from XYZ flightlines
 * Returns { binary, filename }
 */
function generateMsgpackFile(flightlines) {
  // Merge all XYZ objects into one
  const mergedXyz = new XYZ(...flightlines);

  // Export to msgpack binary
  const binary = mergedXyz.dump();

  // Generate filename
  const timestamp = Date.now();
  const filename = `nagelfluh_model_${timestamp}.msgpack`;

  return { binary, filename };
}

export default SaveModelDialog;

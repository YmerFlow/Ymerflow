import React, { useContext, useEffect, useState } from 'react';
import { Modal, Button, Form, ProgressBar, Alert } from 'react-bootstrap';
import { ProcessContext } from './ProcessContext';
import { uploadFile } from './datamodel/api';
import { useImportProject, useProjectImport } from './datamodel/useQueries';

const STATE_LABEL = {
  queued: 'Queued…',
  running: 'Importing…',
  done: 'Done',
  failed: 'Failed',
};

function ProjectImportModal({ show, onHide, onImported }) {
  const { currentProject } = useContext(ProcessContext);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);
  const [importId, setImportId] = useState(null);

  const importMutation = useImportProject();
  const { data: importJob } = useProjectImport(importId);
  const state = importJob?.state;

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadError(null);
    setUploading(true);
    setUploadProgress(0);

    try {
      const uploadResult = await uploadFile(file, setUploadProgress, currentProject);
      setUploading(false);
      const result = await importMutation.mutateAsync(uploadResult.id);
      setImportId(result.id);
    } catch (error) {
      setUploading(false);
      setUploadError(error.response?.data?.detail || error.message || 'Import failed');
    }
  };

  useEffect(() => {
    if (state === 'done' && importJob.project_id) {
      onImported(importJob.project_id);
    }
  }, [state, importJob, onImported]);

  const handleHide = () => {
    setImportId(null);
    setUploadError(null);
    setUploadProgress(0);
    importMutation.reset();
    onHide();
  };

  const busy = uploading || (!!state && state !== 'done' && state !== 'failed');

  return (
    <Modal show={show} onHide={handleHide}>
      <Modal.Header closeButton>
        <Modal.Title>Import Project</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          Choose a project export zip. It's imported as a brand-new project — you'll be its
          sole member, and can invite others afterward.
        </p>

        <Form.Group>
          <Form.Control type="file" accept=".zip" onChange={handleFileChange} disabled={busy} />
        </Form.Group>

        {uploading && (
          <ProgressBar now={uploadProgress} label={`${Math.round(uploadProgress)}%`} className="mt-2" />
        )}

        {uploadError && (
          <Alert variant="danger" className="mt-2">
            {uploadError}
          </Alert>
        )}

        {state && state !== 'failed' && (
          <ProgressBar
            animated={state !== 'done'}
            now={state === 'done' ? 100 : state === 'running' ? 66 : 15}
            className="mt-2"
            label={STATE_LABEL[state] || state}
          />
        )}

        {state === 'failed' && (
          <Alert variant="danger" className="mt-2">
            {importJob.error || 'Import failed'}
          </Alert>
        )}

        {state === 'done' && (
          <Alert variant="success" className="mt-2">
            Import complete.
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleHide}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default ProjectImportModal;

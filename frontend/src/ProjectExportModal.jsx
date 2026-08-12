import React, { useState } from 'react';
import { Modal, Button, ProgressBar, Alert } from 'react-bootstrap';
import { useExportProject, useProjectExport } from './datamodel/useQueries';

const STATE_LABEL = {
  queued: 'Queued…',
  running: 'Packing archive…',
  done: 'Ready',
  failed: 'Failed',
};

function ProjectExportModal({ show, onHide, projectId, projectName }) {
  const [exportId, setExportId] = useState(null);
  const exportMutation = useExportProject();
  const { data: exportJob } = useProjectExport(projectId, exportId);

  const state = exportJob?.state;

  const handleStart = async () => {
    try {
      const result = await exportMutation.mutateAsync(projectId);
      setExportId(result.id);
    } catch (error) {
      console.error('Failed to start project export:', error);
    }
  };

  const handleHide = () => {
    setExportId(null);
    exportMutation.reset();
    onHide();
  };

  return (
    <Modal show={show} onHide={handleHide}>
      <Modal.Header closeButton>
        <Modal.Title>Export Project</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          Pack <strong>{projectName}</strong> (processes, versions, output datasets, uploads, and
          tags) into a downloadable zip archive.
        </p>

        {exportMutation.isError && (
          <Alert variant="danger">
            {exportMutation.error?.response?.data?.detail || exportMutation.error?.message || 'Failed to start export'}
          </Alert>
        )}

        {state && state !== 'done' && (
          <ProgressBar
            animated={state === 'queued' || state === 'running'}
            now={state === 'running' ? 66 : state === 'queued' ? 15 : 100}
            variant={state === 'failed' ? 'danger' : 'primary'}
            label={STATE_LABEL[state] || state}
          />
        )}

        {state === 'failed' && (
          <Alert variant="danger" className="mt-2">
            {exportJob.error || 'Export failed'}
          </Alert>
        )}

        {state === 'done' && (
          <Alert variant="success" className="mt-2">
            Export ready.{' '}
            <a href={exportJob.download_url} download>
              Download export.zip
            </a>
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleHide}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={handleStart}
          disabled={exportMutation.isPending || (!!state && state !== 'done' && state !== 'failed')}
        >
          {state ? 'Restart Export' : 'Start Export'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default ProjectExportModal;

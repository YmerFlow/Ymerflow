import React, { useEffect, useRef, useState } from 'react';
import { Modal, Button, Form, ProgressBar, Alert } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { getProjects, uploadFile } from './datamodel/api';
import {
  queryKeys,
  useAvailableStorageBackends,
  useCreateProject,
  useImportProject,
  useProjectImport,
} from './datamodel/useQueries';

// Poll the projects list until the given project's storage is provisioned (or fails).
async function waitForStorageReady(projectId, { timeoutMs = 180000, intervalMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projects = await getProjects();
    const p = projects.find(x => x.id === projectId);
    if (p?.storage_status === 'ready') return;
    if (p?.storage_status === 'failed') {
      throw new Error('Storage provisioning failed for the new project.');
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for the new project’s storage to become ready.');
}

const PHASE_LABEL = {
  creating: 'Creating project…',
  provisioning: 'Provisioning storage…',
  importing: 'Importing…',
};

// Create Project dialog. Creates an empty project (name + storage backend), or — when an export
// zip is attached — creates the project, uploads the zip INTO it, and imports INTO that same
// project. The import never touches any other project; on failure the backend deletes the
// just-created project, rolling the whole action back.
function ProjectModal({ show, onHide, onCreated }) {
  const queryClient = useQueryClient();
  const { data: backends = [] } = useAvailableStorageBackends();
  const createProject = useCreateProject();
  const importProject = useImportProject();

  const [name, setName] = useState('');
  const [storageBackendId, setStorageBackendId] = useState(null);
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | creating | provisioning | uploading | importing
  const [uploadProgress, setUploadProgress] = useState(0);
  const [importId, setImportId] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const { data: importJob } = useProjectImport(importId);

  // Default to the first allowed backend once the list loads, if nothing selected yet
  // (or the previously-selected backend is no longer in the allowed set).
  useEffect(() => {
    if (backends.length > 0 && !backends.some(b => b.id === storageBackendId)) {
      setStorageBackendId(backends[0].id);
    }
  }, [backends, storageBackendId]);

  const reset = () => {
    setName('');
    setFile(null);
    setPhase('idle');
    setUploadProgress(0);
    setImportId(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // React to import job completion (polled by useProjectImport).
  useEffect(() => {
    if (!importJob) return;
    if (importJob.state === 'done' && importJob.project_id) {
      const newId = importJob.project_id;
      reset();
      onCreated(newId);
    } else if (importJob.state === 'failed') {
      // The backend deleted the target project — refresh the list so it doesn't linger.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setError(importJob.error || 'Import failed');
      setPhase('idle');
      setImportId(null);
    }
  }, [importJob]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase !== 'idle' || createProject.isPending;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !storageBackendId || busy) return;
    setError(null);

    try {
      if (!file) {
        const newProject = await createProject.mutateAsync({ name: name.trim(), storageBackendId });
        reset();
        onCreated(newProject.id);
        return;
      }

      // Import path: create the project, then seed it from the zip — all into the same project.
      setPhase('creating');
      const newProject = await createProject.mutateAsync({ name: name.trim(), storageBackendId });

      setPhase('provisioning');
      await waitForStorageReady(newProject.id);

      setPhase('uploading');
      setUploadProgress(0);
      const uploadResult = await uploadFile(file, setUploadProgress, newProject.id);

      setPhase('importing');
      const result = await importProject.mutateAsync({ projectId: newProject.id, uploadId: uploadResult.id });
      setImportId(result.id); // useProjectImport polls to completion
    } catch (err) {
      setError(err.response?.data?.detail || err.message || 'Failed to create project');
      setPhase('idle');
    }
  };

  const handleHide = () => {
    if (busy) return; // don't abandon an in-flight import
    reset();
    onHide();
  };

  return (
    <Modal show={show} onHide={handleHide} backdrop={busy ? 'static' : true}>
      <Modal.Header closeButton={!busy}>
        <Modal.Title>Create New Project</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form onSubmit={handleSubmit}>
          <Form.Group>
            <Form.Label>Project Name</Form.Label>
            <Form.Control
              type="text"
              placeholder="Enter project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={busy}
            />
          </Form.Group>

          <Form.Group className="mt-3">
            <Form.Label>Storage Backend</Form.Label>
            <Form.Select
              value={storageBackendId || ''}
              onChange={(e) => setStorageBackendId(e.target.value)}
              disabled={busy}
            >
              {backends.map(b => (
                <option key={b.id} value={b.id}>{b.name || b.protocol}</option>
              ))}
            </Form.Select>
          </Form.Group>

          <Form.Group className="mt-3">
            <Form.Label>
              Import from export <span className="text-muted">(optional)</span>
            </Form.Label>
            <Form.Control
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={(e) => setFile(e.target.files[0] || null)}
              disabled={busy}
            />
            <Form.Text className="text-muted">
              Seed the new project from a previously-exported project zip.
            </Form.Text>
          </Form.Group>

          {phase === 'uploading' ? (
            <ProgressBar
              className="mt-3"
              now={uploadProgress}
              label={`Uploading ${Math.round(uploadProgress)}%`}
            />
          ) : PHASE_LABEL[phase] ? (
            <ProgressBar className="mt-3" animated now={100} label={PHASE_LABEL[phase]} />
          ) : null}

          {error && <Alert variant="danger" className="mt-3">{error}</Alert>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleHide} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={busy || !name.trim() || !storageBackendId}>
          {file ? 'Create & Import' : 'Create'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default ProjectModal;

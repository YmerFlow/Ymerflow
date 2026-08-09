import React, { useState, useEffect } from 'react';
import { Modal, Button, Form } from 'react-bootstrap';
import { useAvailableStorageBackends } from './datamodel/useQueries';

function ProjectModal({ show, onHide, onSubmit }) {
  const [name, setName] = useState('');
  const [storageBackendId, setStorageBackendId] = useState(null);
  const { data: backends = [] } = useAvailableStorageBackends();

  // Default to the first allowed backend once the list loads, if nothing selected yet
  // (or the previously-selected backend is no longer in the allowed set).
  useEffect(() => {
    if (backends.length > 0 && !backends.some(b => b.id === storageBackendId)) {
      setStorageBackendId(backends[0].id);
    }
  }, [backends, storageBackendId]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (name.trim() && storageBackendId) {
      onSubmit(name.trim(), storageBackendId);
      setName('');
    }
  };

  const handleHide = () => {
    setName('');
    setStorageBackendId(null);
    onHide();
  };

  return (
    <Modal show={show} onHide={handleHide}>
      <Modal.Header closeButton>
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
            />
          </Form.Group>
          <Form.Group className="mt-3">
            <Form.Label>Storage Backend</Form.Label>
            <Form.Select
              value={storageBackendId || ''}
              onChange={(e) => setStorageBackendId(e.target.value)}
            >
              {backends.map(b => (
                <option key={b.id} value={b.id}>{b.name || b.protocol}</option>
              ))}
            </Form.Select>
          </Form.Group>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleHide}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!name.trim() || !storageBackendId}>
          Create
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default ProjectModal;

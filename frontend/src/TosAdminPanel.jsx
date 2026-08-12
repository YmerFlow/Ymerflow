import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Modal, Form, Alert, Row, Col } from 'react-bootstrap';
import Markdown from 'markdown-to-jsx';
import { useAdminTosVersions, useCreateAdminTosVersion } from './datamodel/useAuthQueries';

function CreateTosVersionModal({ show, onHide, previousBody }) {
  const createMutation = useCreateAdminTosVersion();
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);

  // Default the form to the previous version's text on every open, so an admin publishing a
  // small edit doesn't have to retype the whole document from scratch.
  useEffect(() => {
    if (!show) return;
    setBody(previousBody || '');
    setError(null);
  }, [show, previousBody]);

  const handleClose = () => {
    onHide();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await createMutation.mutateAsync({ body });
      handleClose();
    } catch (e) {
      setError(e?.response?.data?.detail || 'Save failed');
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="xl">
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title>Create New Terms of Service Version</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Row>
            <Col md={6}>
              <Form.Group>
                <Form.Label>Body (Markdown)</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={16}
                  required
                  value={body}
                  onChange={e => setBody(e.target.value)}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Label>Preview</Form.Label>
              <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #dee2e6', borderRadius: '0.375rem', padding: '0.75rem' }}>
                <Markdown>{body || '*Nothing to preview yet*'}</Markdown>
              </div>
            </Col>
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

export default function TosAdminPanel() {
  const { data: versions = [], isLoading } = useAdminTosVersions();
  const [showModal, setShowModal] = useState(false);

  if (isLoading) return <p className="text-muted">Loading...</p>;

  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <Card.Title className="mb-0">Terms of Service Versions</Card.Title>
          <Button size="sm" onClick={() => setShowModal(true)}>Create New Version</Button>
        </div>
        <Table size="sm" hover>
          <thead>
            <tr>
              <th>Version</th>
              <th>Created By</th>
              <th>Created At</th>
              <th>Body</th>
            </tr>
          </thead>
          <tbody>
            {versions.map(v => (
              <tr key={v.version}>
                <td>{v.version}</td>
                <td>{v.created_by_username || <span className="text-muted">—</span>}</td>
                <td>{new Date(v.created_at).toLocaleString()}</td>
                <td style={{ maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.body}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
      <CreateTosVersionModal show={showModal} onHide={() => setShowModal(false)} previousBody={versions[0]?.body} />
    </Card>
  );
}

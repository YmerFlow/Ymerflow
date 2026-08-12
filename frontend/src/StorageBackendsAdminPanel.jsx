import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Badge, Modal, Form, Alert, Spinner } from 'react-bootstrap';
import { hooks } from './plugins/hooks';
import {
  useAdminStorageBackends,
  useCreateAdminStorageBackend,
  useUpdateAdminStorageBackend,
  useTestAdminStorageBackendConnection,
} from './datamodel/useAuthQueries';

const EMPTY_FORM = {
  name: '',
  bucketPrefix: '',
  credentialStrategy: 'static-key',
  sortOrder: 0,
  active: true,
};

function StorageBackendFormModal({ show, onHide, backend }) {
  const protocolForms = hooks.run.storage_protocol_forms();
  const createMutation = useCreateAdminStorageBackend();
  const updateMutation = useUpdateAdminStorageBackend();
  const testMutation = useTestAdminStorageBackendConnection();

  const [form, setForm] = useState(EMPTY_FORM);
  const [protocol, setProtocol] = useState(protocolForms[0]?.type ?? '');
  const [config, setConfig] = useState({});
  const [configTouched, setConfigTouched] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const isEdit = !!backend;

  // Reset all form state on every open, so state from a previous edit/create never leaks in.
  // Secret fields in `config` come back from the server pre-filled with the "****" placeholder
  // for anything already set — never the real value (see docs/plans/storage-cluster-secret-masking.md).
  useEffect(() => {
    if (!show) return;
    if (backend) {
      setForm({
        name: backend.name,
        bucketPrefix: backend.bucket_prefix,
        credentialStrategy: backend.credential_strategy,
        sortOrder: backend.sort_order,
        active: backend.active,
      });
      setProtocol(backend.protocol);
      setConfig(backend.config || {});
    } else {
      setForm(EMPTY_FORM);
      setProtocol(protocolForms[0]?.type ?? '');
      setConfig({});
    }
    setConfigTouched(false);
    setError(null);
    setTestResult(null);
  }, [show, backend]);

  const activeProtocolForm = protocolForms.find(p => p.type === protocol);

  const handleProtocolChange = (type) => {
    setProtocol(type);
    setConfig({});
    setConfigTouched(true);
    setTestResult(null);
  };

  const handleConfigChange = (patch) => {
    setConfig(patch);
    setConfigTouched(true);
    setTestResult(null);
  };

  const handleTest = async () => {
    setError(null);
    setTestResult(null);
    try {
      await testMutation.mutateAsync({
        protocol, config,
        backend_id: backend?.id,
      });
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, message: e?.response?.data?.detail || 'Connection test failed' });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const body = {
      name: form.name,
      bucket_prefix: form.bucketPrefix,
      credential_strategy: form.credentialStrategy,
      sort_order: parseInt(form.sortOrder, 10) || 0,
    };
    if (isEdit) body.active = form.active;
    if (configTouched) {
      body.protocol = protocol;
      body.config = config;
    }

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({ backendId: backend.id, body });
      } else {
        await createMutation.mutateAsync(body);
      }
      onHide();
    } catch (e) {
      setError(e?.response?.data?.detail || 'Save failed');
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <Modal show={show} onHide={onHide}>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title>{isEdit ? 'Edit Storage Backend' : 'Add Storage Backend'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}

          <Form.Group className="mb-3">
            <Form.Label>Name</Form.Label>
            <Form.Control required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Bucket Prefix</Form.Label>
            <Form.Control required value={form.bucketPrefix} onChange={e => setForm(f => ({ ...f, bucketPrefix: e.target.value }))} />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Credential Strategy</Form.Label>
            <Form.Select
              value={form.credentialStrategy}
              onChange={e => setForm(f => ({ ...f, credentialStrategy: e.target.value }))}
            >
              <option value="static-key">Static key</option>
              <option value="short-lived">Short-lived</option>
            </Form.Select>
            {form.credentialStrategy === 'short-lived' && (
              <Alert variant="warning" className="mt-2 mb-0">
                Short-lived credential minting is not implemented for any protocol yet — jobs
                launched against a backend using this strategy will fail.
              </Alert>
            )}
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Sort Order</Form.Label>
            <Form.Control type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} />
          </Form.Group>
          {isEdit && (
            <Form.Group className="mb-3">
              <Form.Check
                type="checkbox"
                label="Active"
                checked={form.active}
                onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
              />
            </Form.Group>
          )}

          <hr />

          <Form.Group className="mb-3">
            <Form.Label>Protocol</Form.Label>
            <Form.Select value={protocol} onChange={e => handleProtocolChange(e.target.value)}>
              {protocolForms.map(p => <option key={p.type} value={p.type}>{p.title}</option>)}
            </Form.Select>
          </Form.Group>
          {activeProtocolForm && (
            <activeProtocolForm.Component
              value={config}
              onChange={handleConfigChange}
            />
          )}
          <div className="d-flex align-items-center gap-2">
            <Button variant="outline-secondary" size="sm" onClick={handleTest} disabled={testMutation.isPending}>
              {testMutation.isPending ? <Spinner size="sm" animation="border" /> : 'Test Connection'}
            </Button>
            {testResult?.ok && <span className="text-success">Connection OK</span>}
            {testResult && !testResult.ok && <span className="text-danger">{testResult.message}</span>}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

export default function StorageBackendsAdminPanel() {
  const { data: backends = [], isLoading } = useAdminStorageBackends();
  const [showModal, setShowModal] = useState(false);
  const [editingBackend, setEditingBackend] = useState(null);

  const openCreate = () => { setEditingBackend(null); setShowModal(true); };
  const openEdit = (backend) => { setEditingBackend(backend); setShowModal(true); };

  if (isLoading) return <p className="text-muted">Loading...</p>;

  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <Card.Title className="mb-0">Storage Backend Administration</Card.Title>
          <Button size="sm" onClick={openCreate}>Add Storage Backend</Button>
        </div>
        <Table size="sm" hover>
          <thead>
            <tr>
              <th>Name</th>
              <th>Protocol</th>
              <th>Endpoint</th>
              <th>Bucket Prefix</th>
              <th>Credential Strategy</th>
              <th>Sort Order</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {backends.map(b => (
              <tr key={b.id} className={b.active ? '' : 'text-muted'}>
                <td>{b.name}</td>
                <td>{b.protocol}</td>
                <td>{b.config?.endpoint || <span className="text-muted">—</span>}</td>
                <td>{b.bucket_prefix}</td>
                <td>{b.credential_strategy}</td>
                <td>{b.sort_order}</td>
                <td>{b.active ? <Badge bg="success">Active</Badge> : <Badge bg="secondary">Retired</Badge>}</td>
                <td>
                  <Button size="sm" variant="outline-primary" onClick={() => openEdit(b)}>Edit</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
      <StorageBackendFormModal show={showModal} onHide={() => setShowModal(false)} backend={editingBackend} />
    </Card>
  );
}

import React, { useState, useRef, useEffect, useContext } from 'react';
import { Modal, Tab, Tabs, Table, Button, Form, Spinner, Alert } from 'react-bootstrap';
import {
  useWorkspaces,
  usePublicWorkspaces,
  useUpdateWorkspace,
  useForkWorkspace,
} from './datamodel/useQueries';
import { ProcessContext } from './ProcessContext';

export default function WorkspaceSharingModal({ show, onHide, currentProject }) {
  return (
    <Modal show={show} onHide={onHide} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Workspaces</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Tabs defaultActiveKey="add" className="mb-3">
          <Tab eventKey="add" title="Add public workspaces">
            <AddPublicWorkspacesTab currentProject={currentProject} onAdded={onHide} />
          </Tab>
          <Tab eventKey="publish" title="Publish workspaces">
            <PublishWorkspacesTab currentProject={currentProject} />
          </Tab>
        </Tabs>
      </Modal.Body>
    </Modal>
  );
}

function AddPublicWorkspacesTab({ currentProject, onAdded }) {
  const { data: publicWorkspaces = [], isLoading } = usePublicWorkspaces();
  const forkWorkspace = useForkWorkspace(currentProject);
  const { setSelectedEnvironment } = useContext(ProcessContext);

  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selected, setSelected] = useState(null);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [error, setError] = useState(null);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = publicWorkspaces.filter(w =>
    w.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelect = (workspace) => {
    setSelected(workspace);
    const latest = workspace.versions?.[workspace.versions.length - 1]?.version ?? null;
    setSelectedVersion(latest);
    setSearchTerm(workspace.title);
    setShowDropdown(false);
    setError(null);
  };

  const handleAdd = async () => {
    if (!selected) return;
    setError(null);
    try {
      await forkWorkspace.mutateAsync({ workspaceId: selected.id, version: selectedVersion });
      setSelected(null);
      setSelectedVersion(null);
      setSearchTerm('');
      if (onAdded) onAdded();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  // Just navigate to it — no mutation, no new workspace created. The only way today to reach
  // an unowned public workspace without forking is to already have its URL; this is the
  // discoverable in-app path to the same thing.
  const handleView = () => {
    if (!selected) return;
    setSelectedEnvironment(selected.id, selectedVersion);
    if (onAdded) onAdded();
  };

  if (isLoading) return <Spinner animation="border" />;

  return (
    <>
      <div className="position-relative mb-3" ref={dropdownRef}>
        <Form.Control
          type="text"
          placeholder="Search public workspaces..."
          value={searchTerm}
          onChange={e => {
            setSearchTerm(e.target.value);
            setSelected(null);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
        />
        {showDropdown && filtered.length > 0 && (
          <div
            className="dropdown-menu show"
            style={{ position: 'absolute', top: '100%', left: 0, maxHeight: '300px', overflowY: 'auto', width: '100%' }}
          >
            {filtered.map(w => (
              <button
                key={w.id}
                type="button"
                className="dropdown-item"
                onClick={() => handleSelect(w)}
              >
                {w.title} <small className="text-muted">— {w.project_name}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="d-flex align-items-center gap-2 mb-3">
          <Form.Label className="mb-0">Version:</Form.Label>
          <Form.Select
            style={{ width: 'auto' }}
            value={selectedVersion ?? ''}
            onChange={e => setSelectedVersion(parseInt(e.target.value, 10))}
          >
            {(selected.versions || []).map(v => (
              <option key={v.version} value={v.version}>v{v.version}</option>
            ))}
          </Form.Select>
          <Button variant="outline-secondary" onClick={handleView}>
            View
          </Button>
          <Button onClick={handleAdd} disabled={forkWorkspace.isPending}>
            {forkWorkspace.isPending ? <Spinner animation="border" size="sm" /> : 'Add to Project'}
          </Button>
        </div>
      )}

      {error && <Alert variant="danger">{error}</Alert>}
    </>
  );
}

function PublishWorkspacesTab({ currentProject }) {
  const { data: workspaces = [], isLoading } = useWorkspaces(currentProject);
  const updateWorkspace = useUpdateWorkspace(currentProject);

  const handleToggle = async (workspace) => {
    try {
      await updateWorkspace.mutateAsync({ workspaceId: workspace.id, is_public: !workspace.is_public });
    } catch (error) {
      alert('Failed to update workspace: ' + (error.response?.data?.detail || error.message));
    }
  };

  if (isLoading) return <Spinner animation="border" />;
  if (workspaces.length === 0) return <p className="text-muted">No workspaces in this project yet.</p>;

  return (
    <Table size="sm" hover>
      <thead>
        <tr>
          <th>Title</th>
          <th>Versions</th>
          <th>Public</th>
        </tr>
      </thead>
      <tbody>
        {workspaces.map(ws => (
          <tr key={ws.id}>
            <td>{ws.title}</td>
            <td>{ws.versions?.length ?? 0}</td>
            <td>
              <Form.Check
                type="checkbox"
                checked={ws.is_public}
                onChange={() => handleToggle(ws)}
                disabled={updateWorkspace.isPending}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

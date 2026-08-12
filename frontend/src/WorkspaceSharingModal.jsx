import React, { useContext } from 'react';
import { Modal, Table, Form, Spinner } from 'react-bootstrap';
import { useWorkspaces, useUpdateWorkspace } from './datamodel/useQueries';
import { AuthContext } from './AuthContext';

export default function WorkspaceSharingModal({ show, onHide, currentProject }) {
  return (
    <Modal show={show} onHide={onHide} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Publish Workspaces</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <PublishWorkspacesTab currentProject={currentProject} />
      </Modal.Body>
    </Modal>
  );
}

function PublishWorkspacesTab({ currentProject }) {
  const { user } = useContext(AuthContext);
  const { data: workspaces = [], isLoading } = useWorkspaces(currentProject);
  const updateWorkspace = useUpdateWorkspace(currentProject);

  const handleTogglePublic = async (workspace) => {
    try {
      await updateWorkspace.mutateAsync({ workspaceId: workspace.id, is_public: !workspace.is_public });
    } catch (error) {
      alert('Failed to update workspace: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleToggleSuperpublic = async (workspace) => {
    try {
      await updateWorkspace.mutateAsync({ workspaceId: workspace.id, superpublic: !workspace.superpublic });
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
          {user?.is_admin && <th>Superpublic</th>}
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
                onChange={() => handleTogglePublic(ws)}
                disabled={updateWorkspace.isPending || ws.superpublic}
                title={ws.superpublic ? 'Superpublic implies public — unset superpublic first' : undefined}
              />
            </td>
            {user?.is_admin && (
              <td>
                <Form.Check
                  type="checkbox"
                  checked={ws.superpublic}
                  onChange={() => handleToggleSuperpublic(ws)}
                  disabled={updateWorkspace.isPending}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

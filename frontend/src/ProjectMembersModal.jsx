import React, { useState, useContext } from 'react';
import { Modal, Tab, Tabs, Table, Button, Form, InputGroup, Spinner, Alert } from 'react-bootstrap';
import { ProcessContext, buildUrlPath } from './ProcessContext';
import {
  useProjectMembers,
  useProjectInvites,
  useInviteMember,
  useCancelInvite,
  useLeaveProject,
  usePublications,
  useCreatePublication,
  useDeletePublication,
} from './datamodel/useQueries';

export default function ProjectMembersModal({ show, onHide, projectId, projectName }) {
  return (
    <Modal show={show} onHide={onHide} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Members — {projectName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Tabs defaultActiveKey="members" className="mb-3">
          <Tab eventKey="members" title="Members">
            <MembersTab projectId={projectId} onHide={onHide} />
          </Tab>
          <Tab eventKey="invite" title="Invite">
            <InviteTab projectId={projectId} />
          </Tab>
          <Tab eventKey="pending" title="Pending Invites">
            <PendingInvitesTab projectId={projectId} />
          </Tab>
          <Tab eventKey="publications" title="Publications">
            <PublicationsTab projectId={projectId} />
          </Tab>
        </Tabs>
      </Modal.Body>
    </Modal>
  );
}

function MembersTab({ projectId, onHide }) {
  const { setCurrentProject } = useContext(ProcessContext);
  const { data: members = [], isLoading } = useProjectMembers(projectId);
  const leaveProject = useLeaveProject(projectId);

  const handleLeave = async () => {
    if (!window.confirm('Are you sure you want to leave this project?')) return;
    try {
      await leaveProject.mutateAsync();
      setCurrentProject(null);
      onHide();
    } catch (error) {
      alert('Failed to leave project: ' + (error.response?.data?.detail || error.message));
    }
  };

  if (isLoading) return <Spinner animation="border" />;

  return (
    <>
      <Table size="sm" hover>
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr key={m.user_id}>
              <td>{m.username}</td>
              <td>{m.email || '—'}</td>
              <td>{new Date(m.joined_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Button
        variant="outline-danger"
        size="sm"
        onClick={handleLeave}
        disabled={leaveProject.isPending}
      >
        Leave Project
      </Button>
    </>
  );
}

function InviteTab({ projectId }) {
  const [email, setEmail] = useState('');
  const [inviteResult, setInviteResult] = useState(null);
  const [error, setError] = useState(null);
  const inviteMember = useInviteMember(projectId);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    setInviteResult(null);
    try {
      const result = await inviteMember.mutateAsync(email || null);
      setInviteResult(result);
      setEmail('');
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  const handleCopy = () => {
    if (inviteResult?.invite_url) {
      navigator.clipboard.writeText(inviteResult.invite_url);
    }
  };

  return (
    <>
      <Form onSubmit={handleCreate}>
        <Form.Group className="mb-3">
          <Form.Label>Email (optional)</Form.Label>
          <Form.Control
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <Form.Text className="text-muted">
            Leave blank to create a link-only invite.
          </Form.Text>
        </Form.Group>
        <Button type="submit" disabled={inviteMember.isPending}>
          {inviteMember.isPending ? <Spinner animation="border" size="sm" /> : 'Create Invite Link'}
        </Button>
      </Form>

      {error && <Alert variant="danger" className="mt-3">{error}</Alert>}

      {inviteResult && (
        <Alert variant="success" className="mt-3">
          <p className="mb-2">
            <strong>Invite link created!</strong>
            {inviteResult.email && <span> Email sent to {inviteResult.email}.</span>}
          </p>
          <InputGroup>
            <Form.Control
              readOnly
              value={inviteResult.invite_url}
              onClick={e => e.target.select()}
            />
            <Button variant="outline-secondary" onClick={handleCopy}>
              Copy
            </Button>
          </InputGroup>
        </Alert>
      )}
    </>
  );
}

function PendingInvitesTab({ projectId }) {
  const { data: invites = [], isLoading } = useProjectInvites(projectId);
  const cancelInvite = useCancelInvite(projectId);

  const handleCancel = async (inviteId) => {
    if (!window.confirm('Cancel this invite?')) return;
    try {
      await cancelInvite.mutateAsync(inviteId);
    } catch (error) {
      alert('Failed to cancel invite: ' + (error.response?.data?.detail || error.message));
    }
  };

  if (isLoading) return <Spinner animation="border" />;
  if (invites.length === 0) return <p className="text-muted">No pending invites.</p>;

  return (
    <Table size="sm" hover>
      <thead>
        <tr>
          <th>Email</th>
          <th>Sent</th>
          <th>Expires</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {invites.map(inv => (
          <tr key={inv.id}>
            <td>{inv.email || <em>link-only</em>}</td>
            <td>{new Date(inv.created_at).toLocaleDateString()}</td>
            <td>{new Date(inv.expires_at).toLocaleDateString()}</td>
            <td>
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => handleCancel(inv.id)}
                disabled={cancelInvite.isPending}
              >
                Cancel
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PublicationsTab({ projectId }) {
  const { selectedEnvironment, selectedEnvironmentVersion, activeProcess, currentPart, currentSounding } = useContext(ProcessContext);
  const { data: publications = [], isLoading } = usePublications(projectId);
  const createPublication = useCreatePublication(projectId);
  const deletePublication = useDeletePublication(projectId);
  const [findable, setFindable] = useState(false);
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  const copyLink = (publicationId) => {
    const path = buildUrlPath(
      selectedEnvironment,
      selectedEnvironmentVersion,
      publicationId,
      activeProcess?.processId,
      activeProcess?.version,
      currentPart === "all" ? null : currentPart,
      currentSounding
    );
    navigator.clipboard.writeText(`${window.location.origin}${path}`);
    setCopiedId(publicationId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const publication = await createPublication.mutateAsync({ findable, allowAnonymous });
      copyLink(publication.id);
    } catch (error) {
      alert('Failed to create publication: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleDelete = async (publicationId) => {
    if (!window.confirm('Delete this publication link? It will stop working immediately.')) return;
    try {
      await deletePublication.mutateAsync(publicationId);
    } catch (error) {
      alert('Failed to delete publication: ' + (error.response?.data?.detail || error.message));
    }
  };

  if (isLoading) return <Spinner animation="border" />;

  return (
    <>
      <p className="text-muted">
        Publications are read-only share links into this project. Anyone with the link can
        view the project, but can never make changes.
      </p>
      {publications.length > 0 && (
        <Table size="sm" hover className="mb-3">
          <thead>
            <tr>
              <th>Findable</th>
              <th>Anonymous</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {publications.map(pub => (
              <tr key={pub.id}>
                <td>{pub.findable ? 'Yes' : 'No'}</td>
                <td>{pub.allow_anonymous ? 'Yes' : 'No'}</td>
                <td>{new Date(pub.created_at).toLocaleDateString()}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    className="me-2"
                    onClick={() => copyLink(pub.id)}
                  >
                    {copiedId === pub.id ? 'Copied!' : 'Copy link'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => handleDelete(pub.id)}
                    disabled={deletePublication.isPending}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Form onSubmit={handleCreate}>
        <Form.Check
          type="checkbox"
          id="publication-findable"
          label="Findable — show up in every user's Projects list"
          checked={findable}
          onChange={e => setFindable(e.target.checked)}
          className="mb-2"
        />
        <Form.Check
          type="checkbox"
          id="publication-anonymous"
          label="Allow anonymous — link works without logging in"
          checked={allowAnonymous}
          onChange={e => setAllowAnonymous(e.target.checked)}
          className="mb-3"
        />
        <Button type="submit" disabled={createPublication.isPending}>
          {createPublication.isPending ? <Spinner animation="border" size="sm" /> : 'Create publication'}
        </Button>
      </Form>
    </>
  );
}

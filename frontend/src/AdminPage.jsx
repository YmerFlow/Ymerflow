import React, { useContext } from 'react';
import { Container, Card, Table, Button, Badge } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from './AuthContext';
import { useAdminUsers, useSetUserAdmin } from './datamodel/useAuthQueries';
import TabbedPage from './TabbedPage';
import ClustersAdminPanel from './ClustersAdminPanel';
import StorageBackendsAdminPanel from './StorageBackendsAdminPanel';
import TosAdminPanel from './TosAdminPanel';

function UsersAdminPanel({ currentUser }) {
  const { data: users = [], isLoading } = useAdminUsers();
  const setAdminMutation = useSetUserAdmin();

  if (isLoading) return <p className="text-muted">Loading...</p>;

  return (
    <Card>
      <Card.Body>
        <Card.Title>User Administration</Card.Title>
        <Table size="sm" hover>
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Admin?</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.username}>
                <td>{u.username}</td>
                <td>{u.email || <span className="text-muted">—</span>}</td>
                <td>{u.is_admin ? <Badge bg="success">Admin</Badge> : null}</td>
                <td>
                  <Button
                    size="sm"
                    variant={u.is_admin ? 'outline-danger' : 'outline-primary'}
                    disabled={u.username === currentUser.username || setAdminMutation.isPending}
                    onClick={() => setAdminMutation.mutate({ username: u.username, isAdmin: !u.is_admin })}
                  >
                    {u.is_admin ? 'Revoke admin' : 'Make admin'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}

export default function AdminPage() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();

  const builtinTabs = [
    {
      key: 'users',
      title: 'Users',
      render: () => <UsersAdminPanel currentUser={user} />,
    },
    {
      key: 'clusters',
      title: 'Clusters',
      render: () => <ClustersAdminPanel />,
    },
    {
      key: 'storage',
      title: 'Storage',
      render: () => <StorageBackendsAdminPanel />,
    },
    {
      key: 'tos',
      title: 'Terms of Service',
      render: () => <TosAdminPanel />,
    },
  ];

  return (
    <>
      <TabbedPage
        title="Admin"
        basePath="/admin"
        hookName="admin_tabs"
        builtinTabs={builtinTabs}
      />
      <Container>
        <div className="mt-3">
          <Button variant="secondary" onClick={() => navigate('/app')}>Back to App</Button>
        </div>
      </Container>
    </>
  );
}

import React, { useContext, useState, useEffect } from 'react';
import { Container, Card, Table, Button, Badge, Form, Pagination } from 'react-bootstrap';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthContext } from './AuthContext';
import { useAdminUsers, useSetUserAdmin } from './datamodel/useAuthQueries';
import TabbedPage from './TabbedPage';
import ClustersAdminPanel from './ClustersAdminPanel';
import StorageBackendsAdminPanel from './StorageBackendsAdminPanel';
import TosAdminPanel from './TosAdminPanel';
import StatsAdminPanel from './StatsAdminPanel';

const PAGE_SIZE = 25;

// A sortable column header: clicking sorts by `col`, clicking the active column flips direction.
function SortableHeader({ col, label, sort, dir, onSort }) {
  const active = sort === col;
  return (
    <th
      role="button"
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      {active ? <span className="ms-1">{dir === 'asc' ? '▲' : '▼'}</span> : null}
    </th>
  );
}

// Numbered page controls. Renders first/last plus a small window around the current page.
function pageWindow(page, pageCount) {
  const pages = new Set([1, pageCount, page, page - 1, page + 1]);
  const sorted = [...pages].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function UsersAdminPanel({ currentUser }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const sort = searchParams.get('sort') || 'username';
  const dir = searchParams.get('dir') || 'asc';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  const { data, isLoading, isFetching } = useAdminUsers({ q, sort, dir, limit: PAGE_SIZE, offset });
  const users = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setAdminMutation = useSetUserAdmin();

  // Merge patches into the query string (don't clobber the :tab path segment).
  const update = (patch) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k); else next.set(k, String(v));
    }
    return next;
  }, { replace: true });

  const onSort = (col) => update({
    sort: col,
    dir: sort === col && dir === 'asc' ? 'desc' : 'asc',
    page: 1,
  });
  const goToPage = (p) => update({ page: p });

  // Local search box state, debounced into the URL so typing doesn't fire a request per keystroke.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => { setSearchInput(q); }, [q]);   // keep in sync with URL (e.g. back/forward)
  useEffect(() => {
    if (searchInput === q) return;
    const handle = setTimeout(() => update({ q: searchInput, page: 1 }), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  return (
    <Card>
      <Card.Body>
        <Card.Title>User Administration</Card.Title>

        <Form.Control
          type="search"
          placeholder="Search by username or email…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="mb-3"
          style={{ maxWidth: '24rem' }}
        />

        {isLoading ? (
          <p className="text-muted">Loading...</p>
        ) : total === 0 ? (
          <p className="text-muted">{q ? `No users match "${q}".` : 'No users.'}</p>
        ) : (
          <>
            <Table size="sm" hover style={{ opacity: isFetching ? 0.6 : 1 }}>
              <thead>
                <tr>
                  <SortableHeader col="username" label="Username" sort={sort} dir={dir} onSort={onSort} />
                  <SortableHeader col="email" label="Email" sort={sort} dir={dir} onSort={onSort} />
                  <SortableHeader col="is_admin" label="Admin?" sort={sort} dir={dir} onSort={onSort} />
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

            <div className="d-flex justify-content-between align-items-center flex-wrap">
              <span className="text-muted">
                Showing {offset + 1}–{offset + users.length} of {total} users
              </span>
              {pageCount > 1 ? (
                <Pagination size="sm" className="mb-0">
                  <Pagination.Prev disabled={page <= 1} onClick={() => goToPage(page - 1)} />
                  {pageWindow(page, pageCount).map((p, i) =>
                    p === '…' ? (
                      <Pagination.Ellipsis key={`e${i}`} disabled />
                    ) : (
                      <Pagination.Item key={p} active={p === page} onClick={() => goToPage(p)}>
                        {p}
                      </Pagination.Item>
                    )
                  )}
                  <Pagination.Next disabled={page >= pageCount} onClick={() => goToPage(page + 1)} />
                </Pagination>
              ) : null}
            </div>
          </>
        )}
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
      key: 'stats',
      title: 'Stats',
      render: () => <StatsAdminPanel />,
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

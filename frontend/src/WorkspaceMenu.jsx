import React, { useContext, useEffect, useState, useRef } from 'react';
import { Dropdown, Form } from 'react-bootstrap';
import { LayoutContext } from './flexout/LayoutContext';
import { ProcessContext } from './ProcessContext';
import { useWorkspaces, useWorkspace, useSaveWorkspace, useSaveWorkspaceVersion, usePublicWorkspaces } from './datamodel/useQueries';
import WorkspaceSharingModal from './WorkspaceSharingModal';

// One row per workspace: clickable title (loads the selected version, default latest) plus an
// inline version <select>. Clicking the title makes this the "current" workspace — that identity
// is remembered in the URL (/w/{id}) via setSelectedEnvironment, and is what the top-level Save
// button writes new versions back to.
function WorkspaceRow({ workspace, onSelect }) {
  const { updateLayout } = useContext(LayoutContext);
  const { selectedEnvironment, selectedEnvironmentVersion, setSelectedEnvironment } = useContext(ProcessContext);

  const versions = workspace.versions || [];
  const latestVersion = versions.length ? versions[versions.length - 1].version : null;
  const isActive = workspace.id === selectedEnvironment;

  // Inactive rows always show the latest version — there's no "pending pick" state independent
  // of the URL; picking a version activates the row immediately (see loadVersion below).
  const displayedVersion = isActive ? (selectedEnvironmentVersion ?? latestVersion) : latestVersion;

  // Load a specific version's layout and make this the current workspace. Used by both the title
  // click and the version dropdown, so changing the version applies it immediately.
  const loadVersion = (versionNum) => {
    const entry = versions.find(v => v.version === versionNum) || versions[versions.length - 1];
    if (!entry) return;
    updateLayout(entry.layout);
    setSelectedEnvironment(workspace.id, entry.version);
    if (onSelect) onSelect();
  };

  return (
    <div className="d-flex align-items-center gap-2 px-3 py-1" style={{ minWidth: '260px' }}>
      <button
        type="button"
        className={`btn btn-sm flex-grow-1 text-start px-0 ${isActive ? 'text-primary fw-bold' : 'text-body'}`}
        style={{ border: 'none', background: 'none' }}
        onClick={() => loadVersion(displayedVersion)}
      >
        {workspace.title}
        {workspace.project_name && <small className="text-muted ms-2">— {workspace.project_name}</small>}
        {workspace.superpublic && <span className="badge bg-primary ms-2">superpublic</span>}
        {!workspace.superpublic && workspace.is_public && <span className="badge bg-secondary ms-2">public</span>}
      </button>
      <select
        className="form-select form-select-sm"
        style={{ width: 'auto' }}
        value={displayedVersion ?? ''}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        onChange={e => loadVersion(parseInt(e.target.value, 10))}
      >
        {versions.map(v => (
          <option key={v.version} value={v.version}>v{v.version}</option>
        ))}
      </select>
    </div>
  );
}

// The main row list: workspaces owned by the current project, the URL-pinned workspace (even
// when it belongs to another project), and every superpublic workspace — merged and deduped
// client-side (Design Decision 7).
function WorkspaceList({ onSelect }) {
  const { currentProject: proj, selectedEnvironment } = useContext(ProcessContext);
  const { data: workspaces = [] } = useWorkspaces(proj);
  const isOwned = workspaces.some(w => w.id === selectedEnvironment);
  const { data: pinned } = useWorkspace(selectedEnvironment, { enabled: !!selectedEnvironment && !isOwned });
  const { data: publicWorkspaces = [] } = usePublicWorkspaces();

  const rows = [];
  const seen = new Set();
  const addRow = (ws) => {
    if (!ws || seen.has(ws.id)) return;
    seen.add(ws.id);
    rows.push(ws);
  };
  if (pinned && !isOwned) addRow(pinned);
  workspaces.forEach(addRow);
  publicWorkspaces.filter(w => w.superpublic).forEach(addRow);

  if (rows.length === 0) {
    return <div className="px-3 py-1 text-muted">No workspaces yet.</div>;
  }

  return (
    <>
      {rows.map(ws => (
        <WorkspaceRow key={ws.id} workspace={ws} onSelect={onSelect} />
      ))}
    </>
  );
}

// "Save" — write the current layout back as a NEW version of the currently-loaded workspace.
// The label names the target workspace and disables itself when nothing is loaded/editable.
function SaveCurrentWorkspaceItem({ layoutRef, onSaved }) {
  const { currentProject: proj, selectedEnvironment, setSelectedEnvironment, projects } = useContext(ProcessContext);
  const { data: current } = useWorkspace(selectedEnvironment);
  // Editability is membership in the workspace's home project, not whether that project
  // happens to be the currently-open one. The `!p.read_only` guard excludes pinned
  // read-only publication entries in `projects` — those aren't real memberships.
  const canEdit = !!current && projects.some(p => p.id === current.project_id && !p.read_only);
  const saveVersion = useSaveWorkspaceVersion(current?.project_id);

  const handleSave = async () => {
    if (!current || !canEdit) return;
    try {
      const saved = await saveVersion.mutateAsync({ workspaceId: current.id, layout: layoutRef.current });
      setSelectedEnvironment(current.id, saved.version);
    } catch (error) {
      console.error('Failed to save workspace version:', error);
      alert('Failed to save new version. Please try again.');
    }
    if (onSaved) onSaved();
  };

  const awayFromHome = current && current.project_id !== proj;
  const label = !current
    ? 'Save (no workspace loaded)'
    : awayFromHome
      ? `Save to "${current.project_name}"`
      : `Save "${current.title}"`;
  const title = !current
    ? 'Load a workspace first'
    : !canEdit
      ? `You are not a member of "${current.project_name}" — cannot save`
      : awayFromHome
        ? `Save a new version to "${current.project_name}"`
        : `Save a new version of "${current.title}"`;

  return (
    <button
      type="button"
      className="dropdown-item"
      onClick={handleSave}
      disabled={!canEdit || saveVersion.isPending}
      title={title}
    >
      {label}
    </button>
  );
}

// Search combobox at the bottom of the menu — adapted from the deleted AddPublicWorkspacesTab.
// Selecting a result just navigates to it: no fork, no "add to my list" mutation.
function PublicWorkspaceSearch({ onSelect }) {
  const { data: publicWorkspaces = [] } = usePublicWorkspaces();
  const { setSelectedEnvironment } = useContext(ProcessContext);
  const [searchTerm, setSearchTerm] = useState('');
  const [showResults, setShowResults] = useState(false);

  const filtered = searchTerm
    ? publicWorkspaces.filter(w => w.title.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];

  const handlePick = (workspace) => {
    const latest = workspace.versions?.[workspace.versions.length - 1]?.version ?? null;
    setSelectedEnvironment(workspace.id, latest);
    setSearchTerm('');
    setShowResults(false);
    if (onSelect) onSelect();
  };

  return (
    <div className="px-3 py-1" onClick={e => e.stopPropagation()}>
      <Form.Control
        type="text"
        size="sm"
        placeholder="Search public workspaces..."
        value={searchTerm}
        onChange={e => { setSearchTerm(e.target.value); setShowResults(true); }}
        onFocus={() => setShowResults(true)}
        onKeyDown={e => {
          // Stop this from reaching document: the app's global vanilla Bootstrap JS bundle
          // (loaded for the flexout MenuBar's native data-bs-toggle dropdowns) also listens
          // for keydown there and crashes on our react-bootstrap-managed toggle, which it
          // doesn't recognize as one of its own instances.
          e.stopPropagation();
          if (e.key === 'Escape') {
            setShowResults(false);
            e.currentTarget.blur();
          }
        }}
      />
      {showResults && filtered.length > 0 && (
        <div className="mt-1" style={{ maxHeight: '200px', overflowY: 'auto' }}>
          {filtered.map(w => (
            <button
              key={w.id}
              type="button"
              className="dropdown-item"
              onClick={() => handlePick(w)}
            >
              {w.title} <small className="text-muted">— {w.project_name}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkspaceMenu() {
  const { layout } = useContext(LayoutContext);
  const { currentProject, selectedEnvironment } = useContext(ProcessContext);
  const { data: current } = useWorkspace(selectedEnvironment);
  const saveWorkspace = useSaveWorkspace(currentProject);
  const layoutRef = useRef(layout);
  const [showSharingModal, setShowSharingModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // "No workspace → Empty layout" is now owned by WorkspaceLayoutSync.

  const handleSaveAsNew = async () => {
    const title = window.prompt('Enter workspace name:');
    if (!title) return;

    try {
      await saveWorkspace.mutateAsync({ title, layout: layoutRef.current });
      alert(`Workspace "${title}" saved successfully!`);
    } catch (error) {
      console.error('Failed to save workspace:', error);
      alert('Failed to save workspace. Please try again.');
    }
    setMenuOpen(false);
  };

  return (
    <>
      {/* autoClose="outside": typing in the search box or picking a row's version <select>
          must not immediately close the menu — only a click outside the whole dropdown does. */}
      <Dropdown show={menuOpen} onToggle={setMenuOpen} autoClose="outside" data-rb-guard>
        <Dropdown.Toggle variant="outline-secondary" size="sm">
          Workspace: {current ? current.title : 'None'}
        </Dropdown.Toggle>
        <Dropdown.Menu style={{ maxHeight: '75vh', overflowY: 'auto' }}>
          <WorkspaceList onSelect={() => setMenuOpen(false)} />
          <Dropdown.Divider />
          <SaveCurrentWorkspaceItem layoutRef={layoutRef} onSaved={() => setMenuOpen(false)} />
          <button type="button" className="dropdown-item" onClick={handleSaveAsNew}>
            Save As New Workspace...
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => { setShowSharingModal(true); setMenuOpen(false); }}
          >
            Publish Workspaces...
          </button>
          <Dropdown.Divider />
          <PublicWorkspaceSearch onSelect={() => setMenuOpen(false)} />
        </Dropdown.Menu>
      </Dropdown>

      <WorkspaceSharingModal
        show={showSharingModal}
        onHide={() => setShowSharingModal(false)}
        currentProject={currentProject}
      />
    </>
  );
}

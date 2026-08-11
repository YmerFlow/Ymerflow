import React, { useContext, useEffect, useState, useRef } from 'react';
import { useRegisterMenu, useRegisterMenuComponent } from './flexout/MenuContext';
import { LayoutContext } from './flexout/LayoutContext';
import { ProcessContext } from './ProcessContext';
import { useWorkspaces, useWorkspace, useSaveWorkspace, useSaveWorkspaceVersion } from './datamodel/useQueries';
import WorkspaceSharingModal from './WorkspaceSharingModal';

// One row per workspace: clickable title (loads the selected version, default latest) plus an
// inline version <select>. Clicking the title makes this the "current" workspace — that identity
// is remembered in the URL (/w/{id}) via setSelectedEnvironment, and is what the top-level Save
// button writes new versions back to.
function WorkspaceRow({ workspace }) {
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
        {workspace.is_public && <span className="badge bg-secondary ms-2">public</span>}
      </button>
      <select
        className="form-select form-select-sm"
        style={{ width: 'auto' }}
        value={displayedVersion ?? ''}
        onClick={e => e.stopPropagation()}
        onChange={e => loadVersion(parseInt(e.target.value, 10))}
      >
        {versions.map(v => (
          <option key={v.version} value={v.version}>v{v.version}</option>
        ))}
      </select>
    </div>
  );
}

export default function WorkspaceMenu() {
  const { layout, updateLayout } = useContext(LayoutContext);
  const { currentProject, selectedEnvironment } = useContext(ProcessContext);
  const saveWorkspace = useSaveWorkspace(currentProject);
  const layoutRef = useRef(layout);
  const [showSharingModal, setShowSharingModal] = useState(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // A private workspace dropped by setCurrentProject's switch logic (ProcessContext, Decision 4)
  // leaves selectedEnvironment null. Clear the layout too, so the previous project's panes don't
  // stay on screen referencing processes/datasets the new project has no relationship to.
  useEffect(() => {
    if (!selectedEnvironment) {
      updateLayout({ id: 'root', widget: 'Empty' });
    }
  }, [selectedEnvironment]);

  // "Save" — write the current layout back as a NEW version of the currently-loaded workspace.
  // A menu component (rather than a static useRegisterMenu action) so the label can name the
  // target workspace and disable itself when nothing is loaded — the "remembers where it came
  // from" affordance. Registered once; it reads live state from context/hooks internally.
  const [SaveCurrentWorkspace] = useState(() => function SaveCurrentWorkspaceComponent() {
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
  });

  useRegisterMenuComponent(['Workspaces', '_save'], SaveCurrentWorkspace, 1);

  useRegisterMenu(
    ['Workspaces', 'Save As New Workspace...'],
    async () => {
      const title = window.prompt('Enter workspace name:');
      if (!title) return;

      try {
        await saveWorkspace.mutateAsync({ title, layout: layoutRef.current });
        alert(`Workspace "${title}" saved successfully!`);
      } catch (error) {
        console.error('Failed to save workspace:', error);
        alert('Failed to save workspace. Please try again.');
      }
    },
    2
  );

  useRegisterMenu(
    ['Workspaces', 'Public Workspaces...'],
    () => setShowSharingModal(true),
    3
  );

  // A single menu component renders every workspace row for the current project. Registering
  // one component (rather than one-per-workspace) keeps the menu correct when the project
  // switches — the flexout menu system has no unregister, so per-row registration would leave
  // the previous project's rows stranded in the tree.
  const [WorkspaceList] = useState(() => function WorkspaceListComponent() {
    const { currentProject: proj, selectedEnvironment } = useContext(ProcessContext);
    const { data: workspaces = [] } = useWorkspaces(proj);
    const isOwned = workspaces.some(w => w.id === selectedEnvironment);
    // Pin the URL's workspace into the list even when the current project doesn't own it —
    // otherwise navigating to a public workspace owned by another project leaves the menu
    // with no active row, even though the workspace loads and is perfectly viewable.
    const { data: pinned } = useWorkspace(selectedEnvironment, { enabled: !!selectedEnvironment && !isOwned });
    const rows = pinned && !isOwned ? [pinned, ...workspaces] : workspaces;
    return (
      <>
        {rows.map(ws => (
          <WorkspaceRow key={ws.id} workspace={ws} />
        ))}
      </>
    );
  });

  useRegisterMenuComponent(['Workspaces', '_workspaceList'], WorkspaceList, 10);

  return (
    <WorkspaceSharingModal
      show={showSharingModal}
      onHide={() => setShowSharingModal(false)}
      currentProject={currentProject}
    />
  );
}

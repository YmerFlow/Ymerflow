import React, { useContext, useEffect, useState, useRef } from 'react';
import { useRegisterMenu, useRegisterMenuComponent } from './flexout/MenuContext';
import { LayoutContext } from './flexout/LayoutContext';
import { ProcessContext } from './ProcessContext';
import { useWorkspaces, useSaveWorkspace, useSaveWorkspaceVersion } from './datamodel/useQueries';
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
  const { layout } = useContext(LayoutContext);
  const { currentProject } = useContext(ProcessContext);
  const saveWorkspace = useSaveWorkspace(currentProject);
  const layoutRef = useRef(layout);
  const [showSharingModal, setShowSharingModal] = useState(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // "Save" — write the current layout back as a NEW version of the currently-loaded workspace.
  // A menu component (rather than a static useRegisterMenu action) so the label can name the
  // target workspace and disable itself when nothing is loaded — the "remembers where it came
  // from" affordance. Registered once; it reads live state from context/hooks internally.
  const [SaveCurrentWorkspace] = useState(() => function SaveCurrentWorkspaceComponent() {
    const { currentProject: proj, selectedEnvironment, setSelectedEnvironment } = useContext(ProcessContext);
    const { data: workspaces = [] } = useWorkspaces(proj);
    const saveVersion = useSaveWorkspaceVersion(proj);
    const current = workspaces.find(w => w.id === selectedEnvironment);

    const handleSave = async () => {
      if (!current) return;
      try {
        const saved = await saveVersion.mutateAsync({ workspaceId: current.id, layout: layoutRef.current });
        setSelectedEnvironment(current.id, saved.version);
      } catch (error) {
        console.error('Failed to save workspace version:', error);
        alert('Failed to save new version. Please try again.');
      }
    };

    return (
      <button
        type="button"
        className="dropdown-item"
        onClick={handleSave}
        disabled={!current || saveVersion.isPending}
        title={current ? `Save a new version of "${current.title}"` : 'Load a workspace first'}
      >
        {current ? `Save "${current.title}"` : 'Save (no workspace loaded)'}
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
    const { currentProject: proj } = useContext(ProcessContext);
    const { data: workspaces = [] } = useWorkspaces(proj);
    return (
      <>
        {workspaces.map(ws => (
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

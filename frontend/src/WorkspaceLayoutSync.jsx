import { useContext, useEffect, useRef } from 'react';
import { ProcessContext } from './ProcessContext';
import { LayoutContext } from './flexout/LayoutContext';
import { useWorkspace } from './datamodel/useQueries';

// The rendered pane layout is a derived function of the URL's workspace: it always shows the
// layout of the workspace named in the URL (or Empty when the URL names none). This is the single
// mechanism satisfying constraint 3 — it replaces the old mount-time `default` load in
// AppWithContext and the WorkspaceMenu empty-effect.
//
// A ref tracks the last-applied `workspaceId@version` key so the sync fires only on a real
// navigation to a different workspace/version (or to no-workspace) — never on re-render or query
// refetch. In-place layout edits (drag/split/add-pane, "Save As New") mutate `layout` state but
// never the URL, so the key is unchanged and the user's edits are never clobbered.
//
// Renders null.
function WorkspaceLayoutSync() {
  const { selectedEnvironment, selectedEnvironmentVersion } = useContext(ProcessContext);
  const { updateLayout } = useContext(LayoutContext);
  const { data: workspace } = useWorkspace(selectedEnvironment);

  const lastAppliedKey = useRef(null);   // `${wsId}@${version}` or 'none'

  useEffect(() => {
    if (!selectedEnvironment) {
      if (lastAppliedKey.current !== 'none') {
        updateLayout({ id: 'root', widget: 'Empty' });
        lastAppliedKey.current = 'none';
      }
      return;
    }
    // Wait until the loaded workspace actually matches the URL id (the query may still hold the
    // previous workspace's data mid-navigation).
    if (!workspace || workspace.id !== selectedEnvironment) return;
    const versions = workspace.versions ?? [];
    const entry = versions.find(v => v.version === selectedEnvironmentVersion)
               ?? versions[versions.length - 1];
    if (!entry) return;
    const key = `${workspace.id}@${entry.version}`;
    if (lastAppliedKey.current === key) return;   // already applied — don't clobber edits
    updateLayout(entry.layout);
    lastAppliedKey.current = key;
  }, [selectedEnvironment, selectedEnvironmentVersion, workspace, updateLayout]);

  return null;
}

export default WorkspaceLayoutSync;

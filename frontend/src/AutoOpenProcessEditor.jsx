import { useContext, useEffect, useRef } from 'react';
import { ProcessContext } from './ProcessContext';
import { LayoutContext } from './flexout/LayoutContext';
import { useWorkspace, useWorkspaces } from './datamodel/useQueries';

// When a user lands on a project that has no processes yet, and the active workspace layout
// contains a ProcessEditor, auto-open it defaulted to the latest Environment + `import_skytem`
// so a fresh project starts on "import your first dataset". Fires once per project.
//
// Renders null — this is a behaviour-only trigger, a sibling of <AutoCreateProjectDialog />.
function AutoOpenProcessEditor() {
  const {
    currentProject, projects, processes, isLoading,
    environments, environmentsLoading,
    selectedEnvironment, setSelectedEnvironment, startNewProcess,
  } = useContext(ProcessContext);
  const { updateLayout, findWidgetPaths, activatePath } = useContext(LayoutContext);

  // The global `default` workspace is not returned by the project-scoped list, so fetch it
  // directly; it cannot be deleted, so it effectively always exists.
  const { data: defaultWorkspace } = useWorkspace('default');
  const { data: projectWorkspaces = [] } = useWorkspaces(currentProject);

  // Project id we've already handled, so we fire at most once per project.
  const handledProjectRef = useRef(null);

  useEffect(() => {
    if (!currentProject) return;
    if (handledProjectRef.current === currentProject) return;
    if (isLoading || processes.length !== 0) return;
    if (environmentsLoading || environments.length === 0) return;

    // Can't create processes on a read-only publication.
    if (projects.find(p => p.id === currentProject)?.read_only) {
      handledProjectRef.current = currentProject;
      return;
    }

    // Step 0 — no workspace selected: select `default` (or the first project workspace),
    // load its latest version's layout, and let the URL/layout settle before continuing.
    // Return WITHOUT marking handled so the effect resumes on the next render.
    if (!selectedEnvironment) {
      const ws = defaultWorkspace ?? projectWorkspaces[0];
      const versions = ws?.versions ?? [];
      const latest = versions[versions.length - 1];
      if (!ws || !latest) return;   // workspace data not loaded yet — wait
      updateLayout(latest.layout);
      setSelectedEnvironment(ws.id, latest.version);
      return;
    }

    // Editor not in the active layout → don't inject a pane; just mark handled.
    const paths = findWidgetPaths('ProcessEditor');
    if (paths.length === 0) {
      handledProjectRef.current = currentProject;
      return;
    }

    // Latest environment by created_at (list_environments is unordered).
    const latestEnv = environments.reduce(
      (a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a)
    );
    startNewProcess({ environmentId: latestEnv.id, type: 'import_skytem' });
    activatePath(paths[0]);
    handledProjectRef.current = currentProject;
  }, [
    currentProject, projects, processes, isLoading,
    environments, environmentsLoading,
    selectedEnvironment, setSelectedEnvironment, startNewProcess,
    updateLayout, findWidgetPaths, activatePath,
    defaultWorkspace, projectWorkspaces,
  ]);

  return null;
}

export default AutoOpenProcessEditor;

import { useContext, useEffect, useRef } from 'react';
import { ProcessContext } from './ProcessContext';
import { LayoutContext } from './flexout/LayoutContext';

// When a user lands on a project that has no processes yet, and the active workspace layout
// contains a ProcessEditor, auto-open it defaulted to the latest Environment + `import_skytem`
// so a fresh project starts on "import your first dataset". Fires once per project.
//
// Renders null — this is a behaviour-only trigger, a sibling of <AutoCreateProjectDialog />.
function AutoOpenProcessEditor() {
  const {
    currentProject, projects, processes, isLoading,
    environments, environmentsLoading,
    startNewProcess,
  } = useContext(ProcessContext);
  const { findWidgetPaths, activatePath } = useContext(LayoutContext);

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
    startNewProcess, findWidgetPaths, activatePath,
  ]);

  return null;
}

export default AutoOpenProcessEditor;

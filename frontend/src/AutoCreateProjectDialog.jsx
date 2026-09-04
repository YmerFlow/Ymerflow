import React, { useContext, useEffect, useRef, useState } from 'react';
import { ProcessContext } from './ProcessContext';
import { hooks } from './plugins/hooks';
import ProjectModal from './ProjectModal';

function AutoCreateProjectDialog() {
  const { projects, projectsLoading, currentProject, setCurrentProject } = useContext(ProcessContext);
  const [show, setShow] = useState(false);
  const checkedRef = useRef(false);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    if (checkedRef.current || projectsLoading) return;
    checkedRef.current = true;

    if (currentProject) return;        // URL already names a project/publication — don't interrupt
    // Only the user's own projects count — super-public publications (read_only) are
    // merged into `projects` but shouldn't suppress the create-project dialog.
    if (projects.some(p => !p.read_only)) return;

    (async () => {
      const redirects = await hooks.run_async.pending_redirects();
      if (redirects.some(Boolean)) return;
      // Re-check against the latest value in case projects loaded during the await.
      if (projectsRef.current.some(p => !p.read_only)) return;
      setShow(true);
    })();
  }, [projectsLoading, projects]);

  const handleCreated = (projectId) => {
    setCurrentProject(projectId);
    setShow(false);
  };

  return (
    <ProjectModal
      show={show}
      onHide={() => setShow(false)}
      onCreated={handleCreated}
    />
  );
}

export default AutoCreateProjectDialog;

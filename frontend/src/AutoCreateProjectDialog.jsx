import React, { useContext, useEffect, useRef, useState } from 'react';
import { ProcessContext } from './ProcessContext';
import { hooks } from './plugins/hooks';
import ProjectModal from './ProjectModal';

function AutoCreateProjectDialog() {
  const { projects, projectsLoading, setCurrentProject } = useContext(ProcessContext);
  const [show, setShow] = useState(false);
  const checkedRef = useRef(false);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    if (checkedRef.current || projectsLoading) return;
    checkedRef.current = true;

    if (projects.length !== 0) return;

    (async () => {
      const redirects = await hooks.run_async.pending_redirects();
      if (redirects.some(Boolean)) return;
      // Re-check against the latest value in case projects loaded during the await.
      if (projectsRef.current.length !== 0) return;
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

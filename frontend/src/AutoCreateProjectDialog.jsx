import React, { useContext, useEffect, useRef, useState } from 'react';
import { ProcessContext } from './ProcessContext';
import { useCreateProject } from './datamodel/useQueries';
import { hooks } from './plugins/hooks';
import ProjectModal from './ProjectModal';

function AutoCreateProjectDialog() {
  const { projects, projectsLoading, setCurrentProject } = useContext(ProcessContext);
  const createProjectMutation = useCreateProject();
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

  const handleCreateProject = async (name, storageBackendId) => {
    try {
      const newProject = await createProjectMutation.mutateAsync({ name, storageBackendId });
      setCurrentProject(newProject.id);
      setShow(false);
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  return (
    <ProjectModal
      show={show}
      onHide={() => setShow(false)}
      onSubmit={handleCreateProject}
    />
  );
}

export default AutoCreateProjectDialog;

import React, { useContext, useState } from 'react';
import { Dropdown } from 'react-bootstrap';
import { ProcessContext } from './ProcessContext';
import { useCreateProject } from './datamodel/useQueries';
import ProjectModal from './ProjectModal';
import ProjectMembersModal from './ProjectMembersModal';

function ProjectDropdown() {
  const { projects, currentProject, setCurrentProject, projectsLoading } = useContext(ProcessContext);
  const createProjectMutation = useCreateProject();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);

  const currentProjectObj = projects.find(p => p.id === currentProject);

  const handleProjectSelect = (projectId) => {
    if (projectId === '_create_new') {
      setShowCreateModal(true);
    } else if (projectId === '_manage_members') {
      setShowMembersModal(true);
    } else {
      setCurrentProject(projectId);
    }
  };

  const handleCreateProject = async (name, storageBackendId) => {
    try {
      const newProject = await createProjectMutation.mutateAsync({ name, storageBackendId });
      setCurrentProject(newProject.id);
      setShowCreateModal(false);
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  if (projectsLoading) {
    return <span className="navbar-text">Loading projects...</span>;
  }

  return (
    <>
      <Dropdown onSelect={handleProjectSelect}>
        <Dropdown.Toggle variant="outline-secondary" size="sm">
          Project: {currentProjectObj ? currentProjectObj.name : 'None'}
        </Dropdown.Toggle>
        <Dropdown.Menu>
          {projects.map((project) => (
            <Dropdown.Item
              key={project.id}
              eventKey={project.id}
              active={project.id === currentProject}
            >
              {project.name}
            </Dropdown.Item>
          ))}
          {projects.length > 0 && <Dropdown.Divider />}
          {currentProject && (
            <Dropdown.Item eventKey="_manage_members">
              Manage Members...
            </Dropdown.Item>
          )}
          <Dropdown.Item eventKey="_create_new">
            Create New Project...
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown>

      <ProjectModal
        show={showCreateModal}
        onHide={() => setShowCreateModal(false)}
        onSubmit={handleCreateProject}
      />

      {currentProject && (
        <ProjectMembersModal
          show={showMembersModal}
          onHide={() => setShowMembersModal(false)}
          projectId={currentProject}
          projectName={currentProjectObj?.name || ''}
        />
      )}
    </>
  );
}

export default ProjectDropdown;

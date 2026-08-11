import React, { useContext, useState } from 'react';
import { Dropdown } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { ProcessContext } from './ProcessContext';
import { queryKeys } from './datamodel/useQueries';
import ProjectModal from './ProjectModal';
import ProjectMembersModal from './ProjectMembersModal';
import ProjectExportModal from './ProjectExportModal';

function ProjectDropdown() {
  const { projects, currentProject, setCurrentProject, projectsLoading } = useContext(ProcessContext);
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  const currentProjectObj = projects.find(p => p.id === currentProject);

  const handleProjectSelect = (projectId) => {
    if (projectId === '_create_new') {
      setShowCreateModal(true);
    } else if (projectId === '_export_project') {
      if (currentProjectObj?.read_only) return;
      setShowExportModal(true);
    } else if (projectId === '_manage_members') {
      if (currentProjectObj?.read_only) return;
      setShowMembersModal(true);
    } else {
      setCurrentProject(projectId);
    }
  };

  // Called by ProjectModal once a project is created — whether empty or seeded from an import.
  const handleProjectCreated = async (newProjectId) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    setCurrentProject(newProjectId);
    setShowCreateModal(false);
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
            <Dropdown.Item
              eventKey="_manage_members"
              disabled={!!currentProjectObj?.read_only}
              title={currentProjectObj?.read_only ? 'Read-only publication — membership cannot be managed here' : undefined}
            >
              Manage Members...
            </Dropdown.Item>
          )}
          {currentProject && (
            <Dropdown.Item
              eventKey="_export_project"
              disabled={!!currentProjectObj?.read_only}
              title={currentProjectObj?.read_only ? 'Read-only publication — cannot be exported here' : undefined}
            >
              Export Project...
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
        onCreated={handleProjectCreated}
      />

      {currentProject && (
        <ProjectMembersModal
          show={showMembersModal}
          onHide={() => setShowMembersModal(false)}
          projectId={currentProject}
          projectName={currentProjectObj?.name || ''}
        />
      )}

      {currentProject && (
        <ProjectExportModal
          show={showExportModal}
          onHide={() => setShowExportModal(false)}
          projectId={currentProject}
          projectName={currentProjectObj?.name || ''}
        />
      )}
    </>
  );
}

export default ProjectDropdown;

import React, { useContext, useState } from 'react';
import { Dropdown } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { ProcessContext } from './ProcessContext';
import { useCreateProject, queryKeys } from './datamodel/useQueries';
import ProjectModal from './ProjectModal';
import ProjectMembersModal from './ProjectMembersModal';
import ProjectExportModal from './ProjectExportModal';
import ProjectImportModal from './ProjectImportModal';

function ProjectDropdown() {
  const { projects, currentProject, setCurrentProject, projectsLoading } = useContext(ProcessContext);
  const queryClient = useQueryClient();
  const createProjectMutation = useCreateProject();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const currentProjectObj = projects.find(p => p.id === currentProject);

  const handleProjectSelect = (projectId) => {
    if (projectId === '_create_new') {
      setShowCreateModal(true);
    } else if (projectId === '_import_project') {
      setShowImportModal(true);
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

  const handleImported = async (newProjectId) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    setCurrentProject(newProjectId);
    setShowImportModal(false);
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
          <Dropdown.Item
            eventKey="_import_project"
            disabled={!currentProject}
            title={!currentProject ? 'Create or join a project first — the import zip is staged there' : undefined}
          >
            Import Project...
          </Dropdown.Item>
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

      {currentProject && (
        <ProjectExportModal
          show={showExportModal}
          onHide={() => setShowExportModal(false)}
          projectId={currentProject}
          projectName={currentProjectObj?.name || ''}
        />
      )}

      <ProjectImportModal
        show={showImportModal}
        onHide={() => setShowImportModal(false)}
        onImported={handleImported}
      />
    </>
  );
}

export default ProjectDropdown;

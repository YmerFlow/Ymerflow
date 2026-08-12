import React, { useContext, useState } from 'react';
import { Dropdown, Form } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { ProcessContext } from './ProcessContext';
import { queryKeys, usePublicPublications } from './datamodel/useQueries';
import ProjectModal from './ProjectModal';
import ProjectMembersModal from './ProjectMembersModal';
import ProjectExportModal from './ProjectExportModal';

// Search combobox for public (findable) projects — the logged-in discovery path for
// publications that aren't superpublic (and so aren't merged directly into `projects`).
// Selecting a result just navigates to it, same "no fork, no mutation" behavior as the
// workspace toolbar's equivalent combobox.
function PublicProjectSearch({ onSelect }) {
  const { data: publicPublications = [] } = usePublicPublications();
  const { setCurrentProject } = useContext(ProcessContext);
  const [searchTerm, setSearchTerm] = useState('');
  const [showResults, setShowResults] = useState(false);

  const filtered = searchTerm
    ? publicPublications.filter(p => p.project_name.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];

  const handlePick = (publication) => {
    setCurrentProject(publication.id);
    setSearchTerm('');
    setShowResults(false);
    if (onSelect) onSelect();
  };

  return (
    <div className="px-3 py-1" onClick={e => e.stopPropagation()}>
      <Form.Control
        type="text"
        size="sm"
        placeholder="Search public projects..."
        value={searchTerm}
        onChange={e => { setSearchTerm(e.target.value); setShowResults(true); }}
        onFocus={() => setShowResults(true)}
        onKeyDown={e => {
          // Stop this from reaching document: the app's global vanilla Bootstrap JS bundle
          // (loaded for the flexout MenuBar's native data-bs-toggle dropdowns) also listens
          // for keydown there and crashes on our react-bootstrap-managed toggle, which it
          // doesn't recognize as one of its own instances.
          e.stopPropagation();
          if (e.key === 'Escape') {
            setShowResults(false);
            e.currentTarget.blur();
          }
        }}
      />
      {showResults && filtered.length > 0 && (
        <div className="mt-1" style={{ maxHeight: '200px', overflowY: 'auto' }}>
          {filtered.map(p => (
            <button
              key={p.id}
              type="button"
              className="dropdown-item"
              onClick={() => handlePick(p)}
            >
              {p.project_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDropdown() {
  const { projects, currentProject, setCurrentProject, projectsLoading } = useContext(ProcessContext);
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const currentProjectObj = projects.find(p => p.id === currentProject);

  const handleProjectSelect = (projectId) => {
    setMenuOpen(false);
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
      {/* autoClose="outside": typing in the public-project search box must not immediately
          close the menu — only a click outside the whole dropdown does. */}
      <Dropdown show={menuOpen} onToggle={setMenuOpen} autoClose="outside" onSelect={handleProjectSelect} data-rb-guard>
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
          <Dropdown.Divider />
          <PublicProjectSearch onSelect={() => setMenuOpen(false)} />
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

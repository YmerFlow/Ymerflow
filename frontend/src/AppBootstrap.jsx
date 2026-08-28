import { useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ProcessContext, buildUrlPath } from './ProcessContext';
import { useWorkspace, useWorkspaces, usePublicWorkspaces } from './datamodel/useQueries';

// Latest version number of a workspace (or null if it has none).
const latestVersion = (ws) => ws?.versions?.[ws.versions.length - 1]?.version ?? null;

// On landing at /app (or any URL missing a /w/ segment) while signed in, write a workspace —
// and, when the user has projects, a project — into the URL in a single atomic navigation, so
// the selectors are never stranded at *None*.
//
//   • user has ≥1 project → first project + that project's first workspace (else `default`)
//     → /app/w/<ws>/wv/<v>/p/<project0>
//   • user has no projects → first public/superpublic workspace (`default`)
//     → /app/w/<ws>/wv/<v>
//
// Renders null — a behaviour-only sibling of <AutoCreateProjectDialog /> / <AutoOpenProcessEditor />.
function AppBootstrap() {
  const { projects, projectsLoading, currentProject, selectedEnvironment } = useContext(ProcessContext);
  const navigate = useNavigate();
  const location = useLocation();

  const targetProjectId = currentProject ?? projects[0]?.id ?? null;
  const { data: projectWorkspaces = [], isLoading: pwLoading } = useWorkspaces(targetProjectId);
  const { data: defaultWorkspace } = useWorkspace('default');
  const { data: publicWorkspaces = [], isLoading: pubLoading } = usePublicWorkspaces();

  // Guard so we navigate at most once per needed bootstrap; the guard is only really needed to
  // avoid re-running while React re-renders before the navigation lands, since once the URL has
  // a workspace `selectedEnvironment` is truthy and the early return below stops us anyway.
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (!location.pathname.startsWith('/app')) return;
    if (selectedEnvironment) return;   // workspace already in URL — nothing to bootstrap
    if (projectsLoading) return;       // wait for the project list
    if (navigatedRef.current) return;

    if (targetProjectId) {
      if (pwLoading) return;           // wait for that project's workspaces before choosing
      const ws = projectWorkspaces[0] ?? defaultWorkspace;
      if (!ws) return;                 // default not loaded yet — wait, don't guess
      navigatedRef.current = true;
      navigate(buildUrlPath(ws.id, latestVersion(ws), targetProjectId, null, null, null, null));
      // → /app/w/<ws>/wv/<v>/p/<project>   (single atomic navigation)
    } else {
      if (pubLoading) return;          // wait for the public list
      const ws = (publicWorkspaces.find(w => w.superpublic) ?? publicWorkspaces[0]) ?? defaultWorkspace;
      if (!ws) return;
      navigatedRef.current = true;
      navigate(buildUrlPath(ws.id, latestVersion(ws), null, null, null, null, null));
      // → /app/w/<ws>/wv/<v>   (no project)
    }
  }, [
    location.pathname, selectedEnvironment, projectsLoading, targetProjectId,
    pwLoading, projectWorkspaces, defaultWorkspace,
    pubLoading, publicWorkspaces, navigate,
  ]);

  return null;
}

export default AppBootstrap;

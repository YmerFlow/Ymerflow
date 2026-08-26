import React, { useEffect, useState, useContext } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LayoutProvider } from './flexout/LayoutContext';
import { MainLayout } from './flexout/Layout';
import { ProcessProvider, ProcessContext } from './ProcessContext';
import { PlotGroupProvider } from './PlotGroupContext';
import { AuthProvider, AuthContext } from './AuthContext';
import { MessageProvider } from './MessageContext';
import MessageDisplay from './MessageDisplay';
import { MenuProvider, useRegisterMenuComponent } from "./flexout/MenuContext";
import MenuBar from "./flexout/MenuBar";
import ProcessSelector from "./ProcessSelector";
import ProjectDropdown from "./ProjectDropdown";
import AutoCreateProjectDialog from "./AutoCreateProjectDialog";
import AutoOpenProcessEditor from "./AutoOpenProcessEditor";
import UserMenu from "./UserMenu";
import WorkspaceMenu from "./WorkspaceMenu";
import BrandLogo from "./BrandLogo";
import LandingPage from "./LandingPage";
import AccountPage from "./AccountPage";
import AdminPage from "./AdminPage";
import InviteAcceptPage from "./InviteAcceptPage";

import ProcessEditor from "./widgets/ProcessEditor";
import FlowView from "./widgets/FlowView";
import PlotView from "./widgets/PlotView";
import EnvironmentView from "./widgets/EnvironmentView";
import ProcessLog from "./widgets/ProcessLog";
import ProcessProgress from "./widgets/ProcessProgress";
import Export from "./widgets/Export";
import ProcessInfo from "./widgets/ProcessInfo";
import AEMModelSimulator from "./widgets/AEMModelSimulator";
import InUseEditor from "./widgets/InUseEditor";
import PluginManager from "./widgets/PluginManager";
import ClusterQueueView from "./widgets/ClusterQueueView";

import { registerHook, resetHooks, hooks } from './plugins/hooks';
import { buildDatasetRegistry } from './datamodel/datasetRegistry';
import { buildLayerTypeRegistry, buildQuantityKindRegistry } from './plugins/registries';
import { loadPlugins } from './plugins/loadPlugin';
import { API, getPublicationInfo } from './datamodel/api';

// Expose API URL for plugins that need to call the backend
if (typeof window !== 'undefined') window.__ymerflow_api = API;

// ── Register built-in dataset types ──────────────────────────────────────────
// These run at module load time (side effects) so the registry is populated
// before any component renders.
import { JsonDataset, XyzDataset, MagDataset } from './datamodel/dataset';
import { WebxtileDataset } from './datamodel/webxtile';
import SameAsBackendClusterForm from './clusterProviders/SameAsBackendClusterForm';
import KubeconfigClusterForm from './clusterProviders/KubeconfigClusterForm';
import S3StorageForm from './storageProviders/S3StorageForm';

registerHook('dataset_types', () => [
  { mimeType: 'application/json',                cls: JsonDataset },
  { mimeType: 'application/x-aarhusxyz-msgpack', cls: XyzDataset },
  { mimeType: 'application/x-magdata-msgpack',   cls: MagDataset },
  { mimeType: 'application/x-webxtile',          cls: WebxtileDataset },
]);

// ── Register built-in widgets ─────────────────────────────────────────────────
registerHook('widgets', () => [
  { name: 'PlotView',          component: PlotView },
  { name: 'FlowView',          component: FlowView },
  { name: 'ProcessEditor',     component: ProcessEditor },
  { name: 'EnvironmentView',   component: EnvironmentView },
  { name: 'ProcessLog',        component: ProcessLog },
  { name: 'ProcessProgress',   component: ProcessProgress },
  { name: 'Export',            component: Export },
  { name: 'ProcessInfo',       component: ProcessInfo },
  { name: 'AEMModelSimulator', component: AEMModelSimulator },
  { name: 'InUseEditor',       component: InUseEditor },
  { name: 'PluginManager',     component: PluginManager },
  { name: 'ClusterQueueView',  component: ClusterQueueView },
]);

// ── Register built-in cluster connection provider forms ──────────────────────
// 'minikube' (selfServiceRegistration: true) moved to plugins/ymerflow-minikube's own
// frontend_bundles-registered form — see docs/plans/minikube-provisioning-plugin.md. A plugin
// registering a similarly asynchronous/credential-driven cluster type (e.g. GKE) sets the same
// flag on its own cluster_provider_forms entry.
registerHook('cluster_provider_forms', () => [
  { type: 'same-as-backend', title: 'Same cluster as backend', Component: SameAsBackendClusterForm },
  { type: 'kubeconfig',      title: 'Kubeconfig',               Component: KubeconfigClusterForm },
]);

// ── Register built-in storage protocol connection forms ──────────────────────
// 'minio' moved to plugins/ymerflow-minikube's own frontend_bundles-registered form.
registerHook('storage_protocol_forms', () => [
  { type: 's3', title: 'AWS S3', Component: S3StorageForm },
]);

// Note: buildDatasetRegistry() and friends are called AFTER plugins load in AuthenticatedApp,
// so plugin-contributed types are included. See useEffect inside AuthenticatedApp.

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function buildWidgets() {
  const map = Object.fromEntries(
    hooks.run.widgets().map(({ name, component }) => [name, component])
  );
  window.__ymerflow_widgets = map;
  return map;
}

var initial_layout = {
    "splitType": "vertical",
    "id": "root",
    "widget": "VerticalSplit",
    "children": [
        {
            "id": "35501582-95b5-458e-b8ca-3a2b63413eac",
            "widget": "FlowView"
        },
        {
            "id": "794e8232-a793-4ff6-9372-3c94169a3eac",
            "widget": "TabSet",
            "children": [
                {
                    "id": "8658b5f1-d171-49b0-8dd9-73e46b469e5d",
                    "widget": "ProcessEditor"
                },
                {
                    "id": "d1e9273c-c3ca-4261-b14a-55cc0e45f583",
                    "widget": "PlotView"
                }
            ]
        }
    ]
};

function MenuBarWithComponents() {
  useRegisterMenuComponent(["_brandLogo"], BrandLogo, 0);
  useRegisterMenuComponent(["_projectDropdown"], ProjectDropdown, -2);
  useRegisterMenuComponent(["_workspaceMenu"], WorkspaceMenu, 2);
  useRegisterMenuComponent(["_processSelector"], ProcessSelector, -1);

  return <>
    {hooks.run_jsx.menu_registrars({ context: 'in' })}
    <UserMenu />
    <MenuBar />
  </>;
}

function PageChrome({ children }) {
  return (
    <div className="d-flex flex-column h-100">
      <MessageDisplay />
      <MenuBarWithComponents />
      <div className="flex-grow-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}

function RequireAdmin({ children }) {
  const { user } = useContext(AuthContext);
  if (!user?.is_admin) {
    return <Navigate to="/app" replace />;
  }
  return children;
}

function AppWithContext({ widgets }) {
  const processContext = useContext(ProcessContext);
  const location = useLocation();
  const [layoutToUse, setLayoutToUse] = useState(initial_layout);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  // Load workspace on mount based on URL or fall back to 'default'
  useEffect(() => {
    const loadInitialWorkspace = async () => {
      // Extract workspace ID and version from URL path (e.g. /app/w/:workspace/wv/:workspaceVersion/...)
      const match = location.pathname.match(/\/w\/([^/]+)/);
      const workspaceId = match ? match[1] : 'default';
      const versionMatch = location.pathname.match(/\/wv\/([^/]+)/);
      const workspaceVersion = versionMatch ? parseInt(versionMatch[1], 10) : null;

      try {
        const { getWorkspace } = await import('./datamodel/api');
        const workspace = await getWorkspace(workspaceId);
        const versions = workspace?.versions ?? [];
        const selectedVersion = versions.find(v => v.version === workspaceVersion) ?? versions[versions.length - 1];
        if (selectedVersion) {
          setLayoutToUse(selectedVersion.layout);
        }
      } catch (error) {
        console.error('Failed to load workspace, using hardcoded layout:', error);
      } finally {
        setLayoutLoaded(true);
      }
    };

    loadInitialWorkspace();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!layoutLoaded) {
    return <div className="d-flex align-items-center justify-content-center h-100">
      <div className="spinner-border" role="status">
        <span className="visually-hidden">Loading workspace...</span>
      </div>
    </div>;
  }

  return (
    <LayoutProvider widgets={widgets} initial_layout={layoutToUse} data_context={processContext}>
      <MenuProvider>
        <Routes>
          <Route path="/account/:tab?" element={
            <PageChrome><AccountPage /></PageChrome>
          } />
          <Route path="/admin/:tab?" element={
            <RequireAdmin>
              <PageChrome><AdminPage /></PageChrome>
            </RequireAdmin>
          } />
          <Route path="/app/*" element={
            <div className="d-flex flex-column h-100">
              <MessageDisplay />
              <MenuBarWithComponents />
              <div className="flex-grow-1 overflow-hidden">
                <MainLayout />
              </div>
              <AutoCreateProjectDialog />
              <AutoOpenProcessEditor />
            </div>
          } />
          {hooks.run.pages().map(({ path, component: C }) => (
            <Route key={path} path={`/app/plugin/${path}`} element={<C />} />
          ))}
          {hooks.run_jsx.app_routes().map(({ path, element }) => (
            <Route key={path} path={path} element={element} />
          ))}
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </MenuProvider>
    </LayoutProvider>
  );
}

function AuthenticatedApp() {
  const { isAuthenticated, token } = useContext(AuthContext);
  const location = useLocation();
  const [pluginsReady, setPluginsReady] = useState(false);
  const [widgets, setWidgets] = useState(null);
  // Tracks whether the URL's /p/:id segment resolves to an anonymous-viewable publication,
  // so an unauthenticated visitor with a publication link can still render /app/* instead
  // of being bounced to the login page. { status: 'idle'|'checking'|'done', allowed: bool }
  const [publicationCheck, setPublicationCheck] = useState({ status: 'idle', allowed: false });

  const publicationIdFromUrl = (() => {
    const match = location.pathname.match(/\/p\/([^/]+)/);
    return match ? match[1] : null;
  })();

  // Resolve GET /publications/{id} whenever an unauthenticated visitor's URL names a
  // project/publication id — determines whether to render read-only or redirect to login.
  useEffect(() => {
    if (isAuthenticated || !publicationIdFromUrl) {
      setPublicationCheck({ status: 'idle', allowed: false });
      return;
    }
    let cancelled = false;
    setPublicationCheck({ status: 'checking', allowed: false });
    getPublicationInfo(publicationIdFromUrl)
      .then(info => {
        if (!cancelled) setPublicationCheck({ status: 'done', allowed: !!info.allow_anonymous });
      })
      .catch(() => {
        if (!cancelled) setPublicationCheck({ status: 'done', allowed: false });
      });
    return () => { cancelled = true; };
  }, [isAuthenticated, publicationIdFromUrl]);

  const anonymousViewingAllowed = !isAuthenticated && publicationCheck.status === 'done' && publicationCheck.allowed;

  // Load plugins from GET /plugins/me before rendering the main app. This runs on every
  // auth transition (the effect keys on [isAuthenticated, token]): an anonymous visitor
  // loads the public bundle set, an authenticated visitor loads the full set. Because the
  // frontend hook registry is append-only, we resetHooks() back to the host built-ins
  // before each reload so hooks don't double-register and a logged-in user's private
  // plugin hooks don't leak after logout. After plugins load, all derived registries are
  // rebuilt so plugin contributions are included.
  useEffect(() => {
    setPluginsReady(false);
    resetHooks();
    fetch(`${API}/plugins/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
      .then(plugins => loadPlugins(plugins))
      .catch(() => {})
      .finally(() => {
        buildDatasetRegistry();
        buildLayerTypeRegistry();
        buildQuantityKindRegistry();
        setWidgets(buildWidgets());
        setPluginsReady(true);
      });
  }, [isAuthenticated, token]);

  // When not logged in on a special URL, persist path/token for post-login redirect
  useEffect(() => {
    if (!isAuthenticated) {
      const path = location.pathname;
      const projectInviteMatch = path.match(/^\/invite\/([^/]+)$/);
      if (projectInviteMatch) {
        sessionStorage.setItem('pendingInviteToken', projectInviteMatch[1]);
      } else if (path !== '/' && path !== '/app') {
        // Store arbitrary paths so plugins can restore fullscreen pages after login
        sessionStorage.setItem('pendingPath', path);
      }
    }
  }, [location.pathname, isAuthenticated]);

  if (!isAuthenticated) {
    if (publicationIdFromUrl && publicationCheck.status !== 'done') {
      // Still resolving the publication link — avoid a login-page flash while we check.
      return (
        <div className="d-flex align-items-center justify-content-center h-100">
          <div className="spinner-border" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
        </div>
      );
    }
    if (!anonymousViewingAllowed) {
      // Not an anonymous-viewable publication link. Render the logged-out plugin routes
      // registered by public plugins if the URL matches one; otherwise the landing page.
      // Wait for public plugins to load first so their logged_out_routes are registered
      // before we try to match the current URL.
      if (!pluginsReady) {
        return (
          <div className="d-flex align-items-center justify-content-center h-100">
            <div className="spinner-border" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          </div>
        );
      }
      return (
        <Routes>
          {hooks.run_jsx.logged_out_routes().map(({ path, element }) => (
            <Route key={path} path={path} element={element} />
          ))}
          <Route path="*" element={<LandingPage />} />
        </Routes>
      );
    }
    // Falls through: valid anonymous-allowed publication link — render /app/* read-only.
  }

  if (!pluginsReady) {
    return (
      <div className="d-flex align-items-center justify-content-center h-100">
        <div className="spinner-border" role="status">
          <span className="visually-hidden">Loading plugins...</span>
        </div>
      </div>
    );
  }

  // Check fullscreen pages registered by plugins — rendered without app chrome
  const fullscreenPages = hooks.run.fullscreen_pages();
  const currentFullscreen = fullscreenPages.find(p => location.pathname.startsWith(p.path));
  if (currentFullscreen) {
    return <currentFullscreen.Component />;
  }
  // Restore fullscreen page after post-login redirect (path stored before auth)
  const pendingPath = sessionStorage.getItem('pendingPath');
  if (pendingPath) {
    const pendingFullscreen = fullscreenPages.find(p => pendingPath.startsWith(p.path));
    if (pendingFullscreen) {
      return <pendingFullscreen.Component />;
    }
    sessionStorage.removeItem('pendingPath');
  }

  // Show invite page when arriving at an invite URL while already logged in,
  // or when there's a pending token from sessionStorage (after post-login redirect)
  const urlInviteMatch = location.pathname.match(/^\/invite\/([^/]+)$/);
  const pendingToken = sessionStorage.getItem('pendingInviteToken');
  const inviteToken = urlInviteMatch ? urlInviteMatch[1] : pendingToken;
  if (inviteToken) {
    return <InviteAcceptPage token={inviteToken} />;
  }

  const providers = hooks.run_jsx.app_providers();
  const appNode = <AppWithContext widgets={widgets} />;
  return providers.reduceRight(
    (children, { Component }) => <Component>{children}</Component>,
    appNode
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MessageProvider>
          <PlotGroupProvider>
            <ProcessProvider>
              <AuthenticatedApp />
            </ProcessProvider>
          </PlotGroupProvider>
        </MessageProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

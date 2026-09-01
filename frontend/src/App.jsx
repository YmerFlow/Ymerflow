import React, { useEffect, useState, useContext } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './datamodel/queryClient';
import { LayoutProvider } from './flexout/LayoutContext';
import { MainLayout } from './flexout/Layout';
import { ProcessProvider, ProcessContext } from './ProcessContext';
import { PlotGroupProvider } from './PlotGroupContext';
import { AuthProvider, AuthContext } from './AuthContext';
import { MessageProvider } from './MessageContext';
import MessageDisplay from './MessageDisplay';
import { MenuProvider, useRegisterMenuComponent } from "./flexout/MenuContext";
import MenuBar from "./flexout/MenuBar";
import { useIsMobile } from "./hooks/useIsMobile";
import ProcessSelector from "./ProcessSelector";
import ProjectDropdown from "./ProjectDropdown";
import AutoCreateProjectDialog from "./AutoCreateProjectDialog";
import AutoOpenProcessEditor from "./AutoOpenProcessEditor";
import AppBootstrap from "./AppBootstrap";
import WorkspaceLayoutSync from "./WorkspaceLayoutSync";
import UserMenu from "./UserMenu";
import WorkspaceMenu from "./WorkspaceMenu";
import BrandLogo from "./BrandLogo";
import { LandingChrome, LandingContent } from "./LandingPage";
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
import ProcessComparison from "./widgets/ProcessComparison";
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
  { name: 'ProcessComparison', component: ProcessComparison },
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

function buildWidgets() {
  const map = Object.fromEntries(
    hooks.run.widgets().map(({ name, component }) => [name, component])
  );
  window.__ymerflow_widgets = map;
  return map;
}

function MenuBarWithComponents() {
  const { isAuthenticated } = useContext(AuthContext);
  useRegisterMenuComponent(["_brandLogo"], BrandLogo, 0);
  useRegisterMenuComponent(["_projectDropdown"], ProjectDropdown, -2);
  useRegisterMenuComponent(["_workspaceMenu"], WorkspaceMenu, 2);
  useRegisterMenuComponent(["_processSelector"], ProcessSelector, -1);

  return <>
    {hooks.run_jsx.menu_registrars({ context: 'in' })}
    {/* No user menu for anonymous visitors (e.g. read-only publication links). */}
    {isAuthenticated && <UserMenu />}
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
  const isMobile = useIsMobile();

  // LayoutProvider starts Empty; WorkspaceLayoutSync fills it in from the URL's workspace.
  return (
    <LayoutProvider widgets={widgets} initial_layout={{ id: 'root', widget: 'Empty' }} data_context={processContext}>
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
              <div className={`flex-grow-1 ${isMobile ? 'overflow-auto' : 'overflow-hidden'}`}>
                <MainLayout />
              </div>
              <AppBootstrap />
              <WorkspaceLayoutSync />
              <AutoCreateProjectDialog />
              <AutoOpenProcessEditor />
            </div>
          } />
          {hooks.run.pages().map(({ path, component: C }) => (
            <Route key={path} path={`/app/plugin/${path}`} element={<C />} />
          ))}
          {hooks.run_jsx.app_routes().map(({ path, element }) => (
            <Route key={path} path={path} element={<PageChrome>{element}</PageChrome>} />
          ))}
          {/* Logged-out plugin routes (e.g. the CMS /page/* pages) are ALSO reachable while logged
              in — a shared/bookmarked logged-out URL resolves instead of bouncing to /app. They get
              the logged-in PageChrome here. They never appear in a logged-in menu: the menu bar only
              runs menu_registrars({ context: 'in' }), so 'out'-context pages are never listed. The
              reverse stays safe — app_routes/pages/fullscreen_pages are never mounted logged-out. */}
          {hooks.run_jsx.logged_out_routes().map(({ path, element }) => (
            <Route key={path} path={path} element={<PageChrome>{element}</PageChrome>} />
          ))}
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </MenuProvider>
    </LayoutProvider>
  );
}

function AuthenticatedApp() {
  const { isAuthenticated, token, authReady } = useContext(AuthContext);
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

  // Load plugins from GET /plugins/me before rendering the main app. Gated on authReady so
  // it never runs against the transient pre-hydration anonymous render: the effect only fires
  // once AuthContext has decided the logged-in-or-out question. It re-fires on real in-session
  // auth transitions (the key includes isAuthenticated): an anonymous visitor loads the public
  // bundle set, an authenticated visitor loads the full set. Because the frontend hook registry
  // is append-only, we resetHooks() back to the host built-ins before each reload so hooks don't
  // double-register and a logged-in user's private plugin hooks don't leak after logout. After
  // plugins load, all derived registries are rebuilt so plugin contributions are included.
  useEffect(() => {
    if (!authReady) return;  // don't load against unknown auth state
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
    // token is read inside for the Authorization header but is intentionally not a trigger —
    // isAuthenticated already gates every transition that changes it; keying on token too would
    // re-fire on same-auth token refreshes for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, isAuthenticated]);

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
        <LandingChrome>
          <Routes>
            {hooks.run_jsx.logged_out_routes().map(({ path, element }) => (
              <Route key={path} path={path} element={element} />
            ))}
            <Route path="*" element={<LandingContent />} />
          </Routes>
        </LandingChrome>
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

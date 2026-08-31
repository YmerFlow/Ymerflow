import axios from 'axios';
import { unpackBinary } from 'msgpack-numpy-js';

// API URL from environment variable, fallback to localhost for development.
// In production (nginx proxy mode) this is set to "/api" at build time.
export const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// Absolute HTTP base URL — needed when API is a relative path (prod nginx proxy mode).
export const ABSOLUTE_API = API.startsWith('http')
  ? API
  : `${window.location.protocol}//${window.location.host}${API}`;

// WebSocket base URL.
// When API is an absolute URL (dev), derive by replacing http→ws.
// When API is a relative path (prod nginx proxy), use window.location host.
const _wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
export const WS_API = API.startsWith('http')
  ? API.replace(/^http/, 'ws')
  : `${_wsProto}://${window.location.host}`;

const apiClient = axios.create({
  baseURL: API,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Authentication functions
export function setAuthToken(token) {
  if (token) {
    apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common['Authorization'];
  }
}

// Synchronous init: set token before any React render so reload doesn't race with useEffect
const _initialToken = localStorage.getItem('auth_token');
if (_initialToken) {
  setAuthToken(_initialToken);
}

export async function login(username, password) {
  const response = await apiClient.post('/auth/login', { username, password });
  return response.data;
}

export async function signup(username, password, email = null, agreedTosVersion = null) {
  const body = { username, password };
  if (email) body.email = email;
  if (agreedTosVersion !== null && agreedTosVersion !== undefined) body.agreed_tos_version = agreedTosVersion;
  const response = await apiClient.post('/auth/signup', body);
  return response.data;
}

export async function acceptTos(version) {
  const response = await apiClient.post('/auth/tos/accept', { version });
  return response.data;
}

export async function listAdminTosVersions() {
  const response = await apiClient.get('/admin/tos-versions');
  return response.data;
}

export async function createAdminTosVersion(body) {
  const response = await apiClient.post('/admin/tos-versions', body);
  return response.data;
}

// ── Admin stats dashboard (docs/plans/admin-stats-pivot-redesign.md) ─────────────────────────

export async function getAdminStatsSummary() {
  const response = await apiClient.get('/admin/stats/summary');
  return response.data;
}

// Static per-deploy dimension / filter whitelist — the single source of truth the pivot UI
// renders its builders from (Decision 5).
export async function getAdminStatsSchema() {
  const response = await apiClient.get('/admin/stats/schema');
  return response.data;
}

// Free N-dimensional GROUP BY. `group_by` is an ordered array sent as a repeated query param;
// axios serialises arrays with `arrayFormat: 'repeat'` so group_by=[a,b] → ?group_by=a&group_by=b.
export async function getAdminStatsPivot(params) {
  const response = await apiClient.get('/admin/stats/pivot', {
    params,
    paramsSerializer: { indexes: null },
  });
  return response.data;
}

export async function getInviteInfo(token) {
  const response = await apiClient.get(`/auth/invites/${token}`);
  return response.data;
}

export async function acceptInvite(token) {
  const response = await apiClient.post(`/auth/invites/${token}/accept`);
  return response.data;
}

export async function getProjectMembers(projectId) {
  const response = await apiClient.get(`/projects/${projectId}/members`);
  return response.data;
}

export async function getProjectInvites(projectId) {
  const response = await apiClient.get(`/projects/${projectId}/invites`);
  return response.data;
}

export async function createProjectInvite(projectId, email) {
  const response = await apiClient.post(`/projects/${projectId}/invites`, { email });
  return response.data;
}

export async function cancelProjectInvite(projectId, inviteId) {
  const response = await apiClient.delete(`/projects/${projectId}/invites/${inviteId}`);
  return response.data;
}

export async function leaveProject(projectId) {
  const response = await apiClient.delete(`/projects/${projectId}/members/me`);
  return response.data;
}

export async function getPublications(projectId) {
  const response = await apiClient.get(`/projects/${projectId}/publications`);
  return response.data;
}

export async function createPublication(projectId, { findable = false, allowAnonymous = true } = {}) {
  const response = await apiClient.post(`/projects/${projectId}/publications`, {
    findable,
    allow_anonymous: allowAnonymous,
  });
  return response.data;
}

export async function deletePublication(projectId, publicationId) {
  const response = await apiClient.delete(`/projects/${projectId}/publications/${publicationId}`);
  return response.data;
}

export async function getPublicationInfo(publicationId) {
  const response = await apiClient.get(`/publications/${publicationId}`);
  return response.data;
}

export async function getPublicPublications() {
  const response = await apiClient.get('/publications/public');
  return response.data;
}

export async function updatePublication(projectId, publicationId, { findable, superpublic } = {}) {
  const body = {};
  if (findable !== undefined) body.findable = findable;
  if (superpublic !== undefined) body.superpublic = superpublic;
  const response = await apiClient.patch(`/projects/${projectId}/publications/${publicationId}`, body);
  return response.data;
}

export async function getApiKeys() {
  const response = await apiClient.get('/auth/api-keys');
  return response.data;
}

export async function createApiKey(label, projectIds, expiresAt = null) {
  const body = { label, project_ids: projectIds || [] };
  if (expiresAt) body.expires_at = expiresAt;
  const response = await apiClient.post('/auth/api-keys', body);
  return response.data;
}

export async function deleteApiKey(keyId) {
  const response = await apiClient.delete(`/auth/api-keys/${keyId}`);
  return response.data;
}

export async function forgotPassword(email) {
  const response = await apiClient.post('/auth/forgot-password', { email });
  return response.data;
}

export async function getUserAccount() {
  const response = await apiClient.get('/auth/account');
  return response.data;
}

export async function getPublicConfig() {
  const response = await apiClient.get('/public-config');
  return response.data;
}

export async function getTos() {
  const response = await apiClient.get('/auth/tos');
  return response.data;
}

export async function updateUserPreferences(preferences) {
  const response = await apiClient.put('/auth/account/preferences', preferences);
  return response.data;
}

export async function updateUserEmail(email) {
  const response = await apiClient.put('/auth/account/email', { email });
  return response.data;
}

export async function listAdminUsers({ q, sort, dir, limit, offset } = {}) {
  const response = await apiClient.get('/auth/admin/users', {
    params: { q: q || undefined, sort, dir, limit, offset },
  });
  return response.data;   // { items, total }
}

export async function setUserAdmin(username, isAdmin) {
  const response = await apiClient.put(`/auth/admin/users/${username}/admin`, { is_admin: isAdmin });
  return response.data;
}

export async function listAdminClusters() {
  const response = await apiClient.get('/admin/clusters');
  return response.data;
}

export async function createAdminCluster(body) {
  const response = await apiClient.post('/admin/clusters', body);
  return response.data;
}

export async function updateAdminCluster(clusterId, body) {
  const response = await apiClient.patch(`/admin/clusters/${clusterId}`, body);
  return response.data;
}

export async function testAdminClusterConnection(body) {
  const response = await apiClient.post('/admin/clusters/test-connection', body);
  return response.data;
}

// Polled by the still-open "Add Cluster" dialog for a self-service (e.g. "minikube") cluster type
// after the admin runs the setup command — 404 until POST /admin/clusters/register-callback has
// created/updated the Cluster row for this client-generated token, so a 404 is treated as "not
// found yet" (null), not an error, letting the caller's poll keep going.
export async function getAdminClusterByRegistrationToken(token) {
  try {
    const response = await apiClient.get('/admin/clusters/by-registration-token', { params: { token } });
    return response.data;
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

export async function listAdminStorageBackends() {
  const response = await apiClient.get('/admin/storage-backends');
  return response.data;
}

export async function createAdminStorageBackend(body) {
  const response = await apiClient.post('/admin/storage-backends', body);
  return response.data;
}

export async function updateAdminStorageBackend(backendId, body) {
  const response = await apiClient.patch(`/admin/storage-backends/${backendId}`, body);
  return response.data;
}

export async function testAdminStorageBackendConnection(body) {
  const response = await apiClient.post('/admin/storage-backends/test-connection', body);
  return response.data;
}

export async function getProjects(viewingId = null) {
  const response = await apiClient.get('/projects', {
    params: viewingId ? { viewing_id: viewingId } : {},
  });
  return response.data;
}

export async function getAvailableClusters(projectId, resourceRequests) {
  const response = await apiClient.get(`/projects/${projectId}/utilities/available-clusters`, {
    params: {
      ...(resourceRequests?.cpu ? { cpu: resourceRequests.cpu } : {}),
      ...(resourceRequests?.memory ? { memory: resourceRequests.memory } : {}),
    },
  });
  return response.data;
}

export async function getAvailableStorageBackends() {
  const response = await apiClient.get('/utilities/available-storage-backends');
  return response.data;
}

export async function getClusterQueues() {
  const response = await apiClient.get('/utilities/cluster-queues');
  return response.data;
}

export async function createProject(name, storageBackendId) {
  const response = await apiClient.post('/projects', { name, storage_backend_id: storageBackendId });
  return response.data;
}

export async function exportProject(projectId) {
  const response = await apiClient.post(`/projects/${projectId}/export`);
  return response.data;
}

export async function getProjectExport(projectId, exportId) {
  const response = await apiClient.get(`/projects/${projectId}/export/${exportId}`);
  return response.data;
}

// Seed an already-created (empty) project from a previously-uploaded export zip. The zip must
// have been uploaded into this same project (POST /projects/{projectId}/upload).
export async function importProject(projectId, uploadId) {
  const response = await apiClient.post(`/projects/${projectId}/import`, { upload_id: uploadId });
  return response.data;
}

export async function getProjectImport(importId) {
  const response = await apiClient.get(`/projects/import/${importId}`);
  return response.data;
}

export async function getEnvironments() {
  const response = await apiClient.get('/environments', { params: { include_schemas: true } });
  return response.data;
}

export async function createEnvironment(env) {
  const response = await apiClient.post('/environments', env);
  return response.data;
}

export async function getEnvironmentProcessTypes(environmentId) {
  const response = await apiClient.get(`/environments/${environmentId}/process-types`);
  return response.data;
}

export async function getProcesses(projectId) {
  // verbose=true: the frontend (FlowView etc.) needs the full per-version payload
  // (parameters, outputs, …). The endpoint defaults to a terse summary for MCP callers;
  // this hidden flag opts back into the historical full shape. See
  // docs/plans/done/mcp-terse-process-tools.md.
  const response = await apiClient.get(`/projects/${projectId}/processes`, {
    params: { verbose: true },
  });
  return response.data;
}

export async function createProcess(proc, projectId) {
  const response = await apiClient.post(`/projects/${projectId}/process`, proc);
  return response.data;
}

export async function getProcessLogs(processId, version, projectId) {
  const response = await apiClient.get(`/projects/${projectId}/process/${processId}/logs`, {
    params: version !== null && version !== undefined ? { version } : {},
  });
  return response.data;
}

export async function cancelProcessVersion(processId, version, projectId) {
  const response = await apiClient.post(`/projects/${projectId}/process/${processId}/versions/${version}/cancel`);
  return response.data;
}

export async function updateProcessPosition(processId, x, y, projectId) {
  await apiClient.patch(`/projects/${projectId}/process/${processId}/position`, { x, y });
}

export async function getDataset(datasetId, projectId) {
  const response = await apiClient.get(`/projects/${projectId}/dataset/${datasetId}`);
  return response.data;
}

export async function searchDatasets(search = "", completedOnly = true, projectId = null) {
  const response = await apiClient.get(`/projects/${projectId}/datasets`, {
    params: {
      search,
      completed_only: completedOnly,
    },
  });
  return response.data;
}

// Load all datasets for a process version from its outputs
export async function getProcessOutputDatasets(process, version, projectId) {
  if (!process || !version) return [];

  const versionObj = getProcessVersion(process, version);
  if (!versionObj?.outputs) {
    return [];
  }

  const datasetPromises = Object.entries(versionObj.outputs).map(async ([name, url]) => {
    // Extract dataset ID from URL (supports both old and new formats)
    let datasetId;
    if (url.includes('/datasets/')) {
      // New format: /files/.../datasets/{id}/...
      const match = url.match(/\/datasets\/([^/]+)\//);
      if (match) {
        datasetId = match[1];
      }
    } else {
      // Old format: /projects/{project_id}/dataset/{id}
      datasetId = url.split('/').pop();
    }

    if (datasetId) {
      const dataset = await getDataset(datasetId, projectId);
      return dataset;
    }
    return null;
  });

  const results = await Promise.all(datasetPromises);
  return results.filter(ds => ds !== null);
}

// Get a specific version of a process
export function getProcessVersion(process, version) {
  if (!process || !process.versions) return null;
  return process.versions.find(v => v.version === version);
}

// Get latest version number for a process
export function getLatestVersion(process) {
  if (!process || !process.versions || process.versions.length === 0) return 1;
  return Math.max(...process.versions.map(v => v.version));
}

// Get the latest version object for a process (highest version number).
export function getLatestVersionObj(process) {
  if (!process || !process.versions || process.versions.length === 0) return null;
  return process.versions.reduce((a, b) => (b.version > a.version ? b : a));
}

// Get the process type of the latest version. `type` and `environment` moved from Process to
// ProcessVersion (each run records its own), so read them from a version — typically the latest.
export function getLatestProcessType(process) {
  return getLatestVersionObj(process)?.type ?? null;
}

export function getLatestProcessEnvironment(process) {
  return getLatestVersionObj(process)?.environment ?? null;
}

// Get data for a dataset or part
export async function getDatasetData(datasetId, partPath = "all", projectId) {
  let url;
  if (partPath === "all") {
    url = `/projects/${projectId}/dataset/${datasetId}/data`;
  } else {
    url = `/projects/${projectId}/dataset/${datasetId}/${partPath}/data`;
  }
  const response = await apiClient.get(url);
  return response.data;
}

// Get geography for a dataset or part
export async function getDatasetGeography(datasetId, partPath = "all", projectId) {
  let url;
  if (partPath === "all") {
    url = `/projects/${projectId}/dataset/${datasetId}/geography`;
  } else {
    url = `/projects/${projectId}/dataset/${datasetId}/${partPath}/geography`;
  }
  const response = await apiClient.get(url);
  return response.data;
}

// Upload a file. Sends the raw File as the request body so the backend can stream it
// straight to object storage (flat memory regardless of size). The filename travels as
// a query param and the content type as the Content-Type header.
export async function uploadFile(file, onProgress, projectId) {
  const response = await apiClient.post(`/projects/${projectId}/upload`, file, {
    params: { filename: file.name },
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    onUploadProgress: (progressEvent) => {
      if (onProgress && progressEvent.lengthComputable) {
        const percentComplete = (progressEvent.loaded / progressEvent.total) * 100;
        onProgress(percentComplete);
      }
    }
  });

  return response.data;
}

// Survey systems (msgpack responses — preserve numpy arrays inside each system's `gex`).
export async function listSystems(projectId) {
  const response = await apiClient.get(`/projects/${projectId}/systems`, {
    responseType: 'arraybuffer',
  });
  return unpackBinary(new Uint8Array(response.data));
}

export async function createSystem(projectId, { name, uploadId }) {
  const response = await apiClient.post(
    `/projects/${projectId}/systems`,
    { name, upload_id: uploadId },
    { responseType: 'arraybuffer' }
  );
  return unpackBinary(new Uint8Array(response.data));
}

export async function getProjectTags(projectId) {
  const response = await apiClient.get(`/projects/${projectId}/tags`);
  return response.data;
}

export async function createProjectTag(projectId, tag) {
  const response = await apiClient.post(`/projects/${projectId}/tags`, tag);
  return response.data;
}

export async function updateProjectTag(projectId, tagId, tag) {
  const response = await apiClient.put(`/projects/${projectId}/tags/${tagId}`, tag);
  return response.data;
}

export async function deleteProjectTag(projectId, tagId) {
  const response = await apiClient.delete(`/projects/${projectId}/tags/${tagId}`);
  return response.data;
}

export async function addVersionTag(processId, version, tagId, projectId) {
  const response = await apiClient.post(`/projects/${projectId}/process/${processId}/versions/${version}/tags/${tagId}`);
  return response.data;
}

export async function removeVersionTag(processId, version, tagId, projectId) {
  const response = await apiClient.delete(`/projects/${projectId}/process/${processId}/versions/${version}/tags/${tagId}`);
  return response.data;
}

// Plugin functions
export async function getPlugins() {
  const response = await apiClient.get('/plugins');
  return response.data;
}

export async function getMyPlugins() {
  const response = await apiClient.get('/plugins/me');
  return response.data;
}

export async function enablePlugin(pluginId) {
  const response = await apiClient.post(`/plugins/${pluginId}/enable`);
  return response.data;
}

export async function disablePlugin(pluginId) {
  const response = await apiClient.post(`/plugins/${pluginId}/disable`);
  return response.data;
}

export async function upgradePlugin(pluginId) {
  const response = await apiClient.post(`/plugins/${pluginId}/upgrade`);
  return response.data;
}

// NOTE: there is no buildPlugin()/registerPlugin(). A frontend plugin is built by submitting a
// `build_frontend_plugin` Process through the generic createProcess() (its parameter schema drives
// the form, like any process type). A completed build auto-registers its output as a
// Plugin/PluginVersion on the backend (like create_environment -> Environment), so it appears in
// GET /plugins automatically once the build is done.

// Fetch a single process (used to poll a build to completion).
export async function getProcess(processId, projectId) {
  // verbose=true: opt back into the full per-version payload (see getProcesses above and
  // docs/plans/done/mcp-terse-process-tools.md). Without it the endpoint returns the terse
  // MCP summary shape (version rows, no parameters/outputs).
  const response = await apiClient.get(`/projects/${projectId}/process/${processId}`, {
    params: { verbose: true },
  });
  return response.data;
}

// Workspace functions
export async function getWorkspaces(projectId) {
  const response = await apiClient.get('/workspaces', { params: { project_id: projectId } });
  return response.data;
}

export async function getPublicWorkspaces() {
  const response = await apiClient.get('/workspaces/public');
  return response.data;
}

export async function getWorkspace(workspaceId) {
  const response = await apiClient.get(`/workspace/${workspaceId}`);
  return response.data;
}

export async function saveWorkspace({ projectId, title, layout }) {
  const response = await apiClient.post('/workspace', { title, layout }, { params: { project_id: projectId } });
  return response.data;
}

export async function saveWorkspaceVersion(workspaceId, layout) {
  const response = await apiClient.post(`/workspace/${workspaceId}/versions`, { layout });
  return response.data;
}

export async function updateWorkspace(workspaceId, { title, is_public, superpublic } = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (is_public !== undefined) body.is_public = is_public;
  if (superpublic !== undefined) body.superpublic = superpublic;
  const response = await apiClient.patch(`/workspace/${workspaceId}`, body);
  return response.data;
}

export async function forkWorkspace(workspaceId, { projectId, version } = {}) {
  const response = await apiClient.post(
    `/workspace/${workspaceId}/fork`,
    version !== undefined ? { version } : {},
    { params: { project_id: projectId } }
  );
  return response.data;
}

export async function deleteWorkspace(workspaceId) {
  const response = await apiClient.delete(`/workspace/${workspaceId}`);
  return response.data;
}

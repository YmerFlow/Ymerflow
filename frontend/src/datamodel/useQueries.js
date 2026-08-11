import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useContext } from 'react';
import { AuthContext } from '../AuthContext';
import {
  getProcesses,
  createProcess,
  getDataset,
  searchDatasets,
  getProcessOutputDatasets,
  getEnvironments,
  createEnvironment,
  getEnvironmentProcessTypes,
  getProjects,
  createProject,
  exportProject,
  getProjectExport,
  importProject,
  getProjectImport,
  getAvailableClusters,
  getAvailableStorageBackends,
  getProjectMembers,
  getProjectInvites,
  createProjectInvite,
  cancelProjectInvite,
  cancelProcessVersion,
  leaveProject,
  getInviteInfo,
  acceptInvite,
  getPublications,
  createPublication,
  deletePublication,
  getProjectTags,
  createProjectTag,
  updateProjectTag,
  deleteProjectTag,
  addVersionTag,
  removeVersionTag,
  getPlugins,
  enablePlugin,
  disablePlugin,
  upgradePlugin,
  getWorkspaces,
  getPublicWorkspaces,
  getWorkspace,
  saveWorkspace,
  saveWorkspaceVersion,
  updateWorkspace,
  forkWorkspace,
  deleteWorkspace,
} from './api';

// Query keys
export const queryKeys = {
  projects: ['projects'],
  environments: ['environments'],
  environmentProcessTypes: (envId) => ['environmentProcessTypes', envId],
  processes: (projectId) => ['processes', projectId],
  dataset: (id) => ['dataset', id],
  datasets: (search, completedOnly, projectId) => ['datasets', { search, completedOnly, projectId }],
  processOutputDatasets: (processId, version) => ['processOutputDatasets', processId, version],
  availableClusters: (projectId, resourceRequests) => ['availableClusters', projectId, resourceRequests?.cpu, resourceRequests?.memory],
  availableStorageBackends: ['availableStorageBackends'],
  projectExport: (projectId, exportId) => ['projectExport', projectId, exportId],
  projectImport: (importId) => ['projectImport', importId],
  projectMembers: (projectId) => ['projectMembers', projectId],
  projectInvites: (projectId) => ['projectInvites', projectId],
  publications: (projectId) => ['publications', projectId],
  inviteInfo: (token) => ['inviteInfo', token],
  projectTags: (projectId) => ['projectTags', projectId],
  workspaces: (projectId) => ['workspaces', projectId],
  publicWorkspaces: ['publicWorkspaces'],
  workspace: (id) => ['workspace', id],
};

// Hook to fetch all projects. viewingId (a project or publication id currently being
// viewed) is pinned to the front of the list when it isn't already present — this lets
// an anonymous viewer with a publication link see that one entry even when not logged in.
export function useProjects(viewingId = null) {
  const { isAuthenticated } = useContext(AuthContext);
  return useQuery({
    queryKey: [...queryKeys.projects, viewingId],
    queryFn: () => getProjects(viewingId),
    enabled: isAuthenticated || !!viewingId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook to create a project
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ name, storageBackendId }) => createProject(name, storageBackendId),
    onSuccess: () => {
      // Invalidate and refetch projects list
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// Hook to start a project export job (fire-and-forget; poll its progress with useProjectExport)
export function useExportProject() {
  return useMutation({
    mutationFn: (projectId) => exportProject(projectId),
  });
}

// Polls an export job until it reaches a terminal state (done/failed).
export function useProjectExport(projectId, exportId, options = {}) {
  return useQuery({
    queryKey: queryKeys.projectExport(projectId, exportId),
    queryFn: () => getProjectExport(projectId, exportId),
    enabled: !!projectId && !!exportId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'done' || state === 'failed' ? false : 2000;
    },
    ...options,
  });
}

// Hook to seed an already-created (empty) project from a previously-uploaded export zip.
// The zip must have been uploaded into that same project.
export function useImportProject() {
  return useMutation({
    mutationFn: ({ projectId, uploadId }) => importProject(projectId, uploadId),
  });
}

// Polls an import job until it reaches a terminal state (done/failed).
export function useProjectImport(importId, options = {}) {
  return useQuery({
    queryKey: queryKeys.projectImport(importId),
    queryFn: () => getProjectImport(importId),
    enabled: !!importId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'done' || state === 'failed' ? false : 2000;
    },
    ...options,
  });
}

// Storage backends are not live/quota-based (unlike cluster limits), so a normal staleTime applies.
export function useAvailableStorageBackends() {
  return useQuery({
    queryKey: queryKeys.availableStorageBackends,
    queryFn: getAvailableStorageBackends,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook to fetch all environments
export function useEnvironments() {
  const { isAuthenticated } = useContext(AuthContext);
  return useQuery({
    queryKey: queryKeys.environments,
    queryFn: getEnvironments,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook to fetch process types for a specific environment
export function useEnvironmentProcessTypes(environmentId, options = {}) {
  return useQuery({
    queryKey: queryKeys.environmentProcessTypes(environmentId),
    queryFn: () => getEnvironmentProcessTypes(environmentId),
    enabled: !!environmentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}

// Hook to fetch all processes
export function useProcesses(projectId = null) {
  return useQuery({
    queryKey: queryKeys.processes(projectId),
    queryFn: () => getProcesses(projectId),
    enabled: !!projectId,
    staleTime: 10 * 1000, // 10 seconds
  });
}

// Hook to fetch a single dataset
export function useDataset(datasetId, projectId, options = {}) {
  return useQuery({
    queryKey: queryKeys.dataset(datasetId),
    queryFn: () => getDataset(datasetId, projectId),
    enabled: !!datasetId && !!projectId,
    staleTime: 30 * 1000, // 30 seconds
    ...options,
  });
}

// Hook to search datasets
export function useSearchDatasets(search = "", completedOnly = true, projectId = null, options = {}) {
  return useQuery({
    queryKey: queryKeys.datasets(search, completedOnly, projectId),
    queryFn: () => searchDatasets(search, completedOnly, projectId),
    enabled: !!projectId,
    staleTime: 10 * 1000, // 10 seconds
    ...options,
  });
}

// Hook to fetch process output datasets
export function useProcessOutputDatasets(process, version, projectId, options = {}) {
  // Include process state in query key so it refetches when state changes
  const versionObj = process?.versions?.find(v => v.version === version);
  const state = versionObj?.state || 'unknown';

  return useQuery({
    queryKey: [...queryKeys.processOutputDatasets(process?.id, version), state],
    queryFn: () => getProcessOutputDatasets(process, version, projectId),
    enabled: !!process && version != null && !!projectId,
    staleTime: 30 * 1000, // 30 seconds
    ...options,
  });
}

// Hook to create an environment
export function useCreateEnvironment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createEnvironment,
    onSuccess: () => {
      // Invalidate and refetch environments list
      queryClient.invalidateQueries({ queryKey: queryKeys.environments });
    },
  });
}

// Hook to create a process
// NOTE: Does NOT auto-invalidate queries. Callers must use ProcessContext invalidation helpers.
export function useCreateProcess() {
  return useMutation({
    mutationFn: ({ proc, projectId }) => createProcess(proc, projectId),
  });
}

// Hook to cancel a process version
// NOTE: Does NOT auto-invalidate queries. Callers must use ProcessContext invalidation helpers.
export function useCancelProcess() {
  return useMutation({
    mutationFn: ({ processId, version, projectId }) => cancelProcessVersion(processId, version, projectId),
  });
}

// Live limits are cluster-specific and can change (Kueue quota), so no staleTime — refetch on
// every cluster/resource-request change that alters the query key.
export function useAvailableClusters(projectId, resourceRequests) {
  return useQuery({
    queryKey: queryKeys.availableClusters(projectId, resourceRequests),
    queryFn: () => getAvailableClusters(projectId, resourceRequests),
  });
}

export function useProjectMembers(projectId) {
  return useQuery({
    queryKey: queryKeys.projectMembers(projectId),
    queryFn: () => getProjectMembers(projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

export function useProjectInvites(projectId) {
  return useQuery({
    queryKey: queryKeys.projectInvites(projectId),
    queryFn: () => getProjectInvites(projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

export function useInviteMember(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email) => createProjectInvite(projectId, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectInvites(projectId) });
    },
  });
}

export function useCancelInvite(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId) => cancelProjectInvite(projectId, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectInvites(projectId) });
    },
  });
}

export function useLeaveProject(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => leaveProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function usePublications(projectId) {
  return useQuery({
    queryKey: queryKeys.publications(projectId),
    queryFn: () => getPublications(projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

export function useCreatePublication(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ findable, allowAnonymous }) => createPublication(projectId, { findable, allowAnonymous }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.publications(projectId) });
    },
  });
}

export function useDeletePublication(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicationId) => deletePublication(projectId, publicationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.publications(projectId) });
    },
  });
}

export function useInviteInfo(token) {
  return useQuery({
    queryKey: queryKeys.inviteInfo(token),
    queryFn: () => getInviteInfo(token),
    enabled: !!token,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token) => acceptInvite(token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useProjectTags(projectId) {
  return useQuery({
    queryKey: queryKeys.projectTags(projectId),
    queryFn: () => getProjectTags(projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

export function useCreateTag(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tag) => createProjectTag(projectId, tag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTags(projectId) });
    },
  });
}

export function useUpdateTag(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, tag }) => updateProjectTag(projectId, tagId, tag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTags(projectId) });
    },
  });
}

export function useDeleteTag(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagId) => deleteProjectTag(projectId, tagId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTags(projectId) });
    },
  });
}

// NOTE: Does NOT auto-invalidate. Callers must use ProcessContext invalidation helpers.
export function useAddVersionTag() {
  return useMutation({
    mutationFn: ({ processId, version, tagId, projectId }) => addVersionTag(processId, version, tagId, projectId),
  });
}

// NOTE: Does NOT auto-invalidate. Callers must use ProcessContext invalidation helpers.
export function useRemoveVersionTag() {
  return useMutation({
    mutationFn: ({ processId, version, tagId, projectId }) => removeVersionTag(processId, version, tagId, projectId),
  });
}

// ── Plugin queries ────────────────────────────────────────────────────────────

export function usePlugins() {
  const { isAuthenticated } = useContext(AuthContext);
  return useQuery({
    queryKey: ['plugins'],
    queryFn: getPlugins,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
}

export function useEnablePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => enablePlugin(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useDisablePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => disablePlugin(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useUpgradePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => upgradePlugin(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

// NOTE: there is no useInstallPlugin(). A frontend plugin is built by creating a
// `build_frontend_plugin` process in the Process Editor (its schema drives the form); it
// auto-registers when the build completes and then appears in usePlugins(). This widget only
// enables/disables already-registered plugins.

// ── Workspace queries ─────────────────────────────────────────────────────────

// Each workspace embeds its full version list (including layout), so selecting a
// workspace/version in the UI never needs a follow-up fetch.
export function useWorkspaces(projectId) {
  return useQuery({
    queryKey: queryKeys.workspaces(projectId),
    queryFn: () => getWorkspaces(projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

export function usePublicWorkspaces() {
  return useQuery({
    queryKey: queryKeys.publicWorkspaces,
    queryFn: getPublicWorkspaces,
    staleTime: 30 * 1000,
  });
}

export function useWorkspace(workspaceId, options = {}) {
  return useQuery({
    queryKey: queryKeys.workspace(workspaceId),
    queryFn: () => getWorkspace(workspaceId),
    enabled: !!workspaceId,
    staleTime: 30 * 1000,
    ...options,
  });
}

export function useSaveWorkspace(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ title, layout }) => saveWorkspace({ projectId, title, layout }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
    },
  });
}

export function useSaveWorkspaceVersion(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, layout }) => saveWorkspaceVersion(workspaceId, layout),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
    },
  });
}

export function useUpdateWorkspace(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, title, is_public }) => updateWorkspace(workspaceId, { title, is_public }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.publicWorkspaces });
    },
  });
}

export function useForkWorkspace(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, version }) => forkWorkspace(workspaceId, { projectId, version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
    },
  });
}

export function useDeleteWorkspace(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId) => deleteWorkspace(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
    },
  });
}

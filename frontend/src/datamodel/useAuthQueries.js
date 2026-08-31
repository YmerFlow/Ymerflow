import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { login, signup, forgotPassword, getUserAccount, getPublicConfig, getTos, acceptTos, updateUserPreferences, updateUserEmail, getApiKeys, createApiKey, deleteApiKey, listAdminUsers, setUserAdmin, listAdminClusters, createAdminCluster, updateAdminCluster, testAdminClusterConnection, getAdminClusterByRegistrationToken, listAdminStorageBackends, createAdminStorageBackend, updateAdminStorageBackend, testAdminStorageBackendConnection, listAdminTosVersions, createAdminTosVersion, getAdminStatsSummary, getAdminStatsSchema, getAdminStatsPivot } from './api';

export function useLogin() {
  return useMutation({
    mutationFn: ({ username, password }) => login(username, password)
  });
}

export function useSignup() {
  return useMutation({
    mutationFn: ({ username, password, email, agreedTosVersion }) => signup(username, password, email, agreedTosVersion)
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: ({ email }) => forgotPassword(email)
  });
}

export function useUserAccount() {
  return useQuery({
    queryKey: ['userAccount'],
    queryFn: getUserAccount,
    enabled: false  // Manually triggered
  });
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['publicConfig'],
    queryFn: getPublicConfig,
    staleTime: Infinity,
  });
}

export function useTos() {
  return useQuery({
    queryKey: ['tos'],
    queryFn: getTos,
  });
}

export function useAcceptTos() {
  return useMutation({
    mutationFn: ({ version }) => acceptTos(version),
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateUserPreferences,
    onSuccess: () => {
      queryClient.invalidateQueries(['userAccount']);
    }
  });
}

export function useUpdateEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateUserEmail,
    onSuccess: () => {
      queryClient.invalidateQueries(['userAccount']);
    }
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['apiKeys'],
    queryFn: getApiKeys,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ label, projectIds, expiresAt }) => createApiKey(label, projectIds, expiresAt),
    onSuccess: () => {
      queryClient.invalidateQueries(['apiKeys']);
    }
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId) => deleteApiKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries(['apiKeys']);
    }
  });
}

export function useAdminUsers(params) {
  return useQuery({
    queryKey: ['adminUsers', params],   // params in the key → refetch on any change
    queryFn: () => listAdminUsers(params),
    keepPreviousData: true,             // avoid table flicker on page/sort change
  });
}

export function useSetUserAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, isAdmin }) => setUserAdmin(username, isAdmin),
    // Invalidate the ['adminUsers'] prefix so every param-keyed page refetches.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminUsers'] }),
  });
}

export function useAdminClusters() {
  return useQuery({
    queryKey: ['adminClusters'],
    queryFn: listAdminClusters,
    // Poll while any cluster (e.g. a freshly-created "minikube" one) is waiting on its
    // registration callback — see docs/plans/done/remote-cluster-provisioning-and-registry.md Phase 6.
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasPending = Array.isArray(data) && data.some(c => c.provisioning_status === 'pending');
      return hasPending ? 3000 : false;
    },
  });
}

export function useCreateAdminCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminCluster,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminClusters'] }),
  });
}

export function useUpdateAdminCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, body }) => updateAdminCluster(clusterId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminClusters'] }),
  });
}

export function useTestAdminClusterConnection() {
  return useMutation({ mutationFn: testAdminClusterConnection });
}

// Polls for the Cluster row a self-service (e.g. "minikube") registration token resolves to —
// see docs/plans/minikube-cluster-registration-ux.md. `token` null/undefined disables the query.
// Stops polling as soon as a match is found (query.state.data is truthy).
export function useAdminClusterByRegistrationToken(token) {
  return useQuery({
    queryKey: ['adminClusterByRegistrationToken', token],
    queryFn: () => getAdminClusterByRegistrationToken(token),
    enabled: !!token,
    retry: false,
    refetchInterval: (query) => (query.state.data ? false : 3000),
  });
}

export function useAdminStorageBackends() {
  return useQuery({
    queryKey: ['adminStorageBackends'],
    queryFn: listAdminStorageBackends,
  });
}

export function useCreateAdminStorageBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminStorageBackend,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminStorageBackends'] }),
  });
}

export function useUpdateAdminStorageBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ backendId, body }) => updateAdminStorageBackend(backendId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminStorageBackends'] }),
  });
}

export function useTestAdminStorageBackendConnection() {
  return useMutation({ mutationFn: testAdminStorageBackendConnection });
}

export function useAdminTosVersions() {
  return useQuery({
    queryKey: ['adminTosVersions'],
    queryFn: listAdminTosVersions,
  });
}

export function useCreateAdminTosVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminTosVersion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['adminTosVersions'] }),
  });
}

// ── Admin stats dashboard (docs/plans/admin-stats-pivot-redesign.md) ─────────────────────────
// Read-only; params live in the queryKey so pivoting/re-windowing refetches. keepPreviousData
// avoids chart/table flicker while the next slice loads. The schema is static per deploy.

export function useAdminStatsSummary() {
  return useQuery({
    queryKey: ['adminStatsSummary'],
    queryFn: getAdminStatsSummary,
  });
}

export function useAdminStatsSchema() {
  return useQuery({
    queryKey: ['adminStatsSchema'],
    queryFn: getAdminStatsSchema,
    staleTime: Infinity,
  });
}

export function useAdminStatsPivot(params) {
  return useQuery({
    queryKey: ['adminStatsPivot', params],
    queryFn: () => getAdminStatsPivot(params),
    enabled: !!(params && params.entity),
    keepPreviousData: true,
  });
}

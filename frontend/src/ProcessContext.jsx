import React, { createContext, useCallback, useMemo, useState, useEffect, useContext, useReducer } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useProcesses, useEnvironments, useProcessOutputDatasets, useProjects, useCreateProcess, useWorkspace } from "./datamodel/useQueries";
import { loadDataset, DatasetCollectionAdapter } from './datamodel/dataset';
import XYZ from './datamodel/libaarhusxyz';
import { useWebSocket } from './hooks/useWebSocket';
import { WS_API, uploadFile } from './datamodel/api';
import { recordNavView } from './datamodel/navTracking';
import { MessageContext } from './MessageContext';

export const ProcessContext = createContext();

// Moved outside component to avoid recreation
const INITIAL_DATASET_OBJECTS = {};
const INITIAL_FETCHED_DATA = {};

// ── InUse diff state ─────────────────────────────────────────────────────────
// diffs:   { [datasetName]: { [channel]: Map<gateIndex, Map<soundingIndex, 0|1>> } }
// history: { [datasetName]: snapshot[] }  (per-dataset undo stack)

function _deepCopyDatasetDiff(datasetDiff) {
  const result = {};
  for (const [channel, channelMap] of Object.entries(datasetDiff)) {
    const newMap = new Map();
    for (const [gateIdx, soundingMap] of channelMap.entries()) {
      newMap.set(gateIdx, new Map(soundingMap));
    }
    result[channel] = newMap;
  }
  return result;
}

function inUseDiffReducer(state, action) {
  switch (action.type) {
    case 'APPLY_EDIT': {
      const { datasetName, channel, entries, value } = action;
      const prevDatasetDiff = state.diffs[datasetName] ?? {};

      // Push snapshot before mutating
      const snapshot = _deepCopyDatasetDiff(prevDatasetDiff);
      const newHistory = {
        ...state.history,
        [datasetName]: [...(state.history[datasetName] ?? []), snapshot],
      };

      // Apply edits
      const newDatasetDiff = _deepCopyDatasetDiff(prevDatasetDiff);
      if (!newDatasetDiff[channel]) newDatasetDiff[channel] = new Map();
      const channelMap = newDatasetDiff[channel];

      for (const { soundingIndex, gateIndex } of entries) {
        if (!channelMap.has(gateIndex)) channelMap.set(gateIndex, new Map());
        const soundingMap = channelMap.get(gateIndex);
        if (value === undefined || value === null) {
          soundingMap.delete(soundingIndex);
        } else {
          soundingMap.set(soundingIndex, value);
        }
        if (soundingMap.size === 0) channelMap.delete(gateIndex);
      }

      return {
        diffs: { ...state.diffs, [datasetName]: newDatasetDiff },
        history: newHistory,
      };
    }
    case 'UNDO': {
      const { datasetName } = action;
      const history = state.history[datasetName] ?? [];
      if (history.length === 0) return state;
      const prevSnapshot = history[history.length - 1];
      return {
        diffs: { ...state.diffs, [datasetName]: prevSnapshot },
        history: { ...state.history, [datasetName]: history.slice(0, -1) },
      };
    }
    case 'CLEAR': {
      const { datasetName } = action;
      return {
        diffs: { ...state.diffs, [datasetName]: {} },
        history: { ...state.history, [datasetName]: [] },
      };
    }
    case 'CLEAR_ALL':
      return { diffs: {}, history: {} };
    default:
      return state;
  }
}
const EMPTY_ARRAY = [];

// Helper to parse URL pathname into params
// Expected format: /app/w/:workspace/wv/:workspaceVersion/p/:project/pr/:process/v/:version/part/:part/s/:sounding
// All segments are optional
function parseUrlParams(pathname) {
  const params = {
    workspace: null,
    workspaceVersion: null,
    project: null,
    process: null,
    version: null,
    part: null,
    sounding: null
  };

  // Strip /app prefix if present, then remove leading slash and split by /
  const cleanPath = pathname.replace(/^\/app/, '').replace(/^\//, '');
  const segments = cleanPath.split('/');

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === 'w' && i + 1 < segments.length) {
      params.workspace = segments[i + 1];
      i++;
    } else if (segment === 'wv' && i + 1 < segments.length) {
      params.workspaceVersion = parseInt(segments[i + 1], 10);
      i++;
    } else if (segment === 'p' && i + 1 < segments.length) {
      params.project = segments[i + 1];
      i++;
    } else if (segment === 'pr' && i + 1 < segments.length) {
      params.process = segments[i + 1];
      i++;
    } else if (segment === 'v' && i + 1 < segments.length) {
      params.version = parseInt(segments[i + 1], 10);
      i++;
    } else if (segment === 'part' && i + 1 < segments.length) {
      params.part = segments[i + 1];
      i++;
    } else if (segment === 's' && i + 1 < segments.length) {
      params.sounding = parseInt(segments[i + 1], 10);
      i++;
    }
  }

  return params;
}

// Helper to build URL path from params
export function buildUrlPath(workspace, workspaceVersion, project, process, version, part, sounding) {
  let path = '/app';

  if (workspace) {
    path += `/w/${workspace}`;
    if (workspaceVersion !== null && workspaceVersion !== undefined) {
      path += `/wv/${workspaceVersion}`;
    }
    if (project) {
      path += `/p/${project}`;
      if (process) {
        path += `/pr/${process}`;
        if (version !== null && version !== undefined) {
          path += `/v/${version}`;
          if (part) {
            path += `/part/${part}`;
          }
          if (sounding !== null && sounding !== undefined) {
            path += `/s/${sounding}`;
          }
        }
      }
    }
  }

  return path;
}

export function ProcessProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { addMessage } = useContext(MessageContext);

  // Parse current values from URL
  const urlParams = useMemo(() => parseUrlParams(location.pathname), [location.pathname]);

  // GUI usage tracking (docs/plans/done/gui-usage-nav-tracking.md). One capture chokepoint:
  // every navigation — navigate() setters, AppBootstrap landings, back/forward, pasted URLs —
  // flows through parseUrlParams here. Debounced ~700ms so only a *dwelled* coordinate is
  // recorded: rapid drill-down / scrubbing re-arms and the cleanup cancels the transient states.
  useEffect(() => {
    const { workspace, workspaceVersion, project, process, version, part, sounding } = urlParams;
    if (!workspace && !project && !process) return;  // bare /app → skip
    const t = setTimeout(() => {
      recordNavView({
        workspace,
        workspace_version: workspaceVersion,
        project,
        process,
        version,
        part: part === "all" ? null : part,  // normalise to match the URL builder (Decision 5)
        sounding,
      });
    }, 700);
    return () => clearTimeout(t);
  }, [urlParams]);

  // Extract values from URL - memoize objects to prevent unnecessary re-renders
  const selectedEnvironment = urlParams.workspace;
  const selectedEnvironmentVersion = urlParams.workspaceVersion;
  const currentProject = urlParams.project;
  const activeProcess = useMemo(() =>
    urlParams.process ? { processId: urlParams.process, version: urlParams.version } : null,
    [urlParams.process, urlParams.version]
  );
  const currentPart = urlParams.part || "all";
  const currentSounding = urlParams.sounding !== null ? urlParams.sounding : 0;

  const { data: projects = EMPTY_ARRAY, isLoading: projectsLoading, error: projectsError } = useProjects(currentProject);
  const { data: processes = EMPTY_ARRAY, isLoading, error: processesError, refetch } = useProcesses(currentProject);
  const { data: environments = EMPTY_ARRAY, isLoading: environmentsLoading, error: environmentsError } = useEnvironments();
  // Needed by setCurrentProject below to decide whether the currently-selected workspace
  // (which may be owned by a different project, or public) should carry across a project switch.
  const { data: currentWorkspace } = useWorkspace(selectedEnvironment);

  // InUse diff state
  const [inUseDiffState, dispatchInUseDiff] = useReducer(inUseDiffReducer, { diffs: {}, history: {} });
  const [inUseAction, setInUseAction] = useState('enable'); // 'enable' | 'disable' | 'clear'
  const [newProcessToken, setNewProcessToken] = useState(0);
  const [newProcessDefaults, setNewProcessDefaults] = useState(null);
  const createProcess = useCreateProcess();

  // Handle query errors
  useEffect(() => {
    if (projectsError) {
      const status = projectsError.response?.status;
      const message = status
        ? `Failed to load projects (HTTP ${status})`
        : `Failed to load projects: ${projectsError.message || 'Unknown error'}`;
      addMessage({ level: 'danger', message });
    }
  }, [projectsError, addMessage]);

  useEffect(() => {
    if (processesError) {
      const status = processesError.response?.status;
      const message = status
        ? `Failed to load processes (HTTP ${status})`
        : `Failed to load processes: ${processesError.message || 'Unknown error'}`;
      addMessage({ level: 'danger', message });
    }
  }, [processesError, addMessage]);

  useEffect(() => {
    if (environmentsError) {
      const status = environmentsError.response?.status;
      const message = status
        ? `Failed to load environments (HTTP ${status})`
        : `Failed to load environments: ${environmentsError.message || 'Unknown error'}`;
      addMessage({ level: 'danger', message });
    }
  }, [environmentsError, addMessage]);

  useEffect(() => {
    const proj = projects.find(p => p.id === currentProject);
    if (proj && proj.storage_status === 'failed') {
      addMessage({ level: 'danger', message: `Storage setup failed for project "${proj.name}". Jobs cannot run until storage is provisioned. Retry via POST /projects/${proj.id}/setup-storage.` });
    }
  }, [currentProject, projects, addMessage]);

  // Setter functions that update the URL
  const setSelectedEnvironment = useCallback((workspace, workspaceVersion = null) => {
    const path = buildUrlPath(workspace, workspaceVersion, currentProject, activeProcess?.processId, activeProcess?.version, currentPart === "all" ? null : currentPart, currentSounding);
    navigate(path);
  }, [navigate, currentProject, activeProcess, currentPart, currentSounding]);

  const setCurrentProject = useCallback((project) => {
    // A public workspace's identity is independent of "current project", so it stays open
    // across a switch. A private workspace has no meaning outside its owning project, so it's
    // dropped rather than left stranded pointing at a project that doesn't have it.
    const [carryWorkspace, carryWorkspaceVersion] = currentWorkspace?.is_public
      ? [selectedEnvironment, selectedEnvironmentVersion]
      : [null, null];
    const path = buildUrlPath(carryWorkspace, carryWorkspaceVersion, project, null, null, null, null);
    navigate(path);
  }, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentWorkspace]);

  const setActiveProcess = useCallback((process) => {
    const path = buildUrlPath(selectedEnvironment, selectedEnvironmentVersion, currentProject, process?.processId, process?.version, null, null);
    navigate(path);
  }, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentProject]);

  const setCurrentPart = useCallback((part) => {
    const path = buildUrlPath(selectedEnvironment, selectedEnvironmentVersion, currentProject, activeProcess?.processId, activeProcess?.version, part === "all" ? null : part, null);
    navigate(path);
  }, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentProject, activeProcess]);

  const setCurrentSounding = useCallback((sounding) => {
    const path = buildUrlPath(selectedEnvironment, selectedEnvironmentVersion, currentProject, activeProcess?.processId, activeProcess?.version, currentPart === "all" ? null : currentPart, sounding);
    navigate(path);
  }, [navigate, selectedEnvironment, selectedEnvironmentVersion, currentProject, activeProcess, currentPart]);

  // Centralized cache invalidation helpers - THE ONLY WAY to invalidate queries in the app
  const invalidateHelpers = useMemo(() => ({
    // Invalidate a specific process and all its related data
    invalidateProcess: async (processId, projectId = currentProject) => {
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ['processes', projectId],
          type: 'active'
        }),
        queryClient.refetchQueries({
          queryKey: ['processOutputDatasets', processId],
          type: 'active'
        })
      ]);
    },

    // Invalidate all processes and related data for current project (or specified project)
    invalidateProject: async (projectId = currentProject) => {
      // Refetch processes - processOutputDatasets will auto-refetch when state changes (due to query key)
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ['processes', projectId],
          type: 'active'
        }),
        queryClient.refetchQueries({
          queryKey: ['datasets'],
          type: 'active'
        })
      ]);
    },

    // Invalidate datasets only
    invalidateDatasets: async () => {
      await queryClient.refetchQueries({
        queryKey: ['datasets'],
        type: 'active'
      });
    }
  }), [queryClient, currentProject]);

  // ── InUse diff helpers ──────────────────────────────────────────────────────

  const applyInMemoryEdit = useCallback((datasetName, channel, entries, value) => {
    dispatchInUseDiff({ type: 'APPLY_EDIT', datasetName, channel, entries, value });
  }, []);

  const undoLastEdit = useCallback((datasetName) => {
    dispatchInUseDiff({ type: 'UNDO', datasetName });
  }, []);

  const clearDatasetDiff = useCallback((datasetName) => {
    dispatchInUseDiff({ type: 'CLEAR', datasetName });
  }, []);

  const saveAllDiffs = useCallback(async (datasetsArg) => {
    const diffsToSave = Object.entries(inUseDiffState.diffs).filter(
      ([, d]) => Object.values(d).some(m => m.size > 0)
    );
    if (diffsToSave.length === 0) return;

    for (const [datasetName, datasetDiff] of diffsToSave) {
      // Collect all unique global sounding indices across all channels/gates.
      const allSoundings = new Set();
      for (const channelMap of Object.values(datasetDiff)) {
        for (const soundingMap of channelMap.values()) {
          for (const si of soundingMap.keys()) allSoundings.add(si);
        }
      }
      const sortedSoundings = [...allSoundings].sort((a, b) => a - b);
      const soundingToRow = new Map(sortedSoundings.map((si, i) => [si, i]));
      const N = sortedSoundings.length;

      // Build layer_data: one Map<gateKey, Float32Array> per channel, NaN = no override.
      const layerData = {};
      for (const [channel, channelMap] of Object.entries(datasetDiff)) {
        const gateMap = new Map();
        for (const [gateKey, soundingMap] of channelMap.entries()) {
          const col = new Float32Array(N).fill(NaN);
          for (const [si, val] of soundingMap.entries()) {
            col[soundingToRow.get(si)] = val;
          }
          gateMap.set(gateKey, col);
        }
        layerData[`InUse_${channel}`] = gateMap;
      }

      // Serialize as libaarhusxyz msgpack diff (apply_idx = global sounding indices).
      const diffXyz = XYZ.fromData({
        flightlines: { apply_idx: Float32Array.from(sortedSoundings) },
        layer_data: layerData,
        model_info: { diff_dummy: NaN },
      });

      let diffUrl;
      try {
        const binary = diffXyz.dump();
        const diffFile = new File([binary], `inuse_diff_${datasetName}.msgpack`,
          { type: 'application/x-aarhusxyz-msgpack' });
        const uploadResult = await uploadFile(diffFile, null, currentProject);
        diffUrl = uploadResult.url;
      } catch (e) {
        console.error(`Failed to upload diff for ${datasetName}:`, e);
        continue;
      }

      // Find dataset metadata to locate the compound_filter process
      const ds = (datasetsArg ?? []).find(d => d.dataset_name === datasetName);
      if (!ds) { console.warn(`Dataset not found: ${datasetName}`); continue; }

      const proc = processes.find(p => p.id === ds.process_id);
      if (!proc) { console.warn(`Process not found for dataset ${datasetName}`); continue; }

      const latestVer = proc.versions[proc.versions.length - 1];
      try {
        await createProcess.mutateAsync({
          proc: { id: proc.id, type: latestVer.type, environment: { id: latestVer.environment?.id }, name: proc.name, params: { ...latestVer.parameters, diff: diffUrl } },
          projectId: currentProject,
        });
      } catch (e) {
        console.error(`Failed to create new process version for ${datasetName}:`, e);
      }
    }

    dispatchInUseDiff({ type: 'CLEAR_ALL' });
    await invalidateHelpers.invalidateProject(currentProject);
  }, [inUseDiffState.diffs, processes, currentProject, createProcess, invalidateHelpers]);

  // Stable WebSocket callbacks wrapped in useCallback to prevent reconnection loops
  const handleWebSocketMessage = useCallback(async (update) => {
    // Use centralized invalidation helper - this is the ONLY place WebSocket updates trigger refetches
    await invalidateHelpers.invalidateProject();
  }, [invalidateHelpers]);

  // WebSocket for process state updates with auto-reconnect
  useWebSocket(`${WS_API}/ws/processes/updates`, {
    enabled: !!currentProject,
    name: 'Process State Updates',
    onMessage: handleWebSocketMessage
  });

  // Find the actual process object from activeProcess
  const process = activeProcess ? processes.find(p => p.id === activeProcess.processId) : null;
  const version = activeProcess?.version;

  const { data: datasets = EMPTY_ARRAY, isLoading: datasetsQueryLoading } = useProcessOutputDatasets(process, version, currentProject);

  // State for dataset objects and data - use stable initial values
  const [datasetObjects, setDatasetObjects] = useState(INITIAL_DATASET_OBJECTS);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [fetchedData, setFetchedData] = useState(INITIAL_FETCHED_DATA);
  const [dataLoading, setDataLoading] = useState(false);

  // Load dataset objects when datasets change
  useEffect(() => {
    const loadDatasets = async () => {
      setDatasetsLoading(true);
      const newDatasetObjects = {};

      for (const dataset of datasets) {
        try {
          const datasetObj = await loadDataset(dataset.id, currentProject);
          newDatasetObjects[dataset.dataset_name] = datasetObj;
        } catch (error) {
          console.error(`Failed to load dataset ${dataset.dataset_name}:`, error);
          const status = error.response?.status;
          const message = status
            ? `Failed to load dataset "${dataset.dataset_name}" (HTTP ${status})`
            : `Failed to load dataset "${dataset.dataset_name}": ${error.message || 'Unknown error'}`;
          addMessage({ level: 'danger', message });
        }
      }

      setDatasetObjects(newDatasetObjects);
      setDatasetsLoading(false);
    };

    if (datasets.length > 0) {
      loadDatasets();
    } else {
      // Clear dataset objects when no datasets - use stable reference
      setDatasetObjects(INITIAL_DATASET_OBJECTS);
      setDatasetsLoading(false);
    }
  }, [datasets, addMessage, currentProject]);

  // Fetch data for current part whenever datasetObjects or currentPart changes
  useEffect(() => {
    if (Object.keys(datasetObjects).length === 0) {
      setFetchedData(INITIAL_FETCHED_DATA);
      setDataLoading(false);
      return;
    }

    const fetchData = async () => {
      setDataLoading(true);
      const newFetchedData = {};

      for (const [datasetName, datasetObj] of Object.entries(datasetObjects)) {
        try {
          const data = await datasetObj.fetchData(currentPart);
          newFetchedData[datasetName] = data;
        } catch (error) {
          console.error(`Failed to fetch data for ${datasetName}:`, error);
          const status = error.response?.status;
          const message = status
            ? `Failed to fetch data for "${datasetName}" (HTTP ${status})`
            : `Failed to fetch data for "${datasetName}": ${error.message || 'Unknown error'}`;
          addMessage({ level: 'danger', message });
        }
      }

      setFetchedData(newFetchedData);
      setDataLoading(false);
    };

    fetchData();

    return () => {
      for (const datasetObj of Object.values(datasetObjects)) {
        datasetObj.cancel();
      }
    };
  }, [datasetObjects, currentPart, addMessage]);

  // Project bootstrap (select the first project when none is selected) now lives in
  // AppBootstrap, which selects workspace + project atomically in a single navigation.

  const contextValue = useMemo(
    () => ({
      projects,
      projectsLoading,
      currentProject,
      setCurrentProject,
      processes,
      isLoading,
      error: processesError,
      refetchProcesses: refetch,
      activeProcess,
      setActiveProcess,
      newProcessToken,
      newProcessDefaults,
      startNewProcess: (defaults = null) => { setNewProcessDefaults(defaults); setActiveProcess(null); setNewProcessToken(t => t + 1); },
      currentPart,
      setCurrentPart,
      selectedEnvironment,
      selectedEnvironmentVersion,
      setSelectedEnvironment,
      environments,
      environmentsLoading,
      datasets,
      datasetObjects,
      datasetCollection: new DatasetCollectionAdapter(datasetObjects),
      datasetsLoading: datasetsLoading || datasetsQueryLoading || (!!activeProcess && isLoading) || (datasets.length > 0 && Object.keys(datasetObjects).length === 0),
      fetchedData,
      dataLoading,
      currentSounding,
      setCurrentSounding,
      // Centralized cache invalidation helpers
      invalidateProcess: invalidateHelpers.invalidateProcess,
      invalidateProject: invalidateHelpers.invalidateProject,
      invalidateDatasets: invalidateHelpers.invalidateDatasets,
      // InUse diff state and helpers
      inMemoryDiffs: inUseDiffState.diffs,
      inMemoryDiffHistory: inUseDiffState.history,
      inUseAction,
      setInUseAction,
      applyInMemoryEdit,
      undoLastEdit,
      clearDatasetDiff,
      saveAllDiffs,
    }),
    [
      projects,
      projectsLoading,
      currentProject,
      setCurrentProject,
      processes,
      isLoading,
      processesError,
      refetch,
      activeProcess,
      setActiveProcess,
      newProcessToken,
      newProcessDefaults,
      currentPart,
      setCurrentPart,
      selectedEnvironment,
      selectedEnvironmentVersion,
      setSelectedEnvironment,
      environments,
      environmentsLoading,
      datasets,
      datasetObjects,
      datasetsLoading,
      datasetsQueryLoading,
      fetchedData,
      dataLoading,
      currentSounding,
      setCurrentSounding,
      invalidateHelpers,
      inUseDiffState,
      inUseAction,
      setInUseAction,
      applyInMemoryEdit,
      undoLastEdit,
      clearDatasetDiff,
      saveAllDiffs,
    ]
  );

  useEffect(() => {
    window.processContext = contextValue;
  }, [contextValue]);

  return (
    <ProcessContext.Provider value={contextValue}>
      {children}
    </ProcessContext.Provider>
  );
}

import React, { createContext, useCallback, useMemo, useState, useEffect, useContext, useReducer, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useProcesses, useEnvironments, useProcessOutputDatasets, useProjects, useCreateProcess, useWorkspace, fetchEnvironmentProcessTypes } from "./datamodel/useQueries";
import { loadDataset, DatasetCollectionAdapter } from './datamodel/dataset';
import XYZ from './datamodel/libaarhusxyz';
import { acceptsEdits, buildDiffColumns, diffFromColumns, editedVersionRequest, inUseDiffReducer, resolveEditTarget, saveIntermediateStep } from './datamodel/inUseDiffs';
import { useWebSocket } from './hooks/useWebSocket';
import { WS_API, uploadFile } from './datamodel/api';
import { recordNavView } from './datamodel/navTracking';
import { MessageContext } from './MessageContext';

export const ProcessContext = createContext();

// Moved outside component to avoid recreation
const INITIAL_DATASET_OBJECTS = {};
const INITIAL_FETCHED_DATA = {};

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
  const { data: environments = EMPTY_ARRAY, isLoading: environmentsLoading, error: environmentsError } = useEnvironments(currentProject);
  // Needed by setCurrentProject below to decide whether the currently-selected workspace
  // (which may be owned by a different project, or public) should carry across a project switch.
  const { data: currentWorkspace } = useWorkspace(selectedEnvironment, currentProject);

  // InUse diff state
  const [inUseDiffState, dispatchInUseDiff] = useReducer(inUseDiffReducer, { diffs: {}, history: {}, dirty: {} });
  // The version each plot path's save-point edit was loaded for. A path loads once per
  // version it names; clearing it (after a Save) lets the next call load the step's
  // then-current edit. Paths whose saved edit is 'loading' or 'failed' cannot be saved:
  // the save would replace that edit with only the new one.
  const loadedEditsRef = useRef(new Map());
  const loadStatusRef = useRef(new Map());
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
    loadedEditsRef.current.delete(datasetName);
    loadStatusRef.current.delete(datasetName);
    dispatchInUseDiff({ type: 'CLEAR', datasetName });
  }, []);

  // Load the saved edit of the save point a plot shows into the editor, under the plot's
  // literal dataset path (the key its overlay reads), so the person edits it in place.
  // PlotView calls this for each editing layer. It does nothing once the path is loaded for
  // the version it names, or while the path does not resolve yet.
  const ensureSavePointEditLoaded = useCallback(async (path) => {
    const target = resolveEditTarget(path, activeProcess, processes);
    if (!target) return;
    const loadedFor = `${target.process.id}.${target.versionObj.version}`;
    if (loadedEditsRef.current.get(path) === loadedFor) return;
    loadedEditsRef.current.set(path, loadedFor);
    loadStatusRef.current.delete(path);
    // A Save, or the path naming another version, while this loaded makes it stale.
    const stale = () => loadedEditsRef.current.get(path) !== loadedFor;

    const point = saveIntermediateStep(target.versionObj.parameters?.steps, target.datasetName);
    let diff = {};
    if (point?.args.diff) {
      loadStatusRef.current.set(path, 'loading');
      try {
        diff = diffFromColumns(await XYZ.fromURL(point.args.diff));
      } catch (e) {
        if (stale()) return;
        console.error(`Failed to load the saved edit on ${path}:`, e);
        loadStatusRef.current.set(path, 'failed');
        addMessage({ level: 'danger', message: `The saved edit on "${path}" could not be loaded (${e.message}), so it is not shown and edits on that plot cannot be saved. Reload the page to try again.` });
        return;
      }
      if (stale()) return;
      loadStatusRef.current.delete(path);
    }
    dispatchInUseDiff({ type: 'LOAD', datasetName: path, diff });
  }, [activeProcess, processes, addMessage]);

  const saveAllDiffs = useCallback(async () => {
    // Only paths changed since their save point's edit loaded, or edited from scratch:
    // an untouched save point is not uploaded again and its step keeps its `diff`.
    const { diffs, dirty } = inUseDiffState;
    const changedPaths = Object.keys(dirty).filter(datasetPath => dirty[datasetPath]);
    if (changedPaths.length === 0) return;

    // Only saved datasets are cleared; a refused or failed save keeps its edits in the editor.
    const saved = [];
    const notSaved = (datasetPath, reason) =>
      addMessage({ level: 'danger', message: `Edits on "${datasetPath}" were not saved: ${reason}. They are still in the editor.` });

    // One new version per edited process version, holding all of its changed datasets:
    // two save points of one pipeline saved separately would each drop the other's edit.
    const groups = new Map();

    // Edits are keyed by the plot layer's dataset path ("current.<dataset>" or
    // "<process>.<version>.<dataset>"), not by dataset name.
    for (const datasetPath of changedPaths) {
      // The process version whose output was edited gets a new version that replays the edits.
      const target = resolveEditTarget(datasetPath, activeProcess, processes);
      if (!target) { notSaved(datasetPath, 'the process version that made it was not found'); continue; }
      const { process: proc, versionObj: editedVer, datasetName } = target;
      const loadStatus = loadStatusRef.current.get(datasetPath);
      if (loadStatus) {
        notSaved(datasetPath, loadStatus === 'loading'
          ? 'its saved edit is still loading'
          : 'its saved edit could not be loaded, so saving would replace it with only the new edits');
        continue;
      }
      const groupKey = `${proc.id}.${editedVer.version}`;
      const group = groups.get(groupKey) ?? { proc, editedVer, edits: [], paths: [] };
      if (group.edits.some(edit => edit.datasetName === datasetName)) {
        notSaved(datasetPath, `"${datasetName}" is also edited in a plot that names it by another path; save that one first`);
        continue;
      }

      // Refuse before uploading: an output with no save point, of a process type whose form
      // has no `diff`, would re-run without the edits, and the new version would look
      // edited while they are gone.
      let processTypes;
      try {
        processTypes = await fetchEnvironmentProcessTypes(queryClient, editedVer.environment?.id);
      } catch (e) {
        notSaved(datasetPath, `could not check whether ${editedVer.type} takes edits (${e.message})`);
        continue;
      }
      if (!acceptsEdits(processTypes, editedVer, datasetName)) {
        notSaved(datasetPath, `${editedVer.type} has no edit point for "${datasetName}", so a re-run would drop the edits`);
        continue;
      }

      const datasetDiff = diffs[datasetPath] ?? {};
      let diffUrl = null;
      if (Object.values(datasetDiff).some(m => m.size > 0)) {
        // apply_idx (global sounding indices) and one InUse column per gate, NaN = no override.
        const { applyIdx, layerData } = buildDiffColumns(datasetDiff);

        // Serialize as libaarhusxyz msgpack diff (apply_idx = global sounding indices).
        const diffXyz = XYZ.fromData({
          flightlines: { apply_idx: Float32Array.from(applyIdx) },
          layer_data: layerData,
          model_info: { diff_dummy: NaN },
        });

        try {
          const binary = diffXyz.dump();
          const diffFile = new File([binary], `inuse_diff_${datasetName}.msgpack`,
            { type: 'application/x-aarhusxyz-msgpack' });
          const uploadResult = await uploadFile(diffFile, null, currentProject);
          diffUrl = uploadResult.url;
        } catch (e) {
          notSaved(datasetPath, `the upload failed (${e.message})`);
          continue;
        }
      } else if (!saveIntermediateStep(editedVer.parameters?.steps, datasetName)?.args.diff) {
        // Emptied, and no saved edit to remove: nothing to write.
        saved.push(datasetPath);
        continue;
      }
      // Emptied otherwise: diffUrl stays null, which removes the save point's edit.

      group.edits.push({ datasetName, diffUrl });
      group.paths.push(datasetPath);
      groups.set(groupKey, group);
    }

    let created = false;
    for (const { proc, editedVer, edits, paths } of groups.values()) {
      try {
        await createProcess.mutateAsync({
          proc: editedVersionRequest(proc, editedVer, edits),
          projectId: currentProject,
        });
        saved.push(...paths);
        created = true;
      } catch (e) {
        for (const datasetPath of paths) {
          notSaved(datasetPath, `the new version of ${proc.name} could not be created (${e.message})`);
        }
      }
    }

    for (const datasetPath of saved) clearDatasetDiff(datasetPath);
    if (created) await invalidateHelpers.invalidateProject(currentProject);
  }, [inUseDiffState, processes, activeProcess, currentProject, createProcess, invalidateHelpers, queryClient, addMessage, clearDatasetDiff]);

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
      inMemoryDiffDirty: inUseDiffState.dirty,
      inUseAction,
      setInUseAction,
      applyInMemoryEdit,
      undoLastEdit,
      clearDatasetDiff,
      ensureSavePointEditLoaded,
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
      ensureSavePointEditLoaded,
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

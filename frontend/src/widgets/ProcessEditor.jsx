import validator from "@rjsf/validator-ajv8";
import React, { useEffect, useState, useContext, useMemo } from "react";
import { Modal, Button, Card } from 'react-bootstrap';
import { CustomForm } from '../jsoneditor';
import { ProcessContext } from '../ProcessContext';
import { useEnvironmentProcessTypes, useCreateProcess, useAvailableClusters, useCancelProcess, useAddVersionTag } from "../datamodel/useQueries";
import { getProcessVersion, getLatestVersion } from '../datamodel/api';
import { LayoutContext } from '../flexout/LayoutContext';
import { AuthContext } from '../AuthContext';
import TagSelector from './FlowView/TagSelector';
import { hooks } from '../plugins/hooks';

function useActivateProcessLog() {
  const { findWidgetPaths, activatePath } = useContext(LayoutContext);
  return () => {
    const paths = findWidgetPaths('ProcessLog');
    if (paths.length > 0) activatePath(paths[0]);
  };
}

const cleanFormData = (data) => {
  if (!data) return data;
  const clean = (obj) => {
    if (Array.isArray(obj)) return obj.map(clean);
    if (obj && typeof obj === 'object') {
      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null) cleaned[key] = clean(value);
      }
      return cleaned;
    }
    return obj;
  };
  return clean(data);
};

// The environments list from the backend is unordered, so "newest" is derived
// from created_at. Returns the id of the most recently created environment, or
// null if the list is empty.
const newestEnvironmentId = (environments) => {
  if (!environments || environments.length === 0) return null;
  const latest = environments.reduce(
    (a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a)
  );
  return latest.id;
};

export default function ProcessEditor() {
  const {
    processes, activeProcess, setActiveProcess, invalidateProject,
    selectedEnvironment, environments, environmentsLoading, currentProject,
    newProcessToken, newProcessDefaults
  } = useContext(ProcessContext);
  const { user } = useContext(AuthContext);
  const activateProcessLog = useActivateProcessLog();

  const process = activeProcess ? processes.find(p => p.id === activeProcess.processId) : null;
  const versionObj = process ? getProcessVersion(process, activeProcess.version) : null;
  const isExisting = !!process && !!versionObj;

  const [processName, setProcessName] = useState("");
  const [localEnvironment, setLocalEnvironment] = useState(newestEnvironmentId(environments) || selectedEnvironment || null);
  const [localType, setLocalType] = useState(null);
  const [formData, setFormData] = useState({});
  const [selectedTags, setSelectedTags] = useState([]);
  const [cpuCores, setCpuCores] = useState(1);
  const [memoryGb, setMemoryGb] = useState(2);
  const [deadlineMinutes, setDeadlineMinutes] = useState(60);
  const [clusterId, setClusterId] = useState(null);
  const [showResourceModal, setShowResourceModal] = useState(false);

  const { data: types = {}, isLoading: typesLoading } = useEnvironmentProcessTypes(localEnvironment);
  const createProcessMutation = useCreateProcess();
  const cancelProcessMutation = useCancelProcess();
  const { data: clusters = [] } = useAvailableClusters(currentProject, {
    cpu: `${Math.floor(cpuCores * 1000)}m`,
    memory: `${memoryGb}Gi`,
  });
  const addVersionTagMutation = useAddVersionTag();
  const selectedCluster = clusters.find(c => c.id === clusterId) ?? clusters[0] ?? null;
  const maxCpu = selectedCluster?.max_cpu_cores ?? 8;
  const maxMemory = selectedCluster?.max_memory_gb ?? 32;
  const maxDeadlineMinutes = selectedCluster?.max_runtime_seconds != null
    ? selectedCluster.max_runtime_seconds / 60
    : null;

  // Default to the first allowed cluster once the list loads, if nothing selected yet
  // (or the previously-selected cluster is no longer in the allowed set).
  useEffect(() => {
    if (clusters.length > 0 && !clusters.some(c => c.id === clusterId)) {
      setClusterId(clusters[0].id);
    }
  }, [clusters, clusterId]);

  const handleClusterChange = (id) => {
    setClusterId(id);
    const cluster = clusters.find(c => c.id === id);
    if (!cluster) return;
    setCpuCores(v => Math.min(v, cluster.max_cpu_cores));
    setMemoryGb(v => Math.min(v, cluster.max_memory_gb));
    if (cluster.max_runtime_seconds != null) {
      setDeadlineMinutes(v => Math.min(v, cluster.max_runtime_seconds / 60));
    }
  };

  // Reset all state to defaults when "Process > Create" menu is triggered
  useEffect(() => {
    if (newProcessToken === 0) return;
    setProcessName("");
    if (newProcessDefaults) {
      setLocalEnvironment(newProcessDefaults.environmentId ?? null);
      setLocalType(newProcessDefaults.type ?? null);   // e.g. 'import_skytem'
    } else {
      // No existing config: default to the newest available environment.
      setLocalEnvironment(newestEnvironmentId(environments) || selectedEnvironment || null);
      setLocalType(null);
    }
    setFormData({});
    setSelectedTags([]);
    setCpuCores(1);
    setMemoryGb(2);
    setDeadlineMinutes(60);
    setClusterId(null);
  }, [newProcessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // No existing config being edited: once environments load, default to the
  // newest one (mirrors the "Process > Create" default). Only runs when there
  // is no active process and nothing has been selected yet.
  useEffect(() => {
    if (activeProcess || localEnvironment) return;
    const newest = newestEnvironmentId(environments);
    if (newest) setLocalEnvironment(newest);
  }, [environments, activeProcess, localEnvironment]);

  // Sync all state from process data when active process/version changes
  useEffect(() => {
    if (!process || !versionObj) return;
    setLocalEnvironment(process.environment?.id);
    setLocalType(process.type);
    setFormData(versionObj.parameters || {});
    setSelectedTags(versionObj.tags || []);
    if (versionObj.resource_requests) {
      const cpuStr = versionObj.resource_requests.cpu ?? "1000m";
      setCpuCores(cpuStr.endsWith('m') ? parseInt(cpuStr) / 1000 : parseFloat(cpuStr));
      setMemoryGb(parseFloat(versionObj.resource_requests.memory ?? "2Gi"));
    }
    if (versionObj.deadline_seconds != null) setDeadlineMinutes(versionObj.deadline_seconds / 60);
    setClusterId(versionObj.cluster?.id ?? null);
  }, [activeProcess?.processId, activeProcess?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate name when type changes in new-process mode
  useEffect(() => {
    if (!activeProcess && localType) {
      const count = processes.filter(p => p.type === localType).length;
      setProcessName(`${localType}-${count + 1}`);
    }
  }, [localType, processes, activeProcess]);

  // Reset type (and form data) if not available in newly selected environment
  useEffect(() => {
    if (!typesLoading && localType && Object.keys(types).length > 0 && !types[localType]) {
      setLocalType(null);
      if (!activeProcess) setFormData({});
    }
  }, [localEnvironment, types, typesLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // First plugin that registers resource_cost_display wins; null if billing is not active.
  const CostDisplay = useMemo(() => hooks.run.resource_cost_display()[0]?.Component ?? null, []);
  const schema = localType ? types[localType]?.schema : null;

  if (activeProcess && (!process || !versionObj)) return null;

  const handleCreateNew = () => {
    if (localType) {
      const count = processes.filter(p => p.type === localType).length;
      setProcessName(`${localType}-${count + 1}`);
    }
    setActiveProcess(null);
    // environment, type, formData, tags, resources all carry over naturally
  };

  const handleSubmit = ({ formData: submittedData }) => {
    const cleanedData = cleanFormData(submittedData);
    const resourceRequests = {
      cpu: `${Math.floor(cpuCores * 1000)}m`,
      memory: `${memoryGb}Gi`,
      "ephemeral-storage": "10Gi"
    };
    if (isExisting) {
      createProcessMutation.mutate({
        proc: {
          id: process.id, name: process.name, type: localType,
          environment: { id: localEnvironment }, params: cleanedData,
          resource_requests: resourceRequests, deadline_seconds: deadlineMinutes * 60,
          cluster: clusterId ? { id: clusterId } : null,
        },
        projectId: currentProject
      }, {
        onSuccess: async (updatedProcess) => {
          await invalidateProject();
          setActiveProcess({ processId: process.id, version: getLatestVersion(updatedProcess) });
          activateProcessLog();
        },
        onError: (error) => { console.error(error); alert("Failed to create new version"); }
      });
    } else {
      createProcessMutation.mutate({
        proc: {
          name: processName, type: localType, environment: { id: localEnvironment },
          params: cleanedData, resource_requests: resourceRequests,
          deadline_seconds: deadlineMinutes * 60, cluster: clusterId ? { id: clusterId } : null,
          inputs: [], outputs: []
        },
        projectId: currentProject
      }, {
        onSuccess: async (newProcess) => {
          await Promise.all(selectedTags.map(tag =>
            addVersionTagMutation.mutateAsync({ processId: newProcess.id, version: 1, tagId: tag.id, projectId: currentProject })
          ));
          await invalidateProject();
          setActiveProcess({ processId: newProcess.id, version: 1 });
          activateProcessLog();
        },
        onError: (error) => { console.error(error); alert("Failed to create process"); }
      });
    }
  };

  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-md-6">
          <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
            <h3 className="mb-0">
              {isExisting ? `${process.name} – Parameters (v${activeProcess.version})` : "New process – Parameters"}
            </h3>
            {isExisting && (
              <Button variant="outline-primary" size="sm" onClick={handleCreateNew}>
                Create new
              </Button>
            )}
            {isExisting && (versionObj.state === 'queued' || versionObj.state === 'starting' || versionObj.state === 'running') && (
              <Button
                variant="outline-danger" size="sm"
                disabled={cancelProcessMutation.isPending}
                onClick={() => cancelProcessMutation.mutate(
                  { processId: process.id, version: activeProcess.version, projectId: currentProject },
                  { onSuccess: () => invalidateProject(), onError: () => alert("Failed to cancel process") }
                )}
              >
                Cancel
              </Button>
            )}
          </div>

          {!isExisting && (
            <div className="mb-3">
              <label className="form-label">Process Name: </label>
              <input
                type="text" className="form-control" value={processName} required
                placeholder="Enter process name" onChange={e => setProcessName(e.target.value)}
              />
            </div>
          )}

          <div className="mb-3">
            <label className="form-label">Environment: </label>
            <select
              className="form-select" value={localEnvironment || ""} disabled={environmentsLoading}
              onChange={e => setLocalEnvironment(e.target.value)}
            >
              <option value="">{environmentsLoading ? "Loading..." : "Select environment..."}</option>
              {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
          </div>

          {localEnvironment && (
            <div className="mb-3">
              <label className="form-label">Process Type: </label>
              <select
                className="form-select" value={localType || ""} disabled={typesLoading}
                onChange={e => { setLocalType(e.target.value); if (!isExisting) setFormData({}); }}
              >
                <option value="">{typesLoading ? "Loading..." : "Select type..."}</option>
                {Object.keys(types).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="col-md-6">
          <h3 className="d-flex justify-content-between align-items-center">
            Resource Configuration
            <Button variant="link" size="sm" onClick={() => setShowResourceModal(true)} className="p-0" title="Edit resources">
              <i className="fa fa-edit"></i>
            </Button>
          </h3>
          <Card>
            <Card.Body>
              <div className="mb-2"><strong>Cluster:</strong> {(isExisting && !showResourceModal ? versionObj.cluster?.name : selectedCluster?.name) ?? "—"}</div>
              <div className="mb-2"><strong>CPU:</strong> {cpuCores} cores</div>
              <div className="mb-2"><strong>Memory:</strong> {memoryGb} GB</div>
              <div className="mb-2"><strong>Deadline:</strong> {deadlineMinutes} minutes</div>
            </Card.Body>
            {CostDisplay && (
              <Card.Footer className="text-muted">
                <CostDisplay
                  cpuCores={cpuCores} memoryGb={memoryGb} deadlineMinutes={deadlineMinutes}
                  accountData={user} variant="summary"
                />
              </Card.Footer>
            )}
          </Card>
          <div className="mt-3">
            <label className="form-label">Tags: </label>
            {isExisting ? (
              <TagSelector
                processId={process.id} version={activeProcess.version}
                currentTags={versionObj.tags || []} projectId={currentProject} variant="inline"
              />
            ) : (
              <TagSelector
                currentTags={selectedTags} onChange={setSelectedTags}
                projectId={currentProject} variant="inline"
              />
            )}
          </div>
        </div>
      </div>

      <Modal show={showResourceModal} onHide={() => setShowResourceModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Edit Resource Configuration</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="mb-3">
            <label className="form-label">Cluster: </label>
            <select
              className="form-select" value={clusterId || ""}
              onChange={e => handleClusterChange(e.target.value)}
            >
              {clusters.length === 0 && <option value="">No clusters available</option>}
              {clusters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="mb-3">
            <label className="form-label">CPU (cores): {cpuCores}</label>
            <input type="range" className="form-range" min="0.1" max={maxCpu} step="0.1"
              value={cpuCores} onChange={e => setCpuCores(parseFloat(e.target.value))} />
          </div>
          <div className="mb-3">
            <label className="form-label">Memory (GB): {memoryGb}</label>
            <input type="range" className="form-range" min="0.5" max={maxMemory} step="0.5"
              value={memoryGb} onChange={e => setMemoryGb(parseFloat(e.target.value))} />
          </div>
          {/* A single task runs in one pod, which must fit on one node, so its ceiling is the
              cluster's single-node capacity (maxCpu/maxMemory). Only surface the aggregate when it
              actually differs — on a single-node cluster the two numbers are equal and the split
              would just be confusing. */}
          {selectedCluster
            && selectedCluster.aggregate_max_cpu_cores != null
            && (selectedCluster.aggregate_max_cpu_cores !== maxCpu
              || selectedCluster.aggregate_max_memory_gb !== maxMemory) && (
            <div className="mb-3 text-muted small">
              A single task can request at most <strong>{maxCpu}</strong> cores / <strong>{maxMemory}</strong> GB
              (one node's capacity). This cluster can queue up to <strong>{selectedCluster.aggregate_max_cpu_cores}</strong> cores
              / <strong>{selectedCluster.aggregate_max_memory_gb}</strong> GB in total across autoscaled nodes.
            </div>
          )}
          <div className="mb-3">
            <label className="form-label">Deadline (minutes)</label>
            <input type="number" className="form-control" min="1" {...(maxDeadlineMinutes != null ? { max: maxDeadlineMinutes } : {})}
              value={deadlineMinutes} onChange={e => setDeadlineMinutes(parseInt(e.target.value) || 60)} />
          </div>
          {CostDisplay && (
            <div className="alert alert-info">
              <CostDisplay
                cpuCores={cpuCores} memoryGb={memoryGb} deadlineMinutes={deadlineMinutes}
                accountData={user} variant="detailed"
              />
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowResourceModal(false)}>Close</Button>
        </Modal.Footer>
      </Modal>

      {schema && (
        <CustomForm
          schema={schema}
          formData={formData}
          validator={validator}
          onChange={e => setFormData(cleanFormData(e.formData))}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

ProcessEditor.title = "Process editor";

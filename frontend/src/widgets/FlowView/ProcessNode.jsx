import React, { useMemo, useCallback, useContext } from 'react';
import { Handle, Position } from 'reactflow';
import { ProcessContext } from '../../ProcessContext';
import TagSelector from './TagSelector';
import StateBadge from './StateBadge';
import { contrastText } from './mimeColors';
import { encodeSeg } from '../../datamodel/datasetPath';
import { useDatasetDragSource } from '../../dnd/datasetDnd';

// One output-dataset box on a node's right edge. It is a dataset drag source (drop
// it onto another widget, e.g. a plot, to add the dataset there) rather than a
// node-drag grip — hence `nodrag` (reactflow leaves it alone) and pointerEvents
// 'auto' (labelStyle disables them). The reactflow source Handle still draws edges.
// Extracted into its own component because react-dnd's useDrag hook can't run in a
// .map loop.
function DatasetOutputBox({ name, datasetId, datasetPath, processId, processVersion, top, labelStyle, bg }) {
  const dragRef = useDatasetDragSource({ datasetId, datasetPath, datasetName: name, processId, processVersion });
  return (
    <div
      ref={dragRef}
      className="nodrag"
      style={{
        position: 'absolute',
        right: `0px`,
        top: `${top}px`,
        ...labelStyle,
        pointerEvents: 'auto',
        cursor: 'grab',
        ...(bg ? { background: bg, color: contrastText(bg), borderColor: bg } : {}),
      }}
      title={name}
    >
      {name}
      <Handle
        type="source"
        position={Position.Right}
        id={name}
        style={{
          position: 'absolute',
          right: `0px`,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          width: 10,
          height: 10,
        }}
      />
    </div>
  );
}

const ProcessNode = React.memo(({ data }) => {
  const { process, selectedVersion, onVersionChange, onClick, activeProcess, visibleVersionsForProcess, datasetColorById } = data;
  const { currentProject } = useContext(ProcessContext);

  const isSelected = activeProcess?.processId === process.id;

  const handleClick = useCallback(() => {
    onClick(process.id, selectedVersion);
  }, [onClick, process.id, selectedVersion]);

  const versionObj = process.versions?.find(v => v.version === selectedVersion);

  const inputParams = [];
  if (versionObj?.dependencies && Array.isArray(versionObj.dependencies)) {
    const uniqueParams = new Set();
    versionObj.dependencies.forEach(dep => {
      if (!uniqueParams.has(dep.target_param_name)) {
        uniqueParams.add(dep.target_param_name);
        inputParams.push(dep.target_param_name);
      }
    });
  }

  const outputNames = versionObj?.outputs ? Object.keys(versionObj.outputs) : [];

  const handleSpacing = 16;
  const labelWidth = 45;
  const labelHeight = 12;
  const headerHeight = 55;

  const labelStyle = {
    background: '#f8f9fa',
    border: '1px solid #aaa',
    borderRadius: '1px',
    padding: '0px 2px',
    fontSize: '6px',
    color: '#555',
    whiteSpace: 'nowrap',
    width: `${labelWidth}px`,
    height: `${labelHeight}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textAlign: 'center',
    lineHeight: `${labelHeight}px`,
    pointerEvents: 'none'
  };

  return (
    <div
      className="card"
      style={{
        cursor: "pointer",
        minWidth: 150,
        minHeight: 100,
        position: 'relative',
        paddingLeft: '5px',
        paddingRight: '5px',
        paddingTop: '5px',
        paddingBottom: '5px',
        border: isSelected ? '3px solid #2269A7' : undefined,
        boxShadow: isSelected ? '0 0 10px rgba(34, 105, 167, 0.3)' : undefined
      }}
      onClick={handleClick}
    >
      {inputParams.map((param, idx) => (
        <div
          key={`input-${param}`}
          style={{
            position: 'absolute',
            left: `0px`,
            top: `${headerHeight + idx * handleSpacing}px`,
            ...labelStyle
          }}
          title={param}
        >
          {param}
          <Handle
            type="target"
            position={Position.Left}
            id={param}
            style={{
              position: 'absolute',
              left: `0px`,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              width: 10,
              height: 10
            }}
          />
        </div>
      ))}

      {outputNames.map((name, idx) => {
        // Color the dataset box by its dataset's main mime type (falls back to the
        // default label style when the dataset's color isn't known yet).
        const outputUrl = versionObj?.outputs?.[name];
        const datasetId = outputUrl ? outputUrl.split('/').pop() : null;
        const bg = (datasetId && datasetColorById?.get(datasetId)) || null;
        // Dataset path PlotView expects for a pinned (other-process) output.
        const datasetPath = `${encodeSeg(process.name)}.${selectedVersion}.${encodeSeg(name)}`;
        return (
          <DatasetOutputBox
            key={`output-${name}`}
            name={name}
            datasetId={datasetId}
            datasetPath={datasetPath}
            processId={process.id}
            processVersion={selectedVersion}
            top={headerHeight + idx * handleSpacing}
            labelStyle={labelStyle}
            bg={bg}
          />
        );
      })}

      <div style={{
        minHeight: `${headerHeight}px`,
        marginBottom: '5px',
        paddingBottom: '5px',
      }}>
        <strong>
          {process.name}
          &nbsp;
          <select
            value={selectedVersion ?? ''}
            onChange={(e) => {
              e.stopPropagation();
              onVersionChange(process.id, parseInt(e.target.value));
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'auto', minWidth: '60px' }}
          >
            {(process.versions || [])
              .filter(v => visibleVersionsForProcess === null || visibleVersionsForProcess.has(v.version))
              .map(v => (
                <option key={v.version} value={v.version}>v{v.version}</option>
              ))
            }
          </select>
          &nbsp;
          <StateBadge state={versionObj?.state} />
        </strong>
        <div className="text-muted small">
          {versionObj?.type}
        </div>
      </div>

      <TagSelector
        key={`${process.id}-v${selectedVersion}`}
        processId={process.id}
        version={selectedVersion}
        currentTags={versionObj?.tags || []}
        projectId={currentProject}
      />
    </div>
  );
});

ProcessNode.displayName = 'ProcessNode';

export default ProcessNode;

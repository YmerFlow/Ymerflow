import React, { useEffect, useRef } from 'react';
import TagSelector from './TagSelector';
import DraggableDataset from './DraggableDataset';
import { encodeSeg } from '../../datamodel/datasetPath';

// Info popup opened by a tree node's info icon. Shows the process type, its input
// datasets (display-only) and output datasets (draggable, same payload as graph mode),
// and the tag editor. Closes on outside click (mousedown outside both the popover and
// its triggering icon) and on Escape.
export default function ProcessInfoPopover({
  process, versionObj, selectedVersion, processesById,
  datasetColorById, currentProject, triggerRef, onClose,
}) {
  const popRef = useRef(null);

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (triggerRef?.current?.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, triggerRef]);

  const dependencies = versionObj?.dependencies || [];
  const outputNames = versionObj?.outputs ? Object.keys(versionObj.outputs) : [];

  return (
    <div
      ref={popRef}
      className="card shadow-sm"
      style={{
        position: 'absolute',
        zIndex: 1000,
        top: '100%',
        left: 0,
        minWidth: 260,
        maxWidth: 360,
        padding: '8px 10px',
        fontSize: '0.85rem',
        background: '#fff',
        cursor: 'default',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ marginBottom: 6 }}>
        <span className="text-muted">Type:</span> {versionObj?.type || '—'}
      </div>

      <div style={{ marginBottom: 6 }}>
        <div className="text-muted small">Inputs</div>
        {dependencies.length === 0 ? (
          <div className="small">—</div>
        ) : (
          dependencies.map((dep, idx) => {
            const srcName = processesById.get(dep.source_process_id)?.name || dep.source_process_id;
            return (
              <div key={idx} className="small">
                <strong>{dep.target_param_name}</strong>
                {' ← '}
                {srcName}.{dep.source_dataset_name}
              </div>
            );
          })
        )}
      </div>

      <div style={{ marginBottom: 6 }}>
        <div className="text-muted small">Outputs</div>
        {outputNames.length === 0 ? (
          <div className="small">—</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {outputNames.map((name) => {
              const outputUrl = versionObj?.outputs?.[name];
              const datasetId = outputUrl ? outputUrl.split('/').pop() : null;
              const bg = (datasetId && datasetColorById?.get(datasetId)) || null;
              const datasetPath = `${encodeSeg(process.name)}.${selectedVersion}.${encodeSeg(name)}`;
              return (
                <DraggableDataset
                  key={name}
                  name={name}
                  datasetId={datasetId}
                  datasetPath={datasetPath}
                  processId={process.id}
                  processVersion={selectedVersion}
                  bg={bg}
                />
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="text-muted small">Tags</div>
        <TagSelector
          variant="inline"
          processId={process.id}
          version={selectedVersion}
          currentTags={versionObj?.tags || []}
          projectId={currentProject}
        />
      </div>
    </div>
  );
}

import React, { useContext } from 'react';
import { ProcessContext } from '../ProcessContext';
import DatasetColumnCombobox from '../jsoneditor/DatasetColumnCombobox';
import { resolveProcessRef } from '../datamodel/processRef';
import { buildProcessConfig, diffConfigs } from '../datamodel/processConfig';

function formatValue(value) {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function headerLabel(ref) {
  if (!ref || !ref.process) return '(no process)';
  return `${ref.process.name} (v${ref.version})`;
}

export default function ProcessComparison({ refA, refB, parentUpdate, id, widget, ...rest }) {
  const { activeProcess, processes } = useContext(ProcessContext);

  const resA = resolveProcessRef(refA, activeProcess, processes);
  const resB = resolveProcessRef(refB, activeProcess, processes);

  const setRef = (which) => (value) => {
    if (!parentUpdate || !id) return;
    const next = which === 'a'
      ? { id, widget, refA: value, refB, ...rest }
      : { id, widget, refA, refB: value, ...rest };
    parentUpdate('replace', id, next);
  };

  const cfgA = resA ? buildProcessConfig(resA.process, resA.versionObj) : {};
  const cfgB = resB ? buildProcessConfig(resB.process, resB.versionObj) : {};
  const rows = (resA?.process && resB?.process) ? diffConfigs(cfgA, cfgB) : [];

  const bothResolved = resA?.process && resB?.process;

  return (
    <div className="p-3 h-100 overflow-auto">
      <div className="d-flex gap-2 mb-3">
        <div style={{ flex: 1 }}>
          <DatasetColumnCombobox value={refA || 'current'} onChange={setRef('a')} mode="process" />
        </div>
        <div style={{ flex: 1 }}>
          <DatasetColumnCombobox value={refB || 'current'} onChange={setRef('b')} mode="process" />
        </div>
      </div>

      {!bothResolved ? (
        <p className="text-muted">Select a process for both sides to compare.</p>
      ) : (
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Path</th>
              <th>{headerLabel(resA)}</th>
              <th>{headerLabel(resB)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-muted">No differences.</td>
              </tr>
            ) : (
              rows.map(row => (
                <tr key={row.path}>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{row.path}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{formatValue(row.a)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{formatValue(row.b)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

ProcessComparison.title = "Process comparison";

ProcessComparison.get_default = () => ({ refA: 'current', refB: 'current' });

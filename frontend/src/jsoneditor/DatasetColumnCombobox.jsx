import React, { useState, useContext, useRef, useEffect } from 'react';
import { ProcessContext } from '../ProcessContext';
import { loadDataset } from '../datamodel/dataset';
import { encodeSeg } from '../datamodel/datasetPath';

export default function DatasetColumnCombobox({ value, onChange, mode }) {
  const { processes, fetchedData, currentProject } = useContext(ProcessContext);
  const [inputValue, setInputValue] = useState(value || '');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [lazilyLoadedColumns, setLazilyLoadedColumns] = useState(new Map());
  const wrapperRef = useRef(null);

  // Sync external value changes
  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const buildOptions = (filter = '') => {
    const lower = filter.toLowerCase();
    const opts = [];

    if (mode === 'process') {
      if (!filter || 'current'.includes(lower)) opts.push('current');
      for (const proc of (processes || [])) {
        for (const ver of (proc.versions || [])) {
          const path = `${encodeSeg(proc.name)}.${ver.version}`;
          if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
        }
      }
    } else if (mode === 'dataset') {
      for (const dsName of Object.keys(fetchedData || {})) {
        const path = `current.${encodeSeg(dsName)}`;
        if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
      }
      for (const proc of (processes || [])) {
        for (const ver of (proc.versions || [])) {
          if (ver.outputs) {
            for (const dsName of Object.keys(ver.outputs)) {
              const path = `${encodeSeg(proc.name)}.${ver.version}.${encodeSeg(dsName)}`;
              if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
            }
          }
        }
      }
    } else {
      // column mode
      for (const [dsName, dsObj] of Object.entries(fetchedData || {})) {
        const cols = dsObj?.columns?.() || [];
        for (const col of cols) {
          const path = `current.${encodeSeg(dsName)}.${col}`;
          if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
        }
      }
      for (const [dsPath, cols] of lazilyLoadedColumns) {
        for (const col of cols) {
          const path = `${dsPath}.${col}`;
          if (!filter || path.toLowerCase().includes(lower)) opts.push(path);
        }
      }
      // other processes — show dataset paths as stubs if columns not yet loaded
      for (const proc of (processes || [])) {
        for (const ver of (proc.versions || [])) {
          if (ver.outputs) {
            for (const dsName of Object.keys(ver.outputs)) {
              const dsPath = `${encodeSeg(proc.name)}.${ver.version}.${encodeSeg(dsName)}`;
              if (!lazilyLoadedColumns.has(dsPath)) {
                if (!filter || dsPath.toLowerCase().includes(lower)) {
                  opts.push(`${dsPath}.<column>`);
                }
              }
            }
          }
        }
      }
    }

    return opts;
  };

  const triggerLazyLoad = (val) => {
    if (mode !== 'column') return;
    const parts = val.split('.');
    if (parts.length >= 3 && parts[0] !== 'current') {
      const dsPath = parts.slice(0, 3).join('.');
      if (lazilyLoadedColumns.has(dsPath)) return;

      // parts hold encoded segments — match back to real objects in encoded space.
      const [procNameSeg, verStr, dsNameSeg] = parts;
      const proc = (processes || []).find(p => encodeSeg(p.name) === procNameSeg);
      const ver = (proc?.versions || []).find(v => String(v.version) === verStr);
      const dsKey = Object.keys(ver?.outputs || {}).find(k => encodeSeg(k) === dsNameSeg);
      const dsUrl = dsKey != null ? ver.outputs[dsKey] : undefined;
      if (!dsUrl) return;

      const dsId = dsUrl.split('/').pop();
      loadDataset(dsId, currentProject)
        .then(dsObj => dsObj.fetchData('all').then(() => dsObj))
        .then(dsObj => {
          const cols = dsObj.columns?.() || [];
          setLazilyLoadedColumns(prev => new Map(prev).set(dsPath, cols));
        })
        .catch(() => {});
    }
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInputValue(val);
    setOptions(buildOptions(val));
    setOpen(true);
    triggerLazyLoad(val);
  };

  const handleFocus = () => {
    setOptions(buildOptions(inputValue));
    setOpen(true);
  };

  const handleSelect = (opt) => {
    if (opt.endsWith('.<column>')) return;
    setInputValue(opt);
    onChange(opt);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', padding: '4px 6px', border: '1px solid #ced4da', borderRadius: '4px' }}
      />
      {open && options.length > 0 && (
        <ul style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          maxHeight: 220,
          overflowY: 'auto',
          background: 'white',
          border: '1px solid #ced4da',
          borderRadius: '0 0 4px 4px',
          margin: 0,
          padding: 0,
          listStyle: 'none',
          zIndex: 1050,
          boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        }}>
          {options.map((opt, i) => (
            <li
              key={i}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(opt); }}
              style={{
                padding: '4px 8px',
                cursor: opt.endsWith('.<column>') ? 'default' : 'pointer',
                fontFamily: 'monospace',
                fontSize: '12px',
                color: opt.endsWith('.<column>') ? '#999' : 'inherit',
                borderBottom: i < options.length - 1 ? '1px solid #f0f0f0' : 'none',
              }}
              onMouseEnter={(e) => { if (!opt.endsWith('.<column>')) e.currentTarget.style.background = '#e9ecef'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

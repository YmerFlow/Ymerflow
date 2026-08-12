import React, { useState, useEffect, useRef, useContext } from 'react';
import { Form } from 'react-bootstrap';
import { ProcessContext } from '../ProcessContext';
import { API, getDataset } from '../datamodel/api';
import { useSearchDatasets } from '../datamodel/useQueries';

// Resolve the API base to an absolute URL for matching stored dataset URLs.
// When API is a relative path (e.g. "/api"), prepend the current origin.
const apiBase = API.startsWith('http') ? API : window.location.origin + API;

export default function DatasetSelector({ value, onChange, id, required }) {
  const { currentProject } = useContext(ProcessContext);
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [displayValue, setDisplayValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceTimer = useRef(null);
  const wrapperRef = useRef(null);

  // Use TanStack Query for dataset search - automatically refetches when invalidated
  const { data: datasets = [], isLoading: loading } = useSearchDatasets(
    debouncedSearch,
    true,
    currentProject
  );

  // Load display value when component mounts with existing value
  useEffect(() => {
    if (value && value.startsWith(apiBase + '/')) {
      // Check if this is a dataset URL (contains /datasets/ in path)
      if (value.includes('/datasets/')) {
        // Extract dataset ID from new format: /files/.../datasets/{id}/...
        const match = value.match(/\/datasets\/([^/]+)\//);
        if (match) {
          const datasetId = match[1];
          getDataset(datasetId, currentProject)
            .then(ds => {
              const display = `${ds.process_name} / v${ds.process_version} / ${ds.dataset_name}`;
              setDisplayValue(display);
              setSearchText(display);
            })
            .catch(err => console.error('Failed to load dataset:', err));
        }
      } else if (value.startsWith(apiBase + '/dataset/') || /\/projects\/[^/]+\/dataset\//.test(value)) {
        // Old format compatibility
        const datasetId = value.split('/').pop();
        getDataset(datasetId, currentProject)
          .then(ds => {
            const display = `${ds.process_name} / v${ds.process_version} / ${ds.dataset_name}`;
            setDisplayValue(display);
            setSearchText(display);
          })
          .catch(err => console.error('Failed to load dataset:', err));
      }
    }
  }, [value, currentProject]);

  // Debounce search text to avoid excessive queries
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 300);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [searchText]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Smart grouping logic
  const getDisplayItems = () => {
    // Group datasets by process
    const grouped = {};
    datasets.forEach(ds => {
      const key = `${ds.process_name} / v${ds.process_version}`;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(ds);
    });

    const processKeys = Object.keys(grouped);

    // If more than 4 processes, show only first dataset per process with count
    if (processKeys.length > 4) {
      return processKeys.map(key => {
        const processSets = grouped[key];
        const first = processSets[0];
        const count = processSets.length;

        if (count > 1) {
          return {
            type: 'group',
            display: `${key} / ... (${count} more datasets)`,
            searchText: key,
            datasets: processSets
          };
        } else {
          return {
            type: 'item',
            display: `${key} / ${first.dataset_name}`,
            url: first.url,
            data: first
          };
        }
      });
    } else {
      // Show all datasets individually
      return datasets.map(ds => ({
        type: 'item',
        display: `${ds.process_name} / v${ds.process_version} / ${ds.dataset_name}`,
        url: ds.url,
        data: ds
      }));
    }
  };

  const handleInputChange = (e) => {
    setSearchText(e.target.value);
    setShowDropdown(true);
  };

  const handleInputFocus = () => {
    setShowDropdown(true);
  };

  const handleItemClick = (item) => {
    if (item.type === 'group') {
      // Update search text to refine to this process
      setSearchText(item.searchText);
      // Keep dropdown open
    } else {
      // Select this dataset
      onChange(item.url);
      setDisplayValue(item.display);
      setSearchText(item.display);
      setShowDropdown(false);
    }
  };

  const displayItems = getDisplayItems();

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <Form.Control
        id={id}
        type="text"
        value={searchText}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        placeholder="Search for dataset..."
        autoComplete="off"
        required={required}
      />
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            maxHeight: '300px',
            overflowY: 'auto',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            marginTop: '2px',
            zIndex: 1000,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}
        >
          {loading && (
            <div style={{ padding: '8px', color: '#666' }}>Loading...</div>
          )}
          {!loading && displayItems.length === 0 && (
            <div style={{ padding: '8px', color: '#666' }}>No datasets found</div>
          )}
          {!loading && displayItems.map((item, idx) => (
            <div
              key={idx}
              onClick={() => handleItemClick(item)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: idx < displayItems.length - 1 ? '1px solid #eee' : 'none',
                backgroundColor: item.type === 'group' ? '#f8f9fa' : 'white',
                fontStyle: item.type === 'group' ? 'italic' : 'normal'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#e9ecef'}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = item.type === 'group' ? '#f8f9fa' : 'white';
              }}
            >
              {item.display}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

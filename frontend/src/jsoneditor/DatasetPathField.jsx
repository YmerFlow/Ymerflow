import React, { useCallback } from 'react';
import DatasetColumnCombobox from './DatasetColumnCombobox';

export default function DatasetPathField({ formData, onChange, fieldPathId, targetMediatypes }) {
  const handleChange = useCallback(
    (value) => onChange(value, fieldPathId.path),
    [onChange, fieldPathId],
  );
  return (
    <DatasetColumnCombobox
      value={formData || ''}
      onChange={handleChange}
      mode="dataset"
      targetMediatypes={targetMediatypes}
    />
  );
}

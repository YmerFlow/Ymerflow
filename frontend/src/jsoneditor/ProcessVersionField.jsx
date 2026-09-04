import React, { useCallback } from 'react';
import DatasetColumnCombobox from './DatasetColumnCombobox';

export default function ProcessVersionField({ formData, onChange, fieldPathId }) {
  const handleChange = useCallback(
    (value) => onChange(value, fieldPathId.path),
    [onChange, fieldPathId],
  );
  return (
    <DatasetColumnCombobox
      value={formData || ''}
      onChange={handleChange}
      mode="process"
    />
  );
}

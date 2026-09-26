import React from 'react';
import TagInput from './TagInput';

const CONTAINER_STYLE = {
  borderTop: 'none',
  borderLeft: 'none',
  borderRight: 'none',
  borderBottom: '1px solid #dee2e6',
  borderRadius: 0,
  background: '#f8f9fa',
  padding: '4px 8px',
};

export default function TagFilterBar({ projectTags, selectedTagNames, onToggle }) {
  const byName = new Map((projectTags || []).map(t => [t.name, t]));

  // Show ALL selected tag names. A name with a matching tag in the current project uses
  // the real tag object (keeping its color); a name with no match (e.g. a filter carried
  // over from another project via a shared workspace) gets a placeholder chip so the user
  // can still clear it (× or backspace) — it just can't be re-added, since nothing matches.
  const selectedTags = [...selectedTagNames].map(name => byName.get(name) || { name });
  const availableTags = (projectTags || []).filter(t => !selectedTagNames.has(t.name));

  // Nothing to display and nothing to add -> render nothing.
  if (selectedTags.length === 0 && availableTags.length === 0) return null;

  const handleAdd = async (name) => {
    if (byName.has(name)) onToggle(name);
  };

  const handleRemove = async (tag) => {
    onToggle(tag.name);
  };

  return (
    <TagInput
      selectedTags={selectedTags}
      availableTags={availableTags}
      onAdd={handleAdd}
      onRemove={handleRemove}
      listId="tag-filter-opts"
      placeholder="Filter by tag…"
      containerStyle={CONTAINER_STYLE}
    />
  );
}

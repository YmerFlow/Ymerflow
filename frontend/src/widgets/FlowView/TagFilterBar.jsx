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

export default function TagFilterBar({ projectTags, selectedTagIds, onToggle }) {
  const tagById = new Map((projectTags || []).map(t => [t.id, t]));

  // Show ALL selected tags, even ids that don't exist in the current project (e.g. a
  // filter carried over from another project via a shared workspace). An unknown tag
  // gets a placeholder chip labelled by its id so the user can still clear it (× or
  // backspace) — it just can't be re-added by name, since there's nothing to match.
  const selectedTags = [...selectedTagIds].map(id => tagById.get(id) || { id, name: id });
  const availableTags = (projectTags || []).filter(t => !selectedTagIds.has(t.id));

  // Nothing to display and nothing to add -> render nothing.
  if (selectedTags.length === 0 && availableTags.length === 0) return null;

  const handleAdd = async (name) => {
    const tag = (projectTags || []).find(t => t.name === name);
    if (tag) onToggle(tag.id);
  };

  const handleRemove = async (tagId) => {
    onToggle(tagId);
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

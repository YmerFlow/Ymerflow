import React, { useContext } from 'react';
import { ProcessContext } from '../../ProcessContext';
import { useProjectTags, useCreateTag, useAddVersionTag, useRemoveVersionTag } from '../../datamodel/useQueries';
import TagInput from './TagInput';

export const TAG_COLORS = ['#007bff', '#28a745', '#dc3545', '#fd7e14', '#6f42c1', '#20c997', '#e83e8c'];

const CONTAINER_STYLES = {
  'node-bottom': {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTop: '1px solid #ccc',
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
    borderRadius: '0 0 0.375rem 0.375rem',
  },
  'inline': {
    border: '1px solid #ccc',
    borderRadius: '3px',
  },
};

export default function TagSelector({ processId, version, currentTags = [], projectId, variant = 'node-bottom', onChange }) {
  const { invalidateProject } = useContext(ProcessContext);
  const { data: projectTags = [] } = useProjectTags(projectId);
  const createTag = useCreateTag(projectId);
  const addVersionTag = useAddVersionTag();
  const removeVersionTag = useRemoveVersionTag();

  const currentTagIds = new Set(currentTags.map(t => t.id));
  const availableTags = projectTags.filter(t => !currentTagIds.has(t.id));

  const handleAdd = async (name) => {
    let tag = projectTags.find(t => t.name === name);
    if (!tag) {
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
      try {
        tag = await createTag.mutateAsync({ name, color });
      } catch {
        return;
      }
    }
    if (currentTagIds.has(tag.id)) return;
    if (onChange) {
      onChange([...currentTags, tag]);
    } else {
      try {
        await addVersionTag.mutateAsync({ processId, version, tagId: tag.id, projectId });
        await invalidateProject(projectId);
      } catch {
        /* ignore */
      }
    }
  };

  const handleRemove = async (tagId) => {
    if (onChange) {
      onChange(currentTags.filter(t => t.id !== tagId));
    } else {
      try {
        await removeVersionTag.mutateAsync({ processId, version, tagId, projectId });
        await invalidateProject(projectId);
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <TagInput
      selectedTags={currentTags}
      availableTags={availableTags}
      onAdd={handleAdd}
      onRemove={handleRemove}
      listId={processId ? `tag-opts-${processId}-${version}` : 'tag-opts-local'}
      containerStyle={CONTAINER_STYLES[variant] ?? CONTAINER_STYLES['node-bottom']}
    />
  );
}

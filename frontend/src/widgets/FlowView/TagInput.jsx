import React, { useState, useRef, useEffect } from 'react';
import TagBadge from './TagBadge';

export default function TagInput({ selectedTags = [], availableTags = [], onAdd, onRemove, listId, placeholder, containerStyle }) {
  const [inputValue, setInputValue] = useState('');
  const [cursorPos, setCursorPos] = useState(selectedTags.length);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setCursorPos(prev => Math.min(prev, selectedTags.length));
  }, [selectedTags.length]);

  const handleAdd = async () => {
    const name = inputValue.trim();
    if (!name) return;
    if (onAdd) await onAdd(name);
    setInputValue('');
    setCursorPos(selectedTags.length + 1);
    inputRef.current?.focus();
  };

  const handleRemove = async (tag) => {
    if (onRemove) await onRemove(tag);
  };

  const tabComplete = () => {
    if (!inputValue) return;
    const lower = inputValue.toLowerCase();
    const matches = availableTags.filter(t => t.name.toLowerCase().startsWith(lower));
    if (matches.length === 0) return;
    if (matches.length === 1) {
      setInputValue(matches[0].name);
      return;
    }
    const names = matches.map(t => t.name);
    let len = 0;
    while (len < names[0].length) {
      const ch = names[0][len].toLowerCase();
      if (names.every(n => n.length > len && n[len].toLowerCase() === ch)) len++;
      else break;
    }
    const stem = names[0].slice(0, len);
    if (stem.length > inputValue.length) setInputValue(stem);
  };

  const handleKeyDown = async (e) => {
    if (e.key === 'Tab' && inputValue !== '') {
      e.preventDefault();
      tabComplete();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      await handleAdd();
    } else if (e.key === 'ArrowLeft' && inputValue === '' && cursorPos > 0) {
      e.preventDefault();
      setCursorPos(prev => prev - 1);
    } else if (e.key === 'ArrowRight' && inputValue === '' && cursorPos < selectedTags.length) {
      e.preventDefault();
      setCursorPos(prev => prev + 1);
    } else if (e.key === 'Backspace' && inputValue === '' && cursorPos > 0) {
      e.preventDefault();
      const tag = selectedTags[cursorPos - 1];
      setCursorPos(prev => prev - 1);
      await handleRemove(tag);
    } else if (e.key === 'Delete' && inputValue === '' && cursorPos < selectedTags.length) {
      e.preventDefault();
      await handleRemove(selectedTags[cursorPos]);
    }
  };

  const pendingInputStyle = {
    border: '1px dashed #6c757d',
    borderRadius: '3px',
    background: '#f0f4ff',
    padding: '1px 5px',
    fontSize: '11px',
    fontFamily: 'inherit',
    outline: 'none',
    minWidth: '30px',
    width: `${inputValue.length + 2}ch`,
  };

  const emptyInputStyle = {
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontSize: '11px',
    fontFamily: 'inherit',
    padding: '1px 0',
    flex: '1 1 auto',
    minWidth: '4px',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '3px',
        padding: '2px 4px',
        background: 'white',
        cursor: 'text',
        transition: 'border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out',
        ...containerStyle,
        boxShadow: focused ? '0 0 0 2px rgba(13,110,253,0.25)' : 'none',
      }}
      onClick={(e) => {
        e.stopPropagation();
        setCursorPos(selectedTags.length);
        inputRef.current?.focus();
      }}
    >
      {selectedTags.slice(0, cursorPos).map((tag, i) => (
        <TagBadge
          key={tag.id ?? tag.name}
          tag={tag}
          onRemove={() => handleRemove(tag)}
          onClick={(e) => { e.stopPropagation(); setCursorPos(i + 1); inputRef.current?.focus(); }}
        />
      ))}
      <input
        ref={inputRef}
        list={listId}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={cursorPos === selectedTags.length ? (placeholder ?? 'Add tag…') : ''}
        style={inputValue ? pendingInputStyle : emptyInputStyle}
      />
      {selectedTags.slice(cursorPos).map((tag, i) => (
        <TagBadge
          key={tag.id ?? tag.name}
          tag={tag}
          onRemove={() => handleRemove(tag)}
          onClick={(e) => { e.stopPropagation(); setCursorPos(cursorPos + i + 1); inputRef.current?.focus(); }}
        />
      ))}
      <datalist id={listId}>
        {availableTags.map(t => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

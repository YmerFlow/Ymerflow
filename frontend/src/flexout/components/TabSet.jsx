import React, { useContext, useEffect, useState, useRef, useMemo } from 'react';
import Pane from './Pane';
import PaneMenuDropdown from './PaneMenuDropdown';
import { useDrag, useDrop } from 'react-dnd';
import { v4 as uuidv4 } from "uuid";
import { LayoutContext } from '../LayoutContext';
import { Modal, Button } from 'react-bootstrap';
import { CustomForm } from '../../jsoneditor';
import validator from "@rjsf/validator-ajv8";

function removeTabFromTree(node, tabSetId, tabId) {
  if (node.id === tabSetId) {
    const newChildren = node.children.filter(t => t.id !== tabId);
    if (newChildren.length === 0) return null;
    const nextActive = newChildren.find(t => t.id === node.activeTab)
      ? node.activeTab
      : newChildren[0].id;
    return { ...node, children: newChildren, activeTab: nextActive };
  }
  if (!node.children) return node;
  let changed = false;
  const newChildren = [];
  for (const child of node.children) {
    const newChild = removeTabFromTree(child, tabSetId, tabId);
    if (newChild !== child) changed = true;
    if (newChild !== null) newChildren.push(newChild);
    else changed = true;
  }
  if (!changed) return node;
  if ((node.widget === 'VerticalSplit' || node.widget === 'HorizontalSplit') && newChildren.length === 1) {
    return newChildren[0];
  }
  return { ...node, children: newChildren };
}

function TabHeader({ tab, index, isActive, onActivate, onInsertBefore, onRemoveTab, onConfigure, hasConfig, onChangeWidget, onTitleChange, widgets }) {
  const Widget = widgets[tab.widget] || (() => null);
  const title = tab.customTitle !== undefined ? tab.customTitle : Widget.title;

  const [showMenu, setShowMenu] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const menuRef = useRef(null);
  const titleInputRef = useRef(null);

  const handleTitleSave = () => {
    if (titleInputRef.current) onTitleChange(titleInputRef.current.value);
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e) => {
    if (e.key === 'Enter') handleTitleSave();
    else if (e.key === 'Escape') setIsEditingTitle(false);
  };

  const [{ isDragging }, drag] = useDrag({
    type: 'pane',
    item: { node: tab },
    end: (_item, monitor) => {
      if (monitor.didDrop()) onRemoveTab(tab.id);
    },
    collect: monitor => ({ isDragging: monitor.isDragging() })
  });

  const [{ isOver }, drop] = useDrop({
    accept: 'pane',
    drop: (dragged, monitor) => {
      if (monitor.didDrop()) return;
      if (dragged.node.id === tab.id) return {};
      onInsertBefore(index, dragged.node);
      return {};
    },
    collect: monitor => ({ isOver: monitor.isOver({ shallow: true }) })
  });

  return (
    <li
      ref={drop}
      className={`nav-item${isOver ? ' tab-drop-target' : ''}`}
    >
      <button
        ref={drag}
        className={`nav-link tab-mini ${isActive ? 'active' : ''}`}
        onClick={onActivate}
        style={{ opacity: isDragging ? 0.5 : 1, cursor: 'grab' }}
      >
        {isActive && isEditingTitle ? (
          <input
            ref={titleInputRef}
            type="text"
            defaultValue={title}
            onBlur={handleTitleSave}
            onKeyDown={handleTitleKeyDown}
            autoFocus
            className="tab-title-input"
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
          />
        ) : (
          <span
            onClick={isActive ? (e => { e.stopPropagation(); setIsEditingTitle(true); }) : undefined}
            style={isActive ? { cursor: 'text' } : {}}
          >
            {title || ' '}
          </span>
        )}
        <span
          ref={isActive ? menuRef : null}
          className="tab-chevron-anchor"
          style={{ visibility: isActive ? 'visible' : 'hidden' }}
          onClick={isActive ? (e => { e.stopPropagation(); setShowMenu(v => !v); }) : undefined}
        >
          <i className={`fas fa-chevron-${showMenu ? 'up' : 'down'}`} />
          {isActive && showMenu && (
              <PaneMenuDropdown anchorRef={menuRef} onClose={() => setShowMenu(false)}>
                <div className="pane-menu-actions">
                  {hasConfig && (
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => { onConfigure(); setShowMenu(false); }}>
                      <i className="fas fa-cog" />
                    </button>
                  )}
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => { onRemoveTab(tab.id); setShowMenu(false); }}>
                    <i className="fas fa-times" />
                  </button>
                </div>
                <div className="pane-menu-widget-list">
                  {Object.entries(widgets).map(([name, widget]) => (
                    <button
                      type="button"
                      key={name}
                      className={tab.widget === name ? 'active' : ''}
                      onClick={() => { onChangeWidget(name); setShowMenu(false); }}
                    >
                      {widget.title}
                    </button>
                  ))}
                </div>
              </PaneMenuDropdown>
            )}
        </span>
      </button>
    </li>
  );
}

export default function TabSet({ parentUpdate, ...node }) {
  const { widgets, updateLayout, data_context } = useContext(LayoutContext);
  const activeTab = node.activeTab ?? node.children[0]?.id;
  const [configTab, setConfigTab] = useState(null);

  const setActiveTab = (id) => {
    parentUpdate('replace', node.id, { ...node, activeTab: id });
  };

  useEffect(() => {
    const validIds = node.children.map(child => child.id);
    if (!validIds.includes(activeTab) && validIds.length > 0) {
      setActiveTab(validIds[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.children, activeTab]);

  const handleChildUpdate = (action, id, newNode) => {
    if (action === 'remove') {
      const newTabs = node.children.filter(t => t.id !== id);
      if (newTabs.length === 0) parentUpdate('remove', node.id);
      else {
        const nextActive = activeTab === id ? newTabs[0]?.id : activeTab;
        parentUpdate('replace', node.id, { ...node, children: newTabs, activeTab: nextActive });
      }
    } else if (action === 'replace') {
      const newTabs = node.children.map(t => (t.id === id ? { ...t, ...newNode } : t));
      const nextActive = activeTab === id ? newNode.id : activeTab;
      parentUpdate('replace', node.id, { ...node, children: newTabs, activeTab: nextActive });
    }
  };

  const handleTabChangeWidget = (tab, widgetName) => {
    const TargetWidget = widgets[widgetName];
    const isSplit = (t) => t === 'VerticalSplit' || t === 'HorizontalSplit';
    const isContainer = (t) => isSplit(t) || t === 'TabSet' || t === 'Grid';
    let newNode = { id: uuidv4(), widget: widgetName };
    if (isSplit(widgetName)) {
      let children = isContainer(tab.widget) ? [...(tab.children || [])] : [{ ...tab }];
      children = children.slice(0, 2);
      while (children.length < 2) children.push({ id: uuidv4(), widget: 'Empty' });
      newNode.children = children;
    } else if (widgetName === 'TabSet') {
      let children = isContainer(tab.widget) ? [...(tab.children || [])] : [{ ...tab }];
      if (children.length === 0) children.push({ id: uuidv4(), widget: 'Empty' });
      newNode.children = children;
    } else if (widgetName === 'Grid') {
      let children = isContainer(tab.widget) ? [...(tab.children || [])] : [{ ...tab }];
      const defaults = TargetWidget?.get_default ? TargetWidget.get_default(data_context) : {};
      newNode = { ...newNode, ...defaults, children };
    } else {
      if (TargetWidget?.get_default) newNode = { ...newNode, ...TargetWidget.get_default(data_context) };
    }
    handleChildUpdate('replace', tab.id, newNode);
  };

  const handleTabConfigSubmit = ({ formData }) => {
    handleChildUpdate('replace', configTab.id, { ...configTab, ...formData });
    setConfigTab(null);
  };

  const insertTabAt = (index, tabNode) => {
    const newTab = { ...tabNode, id: uuidv4() };
    const newTabs = [...node.children];
    newTabs.splice(index, 0, newTab);
    parentUpdate('replace', node.id, { ...node, children: newTabs, activeTab: newTab.id });
  };

  const addTab = (tabNode) => {
    const newTab = { ...tabNode, id: uuidv4() };
    const newTabs = [...node.children, newTab];
    parentUpdate('replace', node.id, { ...node, children: newTabs, activeTab: newTab.id });
  };

  const removeTabFromSource = (tabId) => {
    updateLayout(prevLayout => removeTabFromTree(prevLayout, node.id, tabId) ?? prevLayout);
  };

  const [, drop] = useDrop({
    accept: 'pane',
    drop: (dragged, monitor) => {
      if (monitor.didDrop()) return;
      addTab(dragged.node);
      return {};
    }
  });

  const configWidget = configTab ? (widgets[configTab.widget] || null) : null;
  const configSchema = configWidget?.get_schema ? configWidget.get_schema(data_context) : null;
  const configFormData = useMemo(() => {
    if (!configTab || !configWidget) return configTab;
    const defaults = configWidget.get_default ? configWidget.get_default(data_context) : {};
    return { ...defaults, ...configTab };
  }, [configTab, configWidget, data_context]);

  return (
    <div ref={drop} className="h-100 flex-column d-flex">
      <ul className="nav nav-tabs tabset-tabs">
        {node.children.map((tab, index) => {
          const W = widgets[tab.widget];
          return (
            <TabHeader
              key={tab.id}
              tab={tab}
              index={index}
              isActive={tab.id === activeTab}
              onActivate={() => setActiveTab(tab.id)}
              onInsertBefore={insertTabAt}
              onRemoveTab={removeTabFromSource}
              onConfigure={() => setConfigTab(tab)}
              hasConfig={!!(W?.get_schema)}
              onChangeWidget={(name) => handleTabChangeWidget(tab, name)}
              onTitleChange={(newTitle) => handleChildUpdate('replace', tab.id, { ...tab, customTitle: newTitle })}
              widgets={widgets}
            />
          );
        })}
        <li className="nav-item">
          <button className="nav-link tab-mini" onClick={() => addTab({ id: uuidv4(), widget: 'Empty' })}>+</button>
        </li>
      </ul>
      <div className="p-0 flex-grow-1 position-relative">
        {node.children.map(tab => (
          <div
            key={tab.id}
            className="position-absolute top-0 start-0 w-100 h-100"
            style={{ display: tab.id === activeTab ? 'block' : 'none' }}
          >
            <Pane parentUpdate={handleChildUpdate} onTabMoved={() => removeTabFromSource(tab.id)} {...tab} hideHeader />
          </div>
        ))}
      </div>

      {configTab && configSchema && (
        <Modal show onHide={() => setConfigTab(null)} size="lg">
          <Modal.Header closeButton>
            <Modal.Title>Configure {configWidget?.title}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <CustomForm
              schema={configSchema}
              formData={configFormData}
              validator={validator}
              onSubmit={handleTabConfigSubmit}
            >
              <div className="d-flex justify-content-end gap-2 mt-3">
                <Button variant="secondary" onClick={() => setConfigTab(null)}>Cancel</Button>
                <Button variant="primary" type="submit">Save Configuration</Button>
              </div>
            </CustomForm>
          </Modal.Body>
        </Modal>
      )}
    </div>
  );
}

TabSet.title = "Tabs";

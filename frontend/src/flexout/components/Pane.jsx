import React, { useContext, useState, useRef, Component, useMemo } from 'react';
import { LayoutContext } from '../LayoutContext';
import PaneMenuDropdown from './PaneMenuDropdown';
import Split from './Split';
import TabSet from './TabSet';
import { useDrag, useDrop } from 'react-dnd';
import { v4 as uuidv4 } from "uuid";
import { Modal, Button } from 'react-bootstrap';
import { CustomForm } from '../../jsoneditor';
import validator from "@rjsf/validator-ajv8";
import { useIsMobile } from '../../hooks/useIsMobile';

// Error Boundary to catch widget crashes
class WidgetErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Widget error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  componentDidUpdate(prevProps) {
    // Reset error state if widget type changes or configuration changes
    if (prevProps.widgetName !== this.props.widgetName || prevProps.node !== this.props.node) {
      this.setState({ hasError: false, error: null, errorInfo: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="d-flex flex-column align-items-center justify-content-center h-100 p-3">
          <div className="alert alert-danger w-100">
            <h5 className="alert-heading">
              <i className="fas fa-exclamation-triangle me-2"></i>
              Widget Error
            </h5>
            <p className="mb-2">
              The <strong>{this.props.widgetName}</strong> widget encountered an error and could not be displayed.
            </p>
            {this.state.error && (
              <details className="mt-2">
                <summary style={{ cursor: 'pointer' }}>Error details</summary>
                <pre className="mt-2 mb-0 small" style={{ whiteSpace: 'pre-wrap' }}>
                  {this.state.error.toString()}
                  {this.state.errorInfo && this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
            <hr />
            <p className="mb-0 small">
              Use the dropdown above to select a different widget or try refreshing the page.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}


function stripNoDataSentinels(val) {
  if (val === 'No dataset') return undefined;
  if (Array.isArray(val)) return val.map(stripNoDataSentinels);
  if (val && typeof val === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(val)) {
      const c = stripNoDataSentinels(v);
      if (c !== undefined) r[k] = c;
    }
    return r;
  }
  return val;
}

export default function Pane({ parentUpdate, onTabMoved, hideHeader, ...node }) {
  const { updateLayout, widgets, data_context } = useContext(LayoutContext);
  const isMobile = useIsMobile();
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const titleInputRef = useRef(null);
  const menuRef = useRef(null);

  const Widget = widgets[node.widget] || (() => <div>Unknown Widget: {node.widget}</div>);
  const hasConfig = Widget.get_schema && typeof Widget.get_schema === 'function';

  const handleConfigure = () => {
    setShowMenu(false);
    setShowConfigModal(true);
  };

  const handleConfigSubmit = ({ formData }) => {
    if (parentUpdate) {
      parentUpdate('replace', node.id, formData);
    } else {
      updateLayout(formData);
    }
    setShowConfigModal(false);
  };

  // Merge node with defaults for form initialization - memoized
  const formData = useMemo(() => {
    if (!hasConfig) return node;

    let fd = node;
    if (Widget.get_default && typeof Widget.get_default === 'function') {
      const defaults = Widget.get_default(data_context);
      // Merge defaults with current node, keeping existing values
      fd = { ...defaults, ...node };
    }
    // Strip "No dataset" sentinels so RJSF applies schema defaults when reopened
    // with real data (handles legacy saved configs that used this placeholder).
    return stripNoDataSentinels(fd);
  }, [hasConfig, node, Widget, data_context]);

  const handleRemove = () => {
    if (parentUpdate) parentUpdate('remove', node.id);
    else updateLayout({ type: 'pane', id: 'root', content: { widget: 'empty' } });
  };

  const handleChangeContent = (e) => {
    const type = e.target.value;
    const TargetWidget = widgets[type];

    const isSplit = (t) => t === 'VerticalSplit' || t === 'HorizontalSplit';
    const isContainer = (t) => isSplit(t) || t === 'TabSet' || t === 'Grid';

    // Always start with fresh id and widget type
    let newNode = {
      id: uuidv4(),
      widget: type
    };

    // Container widgets: preserve existing children where possible
    if (isSplit(type)) {
      // Splits need exactly 2 children; preserve from current node if container, wrap it if leaf
      let children = isContainer(node.widget) ? [...(node.children || [])] : [{ ...node }];
      children = children.slice(0, 2);
      while (children.length < 2) children.push({ id: uuidv4(), widget: 'Empty' });
      newNode.children = children;
    } else if (type === 'TabSet') {
      // TabSet needs at least 1 child; preserve from current node if container, wrap it if leaf
      let children = isContainer(node.widget) ? [...(node.children || [])] : [{ ...node }];
      if (children.length === 0) children.push({ id: uuidv4(), widget: 'Empty' });
      newNode.children = children;
    } else if (type === 'Grid') {
      // Grid preserves children from any container; wrap leaf node as first child
      let children = isContainer(node.widget) ? [...(node.children || [])] : [{ ...node }];
      const defaults = TargetWidget.get_default ? TargetWidget.get_default(data_context) : {};
      newNode = { ...newNode, ...defaults, children };
    } else {
      // Leaf widgets: merge in defaults if available
      if (TargetWidget.get_default && typeof TargetWidget.get_default === 'function') {
        const defaults = TargetWidget.get_default(data_context);
        newNode = { ...newNode, ...defaults };  // Merge, but id/widget remain fresh
      }
    }

    if (parentUpdate) parentUpdate('replace', node.id, newNode);
    else updateLayout(newNode);
  };

  const handleTitleClick = () => {
    setIsEditingTitle(true);
  };

  const handleTitleSave = () => {
    if (titleInputRef.current) {
      const newNode = { ...node, customTitle: titleInputRef.current.value };
      if (parentUpdate) parentUpdate('replace', node.id, newNode);
      else updateLayout(newNode);
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleTitleSave();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  };

  // -------------------------------
  // Drag and Drop
  const [{ isDragging }, drag] = useDrag({
    type: 'pane',
    item: { node },
    end: (_item, monitor) => {
      if (onTabMoved && monitor.didDrop()) onTabMoved();
    },
    collect: (monitor) => ({ isDragging: monitor.isDragging() })
  });

  const [, drop] = useDrop({
    accept: 'pane',
    drop: (dragged, monitor) => {
      if (monitor.didDrop()) return; // nested drop target already handled it
      if (dragged.node.id === node.id) return;
      const newNode = { ...dragged.node, id: uuidv4() };
      if (parentUpdate) parentUpdate('replace', node.id, newNode);
      else updateLayout(newNode);
      return {}; // signal to outer handlers (e.g. TabSet) that this drop was handled
    }
  });

  const style = { opacity: isDragging ? 0.5 : 1 };

  return (
    <div ref={drop} style={style} className={`${hideHeader ? 'border-top ' : ''}d-flex flex-column ${isMobile ? '' : 'h-100'}`}>
      {!hideHeader && (
        <div ref={drag} className="d-flex justify-content-between bg-light border-bottom align-items-center ps-1 pane-header">
          <div onClick={handleTitleClick} style={{ cursor: 'pointer', flexGrow: 1, minWidth: 0, minHeight: '1.5em' }}>
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                defaultValue={node.customTitle !== undefined ? node.customTitle : Widget.title}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                className="form-control form-control-sm"
                style={{ width: '100%', maxWidth: '300px' }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              (node.customTitle !== undefined ? node.customTitle : Widget.title) || '\u00A0'
            )}
          </div>
          <div ref={menuRef} className="pane-menu-anchor" onClick={(e) => e.stopPropagation()}>
            <button className="btn pane-menu-toggle" onClick={() => setShowMenu(v => !v)}>
              <i className={`fas fa-chevron-${showMenu ? 'up' : 'down'}`}></i>
            </button>
            {showMenu && (
              <PaneMenuDropdown anchorRef={menuRef} onClose={() => setShowMenu(false)}>
                <div className="pane-menu-actions">
                  {hasConfig && (
                    <button className="btn btn-sm btn-secondary" onClick={handleConfigure}>
                      <i className="fas fa-cog"></i>
                    </button>
                  )}
                  <button className="btn btn-sm btn-danger" onClick={() => { handleRemove(); setShowMenu(false); }}>
                    <i className="fas fa-times"></i>
                  </button>
                </div>
                <div className="pane-menu-widget-list">
                  {Object.entries(widgets).map(([name, widget]) => (
                    <button
                      key={name}
                      className={node.widget === name ? 'active' : ''}
                      onClick={() => { handleChangeContent({ target: { value: name } }); setShowMenu(false); }}
                    >
                      {widget.title}
                    </button>
                  ))}
                </div>
              </PaneMenuDropdown>
            )}
          </div>
        </div>
      )}
      <div className={
        isMobile
          ? (hideHeader ? 'p-1' : 'pt-1')
          : `${hideHeader ? 'p-1' : 'pt-1'} flex-grow-1 overflow-auto`
      }>
        <WidgetErrorBoundary widgetName={node.widget} node={node}>
          <Widget parentUpdate={parentUpdate} {...node} />
        </WidgetErrorBoundary>
      </div>

      {/* Configuration Modal */}
      <Modal show={showConfigModal} onHide={() => setShowConfigModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Configure {Widget.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {hasConfig && (
            <CustomForm
              schema={Widget.get_schema(data_context)}
              formData={formData}
              validator={validator}
              onSubmit={handleConfigSubmit}
            >
              <div className="d-flex justify-content-end gap-2 mt-3">
                <Button variant="secondary" onClick={() => setShowConfigModal(false)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit">
                  Save Configuration
                </Button>
              </div>
            </CustomForm>
          )}
        </Modal.Body>
      </Modal>
    </div>
  );
}

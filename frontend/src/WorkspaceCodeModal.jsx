import React, { useContext, useEffect, useState } from 'react';
import { Modal, Button } from 'react-bootstrap';
import yaml from 'js-yaml';
import { LayoutContext } from './flexout/LayoutContext';

// Modal YAML editor for the live flexout layout tree. Reads the current layout from
// LayoutContext, lets the user edit it as YAML, and applies the parsed result back via
// updateLayout(). Persisting is left to the existing Workspace ▸ Save item — Apply only
// touches the running layout, so it works even for non-members of the workspace's project.
export default function WorkspaceCodeModal({ show, onHide }) {
  const { layout, updateLayout } = useContext(LayoutContext);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  // Re-serialise each time the modal opens so it reflects any layout changes made since
  // it was last closed. lineWidth: -1 disables wrapping; noRefs avoids YAML anchors so the
  // tree stays readable.
  useEffect(() => {
    if (show) {
      setText(yaml.dump(layout, { indent: 2, noRefs: true, lineWidth: -1 }));
      setError(null);
    }
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = () => {
    let parsed;
    try {
      parsed = yaml.load(text);
    } catch (e) {
      setError(e.message); // keep modal open, show the YAML error
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.widget) {
      setError('Layout must be an object with at least a "widget" field.');
      return;
    }
    updateLayout(parsed);
    onHide();
  };

  return (
    <Modal show={show} onHide={onHide} size="xl">
      <Modal.Header closeButton>
        <Modal.Title>Edit workspace as code</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <textarea
          className="form-control"
          value={text}
          onChange={e => setText(e.target.value)}
          spellCheck={false}
          wrap="off"
          style={{
            height: '70vh',
            fontFamily: 'monospace',
            whiteSpace: 'pre',
            overflowWrap: 'normal',
          }}
        />
        {error && <div className="text-danger small mt-2">{error}</div>}
      </Modal.Body>
      <Modal.Footer className="justify-content-between">
        <small className="text-muted">
          Applies to the current layout — use Workspace ▸ Save to persist as a new version.
        </small>
        <div>
          <Button variant="secondary" onClick={onHide} className="me-2">
            Cancel
          </Button>
          <Button variant="primary" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </Modal.Footer>
    </Modal>
  );
}

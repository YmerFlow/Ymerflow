import React, { useContext, useState } from "react";
import { Dropdown, Modal, Button, Form } from "react-bootstrap";
import { AuthContext } from "../AuthContext";
import { ProcessContext } from "../ProcessContext";
import {
  useProcessDefaults,
  usePublicProcessDefaults,
  useProcessDefault,
  useSaveProcessDefault,
  useSaveProcessDefaultVersion,
} from "../datamodel/useQueries";
import { typeTitle } from "./ProcessTypeSelect";

// The latest (highest) version of a default — the one apply and the card sub-label read from.
const latestVersion = (def) => def.versions?.[def.versions.length - 1] ?? null;

// Human label for a default's process type: the type's schema title when the type is present in
// the current environment, else the raw type name.
const defTypeLabel = (def, types) => {
  const type = latestVersion(def)?.type;
  if (!type) return "";
  return types?.[type] ? typeTitle(type, types[type]) : type;
};

// Schema-driven sensitive-content scan (Decision 5): top-level properties of the active type
// schema whose field is a uri/dataset reference AND which have a truthy value in formData.
// Returns their display titles.
export const scanSensitiveFields = (schema, formData) => {
  const props = schema?.properties || {};
  const found = [];
  for (const [key, prop] of Object.entries(props)) {
    const sensitive = prop?.format === "uri" || prop?.["x-format"] === "dataset";
    if (sensitive && formData && formData[key]) found.push(prop.title || key);
  }
  return found;
};

// If a save would make (or already makes) the default public, confirm when sensitive fields carry
// data. Returns true to proceed, false to abort.
const confirmPublicSensitive = (isPublic, activeSchema, formData) => {
  if (!isPublic) return true;
  const fields = scanSensitiveFields(activeSchema, formData);
  if (fields.length === 0) return true;
  return window.confirm(
    `This default will be public. These fields reference data that will become visible to ` +
    `everyone:\n\n${fields.map((f) => `• ${f}`).join("\n")}\n\nMake it public anyway?`
  );
};

function DefaultBadges({ def }) {
  return (
    <>
      {def.project_name && <small className="text-muted ms-2">— {def.project_name}</small>}
      {def.superpublic && <span className="badge bg-primary ms-2">superpublic</span>}
      {!def.superpublic && def.is_public && <span className="badge bg-secondary ms-2">public</span>}
    </>
  );
}

// One card per default, reusing ProcessTypeSelect's card styling (title + description + a type
// sub-label). Selecting it applies the default's latest version.
function DefaultCard({ def, types, active, onSelect }) {
  return (
    <button
      type="button"
      className={`card text-start h-100 border ${active ? "border-primary bg-primary-subtle" : ""}`}
      onClick={() => onSelect(def)}
      style={{ cursor: "pointer" }}
    >
      <div className="card-body p-2">
        <div className="fw-bold">
          {def.title}
          <DefaultBadges def={def} />
        </div>
        {def.description && <div className="text-muted small">{def.description}</div>}
        <div className="text-muted small fst-italic">{defTypeLabel(def, types)}</div>
      </div>
    </button>
  );
}

// The directly-listed rows: project-local ∪ superpublic, deduped, grouped/ordered by process
// type then title (the WorkspaceList dedup pattern).
function DefaultList({ currentProject, types, selectedId, onSelect }) {
  const { data: projectDefaults = [] } = useProcessDefaults(currentProject);
  const { data: publicDefaults = [] } = usePublicProcessDefaults();

  const rows = [];
  const seen = new Set();
  const addRow = (d) => {
    if (!d || seen.has(d.id)) return;
    seen.add(d.id);
    rows.push(d);
  };
  projectDefaults.forEach(addRow);
  publicDefaults.filter((d) => d.superpublic).forEach(addRow);

  rows.sort((a, b) => {
    const ta = defTypeLabel(a, types);
    const tb = defTypeLabel(b, types);
    const byType = ta.localeCompare(tb, undefined, { sensitivity: "base" });
    return byType !== 0 ? byType : a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  if (rows.length === 0) {
    return <div className="px-3 py-1 text-muted">No defaults yet.</div>;
  }

  return (
    <div
      className="p-2"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.5rem" }}
    >
      {rows.map((d) => (
        <DefaultCard key={d.id} def={d} types={types} active={d.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

// "Save" — write the current editor state back as a NEW version of the currently-loaded default.
// Mirrors WorkspaceMenu's SaveCurrentWorkspaceItem, including how it handles a loaded default that
// belongs to another project (a public/superpublic one): editability is membership of the
// default's HOME project (real membership, not a read-only publication), not whether that project
// is the one currently open, and the label/title reflect saving "away from home".
function SaveCurrentDefaultItem({
  loaded, currentProject, buildVersionBody, activeSchema, formData, onSaved,
}) {
  const { isAuthenticated } = useContext(AuthContext);
  const { projects } = useContext(ProcessContext);
  // Re-read the loaded default by id so it reflects the latest saved version (mirrors useWorkspace).
  const { data: current } = useProcessDefault(loaded?.id, currentProject);
  const saveVersion = useSaveProcessDefaultVersion(current?.project_id);

  // Membership of the default's home project, not the open one. `!p.read_only` excludes pinned
  // read-only publication entries — those aren't real memberships. Anonymous visitors never save.
  const canEdit = isAuthenticated && !!current && projects.some(p => p.id === current.project_id && !p.read_only);

  const handleSave = async () => {
    if (!current || !canEdit) return;
    if (!confirmPublicSensitive(current.is_public, activeSchema, formData)) return;
    try {
      const saved = await saveVersion.mutateAsync({ defaultId: current.id, version: buildVersionBody() });
      onSaved({ id: saved.id, title: saved.title, version: latestVersion(saved)?.version });
    } catch (e) {
      console.error("Failed to save process-default version:", e);
      alert(e?.response?.data?.detail || "Failed to save new version. Please try again.");
    }
  };

  const awayFromHome = current && current.project_id !== currentProject;
  const label = !current
    ? "Save (no default loaded)"
    : awayFromHome
      ? `Save to "${current.project_name}"`
      : `Save "${current.title}"`;
  const title = !current
    ? "Load a default first"
    : !canEdit
      ? `You are not a member of "${current.project_name}" — cannot save`
      : awayFromHome
        ? `Save a new version to "${current.project_name}"`
        : `Save a new version of "${current.title}"`;

  return (
    <button
      type="button"
      className="dropdown-item"
      onClick={handleSave}
      disabled={!canEdit || saveVersion.isPending}
      title={title}
    >
      {label}
    </button>
  );
}

// Bottom search over the public gallery (title substring, client-side) — mirrors
// PublicWorkspaceSearch.
function PublicProcessDefaultSearch({ onSelect }) {
  const { data: publicDefaults = [] } = usePublicProcessDefaults();
  const [searchTerm, setSearchTerm] = useState("");
  const [showResults, setShowResults] = useState(false);

  const filtered = searchTerm
    ? publicDefaults.filter((d) => d.title.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];

  return (
    <div className="px-3 py-1" onClick={(e) => e.stopPropagation()}>
      <Form.Control
        type="text"
        size="sm"
        placeholder="Search public defaults..."
        value={searchTerm}
        onChange={(e) => { setSearchTerm(e.target.value); setShowResults(true); }}
        onFocus={() => setShowResults(true)}
        onKeyDown={(e) => {
          // Stop this from reaching document: the global vanilla Bootstrap JS crashes on our
          // react-bootstrap-managed toggle (see bootstrapDropdownConflictGuard.js / WorkspaceMenu).
          e.stopPropagation();
          if (e.key === "Escape") { setShowResults(false); e.currentTarget.blur(); }
        }}
      />
      {showResults && filtered.length > 0 && (
        <div className="mt-1" style={{ maxHeight: "200px", overflowY: "auto" }}>
          {filtered.map((d) => (
            <button key={d.id} type="button" className="dropdown-item" onClick={() => onSelect(d)}>
              {d.title} <small className="text-muted">— {d.project_name}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal for "Save as new default" — collects title/description/visibility, runs the sensitive
// scan before a public save.
function SaveNewDefaultModal({ show, onHide, currentProject, isAdmin, buildVersionBody, activeSchema, formData }) {
  const saveDefault = useSaveProcessDefault(currentProject);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private"); // 'private' | 'public' | 'superpublic'
  const [error, setError] = useState(null);

  const reset = () => { setTitle(""); setDescription(""); setVisibility("private"); setError(null); };
  const close = () => { reset(); onHide(); };

  const handleSave = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required."); return; }
    const isPublic = visibility === "public" || visibility === "superpublic";
    if (!confirmPublicSensitive(isPublic, activeSchema, formData)) return;
    try {
      await saveDefault.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        is_public: isPublic,
        superpublic: visibility === "superpublic",
        version: buildVersionBody(),
      });
      close();
    } catch (e) {
      // Surface the backend's hard env-visibility block (Decision 6) and anything else.
      setError(e?.response?.data?.detail || "Failed to save default.");
    }
  };

  return (
    <Modal show={show} onHide={close}>
      <Modal.Header closeButton>
        <Modal.Title>Save as new default</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label>Title</Form.Label>
          <Form.Control value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Default name" />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Description</Form.Label>
          <Form.Control as="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Visibility</Form.Label>
          <Form.Check type="radio" id="vis-private" label="Private (this project only)"
            checked={visibility === "private"} onChange={() => setVisibility("private")} />
          <Form.Check type="radio" id="vis-public" label="Public (searchable by everyone)"
            checked={visibility === "public"} onChange={() => setVisibility("public")} />
          {isAdmin && (
            <Form.Check type="radio" id="vis-superpublic" label="Superpublic (listed for everyone)"
              checked={visibility === "superpublic"} onChange={() => setVisibility("superpublic")} />
          )}
        </Form.Group>
        {error && <div className="alert alert-danger mb-0">{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saveDefault.isPending}>
          {saveDefault.isPending ? "Saving…" : "Save"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Selector shown above ProcessTypeSelect. Lists project-local + superpublic defaults as cards
 * (grouped by process type), a searchable public list at the bottom, and the save actions
 * (mirroring WorkspaceMenu): a direct "Save" into the currently-loaded default plus "Save as new
 * default…". Selecting a default calls onApply(default, latestVersion).
 */
export default function ProcessDefaultSelect({
  types = {}, currentProject, isAdmin = false, buildVersionBody, activeSchema, formData, onApply,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loaded, setLoaded] = useState(null); // {id, title, version} of the currently-loaded default
  const [showNewModal, setShowNewModal] = useState(false);

  const handleSelect = (def) => {
    const v = latestVersion(def);
    if (!v) return;
    onApply(def, v);
    setLoaded({ id: def.id, title: def.title, version: v.version });
    setMenuOpen(false);
  };

  return (
    <>
      <Dropdown show={menuOpen} onToggle={setMenuOpen} autoClose="outside" data-rb-guard>
        <Dropdown.Toggle variant="outline-secondary" size="sm">
          Default: {loaded ? loaded.title : "None"}
        </Dropdown.Toggle>
        <Dropdown.Menu style={{ maxHeight: "75vh", overflowY: "auto", minWidth: "min(44rem, 90vw)" }}>
          <DefaultList
            currentProject={currentProject}
            types={types}
            selectedId={loaded?.id}
            onSelect={handleSelect}
          />
          <Dropdown.Divider />
          <SaveCurrentDefaultItem
            loaded={loaded}
            currentProject={currentProject}
            buildVersionBody={buildVersionBody}
            activeSchema={activeSchema}
            formData={formData}
            onSaved={(next) => { setLoaded(next); setMenuOpen(false); }}
          />
          <button type="button" className="dropdown-item" onClick={() => { setShowNewModal(true); setMenuOpen(false); }}>
            Save as new default…
          </button>
          <Dropdown.Divider />
          <PublicProcessDefaultSearch onSelect={handleSelect} />
        </Dropdown.Menu>
      </Dropdown>

      <SaveNewDefaultModal
        show={showNewModal}
        onHide={() => setShowNewModal(false)}
        currentProject={currentProject}
        isAdmin={isAdmin}
        buildVersionBody={buildVersionBody}
        activeSchema={activeSchema}
        formData={formData}
      />
    </>
  );
}

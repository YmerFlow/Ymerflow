import React, { useEffect, useRef, useState } from "react";
import { usePublicEnvironments } from "../datamodel/useQueries";

/**
 * The "Software version" (environment) picker — the environment analogue of WorkspaceMenu.
 *
 * The collapsed trigger renders the selected environment's name as plain text with a
 * FontAwesome edit icon; clicking it opens a dropdown listing the environments the user can
 * choose from, merged and deduped client-side (mirrors WorkspaceMenu's WorkspaceList):
 *
 *   1. the currently-selected environment, if it isn't already in the project-scoped list
 *      (a public env pinned from another project),
 *   2. the project-scoped list `environments` (super-public base runners + project-local),
 *
 * plus a search box over the public-environment gallery at the bottom.
 *
 * A thin wrapper over the old `<select>` contract: it only changes how an environment is
 * chosen, still calling `onChange(id)` with the environment id. The `environments` prop is the
 * project-scoped list (already super-public ∪ project-local from the backend).
 */

function EnvironmentBadges({ env }) {
  return (
    <>
      {env.project_name && <small className="text-muted ms-2">— {env.project_name}</small>}
      {env.superpublic && <span className="badge bg-primary ms-2">superpublic</span>}
      {!env.superpublic && env.is_public && <span className="badge bg-secondary ms-2">public</span>}
    </>
  );
}

export default function EnvironmentSelect({ environments = [], value, disabled = false, loading = false, onChange }) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const rootRef = useRef(null);
  const { data: publicEnvironments = [] } = usePublicEnvironments();

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Merge & dedup (client-side): the pinned selected env if not already in the project list,
  // then the project-scoped list (super-public + project-local). Mirrors WorkspaceList.
  const rows = [];
  const seen = new Set();
  const addRow = (env) => {
    if (!env || seen.has(env.id)) return;
    seen.add(env.id);
    rows.push(env);
  };
  const inProjectList = environments.some(e => e.id === value);
  if (value && !inProjectList) addRow(publicEnvironments.find(e => e.id === value));
  environments.forEach(addRow);

  // The selected env may live in the project list, the public gallery, or nowhere loaded yet.
  const selected = value
    ? (environments.find(e => e.id === value) || publicEnvironments.find(e => e.id === value))
    : null;
  const triggerText = loading
    ? "Loading..."
    : selected
      ? selected.name
      : "Select environment...";

  const select = (id) => {
    onChange?.(id);
    setSearchTerm("");
    setOpen(false);
  };

  const filtered = searchTerm
    ? publicEnvironments.filter(e => e.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <span
        role="button"
        aria-disabled={disabled}
        aria-expanded={open}
        onClick={() => { if (!disabled) setOpen(o => !o); }}
        className={`d-inline-flex align-items-center ${selected ? "" : "text-muted"}`}
        style={{
          cursor: disabled ? "default" : "pointer",
          userSelect: "none",
          opacity: disabled ? 0.65 : 1,
        }}
      >
        <span>{triggerText}</span>
        <i className="fa fa-edit ms-2" />
      </span>

      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: "100%",
            width: "max-content",
            maxWidth: "90vw",
            zIndex: 1050,
            marginTop: "0.25rem",
            maxHeight: "400px",
            overflowY: "auto",
          }}
        >
          <div className="list-group list-group-flush">
            {rows.map(env => {
              const active = env.id === value;
              return (
                <button
                  key={env.id}
                  type="button"
                  className={`list-group-item list-group-item-action ${active ? "active" : ""}`}
                  onClick={() => select(env.id)}
                >
                  {env.name}
                  <EnvironmentBadges env={env} />
                </button>
              );
            })}
          </div>

          {/* Search box over the public-environment gallery. */}
          <div className="p-2 border-top" onClick={e => e.stopPropagation()}>
            <input
              type="text"
              className="form-control form-control-sm"
              placeholder="Search public environments..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => {
                // Don't let keystrokes reach document-level handlers / close the panel.
                e.stopPropagation();
                if (e.key === "Escape") { setSearchTerm(""); e.currentTarget.blur(); }
              }}
            />
            {filtered.length > 0 && (
              <div className="list-group list-group-flush mt-1" style={{ maxHeight: "200px", overflowY: "auto" }}>
                {filtered.map(env => (
                  <button
                    key={env.id}
                    type="button"
                    className={`list-group-item list-group-item-action ${env.id === value ? "active" : ""}`}
                    onClick={() => select(env.id)}
                  >
                    {env.name}
                    <EnvironmentBadges env={env} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

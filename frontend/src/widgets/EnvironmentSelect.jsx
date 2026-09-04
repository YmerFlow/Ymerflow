import React, { useEffect, useRef, useState } from "react";

/**
 * Cosmetic replacement for the environment (software version) `<select>`. The
 * collapsed trigger renders the selected environment's name as plain text with a
 * FontAwesome edit icon next to it; clicking it opens a dropdown list of the
 * available environments — exactly what clicking the old select's caret did.
 *
 * A thin wrapper over the old `<select>` contract: it only changes how an
 * environment is chosen, still calling `onChange(id)` with the environment id.
 * Default value / initial selection and all handlers remain the caller's job.
 */
export default function EnvironmentSelect({ environments = [], value, disabled = false, loading = false, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

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

  const selected = value ? environments.find(env => env.id === value) : null;
  const triggerText = loading
    ? "Loading..."
    : selected
      ? selected.name
      : "Select environment...";

  const select = (id) => {
    onChange?.(id);
    setOpen(false);
  };

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
            {environments.map(env => {
              const active = env.id === value;
              return (
                <button
                  key={env.id}
                  type="button"
                  className={`list-group-item list-group-item-action ${active ? "active" : ""}`}
                  onClick={() => select(env.id)}
                >
                  {env.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

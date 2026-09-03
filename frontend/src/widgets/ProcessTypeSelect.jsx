import React, { useEffect, useRef, useState } from "react";

// Fallback rule (see plan Decision 4): a type whose schema has no top-level
// `title` shows its raw entry-point name; a missing `description` renders no
// description line. Kept here so both the trigger and the card list agree.
export const typeTitle = (name, type) => type?.schema?.title || name;
export const typeDescription = (type) => type?.schema?.description || null;

/**
 * Card-dropdown replacement for the process-type `<select>`. The collapsed
 * trigger shows the selected type's card (title + description) with a caret;
 * clicking it opens a scrollable panel of one card per available type. A thin
 * wrapper over the old `<select>` contract — it only changes how a type is
 * chosen, still calling `onChange(name)` with the entry-point name.
 */
export default function ProcessTypeSelect({ types = {}, value, disabled = false, loading = false, onChange }) {
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

  const selectedType = value ? types[value] : null;
  const triggerTitle = loading
    ? "Loading…"
    : value
      ? typeTitle(value, selectedType)
      : "Select type…";
  const triggerDescription = value && !loading ? typeDescription(selectedType) : null;

  const select = (name) => {
    onChange?.(name);
    setOpen(false);
  };

  // Cards are ordered alphabetically by their display title (case-insensitive),
  // falling back to the machine name via typeTitle.
  const sortedNames = Object.keys(types).sort((a, b) =>
    typeTitle(a, types[a]).localeCompare(typeTitle(b, types[b]), undefined, { sensitivity: "base" })
  );

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div
        className={`card ${disabled ? "text-muted" : ""}`}
        role="button"
        aria-disabled={disabled}
        aria-expanded={open}
        onClick={() => { if (!disabled) setOpen(o => !o); }}
        style={{
          cursor: disabled ? "default" : "pointer",
          userSelect: "none",
          opacity: disabled ? 0.65 : 1,
        }}
      >
        <div className="card-body py-2 px-3 d-flex align-items-center">
          <div className="flex-grow-1">
            <div className={value ? "fw-bold" : "text-muted"}>{triggerTitle}</div>
            {triggerDescription && <div className="text-muted small">{triggerDescription}</div>}
          </div>
          <i
            className="fa fa-chevron-down ms-2"
            style={{ transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}
          />
        </div>
      </div>

      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            // Grow wider than the (often narrow) form column and overlap the
            // content to the right rather than being clamped to the container
            // width; the high z-index keeps it above the form/right column.
            width: "max(100%, 44rem)",
            maxWidth: "90vw",
            zIndex: 1050,
            marginTop: "0.25rem",
            maxHeight: "400px",
            overflowY: "auto",
          }}
        >
          {/* Responsive card grid: auto-fill + minmax lets the number of
              columns grow with the available dropdown width (1 column when
              narrow, 2–3+ when there is room). */}
          <div
            className="p-2"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: "0.5rem",
            }}
          >
            {sortedNames.map((name) => {
              const t = types[name];
              const description = typeDescription(t);
              const active = name === value;
              return (
                <button
                  key={name}
                  type="button"
                  className={`card text-start h-100 border ${active ? "border-primary bg-primary-subtle" : ""}`}
                  onClick={() => select(name)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="card-body p-2">
                    <div className="fw-bold">{typeTitle(name, t)}</div>
                    {description && <div className="text-muted small">{description}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

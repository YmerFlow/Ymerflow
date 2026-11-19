import React from 'react';

export default function CustomFieldTemplate(props) {
  const {
    id,
    classNames,
    style,
    label,
    help,
    required,
    errors,
    children,
    hidden,
    displayLabel,
    schema,
    rawDescription,
  } = props;

  if (hidden) {
    return <div style={{ display: 'none' }}>{children}</div>;
  }

  // rjsf v6 passes `description` as a (often empty) ReactElement and no longer
  // carries the schema's description in `rawDescription` (that now holds only a
  // `ui:description` directive). Read the real help text straight from the schema
  // so the tooltip has content and the icon only shows when there's something to
  // say — otherwise every field got an empty black bubble.
  const descText =
    (typeof schema?.description === 'string' && schema.description.trim() && schema.description) ||
    rawDescription ||
    '';

  const bubble = descText ? (
    <span className="field-description-icon">
      <i className="fa fa-question-circle" aria-label="Help" />
      <span className="field-description-tooltip">{descText}</span>
    </span>
  ) : null;

  // Leaf widgets with no displayed label (notably checkboxes, where rjsf sets
  // displayLabel=false) render their description inline. Surface it as a bubble
  // too, so booleans match every other field. Objects/arrays keep their own
  // inline section description.
  const isLeaf = schema?.type !== 'object' && schema?.type !== 'array';

  return (
    <div className={classNames} style={style}>
      {displayLabel && label && (
        <label htmlFor={id} className="control-label">
          {label}
          {required && <span className="required">*</span>}
          {bubble}
        </label>
      )}
      {children}
      {!(displayLabel && label) && isLeaf && bubble}
      {errors}
      {help}
    </div>
  );
}

import React from 'react';
import HelpBubble from './HelpBubble';

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

  const bubble = <HelpBubble text={descText} />;

  // Object/array fields render their own heading (a <legend> via the Object/Array
  // field template). rjsf also marks their FieldTemplate label displayable for
  // additionalProperties entries (e.g. each axis under `axes`), which produced a
  // duplicate "xaxis_bottom" (control-label) + "xaxis_bottom" (legend). Skip the
  // FieldTemplate label for them and let the legend be the single heading.
  const isObjectOrArray =
    schema?.type === 'object' || schema?.type === 'array' || !!schema?.properties || !!schema?.items;

  // Leaf widgets with no displayed label (notably checkboxes, where rjsf sets
  // displayLabel=false) render their description inline. Surface it as a bubble
  // too, so booleans match every other field.
  const isLeaf = !isObjectOrArray;
  const showLabel = displayLabel && label && !isObjectOrArray;

  // Single-row inputs (text, number, dropdown, combobox) put the label and field
  // on one line: "label: <field>". Multi-row widgets (textarea) and checkboxes keep
  // the label stacked above / inline with the control.
  const isTextarea = schema?.['x-format'] === 'textarea';
  const isCheckbox = schema?.type === 'boolean';
  const isSingleRow = showLabel && !isTextarea && !isCheckbox;

  if (isSingleRow) {
    return (
      <div className={`${classNames} field-inline`} style={style}>
        <div className="field-inline-row">
          <label htmlFor={id} className="control-label">
            {label}
            {required && <span className="required">*</span>}
            <span className="label-colon">:</span>
            {bubble}
          </label>
          <div className="field-inline-control">{children}</div>
        </div>
        {errors}
        {help}
      </div>
    );
  }

  return (
    <div className={classNames} style={style}>
      {showLabel && (
        <label htmlFor={id} className="control-label">
          {label}
          {required && <span className="required">*</span>}
          {bubble}
        </label>
      )}
      {children}
      {!showLabel && isLeaf && bubble}
      {errors}
      {help}
    </div>
  );
}

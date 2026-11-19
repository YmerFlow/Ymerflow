import React from 'react';
import { TranslatableString, getSubmitButtonOptions } from '@rjsf/utils';

// Base IconButton with FontAwesome. Rendered icon-only (no filled button box) since
// the glyphs (square-plus/minus, circle-up/down) carry their own shape.
// Destructure rjsf-injected props that must not reach the DOM button element.
function IconButton({ iconType = 'default', icon, className, uiSchema, registry, schema, options, ...otherProps }) {
  return (
    <button type='button' className={`yf-icon-btn yf-icon-btn--${iconType} ${className}`} {...otherProps}>
      <i className={`fa-solid fa-${icon}`} />
    </button>
  );
}

export function AddButton({ id, className, onClick, disabled, registry }) {
  const { translateString } = registry;
  // Plain button, no Bootstrap `.row`/offset-grid wrapper — that wrapper's negative
  // row margins overflowed the fieldset (horizontal scrollbar). `className` carries
  // rjsf's `rjsf-array-item-add` / `rjsf-object-property-expand`, which styling.scss
  // uses to float this button at the top-right of the array/object title.
  return (
    <IconButton
      id={id}
      iconType='info'
      icon='square-plus'
      className={`btn-add ${className}`}
      title={translateString(TranslatableString.AddButton)}
      onClick={onClick}
      disabled={disabled}
    />
  );
}

export function CopyButton(props) {
  const { registry: { translateString } } = props;
  return <IconButton title={translateString(TranslatableString.CopyButton)} {...props} icon='copy' />;
}

export function MoveDownButton(props) {
  const { registry: { translateString } } = props;
  return <IconButton title={translateString(TranslatableString.MoveDownButton)} {...props} icon='circle-down' />;
}

export function MoveUpButton(props) {
  const { registry: { translateString } } = props;
  return <IconButton title={translateString(TranslatableString.MoveUpButton)} {...props} icon='circle-up' />;
}

export function RemoveButton(props) {
  const { registry: { translateString } } = props;
  return <IconButton title={translateString(TranslatableString.RemoveButton)} {...props} iconType='danger' icon='square-minus' />;
}

export function SubmitButton({ uiSchema }) {
  const { submitText, norender, props: submitButtonProps = {} } = getSubmitButtonOptions(uiSchema);

  if (norender) {
    return null;
  }

  return (
    <div>
      <button
        type="submit"
        {...submitButtonProps}
        className={`btn btn-primary ${submitButtonProps.className || ''}`}
      >
        {submitText}
      </button>
    </div>
  );
}

const ButtonTemplates = {
  AddButton,
  CopyButton,
  MoveDownButton,
  MoveUpButton,
  RemoveButton,
  SubmitButton,
};

export default ButtonTemplates;

import React from 'react';
import { getDefaultRegistry } from '@rjsf/core';
import LengthScaleField from './LengthScaleField';

// Picks an object's widget by its x-format, as CustomStringField does for strings. Any
// other object is the default object field, unchanged.
export default function CustomObjectField(props) {
  if (props.schema?.['x-format'] === 'length-scale') {
    return <LengthScaleField {...props} />;
  }
  const { fields } = getDefaultRegistry();
  return <fields.ObjectField {...props} />;
}

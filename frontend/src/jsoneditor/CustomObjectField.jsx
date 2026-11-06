import React, { useMemo, useRef } from 'react';
import { getDefaultRegistry } from '@rjsf/core';
import { hasLengthScales, withLengthScales } from './lengthScale';

// The default object field, with the `x-length-scale` links of its properties applied to
// its children's changes (see lengthScale.js). An object without them gets its onChange
// as it is.
export default function CustomObjectField(props) {
  const { schema, formData, onChange, fieldPathId, registry } = props;
  const properties = registry.schemaUtils.retrieveSchema(schema, formData).properties;
  // Read when a child changes, not when the handler is made (see withLengthScales).
  const current = useRef();
  current.current = { properties, formData };
  // The children's paths extend childFieldPathId when the default field is given one.
  const objectPath = (props.childFieldPathId ?? fieldPathId).path;
  const linkedOnChange = useMemo(
    () => withLengthScales(onChange, () => current.current, objectPath),
    [onChange, objectPath],
  );
  const { fields } = getDefaultRegistry();
  return <fields.ObjectField {...props} onChange={hasLengthScales(properties) ? linkedOnChange : onChange} />;
}

import React, { useMemo, useRef } from 'react';
import { getTemplate, getUiOptions, toFieldPathId } from '@rjsf/utils';
import { lengthScaleRows, withLengthScales } from './lengthScale';

// The widget for a group object with x-format "length-scale" (see lengthScale.js). It owns
// the group: every member is rendered here, each alpha beside its length, and a change to
// one of a pair, or to alpha_s, also writes the partners. The group's chrome (title,
// description) is the form's usual object template.
export default function LengthScaleField(props) {
  const {
    schema, uiSchema = {}, formData, errorSchema, fieldPathId, name, title,
    onChange, onBlur, onFocus, registry, disabled, readonly, hideError,
  } = props;
  const { schemaUtils, globalFormOptions, globalUiOptions, fields: { SchemaField } } = registry;
  const group = schemaUtils.retrieveSchema(schema, formData);
  const members = group.properties ?? {};
  const config = group['x-length-scales'];
  const groupPath = (props.childFieldPathId ?? fieldPathId).path;

  // Read when a member changes, not when the handler is made (see withLengthScales).
  const current = useRef(formData);
  current.current = formData;
  const onMemberChange = useMemo(
    () => withLengthScales(onChange, config, () => current.current, groupPath),
    [onChange, config, groupPath],
  );

  const member = (key) => (
    <SchemaField
      key={key}
      name={key}
      schema={members[key]}
      uiSchema={uiSchema[key]}
      required={group.required?.includes(key)}
      fieldPathId={toFieldPathId(key, globalFormOptions, groupPath)}
      formData={formData?.[key]}
      errorSchema={errorSchema?.[key]}
      onChange={onMemberChange}
      onBlur={onBlur}
      onFocus={onFocus}
      registry={registry}
      disabled={disabled}
      readonly={readonly}
      hideError={hideError}
    />
  );

  const uiOptions = getUiOptions(uiSchema, globalUiOptions);
  const Template = getTemplate('ObjectFieldTemplate', registry, uiOptions);
  const rows = lengthScaleRows(Object.keys(members), config).map((row) => ({
    name: row.join('+'),
    content: row.length === 1 ? member(row[0]) : (
      <div key={row.join('+')} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '8px' }}>
        {row.map(member)}
      </div>
    ),
    hidden: false,
    readonly,
    disabled,
    required: false,
  }));
  return (
    <Template
      title={uiOptions.title ?? group.title ?? title ?? name}
      description={uiOptions.description ?? group.description}
      properties={rows}
      readonly={readonly}
      disabled={disabled}
      required={props.required}
      fieldPathId={fieldPathId}
      uiSchema={uiSchema}
      errorSchema={errorSchema}
      schema={group}
      formData={formData}
      registry={registry}
      onAddProperty={() => {}}
    />
  );
}

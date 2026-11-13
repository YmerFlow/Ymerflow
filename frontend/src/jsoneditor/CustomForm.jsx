import React, { useEffect } from 'react';
import Form from '@rjsf/core';
import { getDefaultRegistry } from '@rjsf/core';
import CustomStringField from './CustomStringField';
import CustomNumberField from './CustomNumberField';
import CustomObjectField from './CustomObjectField';
import ExpressionField from './ExpressionField';
import ButtonTemplates from './CustomButtonTemplates';
import CustomFieldTemplate from './CustomFieldTemplate';

function CustomAnyOfField(props) {
  if (props.schema?.['x-format'] === 'expression') {
    return (
      <ExpressionField
        schema={props.schema}
        formData={props.formData}
        onChange={props.onChange}
        registry={props.registry}
        fieldPathId={props.fieldPathId}
      />
    );
  }
  const { fields } = getDefaultRegistry();
  return <fields.AnyOfField {...props} />;
}

export default function CustomForm(props) {
  useEffect(() => {
    window.formSchema = props.schema;
    window.formData = props.formData;
  }, [props.schema, props.formData]);
  const customFields = {
    StringField: CustomStringField,
    NumberField: CustomNumberField,
    ObjectField: CustomObjectField,
    AnyOfField: CustomAnyOfField,
  };

  const customTemplates = {
    ButtonTemplates: ButtonTemplates,
    FieldTemplate: CustomFieldTemplate
  };

  // Clean up undefined properties (removes undefined values left by anyOf switching)
  const cleanFormData = (data) => {
    if (!data) return data;

    // Deep clean - remove undefined/null properties
    const clean = (obj) => {
      if (Array.isArray(obj)) {
        return obj.map(clean);
      } else if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
          if (value !== undefined && value !== null) {
            cleaned[key] = clean(value);
          }
        }
        return cleaned;
      }
      return obj;
    };

    return clean(data);
  };

  // Wrap onSubmit to clean data before submission
  const handleSubmit = (e, nativeEvent) => {
    const cleanedData = cleanFormData(e.formData);
    const cleanedEvent = { ...e, formData: cleanedData };

    if (props.onSubmit) {
      props.onSubmit(cleanedEvent, nativeEvent);
    }
  };

  // Filter out misleading anyOf validation errors
  const transformErrors = (errors) => {
    // Group errors by path to detect anyOf failures
    const errorsByPath = {};
    errors.forEach(error => {
      const path = error.property || '';
      if (!errorsByPath[path]) errorsByPath[path] = [];
      errorsByPath[path].push(error);
    });

    // Filter errors: keep only the final anyOf error, not individual branch errors
    return errors.filter(error => {
      const path = error.property || '';

      // If this is an anyOf error at a specific path, keep it
      if (error.name === 'anyOf') {
        return true;
      }

      // If there's an anyOf error at this same path, this is a branch error - hide it
      const pathErrors = errorsByPath[path] || [];
      const hasAnyOfError = pathErrors.some(e => e.name === 'anyOf');
      if (hasAnyOfError) {
        return false;
      }

      // Keep all other errors
      return true;
    });
  };

  return <Form
    {...props}
    fields={customFields}
    templates={customTemplates}
    onSubmit={handleSubmit}
    transformErrors={props.transformErrors || transformErrors}
  />;
}

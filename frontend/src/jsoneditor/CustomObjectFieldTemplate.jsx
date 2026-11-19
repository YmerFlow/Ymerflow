import React, { createContext, useContext } from 'react';
import { getDefaultRegistry } from '@rjsf/core';

// Gladly wraps each layer/element as an object whose single member is another object:
//   { title: "X", properties: { Y: { type: "object", properties: {…fields} } } }
// where X and Y need not match. rjsf renders the wrapper's title and the inner
// object's title — two headings for one thing — and inside an anyOf the union
// dropdown shows it a third time. The data shape { Y: {…} } is meaningful, so we
// can't flatten the schema; instead we drop the redundant *heading*, detected
// structurally (never by comparing names/titles).
//
// A "pure wrapper" is an object with exactly one property, no additionalProperties,
// whose single property is itself an object. Such a wrapper tells that child to drop
// its heading (the wrapper already names it). An anyOf/oneOf tells its selected
// variant to drop its heading (the dropdown already names it). Objects with more than
// one property are never collapsed — their members are real fields.
export const TitleContext = createContext({ suppressTitle: false });

function isObjectSchema(s) {
  return !!s && (s.type === 'object' || !!s.properties || !!s.anyOf || !!s.oneOf);
}

export default function CustomObjectFieldTemplate(props) {
  const { suppressTitle } = useContext(TitleContext);
  const { schema } = props;

  const propNames = schema?.properties ? Object.keys(schema.properties) : [];
  const hasAdditional =
    schema?.additionalProperties !== undefined && schema?.additionalProperties !== false;
  const isWrapper =
    propNames.length === 1 && !hasAdditional && isObjectSchema(schema.properties[propNames[0]]);

  const { ObjectFieldTemplate: DefaultObjectFieldTemplate } = getDefaultRegistry().templates;
  const passedProps = suppressTitle ? { ...props, title: '' } : props;

  // Suppress this object's own heading if an enclosing wrapper/union asked us to;
  // tell our single child to suppress its heading if we are a pure wrapper.
  return (
    <TitleContext.Provider value={{ suppressTitle: isWrapper }}>
      <DefaultObjectFieldTemplate {...passedProps} />
    </TitleContext.Provider>
  );
}

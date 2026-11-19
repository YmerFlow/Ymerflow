import React from 'react';
import HelpBubble from './HelpBubble';

// Renders an object/array section heading (a <legend>) plus a "?" help bubble built
// from the schema's description — so section descriptions (transforms, colorbars,
// interactions, …) appear as hover popups on the heading instead of inline text.
// (The inline copy is suppressed by CustomDescriptionFieldTemplate.)
export default function CustomTitleFieldTemplate(props) {
  const { id, title, required, schema, optionalDataControl } = props;
  if (!title) return null;
  return (
    <legend id={id}>
      {title}
      {required && <span className="required">*</span>}
      <HelpBubble text={schema?.description} />
      {optionalDataControl && (
        <span className="pull-right" style={{ marginBottom: '2px' }}>
          {optionalDataControl}
        </span>
      )}
    </legend>
  );
}

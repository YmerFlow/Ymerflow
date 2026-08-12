# JSON Schema Forms

YmerFlow uses JSON Schema forms for process parameter configuration and other dynamic form generation. The frontend extends the `@rjsf/core` library with custom fields and widgets.

## Overview

Forms are automatically generated from JSON Schema definitions provided by process types. The custom form system is located in `frontend/src/jsoneditor/`.

### Architecture

```
jsoneditor/
├── index.js                    # Main exports
├── CustomForm.jsx              # Wrapper around @rjsf Form: custom fields/templates, form-data cleaning, error filtering
├── CustomStringField.jsx       # Custom string field: routes to DatasetPathField / DatasetSelector / FileUploadField by x-format
├── CustomNumberField.jsx       # Custom number field: routes to EPSGSelector for format: 'x-epsg'
├── CustomFieldTemplate.jsx     # Field wrapper: label, required marker, description tooltip, errors, help
├── CustomButtonTemplates.jsx   # Add/Copy/Move/Remove/Submit button templates (FontAwesome icons, Bootstrap classes)
├── DatasetSelector.jsx         # Searchable dropdown widget for selecting another process's dataset output
├── DatasetPathField.jsx        # Wraps DatasetColumnCombobox in "dataset" mode (process-scoped dataset path, no column)
├── DatasetColumnCombobox.jsx   # Shared autocomplete combobox for dataset/column path strings, used by DatasetPathField and ExpressionField
├── ExpressionField.jsx         # Toggle between a plain column reference and an anyOf-driven computation expression
├── EPSGSelector.jsx            # Searchable dropdown widget for picking an EPSG coordinate system code
└── FileUploadField.jsx         # File input widget that uploads via the API and stores the resulting URL
```

## Basic Usage

### Using CustomForm

**Always use `CustomForm` instead of the standard `@rjsf Form`:**

```javascript
import { CustomForm } from './jsoneditor';
import validator from '@rjsf/validator-ajv8';

function ProcessEditor() {
  const [formData, setFormData] = useState({});

  const schema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Process Name'
      },
      threshold: {
        type: 'number',
        title: 'Threshold',
        default: 0.5
      }
    }
  };

  const handleSubmit = ({ formData }) => {
    console.log('Submitted:', formData);
  };

  return (
    <CustomForm
      schema={schema}
      formData={formData}
      validator={validator}
      onChange={({ formData }) => setFormData(formData)}
      onSubmit={handleSubmit}
    />
  );
}
```

**Note:** `@rjsf/core` v6 requires an explicit `validator` prop — `CustomForm` does not supply a default one. Every call site (`ProcessEditor.jsx`, `Pane.jsx`, `TabSet.jsx`, `AddFlightlineDialog.jsx`, `CreateModelDialog.jsx`) imports `validator` from `@rjsf/validator-ajv8` and passes it explicitly.

### Why CustomForm?

`CustomForm` is a thin wrapper around `@rjsf/core`'s `Form` (see `frontend/src/jsoneditor/CustomForm.jsx`). It passes through all normal `Form` props (including `validator`, which callers must still supply — see note above) and adds:

- **Custom fields**: `StringField` → `CustomStringField` (dataset/upload/path widgets), `NumberField` → `CustomNumberField` (EPSG widget), `AnyOfField` → an inline `CustomAnyOfField` that special-cases `x-format: 'expression'` schemas by rendering `ExpressionField` instead of the default `anyOf` UI
- **Custom templates**: `ButtonTemplates` (FontAwesome/Bootstrap-styled Add/Copy/Move/Remove/Submit buttons) and `FieldTemplate` → `CustomFieldTemplate` (label, required marker, description tooltip, errors, help text)
- **Form-data cleaning**: `onSubmit` is wrapped to deep-strip `undefined`/`null` properties left behind when `anyOf` branches switch, before calling the caller's `onSubmit`
- **Error filtering**: a default `transformErrors` (overridable via props) hides misleading per-branch validation errors on a field once an `anyOf` error already exists for that same path, so users see one clear error instead of every failed branch

## Dataset Selection

The most important custom feature is the dataset selector for process inputs.

### Schema Definition

To enable dataset selection, use these schema properties:

```javascript
{
  type: 'object',
  properties: {
    input_data: {
      type: 'string',
      format: 'uri',           // Recommended convention (not enforced by code)
      'x-format': 'dataset',   // Triggers custom selector
      title: 'Input Dataset'
    }
  }
}
```

**Note:** `CustomStringField` only checks `schema['x-format'] === 'dataset'` — `format: 'uri'` is not inspected. Setting `format: 'uri'` is a recommended schema-authoring convention (it documents intent and keeps the field consistent with the JSON Schema spec), but it has no effect on whether the selector renders.

### DatasetSelector Component

The `DatasetSelector` provides a searchable dropdown for selecting process outputs.

**Features:**
- **Debounced search** (300ms delay)
- **Smart grouping**: When >4 processes match, shows first dataset + count
- **Click to refine**: Click grouped item to add process name to search
- **Format**: "Process Name / v123 / dataset-name"
- **Value**: Stores the dataset's `url` as returned by the search API, e.g. `http://localhost:8000/projects/{project_id}/files/.../datasets/{id}/...`. An older URL shape containing `/dataset/{id}` (without the `s`) is still recognized when resolving an existing value back to its display label, for back-compat with data saved before the format changed.

**Implementation:** See `frontend/src/jsoneditor/DatasetSelector.jsx` for the complete implementation including:
- Debounced search (300ms)
- Dataset grouping logic
- Loading states
- Click handlers
- New-format (`/datasets/{id}/`) vs. old-format (`/dataset/{id}`) value resolution

### Using Selected Dataset

The form data will contain the dataset URL:

```javascript
const handleSubmit = ({ formData }) => {
  console.log(formData.input_data);
  // Output: "http://localhost:8000/projects/proj-abc/files/.../datasets/abc-123-xyz/..."

  // Fetch the dataset
  fetch(formData.input_data)
    .then(r => r.json())
    .then(data => {
      // Process dataset
    });
};
```

## Custom Field Detection

`CustomStringField` automatically detects special formats and renders appropriate widgets.

### CustomStringField Logic

`CustomStringField` detects special `x-format` properties in the schema and renders appropriate widgets. It checks `schema['x-format']` only — plain `format` values (other than as a schema-authoring convention, see above) are not inspected.

**See:** `frontend/src/jsoneditor/CustomStringField.jsx` for format detection logic including:
- `x-format: 'dataset'` — dataset selector, see below
- `x-format: 'datasetPath'` — dataset path field, see below
- `x-format: 'upload'` — file upload field, see below
- Extensible format detection pattern

### `x-format: 'datasetPath'`

```javascript
{
  type: 'string',
  'x-format': 'datasetPath',
  title: 'Dataset Path'
}
```

Renders `DatasetPathField`, which wraps the shared `DatasetColumnCombobox` in `mode="dataset"`. It offers an autocomplete list of process-scoped dataset paths (e.g. `current.mydataset` for datasets already loaded into the widget, or `Process Name.version.dataset-name` for any process output in the project) without drilling into individual columns. Used where a value should reference a whole dataset rather than a specific column.

### `x-format: 'upload'`

```javascript
{
  type: 'string',
  'x-format': 'upload',
  title: 'Upload File'
}
```

Renders `FileUploadField`, a file `<input>` that uploads the selected file via the API (`uploadFile` from `datamodel/api`), shows a progress bar while uploading, and calls `onChange` with the resulting URL once the upload completes. Errors from the upload are surfaced inline.

## Expression Fields

`x-format: 'expression'` is handled at the `anyOf` level, not by `CustomStringField`. `CustomForm` registers a custom `AnyOfField` (defined inline in `CustomForm.jsx`) that checks `props.schema['x-format'] === 'expression'`; when it matches, it renders `ExpressionField` instead of `@rjsf`'s default `anyOf` selector UI. This is used by plot/layer config schemas where a value can be either a plain dataset column reference or a computed expression built from other fields.

```javascript
{
  type: 'object',
  properties: {
    color: {
      'x-format': 'expression',
      anyOf: [
        { type: 'string' },              // plain "dataset.column" reference
        { type: 'object', /* ... */ }    // computation schema(s), e.g. { operator, operands }
      ],
      title: 'Color'
    }
  }
}
```

`ExpressionField` (`frontend/src/jsoneditor/ExpressionField.jsx`) toggles between two modes:
- **Column mode** (default when `formData` is a string or empty): renders `DatasetColumnCombobox` in `mode="column"`, offering autocomplete over dataset/column paths (own loaded datasets under `current.*`, other processes' outputs as `Process Name.version.dataset.column`, lazily loading columns for outputs not yet fetched).
- **Computation mode** (used when `formData` is an object, or after clicking the "ƒ" toggle button): renders the default `SchemaField` against an `anyOf` built from the object-typed branches of the schema (`schema._expressionAnyOf` if present, else `schema.anyOf`), letting the user build a structured computation. A toggle button (only shown when object-typed branches exist) switches back and forth; switching back to column mode clears the value.

`DatasetColumnCombobox` (`frontend/src/jsoneditor/DatasetColumnCombobox.jsx`) is the shared autocomplete widget behind both `ExpressionField`'s column mode and `DatasetPathField`; the `mode` prop (`"column"` vs `"dataset"`) controls whether it offers full `dataset.column` paths or dataset-only paths.

### Adding Custom Formats

To add a new custom format:

1. **Define schema property:**

```javascript
{
  my_field: {
    type: 'string',
    format: 'my-custom-format',
    'x-widget': 'custom',  // Optional additional hint
    title: 'My Field'
  }
}
```

2. **Add detection in CustomStringField:**

```javascript
if (schema.format === 'my-custom-format') {
  return <MyCustomWidget {...props} />;
}
```

3. **Create widget component:**

```javascript
function MyCustomWidget({ value, onChange }) {
  return (
    <div>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* Custom UI */}
    </div>
  );
}
```

## Schema Features

### Supported Types

- **string**: Text input, textarea, select (with enum)
- **number** / **integer**: Number input with min/max
- **boolean**: Checkbox
- **array**: List of items (add/remove)
- **object**: Nested fieldset

### Validation

```javascript
{
  type: 'string',
  minLength: 3,
  maxLength: 50,
  pattern: '^[a-zA-Z0-9_-]+$',
  title: 'Process Name'
}
```

### Enums (Dropdowns)

```javascript
{
  type: 'string',
  enum: ['option1', 'option2', 'option3'],
  default: 'option1',
  title: 'Select Option'
}
```

### Arrays

```javascript
{
  type: 'array',
  items: {
    type: 'string'
  },
  title: 'Tags'
}
```

### Nested Objects

```javascript
{
  type: 'object',
  properties: {
    solver: {
      type: 'object',
      title: 'Solver Configuration',
      properties: {
        method: {
          type: 'string',
          enum: ['CG', 'LBFGS'],
          title: 'Method'
        },
        tolerance: {
          type: 'number',
          default: 1e-6,
          title: 'Tolerance'
        }
      }
    }
  }
}
```

### Conditional Fields

Show/hide fields based on other field values:

```javascript
{
  type: 'object',
  properties: {
    enable_feature: {
      type: 'boolean',
      title: 'Enable Feature'
    },
    feature_config: {
      type: 'object',
      title: 'Feature Configuration',
      properties: {
        param1: { type: 'string' }
      }
    }
  },
  dependencies: {
    enable_feature: {
      oneOf: [
        {
          properties: {
            enable_feature: { const: true }
          },
          required: ['feature_config']
        },
        {
          properties: {
            enable_feature: { const: false }
          }
        }
      ]
    }
  }
}
```

## UI Hints

### Titles and Descriptions

```javascript
{
  type: 'number',
  title: 'Regularization Parameter',           // Label
  description: 'Controls smoothness of result', // Help text
  default: 0.01
}
```

### Placeholders

```javascript
{
  type: 'string',
  title: 'Process Name',
  default: '',
  examples: ['my-process-123']  // Shows as placeholder
}
```

### Widget Hints

```javascript
{
  type: 'string',
  title: 'Description',
  format: 'textarea',  // Multi-line input
  default: ''
}
```

## Form Validation

### Built-in Validation

JSON Schema validation runs automatically:

```javascript
const schema = {
  type: 'object',
  properties: {
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 100
    }
  },
  required: ['count']
};

<CustomForm
  schema={schema}
  formData={formData}
  validator={validator}
  onSubmit={handleSubmit}
  onError={(errors) => console.log('Validation errors:', errors)}
/>
```

### Custom Validation

Add custom validation functions:

```javascript
function validate(formData, errors) {
  if (formData.start_date > formData.end_date) {
    errors.end_date.addError('End date must be after start date');
  }
  return errors;
}

<CustomForm
  schema={schema}
  formData={formData}
  validator={validator}
  validate={validate}
  onSubmit={handleSubmit}
/>
```

### Live Validation

Enable real-time validation:

```javascript
<CustomForm
  schema={schema}
  formData={formData}
  validator={validator}
  liveValidate={true}  // Validate on every change
  onSubmit={handleSubmit}
/>
```

## Styling

### Theme Customization

There is no `@rjsf` theme package in use (`frontend/package.json` only depends on `@rjsf/core` and `@rjsf/validator-ajv8`, and no `ThemeProvider` is used anywhere) — `@rjsf/core`'s plain HTML-form rendering is used directly, restyled via `CustomFieldTemplate` and `CustomButtonTemplates` (Bootstrap-flavored classNames like `btn btn-primary`, `control-label`, etc.) plus the project's own CSS. Custom widgets such as `DatasetSelector`, `EPSGSelector`, and `FileUploadField` are built with `react-bootstrap` components (`Form.Control`, `ProgressBar`, ...) directly, since `bootstrap` and `react-bootstrap` are already project dependencies. To change the look, edit `CustomFieldTemplate.jsx` / `CustomButtonTemplates.jsx` or the project's global CSS rather than swapping in an `@rjsf` theme package.

### Custom CSS

Target form elements with CSS:

```css
.rjsf .form-group {
  margin-bottom: 15px;
}

.rjsf .field-string input {
  width: 100%;
  padding: 8px;
}

.rjsf .field-description {
  font-size: 0.9em;
  color: #666;
}
```

## Best Practices

### Schema Design

**✅ DO**: Provide defaults and descriptions

```javascript
{
  type: 'number',
  title: 'Threshold',
  description: 'Values below this will be filtered out',
  default: 0.5,
  minimum: 0,
  maximum: 1
}
```

**❌ DON'T**: Use unclear field names

```javascript
{
  type: 'number',
  title: 'T',  // ❌ Too cryptic
  default: 0.5
}
```

### Form State

**✅ DO**: Control form data via state

```javascript
const [formData, setFormData] = useState({});

<CustomForm
  formData={formData}
  onChange={({ formData }) => setFormData(formData)}
/>
```

**❌ DON'T**: Use uncontrolled forms for complex scenarios

```javascript
<CustomForm />  // ❌ No state management
```

### Error Handling

**✅ DO**: Handle submission errors gracefully

```javascript
const handleSubmit = async ({ formData }) => {
  try {
    await submitProcess(formData);
  } catch (error) {
    setError(error.message);
  }
};
```

**❌ DON'T**: Ignore validation errors

```javascript
const handleSubmit = ({ formData }) => {
  // ❌ No error handling
  submitProcess(formData);
};
```

## Advanced Topics

### Custom Templates

Override field templates for custom layouts:

```javascript
import { FieldTemplate } from './CustomFieldTemplate';

<CustomForm
  schema={schema}
  FieldTemplate={FieldTemplate}
/>
```

### Custom Widgets

Register custom widgets for specific types:

```javascript
const widgets = {
  colorPicker: ColorPickerWidget,
  datasetSelector: DatasetSelector
};

<CustomForm
  schema={schema}
  widgets={widgets}
/>

// Use in schema:
{
  type: 'string',
  title: 'Color',
  widget: 'colorPicker'  // References custom widget
}
```

### Form Context

Pass additional data to custom widgets:

```javascript
const formContext = {
  processTypes: availableProcessTypes,
  currentUser: user
};

<CustomForm
  schema={schema}
  formContext={formContext}
/>

// Access in custom widget:
function MyWidget({ formContext }) {
  const { processTypes } = formContext;
  // ...
}
```

### Dynamic Schemas

Generate schemas dynamically based on conditions:

```javascript
function ProcessEditor() {
  const [processType, setProcessType] = useState('fft');
  const [schema, setSchema] = useState(null);

  useEffect(() => {
    fetch(`/process-types/${processType}/schema`)
      .then(r => r.json())
      .then(setSchema);
  }, [processType]);

  return schema ? (
    <CustomForm schema={schema} />
  ) : (
    <div>Loading...</div>
  );
}
```

## Reference

### @rjsf Documentation

For more details on JSON Schema form features, see:
- [@rjsf/core documentation](https://rjsf-team.github.io/react-jsonschema-form/)
- [JSON Schema specification](https://json-schema.org/)

### YmerFlow-Specific Extensions

- `x-format: "dataset"`: Dataset selector widget
- `x-format: "datasetPath"`: Dataset path field (whole-dataset reference)
- `x-format: "upload"`: File upload field
- `x-format: "expression"` (on an `anyOf` schema): Expression field (column reference or computation)
- `format: "x-epsg"` (on a number field): EPSG code selector
- Custom field detection in `CustomStringField.jsx` / `CustomNumberField.jsx`
- Smart dataset grouping in `DatasetSelector.jsx`

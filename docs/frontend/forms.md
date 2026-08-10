# JSON Schema Forms

YmerFlow uses JSON Schema forms for process parameter configuration and other dynamic form generation. The frontend extends the `@rjsf/core` library with custom fields and widgets.

## Overview

Forms are automatically generated from JSON Schema definitions provided by process types. The custom form system is located in `frontend/src/jsoneditor/`.

### Architecture

```
jsoneditor/
├── index.js              # Main exports
├── CustomForm.js         # Wrapper around @rjsf Form
├── CustomStringField.js  # Custom string field with format detection
└── DatasetSelector.js    # Dataset selection widget
```

## Basic Usage

### Using CustomForm

**Always use `CustomForm` instead of the standard `@rjsf Form`:**

```javascript
import CustomForm from './jsoneditor';

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
      onChange={({ formData }) => setFormData(formData)}
      onSubmit={handleSubmit}
    />
  );
}
```

### Why CustomForm?

`CustomForm` provides:
- **Custom field handlers**: Detects special formats like `x-format: "dataset"`
- **Enhanced widgets**: Dataset selector, color picker, etc.
- **Consistent styling**: Bootstrap-based theme
- **Validation**: Built-in JSON Schema validation
- **Error handling**: User-friendly error messages

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
      format: 'uri',           // Must be 'uri'
      'x-format': 'dataset',   // Triggers custom selector
      title: 'Input Dataset'
    }
  }
}
```

### DatasetSelector Component

The `DatasetSelector` provides a searchable dropdown for selecting process outputs.

**Features:**
- **Debounced search** (300ms delay)
- **Smart grouping**: When >4 processes match, shows first dataset + count
- **Click to refine**: Click grouped item to add process name to search
- **Format**: "Process Name / v123 / dataset-name"
- **Value**: Stores full URL: `http://localhost:8000/dataset/{id}`

**Implementation:** See `frontend/src/jsoneditor/DatasetSelector.js` for the complete implementation including:
- Debounced search (300ms)
- Dataset grouping logic
- Loading states
- Click handlers

### Using Selected Dataset

The form data will contain the dataset URL:

```javascript
const handleSubmit = ({ formData }) => {
  console.log(formData.input_data);
  // Output: "http://localhost:8000/dataset/abc-123-xyz"

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

`CustomStringField` detects special `format` and `x-format` properties in the schema and renders appropriate widgets.

**See:** `frontend/src/jsoneditor/CustomStringField.js` for format detection logic including:
- Dataset selector (`format: 'uri'` + `x-format: 'dataset'`)
- Color picker (`format: 'color'`)
- Extensible format detection pattern

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
  liveValidate={true}  // Validate on every change
  onSubmit={handleSubmit}
/>
```

## Styling

### Theme Customization

CustomForm uses Bootstrap theme by default:

```javascript
import { ThemeProvider } from '@rjsf/core';
import { Theme as Bootstrap4Theme } from '@rjsf/bootstrap-4';

<ThemeProvider theme={Bootstrap4Theme}>
  <CustomForm schema={schema} />
</ThemeProvider>
```

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
- Custom field detection in `CustomStringField.js`
- Smart dataset grouping in `DatasetSelector.js`

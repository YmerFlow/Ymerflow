# Comparison: Original vs. Ported

## Package Structure

### Original (emerald-beryl-pipeline)
```
emerald-beryl-pipeline/
├── beryl_pipeline/
│   ├── __init__.py
│   ├── file_import.py          (166 lines)
│   ├── processing.py           (106 lines)
│   ├── inversion.py            (196 lines)
│   ├── utils.py                (39 lines)
│   ├── localize.py             (66 lines)
│   ├── introspect.py           (33 lines)
│   ├── integration.py          (~100 lines)
│   ├── processing_workbench_import.py
│   └── inversion_workbench_import.py
├── setup.py
└── README.md
```

### Ported (aem_processes)
```
aem_processes/
├── __init__.py                  (3 lines)
├── import_process.py           (246 lines) - includes LibaarhusXYZImporter
├── processing_process.py       (222 lines)
├── inversion_process.py        (376 lines)
├── utils.py                    (131 lines) - merged localize.py
├── setup.py                    (42 lines)
├── README.md                   (comprehensive docs)
├── PORTING_NOTES.md           (migration guide)
└── COMPARISON.md              (this file)

Total: ~1,141 lines of Python code
```

## Code Metrics

| Component | Original | Ported | Change |
|-----------|----------|--------|--------|
| Import | 166 lines | 246 lines | +48% (includes importer class) |
| Processing | 106 lines | 222 lines | +109% (explicit dataset handling) |
| Inversion | 196 lines | 376 lines | +92% (inline directives) |
| Utils | 105 lines | 131 lines | +25% (merged localize) |
| **Total Core** | **573 lines** | **975 lines** | **+70%** |

Note: Line count increase is due to:
- Explicit dataset writing (replaced shared utilities)
- Inline directive classes (originally separate)
- Error handling and fallbacks
- Documentation strings

## Feature Comparison

| Feature | Original | Ported | Notes |
|---------|----------|--------|-------|
| **Import** |
| SkyTEM XYZ import | ✅ | ✅ | Same functionality |
| Flight-line splitting | ✅ | ✅ | Preserved |
| URL localization | ✅ | ✅ | fsspec instead of poltergust |
| Multiple formats | XYZ, GEX, msgpack, YAML, GeoJSON | msgpack, GeoJSON | Simplified to essentials |
| Entry point plugins | ✅ | ✅ | Same system |
| **Processing** |
| Pipeline steps | ✅ | ✅ | Same entry point system |
| Data normalization | ✅ | ✅ | Preserved |
| Inversion columns | ✅ | ✅ | num_* field generation |
| Flight-line splitting | ✅ | ✅ | Preserved |
| Diff msgpack | ✅ | ❌ | Not needed in YmerFlow |
| **Inversion** |
| SimPEG integration | ✅ | ✅ | Same framework |
| Multiple models | ✅ | ✅ | L2, sparse |
| Iteration logging | ✅ | ✅ | RMSE, phi_d, phi_m metrics |
| Resource monitoring | ✅ | ✅ | emerald-monitor |
| Save iterations | ✅ | ✅ | Optional intermediate models |
| Flight-line splitting | ✅ | ✅ | Preserved |
| **Orchestration** |
| Task dependencies | Luigi | YmerFlow | Framework change |
| Config files | YAML | JSON Schema | Dynamic generation |
| Completion tracking | DONE files | Process status | Framework change |
| Introspection | Separate task | On-demand | Schemas generated in schema() |
| Integration task | Luigi task | N/A | YmerFlow handles |

## API Comparison

### Import Process

**Original (Luigi):**
```python
import luigi
from beryl_pipeline.file_import import Import

# Create task
task = Import(import_name="s3://bucket/import001")

# Run via Luigi
luigi.build([task], local_scheduler=True)

# Access outputs
data_path = task.data().path  # s3://bucket/import001/out.xyz
gex_path = task.system_data().path  # s3://bucket/import001/out.gex
```

**Ported (YmerFlow):**
```python
from aem_processes.import_process import Import

# Get schema
schema = Import.schema()

# Run process
result = Import.run(
    storage_context={
        'process_id': 'proc-123',
        'storage_base': 's3://bucket',
        'storage_kwargs': {}
    },
    importer={
        'name': 'SkyTEM XYZ',
        'args': {
            'files': {'xyzfile': '...', 'gexfile': '...'},
            'scalefactor': 1e-12,
            'projection': 32611
        }
    }
)

# Access outputs
data_url = result['outputs']['imported_data']
# s3://bucket/processes/proc-123/datasets/{uuid}/root.msgpack
```

### Processing Process

**Original (Luigi):**
```python
from beryl_pipeline.processing import Processing

# Create task (reads config from file)
task = Processing(processing_name="s3://bucket/processing001")

# Run
luigi.build([task])

# Access output
processed_path = task.data().path
```

**Ported (YmerFlow):**
```python
from aem_processes.processing_process import Processing

result = Processing.run(
    storage_context={...},
    input_data="s3://bucket/processes/proc-123/datasets/{uuid}/root.msgpack",
    steps=[
        {'name': 'Workbench import', 'args': {...}}
    ]
)

processed_url = result['outputs']['processed_data']
```

### Inversion Process

**Original (Luigi):**
```python
from beryl_pipeline.inversion import Inversion

task = Inversion(inversion_name="s3://bucket/inversion001")
luigi.build([task])

# Access multiple outputs
smooth_model = task.output().path  # .../smooth_model.xyz
sparse_model = task.output().path  # .../sparse_model.xyz
```

**Ported (YmerFlow):**
```python
from aem_processes.inversion_process import Inversion

result = Inversion.run(
    storage_context={...},
    input_data="s3://bucket/processes/proc-456/datasets/{uuid}/root.msgpack",
    system={
        'name': 'Dual moment TEM',
        'args': {
            'optimizer__max_iter': 50,
            'save_iterations': False
        }
    }
)

# Access multiple outputs
outputs = result['outputs']
# {
#   'processed': 's3://.../datasets/{uuid1}/root.msgpack',
#   'smooth_model': 's3://.../datasets/{uuid2}/root.msgpack',
#   'smooth_synthetic': 's3://.../datasets/{uuid3}/root.msgpack',
#   'sparse_model': 's3://.../datasets/{uuid4}/root.msgpack',
#   'sparse_synthetic': 's3://.../datasets/{uuid5}/root.msgpack'
# }
```

## Schema Examples

### Import Schema (Generated)

```json
{
  "type": "object",
  "properties": {
    "importer": {
      "anyOf": [
        {
          "type": "object",
          "title": "SkyTEM XYZ",
          "properties": {
            "name": {"const": "SkyTEM XYZ"},
            "args": {
              "type": "object",
              "properties": {
                "files": {
                  "type": "object",
                  "x-format": "multi-url",
                  "properties": {
                    "xyzfile": {"type": "string", "format": "url", "pattern": "\\.xyz$"},
                    "gexfile": {"type": "string", "format": "url", "pattern": "\\.gex$"},
                    "alcfile": {"type": "string", "format": "url", "pattern": "\\.alc$"}
                  }
                },
                "scalefactor": {"type": "number", "default": 1e-12},
                "projection": {"type": "integer", "format": "x-epsg"}
              }
            }
          }
        }
      ]
    }
  },
  "required": ["importer"]
}
```

### Processing Schema (Generated)

```json
{
  "type": "object",
  "properties": {
    "input_data": {
      "type": "string",
      "format": "uri",
      "x-format": "dataset",
      "title": "Input Dataset"
    },
    "steps": {
      "type": "array",
      "title": "Processing Steps",
      "items": {
        "anyOf": [
          // ... processing steps from entry points
        ]
      }
    }
  },
  "required": ["input_data"]
}
```

### Inversion Schema (Generated)

```json
{
  "type": "object",
  "properties": {
    "input_data": {
      "type": "string",
      "format": "uri",
      "x-format": "dataset"
    },
    "system": {
      "anyOf": [
        {
          "type": "object",
          "title": "Dual moment TEM",
          "properties": {
            "name": {"const": "Dual moment TEM"},
            "args": {
              "type": "object",
              "properties": {
                "save_iterations": {"type": "boolean", "default": false},
                "optimizer__max_iter": {"type": "integer"},
                // ... system-specific args
              }
            }
          }
        }
      ]
    }
  },
  "required": ["input_data", "system"]
}
```

## Dataset Structure Comparison

### Original Output Structure

```
s3://bucket/import001/
├── out.xyz                    # Main data (text format)
├── out.gex                    # System data (text format)
├── out.msgpack                # Binary format
├── out.summary.yml            # Metadata
├── out.geojson               # Geography
├── out.line1.xyz             # Flight line 1
├── out.line1.gex
├── out.line1.msgpack
├── out.line1.summary.yml
├── out.line1.geojson
├── log.yml                    # Process log
└── DONE                       # Completion marker
```

### Ported Output Structure

```
s3://bucket/processes/proc-123/datasets/uuid-456/
├── root.msgpack              # Main data (includes GEX)
├── root.geojson              # Geography
├── info.json                 # Dataset metadata
└── parts/
    ├── line1.msgpack         # Flight line 1
    ├── line1.geojson
    ├── line2.msgpack         # Flight line 2
    └── line2.geojson
```

**Key Differences:**
1. GEX embedded in msgpack (not separate file)
2. No XYZ text format (msgpack only)
3. No summary.yml (info.json instead)
4. Parts in subdirectory (cleaner structure)
5. No DONE marker (tracked by framework)
6. No log.yml (tracked by framework)

## Entry Points Comparison

### Original

```python
entry_points = {
    'beryl_pipeline.import': [
        'SkyTEM XYZ=beryl_pipeline.file_import:LibaarhusXYZImporter'
    ],
    'simpeg.static_instrument': [
        'Dual moment TEM=SimPEG.electromagnetics.utils.static_instrument.dual:DualMomentTEMXYZSystem',
        'Workbench import=beryl_pipeline.inversion_workbench_import:WorkbenchImporter'
    ],
    'emeraldprocessing.pipeline_step': [
        'Workbench import=beryl_pipeline.processing_workbench_import:import_from_workbench',
    ]
}
```

### Ported

```python
entry_points = {
    # Process types for YmerFlow
    "ymerflow.process_types": [
        "import_skytem=aem_processes.import_process:Import",
        "process_tem=aem_processes.processing_process:Processing",
        "invert_tem=aem_processes.inversion_process:Inversion",
    ],
    # Re-export importers for compatibility
    "beryl_pipeline.import": [
        "SkyTEM XYZ=aem_processes.import_process:LibaarhusXYZImporter",
    ],
}
```

**Note:** Processing steps and inversion systems are imported from emeraldprocessing and simpeg packages.

## Migration Checklist

For teams migrating from Luigi pipeline to YmerFlow:

- [x] Core processes ported (Import, Processing, Inversion)
- [x] Entry point system preserved
- [x] Flight-line splitting maintained
- [x] Schema generation implemented
- [x] Dataset format conversion (Luigi → YmerFlow)
- [x] URL localization adapted (poltergust → fsspec)
- [x] Resource monitoring preserved
- [x] Iteration logging maintained
- [ ] Integration testing with real data
- [ ] Performance benchmarking
- [ ] Documentation updates
- [ ] User training materials

## Backward Compatibility

The ported package maintains backward compatibility with:
- ✅ `beryl_pipeline.import` entry points (importers)
- ✅ `emeraldprocessing.pipeline_step` entry points (processing)
- ✅ `simpeg.static_instrument` entry points (inversion)
- ✅ libaarhusxyz data format
- ✅ swaggerspect schema generation

Not compatible with:
- ❌ Luigi task dependencies
- ❌ Config YAML files
- ❌ DONE marker files
- ❌ poltergust-luigi-utils caching
- ❌ Output file naming conventions

## Performance Considerations

### Original (Luigi)
- Caching via poltergust-luigi-utils
- Incremental task execution (skip if DONE exists)
- Local file system preferred
- Manual cleanup required

### Ported (YmerFlow)
- No built-in caching (relies on fsspec caching)
- Full re-execution on each run
- Cloud-native by design
- Automatic cleanup (temp files)

**Recommendation:** Add caching layer in YmerFlow framework for frequently accessed datasets.

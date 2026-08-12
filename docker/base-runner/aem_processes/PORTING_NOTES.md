# Porting Notes: emerald-beryl-pipeline → aem_processes

## Summary

Successfully ported emerald-beryl-pipeline Luigi tasks to YmerFlow framework.

## File Mapping

| Original (Luigi) | Ported (YmerFlow) | Status |
|-----------------|-------------------|--------|
| `file_import.py` | `import_process.py` | ✅ Complete |
| `processing.py` | `processing_process.py` | ✅ Complete |
| `inversion.py` | `inversion_process.py` | ✅ Complete |
| `utils.py` | `utils.py` | ✅ Adapted |
| `localize.py` | `utils.py` (merged) | ✅ Integrated |
| `introspect.py` | N/A (schemas generated on-demand) | ✅ Not needed |
| `integration.py` | N/A (YmerFlow orchestrates) | ✅ Not needed |

## Key Changes

### 1. Task Structure

**Before (Luigi):**
```python
class Import(luigi.Task):
    import_name = luigi.Parameter()

    def requires(self):
        return None

    def run(self):
        # Read config from file
        with self.config_target().open("r") as f:
            config = yaml.load(f)
        # Process...

    def output(self):
        return Target('%s/DONE' % self.import_name)
```

**After (YmerFlow):**
```python
class Import:
    @classmethod
    def schema(cls):
        # Return JSON Schema (dynamically from entry points)
        return swaggerspect.swagger_to_json_schema(...)

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        # Parameters come from kwargs
        # Write datasets using fsspec
        return {"status": "success", "outputs": {...}}
```

### 2. File Operations

**Before (Luigi):**
```python
# Using poltergust-luigi-utils caching
target = poltergust_luigi_utils.caching.CachingOpenerTarget(url)
with target.open("w") as f:
    f.write(data)
```

**After (YmerFlow):**
```python
# Using fsspec directly
with fsspec.open(url, 'wb', **storage_kwargs) as f:
    f.write(data)
```

### 3. Dependencies

**Before (Luigi):**
```python
def requires(self):
    with self.config_target().open("r") as f:
        config = yaml.load(f)
    return Import(import_name=config["data"]["args"]["data"].rsplit("/", 1)[0])
```

**After (YmerFlow):**
```python
# Dependencies via dataset URLs in schema
"input_data": {
    "type": "string",
    "format": "uri",
    "x-format": "dataset",
    "title": "Input Dataset"
}

# In run():
input_data_url = kwargs.get('input_data')
with localize_urls({'input': input_data_url}, storage_kwargs) as localized:
    xyz, gex = libaarhusxyz.export.msgpack.load(localized['input'], True)
```

### 4. Output Structure

**Before (Luigi):**
```
{import_name}/
├── out.xyz
├── out.gex
├── out.msgpack
├── out.summary.yml
├── out.geojson
├── out.{flight_line}.xyz
├── out.{flight_line}.gex
├── out.{flight_line}.msgpack
├── out.{flight_line}.summary.yml
├── out.{flight_line}.geojson
├── log.yml
└── DONE
```

**After (YmerFlow):**
```
{storage_base}/processes/{process_id}/datasets/{dataset_id}/
├── root.msgpack
├── root.geojson
├── info.json
└── parts/
    ├── {flight_line}.msgpack
    └── {flight_line}.geojson
```

### 5. Configuration

**Before (Luigi):**
```yaml
# config.yml stored at import_name/config.yml
importer:
  name: "SkyTEM XYZ"
  args:
    files:
      xyzfile: "s3://bucket/data.xyz"
      gexfile: "s3://bucket/data.gex"
    scalefactor: 1e-12
    projection: 32611
```

**After (YmerFlow):**
```json
// JSON Schema parameters passed to run()
{
  "importer": {
    "name": "SkyTEM XYZ",
    "args": {
      "files": {
        "xyzfile": "s3://bucket/data.xyz",
        "gexfile": "s3://bucket/data.gex"
      },
      "scalefactor": 1e-12,
      "projection": 32611
    }
  }
}
```

## Implementation Details

### URL Localization

**Original (poltergust-luigi-utils):**
```python
@contextlib.contextmanager
def localize(config):
    mapping = {}
    # Downloads URLs to temp files
    # Uses CachingOpenerTarget context managers
    yield localized_config
```

**Ported (fsspec):**
```python
@contextlib.contextmanager
def localize_urls(config, storage_kwargs):
    temp_files = []
    # Downloads URLs using fsspec.open()
    # Cleans up temp files on exit
    yield localized_config
```

### System Loading

**Original:**
```python
def load_system(system):
    if system["name"].startswith("/"):
        # Load from file
        with open(system["name"]) as f:
            system_description = yaml.load(f)
        with load_system(system_description) as base:
            yield load_system_from_base(base, system)
    else:
        # Load from entry point
        yield load_system_from_base(systems[system["name"]].load(), system)
```

**Ported:**
```python
def load_system(system, storage_kwargs):
    # Same logic but supports remote URLs via fsspec
    if system["name"].startswith("/") or "://" in system["name"]:
        with fsspec.open(system["name"], 'r', **storage_kwargs) as f:
            system_description = yaml.load(f)
        # ... recursive loading
    else:
        # Entry point loading unchanged
```

### Dataset Writing

**Key Pattern:**
```python
def _write_dataset(cls, xyz, gex, dataset_name, process_id, storage_base, storage_kwargs):
    dataset_id = str(uuid.uuid4())
    dataset_prefix = f"{storage_base}/processes/{process_id}/datasets/{dataset_id}"

    # 1. Write root msgpack (XYZ + GEX)
    with fsspec.open(f"{dataset_prefix}/root.msgpack", 'wb', **storage_kwargs) as f:
        xyz.to_msgpack(f, gex=gex)

    # 2. Write root geography (GeoJSON)
    with fsspec.open(f"{dataset_prefix}/root.geojson", 'w', **storage_kwargs) as f:
        json.dump(xyz.to_geojson(), f)

    # 3. Split by flight lines and write parts
    for fline, line_xyz in xyz.split_by_line().items():
        fline_str = slugify.slugify(str(fline), separator="_")
        with fsspec.open(f"{dataset_prefix}/parts/{fline_str}.msgpack", 'wb', **storage_kwargs) as f:
            line_xyz.to_msgpack(f, gex=gex)
        # ... write part geography

    # 4. Write info.json with parts metadata
    with fsspec.open(f"{dataset_prefix}/info.json", 'w', **storage_kwargs) as f:
        json.dump(dataset_info, f)

    return dataset_id
```

## Schema Generation

### Import Schema

Uses `swaggerspect.get_apis("beryl_pipeline.import")` to introspect:
- `LibaarhusXYZImporter.__init__` signature
- Type annotations with embedded `json_schema` metadata
- Generates dynamic schema with available importers

### Processing Schema

Uses `swaggerspect.get_apis("emeraldprocessing.pipeline_step")` for:
- Available processing steps from entry points
- Multi-step array schema
- Dataset URL input parameter

### Inversion Schema

Uses `swaggerspect.get_apis("simpeg.static_instrument")` for:
- Available inversion systems from entry points
- Adds `save_iterations` flag to all systems
- Dataset URL input parameter

## Testing Checklist

- [ ] Install package: `pip install -e .`
- [ ] Verify entry points registered: `pip show aem-processes`
- [ ] Test import schema generation: `Import.schema()`
- [ ] Test processing schema generation: `Processing.schema()`
- [ ] Test inversion schema generation: `Inversion.schema()`
- [ ] Test with full dependencies: `pip install -e ".[all]"`
- [ ] Run import process with sample data
- [ ] Run processing process with imported data
- [ ] Run inversion process with processed data
- [ ] Verify dataset structure matches YmerFlow format
- [ ] Verify flight-line splitting works
- [ ] Verify resource monitoring (if emerald-monitor installed)

## Known Limitations

1. **Entry Point Discovery**: Requires emerald-beryl-pipeline[all] to be installed for processing steps and inversion systems to be available

2. **Schema Fallbacks**: If swaggerspect fails, fallback schemas provide basic functionality but less detailed validation

3. **URL Localization**: Temporary files are created for remote datasets - may use significant disk space for large surveys

4. **Resource Monitoring**: emerald-monitor is optional - inversions run without it but don't track CPU/memory usage

## Future Enhancements

1. **Streaming**: Support streaming large datasets without full localization
2. **Partial Loading**: Load only required flight lines for processing
3. **Caching**: Add caching layer for frequently accessed datasets
4. **Validation**: Add pre-flight validation of parameters before running
5. **Progress Tracking**: Add progress callbacks for long-running inversions
6. **Parallel Processing**: Process flight lines in parallel

## Migration Guide

For users migrating from Luigi-based pipeline:

1. **Replace config files with parameters**: Convert YAML configs to JSON parameters
2. **Update import paths**: Change from `import_name/out.msgpack` to dataset URLs
3. **Remove task dependencies**: YmerFlow handles dependency graph
4. **Update file paths**: Use storage URLs instead of local paths
5. **Remove DONE markers**: Process completion tracked automatically

## Support

For issues or questions:
- Original pipeline: https://github.com/emerald-geomodelling/emerald-beryl-pipeline
- YmerFlow framework: See project documentation

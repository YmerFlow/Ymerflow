import time
import uuid
import json
import fsspec
import pandas as pd
from ymerflow_runner import xyz_utils


def create_mock_dataset(process_type: str, output_name: str, storage_context: dict):
    """Create a mock dataset and write to storage.

    Args:
        process_type: Type of process (fft, inversion, etc.)
        output_name: Name of output (spectrum, model, etc.)
        storage_context: Dict with process_id, storage_base, storage_kwargs

    Returns:
        Storage URL of created dataset
    """
    dataset_id = str(uuid.uuid4())
    process_id = storage_context['process_id']
    process_version = storage_context['version']
    project_id = storage_context['project_id']
    storage_base = storage_context['storage_base']
    storage_kwargs = storage_context['storage_kwargs']

    # Create XYZ dataset with msgpack format
    xyz_data = xyz_utils.create_mock_xyz(process_type=process_type)
    msgpack_data = xyz_utils.xyz_to_msgpack(xyz_data)

    # Store root part data
    root_file_url = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"
    print(f"Writing msgpack dataset to: {root_file_url}")

    with fsspec.open(root_file_url, 'wb', **storage_kwargs) as f:
        f.write(msgpack_data)

    # Generate and store root part geography (GeoJSON)
    root_geojson = xyz_utils.xyz_to_geojson(xyz_data)
    for feature in root_geojson["features"]:
        feature["properties"]["dataset_id"] = dataset_id

    root_geography_url = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.geojson"
    print(f"Writing geography to: {root_geography_url}")

    with fsspec.open(root_geography_url, 'w', **storage_kwargs) as f:
        json.dump(root_geojson, f)

    # Add additional parts from unique values in "title" column
    if "title" in xyz_data["xyz"].flightlines.columns:
        unique_titles = xyz_data["xyz"].flightlines["title"].unique()
        for title in unique_titles:
            # Convert numpy types to Python native types for JSON serialization
            title_str = str(title) if pd.notna(title) else "unknown"
            part_file_url = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/parts/{title_str}.msgpack"

            # Extract and save part data
            part_xyz = xyz_utils.extract_xyz_part(xyz_data, title_str)
            if part_xyz:
                part_msgpack = xyz_utils.xyz_to_msgpack(part_xyz)
                print(f"Writing part msgpack to: {part_file_url}")

                with fsspec.open(part_file_url, 'wb', **storage_kwargs) as f:
                    f.write(part_msgpack)

                # Generate and store part geography (GeoJSON)
                part_geojson = xyz_utils.xyz_to_geojson(part_xyz, part_path=title_str)
                for feature in part_geojson["features"]:
                    feature["properties"]["dataset_id"] = dataset_id

                part_geography_url = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/parts/{title_str}.geojson"
                print(f"Writing part geography to: {part_geography_url}")

                with fsspec.open(part_geography_url, 'w', **storage_kwargs) as f:
                    json.dump(part_geojson, f)

    # Scan written files and build parts structure (similar to _create_outputs in process.py)
    dataset_prefix = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}"
    files = {}
    parts = {}

    # Get fsspec filesystem
    fs = fsspec.filesystem(storage_base.split('://')[0], **storage_kwargs)
    bucket_and_path = dataset_prefix.split('://', 1)[1]

    try:
        # List all items in dataset directory
        items = fs.ls(bucket_and_path, detail=True)

        for item in items:
            if item.get('type') != 'directory':
                file_path = item['name']
                filename = file_path.split('/')[-1]

                # Reconstruct storage URL
                file_storage_url = f"{storage_base.split('://')[0]}://{file_path}"

                # Determine mime type
                if filename.endswith('.msgpack'):
                    mime_type = "application/x-aarhusxyz-msgpack"
                elif filename.endswith('.geojson'):
                    mime_type = "application/geo+json"
                elif filename.endswith('.json'):
                    mime_type = "application/json"
                else:
                    mime_type = "application/octet-stream"

                # Check if this is root or a part
                if filename == 'root.msgpack':
                    # Root data file
                    files["application/x-aarhusxyz-msgpack"] = file_storage_url
                elif filename == 'root.geojson':
                    # Root geography file
                    files["application/geo+json"] = file_storage_url

        # Check for parts directory
        parts_path = f"{bucket_and_path}/parts"
        try:
            part_files = fs.ls(parts_path, detail=True)

            for item in part_files:
                if item.get('type') != 'directory':
                    file_path = item['name']
                    filename = file_path.split('/')[-1]

                    # Extract part name (without extension)
                    if filename.endswith('.msgpack'):
                        part_name = filename[:-8]  # Remove .msgpack
                        mime_type = "application/x-aarhusxyz-msgpack"
                    elif filename.endswith('.geojson'):
                        part_name = filename[:-8]  # Remove .geojson
                        mime_type = "application/geo+json"
                    else:
                        continue

                    # Reconstruct storage URL
                    file_storage_url = f"{storage_base.split('://')[0]}://{file_path}"

                    # Add to parts structure
                    if part_name not in parts:
                        parts[part_name] = {"files": {}}

                    if filename.endswith('.msgpack'):
                        parts[part_name]["files"]["application/x-aarhusxyz-msgpack"] = file_storage_url
                    elif filename.endswith('.geojson'):
                        parts[part_name]["files"]["application/geo+json"] = file_storage_url
        except FileNotFoundError:
            # No parts directory exists, that's fine
            pass
    except Exception as e:
        print(f"Warning: Could not scan dataset files: {e}")

    # Create info.json with dataset metadata
    dataset_info = {
        "id": dataset_id,
        "mime_type": "application/x-aarhusxyz-msgpack",
        "dataset_name": output_name,
        "files": files,
        "parts": parts
    }

    info_url = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/info.json"
    print(f"Writing dataset info to: {info_url}")

    with fsspec.open(info_url, 'w', **storage_kwargs) as f:
        json.dump(dataset_info, f, indent=2)

    print(f"Dataset written successfully: {dataset_id}")
    return root_file_url


class fft:
    """FFT process type."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for FFT parameters."""
        return {
            "type": "object",
            "properties": {
                "input_signal": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Signal"
                },
                "window": {"type": "number", "default": 1.0},
                "overlap": {"type": "number", "default": 0.5}
            },
            "required": ["window"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Fake FFT process that writes output datasets."""
        print("Running FFT...")
        print(f"Parameters: {kwargs}")

        time.sleep(5)

        # Create output datasets
        outputs = {}
        if storage_context:
            outputs['spectrum'] = create_mock_dataset('fft', 'spectrum', storage_context)
            outputs['processed'] = create_mock_dataset('fft', 'processed', storage_context)

        print("FFT complete")
        return {"status": "success", "outputs": outputs}


class inversion:
    """Inversion process type."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for inversion parameters."""
        return {
            "type": "object",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset"
                },
                "regularization": {"type": "number", "default": 0.1},
                "max_iter": {"type": "integer", "default": 50}
            }
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Fake inversion process that writes output datasets."""
        print("Running inversion...")
        print(f"Parameters: {kwargs}")

        time.sleep(10)

        # Create output datasets
        outputs = {}
        if storage_context:
            outputs['model'] = create_mock_dataset('inversion', 'model', storage_context)
            outputs['residuals'] = create_mock_dataset('inversion', 'residuals', storage_context)

        print("Inversion complete")
        return {"status": "success", "outputs": outputs}


class import_data:
    """Import data process type."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for import_data parameters."""
        return {
            "type": "object",
            "properties": {
                "data_file": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "upload",
                    "title": "Data File"
                },
                "file_format": {
                    "type": "string",
                    "enum": ["csv", "xyz", "json"],
                    "default": "csv",
                    "title": "File Format"
                }
            },
            "required": ["data_file"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Import data process that reads from uploads and writes datasets."""
        print("Running import_data...")
        print(f"Parameters: {kwargs}")

        # In a real implementation, would read from kwargs['data_file'] (upload URL)
        # and convert to dataset format

        time.sleep(3)

        # Create output dataset
        outputs = {}
        if storage_context:
            outputs['imported_data'] = create_mock_dataset('import_data', 'imported_data', storage_context)

        print("Import complete")
        return {"status": "success", "outputs": outputs}


class create_environment:
    """Create environment process type."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for create_environment parameters."""
        # No schema defined in migration for this process type
        return {
            "type": "object",
            "properties": {}
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Fake environment creation."""
        print("Creating environment...")
        print(f"Parameters: {kwargs}")

        time.sleep(15)

        print("Environment created")
        return {"status": "success"}

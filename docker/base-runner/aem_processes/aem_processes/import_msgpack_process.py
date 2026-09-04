"""Import process for XYZ msgpack containers (e.g., from YmerFlow AEM Model Simulator)."""

import libaarhusxyz
from libaarhusxyz.export import msgpack as xyz_msgpack
from .utils import localize_urls
from .dataset_utils import write_dataset


class MsgpackImporter:
    """Import AEM data from XYZ msgpack container with embedded GEX."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for import parameters."""
        return {
            "type": "object",
            "title": "Import YmerFlow AEM (msgpack)",
            "description": "Import airborne TEM data from a YmerFlow XYZ msgpack container with an "
                           "embedded GEX (e.g. from the AEM Model Simulator). Produces an XYZ "
                           "dataset ready for processing and inversion.",
            "properties": {
                "msgpack_file": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "upload",
                    "x-url-media-type": "application/x-aarhusxyz-msgpack",
                    "title": "XYZ Msgpack File",
                    "description": "XYZ msgpack container with embedded GEX data (.xyz or .msgpack)",
                    "pattern": "\\.(xyz|msgpack)(\\.gz|\\.bz2|\\.zip)?$"
                }
            },
            "required": ["msgpack_file"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Import msgpack data and write output dataset.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Process parameters from schema (msgpack_file)

        Returns:
            Dict with status and outputs
        """
        print("Running msgpack import...")
        print(f"Parameters: {kwargs}")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context['process_id']
        process_version = storage_context['version']
        storage_base = storage_context['storage_base']
        storage_kwargs = storage_context['storage_kwargs']

        # Extract parameters
        msgpack_file = kwargs.get("msgpack_file")

        # Validate required parameters
        assert msgpack_file is not None, "Missing msgpack file"

        # Localize URLs to local files
        file_params = {
            "msgpack_file": msgpack_file
        }

        with localize_urls(file_params, storage_kwargs) as localized_files:
            print("Loading XYZ msgpack container...")

            # Load XYZ msgpack (contains both data and GEX)
            # Use the msgpack-specific loader which handles binary format correctly
            xyz, gex = xyz_msgpack.load(localized_files["msgpack_file"], return_gex=True)

            # Validate that the msgpack contains required data
            assert hasattr(xyz, 'flightlines'), "Invalid msgpack: missing flightlines data"

            # Check for projection in model_info
            if 'projection' not in xyz.model_info:
                print("Warning: No projection found in msgpack, data may not have CRS information")

            # Try to normalize column names (may not be needed for files from Model Simulator)
            # This is safe to call - it only renames columns if they match known patterns
            try:
                xyz.normalize(naming_standard="alc")
                print("Normalized column names to ALC standard")
            except Exception as e:
                print(f"Could not normalize column names: {e}")
                print("Continuing without normalization (may be OK for resistivity models)")

            # Ensure GEX exists (msgpack.load returns None if no GEX data in file)
            if gex is None:
                print("Warning: No GEX/system data found in msgpack")
                # Create empty GEX for compatibility
                gex = libaarhusxyz.GEX()
            else:
                print("Found embedded GEX/system data in msgpack")

            # Write dataset
            print("Writing imported dataset...")
            dataset_id = write_dataset(
                xyz,
                gex,
                "imported_data",
                process_id,
                process_version,
                storage_base,
                storage_kwargs
            )

            outputs = {
                'imported_data': f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"
            }

            print("Msgpack import complete")
            return {"status": "success", "outputs": outputs}

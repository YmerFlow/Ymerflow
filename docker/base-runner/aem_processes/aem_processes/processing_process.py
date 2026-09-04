"""Processing process for geophysics data."""

import libaarhusxyz
import libaarhusxyz.export.msgpack
import numpy as np
import swaggerspect
from .utils import get_entry_points, load_fn, localize_urls, normalize_column_case
from .dataset_utils import write_dataset


class Processing:
    """Apply data processing steps to imported survey data."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for processing parameters.

        Dynamically generates schema from available processing steps.
        """
        # Get available processing steps
        try:
            steps_schema = swaggerspect.swagger_to_json_schema(
                swaggerspect.get_apis("emeraldprocessing.pipeline_step"),
                multi=True  # Allow multiple steps
            )
        except Exception as e:
            # Fallback if swaggerspect fails or no steps available
            steps_schema = {
                "type": "array",
                "title": "Processing Steps",
                "description": "Sequence of processing steps to apply",
                "items": {
                    "type": "object"
                }
            }

        return {
            "type": "object",
            "title": "Process TEM",
            "description": "Apply a configurable chain of processing steps (filtering, averaging, "
                           "gate handling, etc.) to an imported airborne TEM dataset, producing a "
                           "processed XYZ dataset ready for inversion.",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": "Dataset from import or previous processing"
                },
                "steps": steps_schema
            },
            "required": ["input_data"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Process data and write output datasets.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Process parameters from schema

        Returns:
            Dict with status and outputs
        """
        print("Running processing...")
        print(f"Parameters: {kwargs}")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context['process_id']
        process_version = storage_context['version']
        storage_base = storage_context['storage_base']
        storage_kwargs = storage_context['storage_kwargs']

        # Localize all URLs in kwargs
        with localize_urls(kwargs, storage_kwargs) as localized_kwargs:
            # Get input dataset path (now localized)
            input_data_path = localized_kwargs.get('input_data')
            if not input_data_path:
                raise ValueError("input_data is required")

            # Get processing steps (now localized)
            steps = localized_kwargs.get('steps', [])

            # Use default data loader
            data_loader_name = 'emeraldprocessing.pipeline.ProcessingData'

            # Load XYZ and GEX data once
            print(f"Loading input data from: {input_data_path}")
            xyz, gex = libaarhusxyz.export.msgpack.load(input_data_path, True)
            print(f"  Flightlines columns before normalize: {list(xyz.flightlines.columns)}")
            normalize_column_case(xyz)
            xyz.normalize(naming_standard="alc")
            print(f"  Flightlines columns after normalize:  {list(xyz.flightlines.columns)}")
            print(f"  tilt_roll_column={xyz.tilt_roll_column!r}  tilt_pitch_column={xyz.tilt_pitch_column!r}")

            # Populate Current_Ch## from GEX approximate current if missing.
            # This can happen when the container libaarhusxyz version differs
            # from the one used at import time, or if the column was not
            # present in the original XYZ file and was not written into the
            # msgpack by the import process.  emeraldprocessing's
            # makeGateTimesDipoleMoments() requires these columns in
            # xyz.flightlines and will KeyError without them.
            for ch in range(1, gex.number_channels + 1):
                ch_key = f"Channel{ch}"
                suffix = f"Ch{ch:02d}"
                current_col = f"Current_{suffix}"
                if current_col not in xyz.flightlines.columns:
                    print(f"  {current_col} missing from flightlines — "
                          f"filling from GEX TxApproximateCurrent")
                    xyz.flightlines[current_col] = (
                        gex.gex_dict[ch_key]["TxApproximateCurrent"]
                    )

            # Create ProcessingData instance with xyz and gex objects directly
            print(f"Creating data loader: {data_loader_name}")
            ProcessingDataClass = load_fn(data_loader_name)

            # Note: ProcessingData expects outdir for temporary files
            import tempfile
            with tempfile.TemporaryDirectory() as tempdir:
                data = ProcessingDataClass(
                    outdir=tempdir,
                    data=xyz,
                    system_data=gex
                )

                # Store original data for reference
                data.orig_xyz = xyz
                data.orig_xyz_by_line = xyz.split_by_line()

                # Apply processing steps (already localized)
                if steps:
                    print(f"Applying {len(steps)} processing step(s)...")
                    data.process(steps)
                else:
                    print("No processing steps specified, passing through data")

                # Add inversion-ready columns (num_* fields for inuse keys)
                print("Adding inversion-ready columns...")
                try:
                    from emeraldprocessing.tem.data_keys import inuse_key_prefix

                    for key in data.xyz.layer_data.keys():
                        if inuse_key_prefix in key:
                            if '_' not in key.split(inuse_key_prefix)[0]:
                                col_name = f"num_{key}"
                                data.xyz.flightlines[col_name] = np.abs(
                                    data.xyz.layer_data[key]
                                ).sum(axis=1, skipna=True)
                except ImportError:
                    print("Warning: emeraldprocessing not available, skipping inversion columns")

                # Write processed dataset
                print("Writing processed dataset...")
                dataset_id = write_dataset(
                    data.xyz,
                    gex,
                    "processed_data",
                    process_id,
                    process_version,
                    storage_base,
                    storage_kwargs
                )

                outputs = {
                    'processed_data': f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"
                }

                print("Processing complete")
                return {"status": "success", "outputs": outputs}

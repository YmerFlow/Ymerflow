"""Forward modelling process for electromagnetic data."""

import json
import fsspec
import libaarhusxyz
import libaarhusxyz.export.msgpack
import numpy as np
import pandas as pd
import swaggerspect
import SimPEG
import SimPEG.directives
from .utils import get_entry_points, load_system, localize_urls, normalize_column_case
from .dataset_utils import write_dataset
import swaggerspect.validate
import copy


class Forward:
    """Run forward modelling for electromagnetic data.

    Takes a resistivity model as input and generates synthetic AEM responses.
    """

    @classmethod
    def system_schema(cls):
        return swaggerspect.swagger_to_json_schema(
            swaggerspect.get_apis("simpeg.static_instrument"),
            multi=False
        )

    @classmethod
    def schema(cls):
        """Return JSON Schema for forward modelling parameters.

        Dynamically generates schema from available systems.
        """

        return {
            "type": "object",
            "title": "Forward Model TEM",
            "description": "Compute the synthetic airborne TEM response of a resistivity model "
                           "(from an inversion or model simulator) for a chosen system geometry.",
            "properties": {
                "input_model": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Resistivity Model",
                    "description": "Resistivity model dataset to forward model (from inversion or model simulator)"
                },
                "system": cls.system_schema(),
            },
            "required": ["input_model", "system"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Run forward modelling and write output dataset.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Process parameters from schema

        Returns:
            Dict with status and outputs
        """
        print("Running forward modelling...")
        print(f"Parameters: {kwargs}")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context['process_id']
        process_version = storage_context['version']
        storage_base = storage_context['storage_base']
        storage_kwargs = storage_context['storage_kwargs']

        # Get input model URL
        input_model_url = kwargs.get('input_model')
        if not input_model_url:
            raise ValueError("input_model is required")

        # Get system configuration
        system_config = kwargs.get('system', {})
        if not system_config:
            raise ValueError("system configuration is required")

        # Transform system_config from swaggerspect format to load_system format
        # swaggerspect produces: {"system_name": {"param1": val1, ...}}
        # load_system expects: {"name": "system_name", "args": {"param1": val1, ...}}

        system_config = copy.deepcopy(system_config)
        swaggerspect.validate.GroupMergingValidator(
            cls.system_schema()
        ).validate(
            system_config
        )

        system_name, system_args = next(iter(system_config.items()))
        system_config = {"name": system_name, "args": system_args}

        # Track outputs
        outputs = {}

        # Localize input model URL
        print(f"Loading input model from: {input_model_url}")
        with localize_urls({'input': input_model_url}, storage_kwargs) as localized:
            input_path = localized['input']

            xyz, gex = libaarhusxyz.export.msgpack.load(input_path, True)
            normalize_column_case(xyz)
            xyz.normalize(naming_standard="libaarhusxyz")

            # Verify this is a resistivity model (has layer_data)
            if not hasattr(xyz, 'layer_data') or not xyz.layer_data:
                raise ValueError(
                    "Input dataset does not appear to be a resistivity model. "
                    "Forward modelling requires a dataset with layer_data (resistivity values). "
                    "Expected input: output from inversion or resistivity model simulator. "
                    "If you have raw AEM data, use the inversion process instead."
                )

            print(f"Loading forward modelling system: {system_config.get('name')}")
            with load_system(system_config, storage_kwargs) as SystemClass:
                CalibratedSystem = SystemClass.load_gex(gex)

                # Create forward modelling instance
                print("Creating forward modelling system...")
                forward_system = CalibratedSystem(xyz)

                # Run forward modelling
                print("Running forward modelling...")
                synthetic_data = forward_system.forward()

                # Collect output dataset (synthetic data)
                print("Collecting results...")

                # The forward model may pass through the input model's depth columns
                # (dep_top, dep_bot) stored as object-dtype arrays — libaarhusxyz's
                # normalize_depths calls np.isfinite which doesn't support object dtype.
                # Cast any object-dtype layer_data values to float64 before normalizing.
                import pandas as pd
                for _key, _val in list(synthetic_data.layer_data.items()):
                    if isinstance(_val, pd.DataFrame):
                        for _col in _val.select_dtypes(include="object").columns:
                            try:
                                _val[_col] = pd.to_numeric(_val[_col], errors="coerce")
                            except Exception:
                                pass
                    elif isinstance(_val, dict):
                        # dict-of-arrays format (AEMModelSimulator / msgpack-numpy-js)
                        for _layer_idx, _arr in list(_val.items()):
                            if hasattr(_arr, "dtype") and _arr.dtype == object:
                                try:
                                    _val[_layer_idx] = _arr.astype(float)
                                except Exception:
                                    pass
                    elif hasattr(_val, "dtype") and _val.dtype == object:
                        try:
                            synthetic_data.layer_data[_key] = _val.astype(float)
                        except Exception:
                            pass

                synthetic_data.normalize(naming_standard="alc")

                # Populate tilt columns if missing
                for tilt_col in ("tilt_x", "tilt_y", "tilt_z"):
                    if tilt_col not in synthetic_data.flightlines.columns:
                        synthetic_data.flightlines[tilt_col] = 0

                # Populate Current_Ch##, InUse_Ch##, and STD_Ch## columns —
                # the forward model uses GEX values but doesn't write them into
                # the output flightlines/layer_data, which emeraldprocessing requires.
                for ch in range(1, gex.number_channels + 1):
                    ch_key = f"Channel{ch}"
                    suffix = f"Ch{ch:02d}"

                    current_col = f"Current_{suffix}"
                    if current_col not in synthetic_data.flightlines.columns:
                        synthetic_data.flightlines[current_col] = gex.gex_dict[ch_key]["TxApproximateCurrent"]

                    gate_col = f"Gate_{suffix}"
                    if gate_col in synthetic_data.layer_data:
                        gate_df = synthetic_data.layer_data[gate_col]

                        inuse_col = f"InUse_{suffix}"
                        if inuse_col not in synthetic_data.layer_data:
                            # 1 where gate has finite data, 0 where NaN/inf (gate filtered out)
                            synthetic_data.layer_data[inuse_col] = gate_df.notna().astype(np.int8)

                        std_col = f"STD_{suffix}"
                        if std_col not in synthetic_data.layer_data:
                            uniform_std = gex.gex_dict[ch_key].get("UniformDataSTD", 0.03)
                            # Fill uniform STD only where gate data exists; NaN elsewhere
                            synthetic_data.layer_data[std_col] = gate_df.where(gate_df.isna(), uniform_std)

                # Write synthetic data output
                print("Writing synthetic_data...")
                dataset_id = write_dataset(
                    synthetic_data,
                    gex,
                    "synthetic_data",
                    process_id,
                    process_version,
                    storage_base,
                    storage_kwargs
                )
                outputs["synthetic_data"] = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"

                print("Forward modelling complete")
                return {"status": "success", "outputs": outputs}

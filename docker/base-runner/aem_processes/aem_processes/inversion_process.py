"""Inversion process for electromagnetic data."""

import json
import fsspec
import libaarhusxyz
import libaarhusxyz.export.msgpack
import numpy as np
import swaggerspect
import SimPEG
import SimPEG.directives
from .utils import get_entry_points, load_system, localize_urls
from .dataset_utils import write_dataset
from .directives import ReportingDirective, SaveOutputEveryIteration
import swaggerspect.validate
import copy

try:
    import emerald_monitor
except ImportError:
    emerald_monitor = None

class Inversion:
    """Run 3D electromagnetic inversions (TEM data)."""

    @classmethod
    def system_schema(cls):
        return swaggerspect.swagger_to_json_schema(
            swaggerspect.get_apis("simpeg.static_instrument"),
            multi=False
        )
    
    @classmethod
    def schema(cls):
        """Return JSON Schema for inversion parameters.

        Dynamically generates schema from available inversion systems.
        """

        return {
            "type": "object",
            "title": "Invert TEM",
            "description": "Run a SimPEG-based 1D inversion of a processed airborne TEM dataset, "
                           "producing a layered resistivity model and synthetic response.",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": "Processed dataset to invert"
                },
                "system": cls.system_schema(),
                "save_iterations": {
                    "type": "boolean",
                    "default": False,
                    "description": "Save intermediate models and synthetic data for every inversion iteration"
                }
            },
            "required": ["input_data", "system"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Run inversion and write output datasets.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Process parameters from schema

        Returns:
            Dict with status and outputs
        """
        print("Running inversion...")
        print(f"Parameters: {kwargs}")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context['process_id']
        process_version = storage_context['version']
        storage_base = storage_context['storage_base']
        storage_kwargs = storage_context['storage_kwargs']

        # Get input dataset URL
        input_data_url = kwargs.get('input_data')
        if not input_data_url:
            raise ValueError("input_data is required")

        # Get system configuration
        system_config = kwargs.get('system', {})
        if not system_config:
            raise ValueError("system configuration is required")

        # Get save_iterations flag (now a top-level parameter)
        save_iterations = kwargs.get('save_iterations', False)

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
        iteration_datasets = []

        # Localize input data URL
        print(f"Loading input data from: {input_data_url}")
        with localize_urls({'input': input_data_url}, storage_kwargs) as localized:
            input_path = localized['input']

            xyz, gex = libaarhusxyz.export.msgpack.load(input_path, True)
            xyz.normalize(naming_standard="libaarhusxyz")

            print(f"Loading inversion system: {system_config.get('name')}")
            with load_system(system_config, storage_kwargs) as SystemClass:
                # Create enhanced system class with directives
                class PipelineSystem(SystemClass):
                    """System class with pipeline directives."""

                    def make_directives(self):
                        directives = SystemClass.make_directives(self)
                        directives += [ReportingDirective()]
                        if save_iterations:
                            directives += [SaveOutputEveryIteration(self, iteration_datasets)]
                        return directives

                CalibratedSystem = PipelineSystem.load_gex(gex)

                # Create inversion instance
                print("Creating inversion system...")
                inversion = CalibratedSystem(xyz)

                # Run inversion with resource monitoring
                print("Running inversion...")

                if emerald_monitor is not None:
                    with emerald_monitor.resource_monitor() as monitor:
                        monitor.start_logging()
                        try:
                            inversion.invert()
                        finally:
                            monitor.stop_logging()

                        try:
                            monitor_info = monitor.get_logs()
                            inversion_time = np.round(monitor_info.iloc[-1].elapsed_time / 60 / 60, 4)
                            print(f"Inversion time: {inversion_time} hours")
                        except (IndexError, Exception) as e:
                            print(f"Warning: could not retrieve monitor logs: {e}")
                            monitor_info = None
                else:
                    inversion.invert()
                    monitor_info = None

                # Collect output datasets
                print("Collecting results...")
                datasets = {
                    "processed": getattr(inversion, 'corrected', None),
                    "sparse_model": getattr(inversion, 'sparse', None),
                    "sparse_synthetic": getattr(inversion, 'sparsepred', None),
                    "smooth_model": getattr(inversion, 'l2', None),
                    "smooth_synthetic": getattr(inversion, 'l2pred', None),
                }
                for name, dataset in datasets.items():
                    if dataset is not None:
                        dataset.normalize(naming_standard="alc")

                # Write main datasets
                for name, dataset in datasets.items():
                    if dataset is not None:
                        print(f"Writing {name}...")
                        dataset_id = write_dataset(
                            dataset,
                            gex,
                            name,
                            process_id,
                            process_version,
                            storage_base,
                            storage_kwargs
                        )
                        outputs[name] = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"

                # Write iteration datasets if save_iterations was enabled
                for iter_data in iteration_datasets:
                    iter_num = iter_data['iter']

                    # Write model
                    model_name = f"intermediate_{iter_num}_model"
                    print(f"Writing {model_name}...")
                    model_id = write_dataset(
                        iter_data['model'],
                        gex,
                        model_name,
                        process_id,
                        process_version,
                        storage_base,
                        storage_kwargs
                    )
                    outputs[model_name] = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{model_id}/root.msgpack"

                    # Write synthetic
                    synthetic_name = f"intermediate_{iter_num}_synthetic"
                    print(f"Writing {synthetic_name}...")
                    synthetic_id = write_dataset(
                        iter_data['synthetic'],
                        gex,
                        synthetic_name,
                        process_id,
                        process_version,
                        storage_base,
                        storage_kwargs
                    )
                    outputs[synthetic_name] = f"{storage_base}/processes/{process_id}/{process_version}/datasets/{synthetic_id}/root.msgpack"

                # Write monitor info if available
                if monitor_info is not None:
                    monitor_url = f"{storage_base}/processes/{process_id}/monitor_info.csv"
                    print(f"Writing resource monitoring data to: {monitor_url}")
                    with fsspec.open(monitor_url, 'w', **storage_kwargs) as f:
                        monitor_info.to_csv(f)

                print("Inversion complete")
                return {"status": "success", "outputs": outputs}

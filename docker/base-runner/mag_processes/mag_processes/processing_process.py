"""Processing pipeline for magnetic survey data."""

import tempfile

import swaggerspect

from AirMagTools.magdata import MagData
from AirMagTools.pipeline import MagPipeline

from .utils import localize_urls
from .dataset_utils import write_dataset


class MagProcessing:
    """Apply an AirMagTools processing pipeline to magnetic survey data."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for processing parameters.

        The steps schema is generated dynamically from the
        ``mag_pipeline.filters`` entry-point group via swaggerspect, so it
        stays in sync with whatever filters are installed.  Falls back to
        a bare array schema if swaggerspect cannot introspect the entry
        points (e.g. AirMagTools not yet installed).
        """
        try:
            steps_schema = swaggerspect.swagger_to_json_schema(
                swaggerspect.get_apis("mag_pipeline.filters"),
                multi=True,
            )
        except Exception:
            steps_schema = {
                "type": "array",
                "title": "Processing Steps",
                "description": "Sequence of processing steps to apply",
                "items": {"type": "object"},
            }

        return {
            "type": "object",
            "title": "Process Magnetic",
            "description": "Apply a configurable AirMagTools filter pipeline (levelling, "
                           "de-spiking, corrections, etc.) to a magnetic survey dataset, producing "
                           "a processed MagData dataset.",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": "Imported or previously processed mag dataset",
                },
                "steps": steps_schema,
            },
            "required": ["input_data", "steps"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Run the processing pipeline and save the result as msgpack.

        The pipeline dict is constructed directly from the user-supplied
        steps list — no YAML file is involved.  A temporary directory is
        provided as ``out_path`` so that any ``write_*_summary`` filters
        can flush side-output CSVs without error; those files are not
        persisted to the dataset storage.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Validated schema parameters (input_data, steps)

        Returns:
            Dict with status and outputs mapping
        """
        print("Running mag processing...")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context["process_id"]
        process_version = storage_context["version"]
        storage_base = storage_context["storage_base"]
        storage_kwargs = storage_context["storage_kwargs"]

        input_data_url = kwargs.get("input_data")
        steps = kwargs.get("steps", [])

        if not input_data_url:
            raise ValueError("input_data is required")

        with localize_urls({"input_data": input_data_url}, storage_kwargs) as localized:
            print(f"Loading input data from: {localized['input_data']}")
            data = MagData.load(localized["input_data"])

            # Provide a scratch directory as out_path for any write_*
            # summary filters; the pipeline dict is built directly from
            # the user-supplied steps list.
            with tempfile.TemporaryDirectory() as out_path:
                print(f"Running pipeline with {len(steps)} step(s)...")
                pipeline = MagPipeline({"steps": steps}, out_path=out_path)
                data = pipeline.run(data)

            print("Writing processed dataset...")
            dataset_id = write_dataset(
                data,
                "processed_mag_data",
                process_id,
                process_version,
                storage_base,
                storage_kwargs,
            )

        outputs = {
            "processed_data": f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"
        }

        print("Mag processing complete")
        return {"status": "success", "outputs": outputs}

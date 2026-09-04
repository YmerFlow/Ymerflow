"""Equivalent-source gridding process for airborne magnetic data."""

import os
import tempfile

import copy

import fsspec
import swaggerspect
import swaggerspect.validate

from AirMagTools.magdata import MagData

from .utils import localize_urls
from .dataset_utils import write_webxtile_dataset


def _sync_sensitivity_from_blob(local_dir, blob_base, storage_kwargs):
    """Download cached sensitivity files from blob storage into *local_dir*.

    Silently skips if the blob path doesn't exist yet.
    """
    try:
        fs, path = fsspec.core.url_to_fs(blob_base, **storage_kwargs)
        if not fs.exists(path):
            return
        prefix = path.rstrip("/") + "/"
        for remote in fs.find(path):
            rel = remote[len(prefix):] if remote.startswith(prefix) else os.path.basename(remote)
            local = os.path.join(local_dir, rel)
            os.makedirs(os.path.dirname(local), exist_ok=True)
            with fs.open(remote, "rb") as src, open(local, "wb") as dst:
                dst.write(src.read())
        print(f"Downloaded sensitivity cache from {blob_base}")
    except Exception as exc:
        print(f"Warning: could not download sensitivity cache: {exc}")


def _sync_sensitivity_to_blob(local_dir, blob_base, storage_kwargs):
    """Upload local sensitivity files to blob storage."""
    try:
        for root, _, files in os.walk(local_dir):
            for fname in files:
                local = os.path.join(root, fname)
                rel = os.path.relpath(local, local_dir)
                remote = f"{blob_base}/{rel}"
                with open(local, "rb") as src:
                    with fsspec.open(remote, "wb", **storage_kwargs) as dst:
                        dst.write(src.read())
        print(f"Uploaded sensitivity cache to {blob_base}")
    except Exception as exc:
        print(f"Warning: could not upload sensitivity cache: {exc}")


class MagEquivSource:
    """Equivalent source inversion — gridded Bx/By/Bz/TMI from flight-line TMI."""

    @classmethod
    def system_schema(cls):
        return swaggerspect.get_apis("ymerflow.mag_equiv_source_systems")

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "title": "Equivalent Source (Magnetic)",
            "description": "Fit an equivalent-source model to a processed magnetic survey and grid "
                           "it to a regular surface, producing gridded Bx/By/Bz/TMI fields for 3D "
                           "inversion.",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": "Processed magnetic survey dataset (MagData msgpack)",
                },
                "system": cls.system_schema(),
            },
            "required": ["input_data", "system"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Run equivalent source inversion and write gridded webxtile output."""
        print("Running equivalent source inversion...")
        print(f"Parameters: {kwargs}")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context["process_id"]
        process_version = storage_context["version"]
        storage_base = storage_context["storage_base"]
        storage_kwargs = storage_context["storage_kwargs"]

        input_data_url = kwargs.get("input_data")
        if not input_data_url:
            raise ValueError("input_data is required")

        system_config = kwargs.get("system", {})
        if not system_config:
            raise ValueError("system configuration is required")

        # Flatten grouped parameters: {"layer": {"cell_size": 50}} → {"layer__cell_size": 50}
        system_config = copy.deepcopy(system_config)
        swaggerspect.validate.GroupMergingValidator(cls.system_schema()).validate(system_config)
        system_name, system_args = next(iter(system_config.items()))

        outputs = {}

        with localize_urls({"input": input_data_url}, storage_kwargs) as localized:
            input_path = localized["input"]
            print(f"Loading MagData from: {input_path}")
            mag_data = MagData.load(input_path)

        # Sensitivity cache blob location
        sens_blob_base = f"{storage_base}/sensitivity_cache/equiv"

        with tempfile.TemporaryDirectory() as sens_local_base:
            # Load the system class from the entry point (supports custom subclasses)
            import importlib.metadata
            eps = {e.name: e for e in importlib.metadata.entry_points().get(
                "ymerflow.mag_equiv_source_systems", []
            )}
            if system_name not in eps:
                raise ValueError(f"Unknown equivalent source system: {system_name!r}")
            SystemClass = eps[system_name].load()

            system = SystemClass(
                mag_data,
                sensitivity_path=sens_local_base,
                store_sensitivities="disk",
                **system_args,
            )

            # Resolve hash-keyed path and sync cache from blob
            hash_path = system._resolved_sensitivity_path()
            hash_key = os.path.basename(hash_path)
            _sync_sensitivity_from_blob(
                hash_path, f"{sens_blob_base}/{hash_key}", storage_kwargs
            )

            print("Running inversion...")
            ds_equiv = system.invert()

            # Upload updated sensitivity cache
            _sync_sensitivity_to_blob(
                hash_path, f"{sens_blob_base}/{hash_key}", storage_kwargs
            )

        print("Writing gridded output...")
        dataset_id = write_webxtile_dataset(
            ds_equiv,
            "equiv_source_grid",
            process_id,
            process_version,
            storage_base,
            storage_kwargs,
        )
        outputs["equiv_source_grid"] = (
            f"{storage_base}/processes/{process_id}/{process_version}"
            f"/datasets/{dataset_id}/info.json"
        )

        print("Equivalent source inversion complete")
        return {"status": "success", "outputs": outputs}

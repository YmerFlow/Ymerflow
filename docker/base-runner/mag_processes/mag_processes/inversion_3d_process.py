"""Full 3D magnetic inversion process."""

import os
import tempfile

import copy

import fsspec
import swaggerspect
import swaggerspect.validate
import xarray as xr

from .utils import localize_urls
from .dataset_utils import write_webxtile_dataset


def _sync_sensitivity_from_blob(local_dir, blob_base, storage_kwargs):
    try:
        fs, path = fsspec.core.url_to_fs(blob_base, **storage_kwargs)
        if not fs.exists(path):
            return
        for remote in fs.find(path):
            rel = os.path.relpath(remote, path)
            local = os.path.join(local_dir, rel)
            os.makedirs(os.path.dirname(local), exist_ok=True)
            with fs.open(remote, "rb") as src, open(local, "wb") as dst:
                dst.write(src.read())
        print(f"Downloaded sensitivity cache from {blob_base}")
    except Exception as exc:
        print(f"Warning: could not download sensitivity cache: {exc}")


def _sync_sensitivity_to_blob(local_dir, blob_base, storage_kwargs):
    try:
        for root, _, files in os.walk(local_dir):
            for fname in files:
                local = os.path.join(root, fname)
                rel = os.path.relpath(local, local_dir)  # local OS path, relpath is safe here
                remote = f"{blob_base}/{rel}"
                with open(local, "rb") as src:
                    with fsspec.open(remote, "wb", **storage_kwargs) as dst:
                        dst.write(src.read())
        print(f"Uploaded sensitivity cache to {blob_base}")
    except Exception as exc:
        print(f"Warning: could not upload sensitivity cache: {exc}")


def _load_input_grid(input_url, storage_kwargs):
    """Load gridded equivalent-source output from a webxtile dataset info.json URL."""
    # The URL points to info.json; load the tile directory
    tile_dir_url = input_url.rsplit("/", 1)[0] + "/tiles"
    with tempfile.TemporaryDirectory() as tmp:
        # Download all tile files to a local temp directory so xarray can open them
        fs, path = fsspec.core.url_to_fs(tile_dir_url, **storage_kwargs)
        prefix = path.rstrip("/") + "/"
        for remote in fs.find(path):
            rel = remote[len(prefix):] if remote.startswith(prefix) else os.path.basename(remote)
            local = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(local), exist_ok=True)
            with fs.open(remote, "rb") as src, open(local, "wb") as dst:
                dst.write(src.read())
        ds = xr.open_dataset(tmp, engine="webxtile")
        # Load into memory so we can close the temp dir
        ds = ds.load()
    return ds


class MagInversion3D:
    """Full 3D magnetic inversion — susceptibility / MVI model from gridded fields."""

    @classmethod
    def system_schema(cls):
        return swaggerspect.get_apis("ymerflow.mag_inversion_3d_systems")

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "title": "3D Magnetic Inversion",
            "description": "Run a full 3D inversion of gridded magnetic fields, producing a 3D "
                           "susceptibility or magnetization-vector model volume.",
            "properties": {
                "input_data": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": (
                        "Gridded equivalent-source output dataset "
                        "(webxtile with Bx/By/Bz/TMI fields)"
                    ),
                },
                "system": cls.system_schema(),
            },
            "required": ["input_data", "system"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Run 3D inversion and write 3D susceptibility/MVI webxtile output."""
        print("Running full 3D magnetic inversion...")
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

        system_config = copy.deepcopy(system_config)
        swaggerspect.validate.GroupMergingValidator(cls.system_schema()).validate(system_config)
        system_name, system_args = next(iter(system_config.items()))

        outputs = {}

        print(f"Loading input grid from: {input_data_url}")
        ds_equiv = _load_input_grid(input_data_url, storage_kwargs)

        sens_blob_base = f"{storage_base}/sensitivity_cache/mag3d"

        with tempfile.TemporaryDirectory() as sens_local_base:
            import importlib.metadata
            eps = {e.name: e for e in importlib.metadata.entry_points().get(
                "ymerflow.mag_inversion_3d_systems", []
            )}
            if system_name not in eps:
                raise ValueError(f"Unknown 3D inversion system: {system_name!r}")
            SystemClass = eps[system_name].load()

            system = SystemClass(
                ds_equiv,
                sensitivity_path=sens_local_base,
                store_sensitivities="disk",
                **system_args,
            )

            hash_path = system._resolved_sensitivity_path()
            hash_key = os.path.basename(hash_path)
            _sync_sensitivity_from_blob(
                hash_path, f"{sens_blob_base}/{hash_key}", storage_kwargs
            )

            print("Running 3D inversion...")
            ds_3d = system.invert()

            _sync_sensitivity_to_blob(
                hash_path, f"{sens_blob_base}/{hash_key}", storage_kwargs
            )

        print("Writing 3D model output...")
        dataset_id = write_webxtile_dataset(
            ds_3d,
            "mag_3d_model",
            process_id,
            process_version,
            storage_base,
            storage_kwargs,
        )
        outputs["mag_3d_model"] = (
            f"{storage_base}/processes/{process_id}/{process_version}"
            f"/datasets/{dataset_id}/info.json"
        )

        print("3D inversion complete")
        return {"status": "success", "outputs": outputs}

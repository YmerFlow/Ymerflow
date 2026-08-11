"""Compound filter process type.

Loads an input XYZ dataset, optionally applies a sparse InUse diff
(libaarhusxyz msgpack format), and writes the result as a new dataset.
"""

import io
import sys
import os
import uuid
import contextlib
import tempfile
import fsspec


@contextlib.contextmanager
def _localize(url, storage_kwargs):
    """Download a remote file to a local temp path and yield the path."""
    if not url or "://" not in url:
        yield url
        return

    if url.startswith("file://"):
        yield url[len("file://"):]
        return

    _, ext = os.path.splitext(url)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        with fsspec.open(url, "rb", **storage_kwargs) as src:
            tmp.write(src.read())
        tmp.close()
        yield tmp.name
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _write_dataset(xyz, gex, dataset_name, process_id, process_version,
                   storage_base, storage_kwargs):
    """Write XYZ to storage and return the dataset ID."""
    try:
        # Try to use the shared aem_processes utility if available
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "aem_processes"))
        from aem_processes.dataset_utils import write_dataset
        return write_dataset(xyz, gex, dataset_name, process_id, process_version,
                             storage_base, storage_kwargs)
    except (ImportError, Exception) as e:
        print(f"Falling back to minimal dataset writer ({e})")

    dataset_id = str(uuid.uuid4())
    dataset_prefix = (
        f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}"
    )

    buf = io.BytesIO()
    if gex is not None:
        xyz.to_msgpack(buf, gex=gex)
    else:
        xyz.to_msgpack(buf)
    buf.seek(0)

    root_file_url = f"{dataset_prefix}/root.msgpack"
    print(f"Writing msgpack to: {root_file_url}")
    with fsspec.open(root_file_url, "wb", **storage_kwargs) as f:
        f.write(buf.read())

    files = {"application/x-aarhusxyz-msgpack": root_file_url}
    info = {
        "id": dataset_id,
        "mime_type": "application/x-aarhusxyz-msgpack",
        "dataset_name": dataset_name,
        "files": files,
        "parts": {},
    }
    info_url = f"{dataset_prefix}/info.json"
    print(f"Writing info.json to: {info_url}")
    with fsspec.open(info_url, "w", **storage_kwargs) as f:
        json.dump(info, f, indent=2)

    return dataset_id


class compound_filter:
    """Apply a sparse InUse diff to an input XYZ dataset.

    Parameters
    ----------
    input   : storage URL of the input XYZ msgpack dataset (required)
    diff    : storage URL of a JSON diff file produced by the frontend editor (optional)
    output_name : name for the output dataset (default: "filtered")
    """

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input Dataset",
                    "description": "Input XYZ dataset to filter",
                },
                "diff": {
                    "type": "string",
                    "format": "uri",
                    "title": "InUse Diff (optional)",
                    "description": "libaarhusxyz msgpack diff produced by the InUse editor; leave blank for pass-through",
                },
                "output_name": {
                    "type": "string",
                    "title": "Output Dataset Name",
                    "default": "filtered",
                    "description": "Name for the output dataset",
                },
            },
            "required": ["input"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        import libaarhusxyz
        import numpy as np

        process_id = storage_context["process_id"]
        process_version = storage_context["version"]
        storage_base = storage_context["storage_base"]
        storage_kwargs = storage_context["storage_kwargs"]

        input_url = kwargs["input"]
        diff_url = kwargs.get("diff") or None
        output_name = kwargs.get("output_name", "filtered")

        print(f"compound_filter: loading input from {input_url}")

        with _localize(input_url, storage_kwargs) as local_input:
            xyz, gex = libaarhusxyz.export.msgpack.load(local_input, True)

        xyz.normalize()
        print(f"Loaded {len(xyz.flightlines)} soundings")

        if diff_url:
            print(f"compound_filter: applying diff from {diff_url}")
            try:
                with _localize(diff_url, storage_kwargs) as local_diff:
                    diff_xyz, _ = libaarhusxyz.export.msgpack.load(local_diff, True)
                n_soundings = len(diff_xyz.flightlines)
                n_channels = len(diff_xyz.layer_data)
                print(f"Loaded diff: {n_soundings} sounding overrides across {n_channels} channel(s)")
                xyz = xyz.apply_diff(diff_xyz)
                print(f"Applied diff")
            except Exception as e:
                print(f"Warning: could not apply diff ({e}); continuing without it")

        dataset_id = _write_dataset(
            xyz, gex, output_name,
            process_id, process_version,
            storage_base, storage_kwargs,
        )
        print(f"compound_filter: output dataset ID = {dataset_id}")
        return {"status": "success", "output_name": output_name, "dataset_id": dataset_id}

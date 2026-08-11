"""``build_frontend_plugin`` process type.

Builds a Nagelfluh frontend plugin (an npm source package) into a Module-Federation remote and
writes it as a directory output dataset (mime ``application/x-mf-remote``) into the project bucket.

It runs in a pod like any other process, but the actual build logic lives in the shared
``ymerflow_plugin_build.build_frontend`` routine so the identical code path can also be invoked
locally (``python -m ymerflow_plugin_build``) and from a backend plugin's ``setup.py`` — which is
what makes the whole install flow testable without a Kubernetes cluster.

``ymerflow_plugin_build`` is the standalone ymerflow-plugin-sdk package, pip-installed from its git
URL in both the runner image and the dev env.
"""

import json
import os
import tempfile
import uuid

import fsspec


def _load_build_routine():
    """Import the shared build routine (ymerflow-plugin-sdk, pip-installed from its git URL)."""
    from ymerflow_plugin_build import build_frontend, HOST_SHARED_VERSIONS
    return build_frontend, HOST_SHARED_VERSIONS


class build_frontend_plugin:
    """Build an npm-source frontend plugin into a Module-Federation remote.

    Parameters
    ----------
    npm_name : str
        The plugin's npm package name (must exist in the server-local npm source dir).
    npm_version : str
        Exact version to build (no ranges — pin for provenance).
    output_name : str
        Name for the output dataset (default ``"dist"``).

    The host's shared-singleton versions are injected by the runner via the
    ``PLUGIN_SHARED_VERSIONS`` env var (JSON). If absent, the routine's built-in defaults are used.
    The server-local npm source dir comes from ``PLUGIN_NPM_SOURCE_DIR``.
    """

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "properties": {
                "npm_name": {
                    "type": "string",
                    "title": "npm Package Name",
                    "description": "Name of the plugin npm package (present in the server-local source dir)",
                },
                "npm_version": {
                    "type": "string",
                    "title": "npm Version",
                    "description": "Exact version to build (pin — no ranges)",
                },
                "output_name": {
                    "type": "string",
                    "title": "Output Dataset Name",
                    "default": "dist",
                },
            },
            "required": ["npm_name", "npm_version"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        build_frontend, host_shared = _load_build_routine()

        process_id = storage_context["process_id"]
        process_version = storage_context["version"]
        storage_base = storage_context["storage_base"]
        storage_kwargs = storage_context["storage_kwargs"]

        npm_name = kwargs["npm_name"]
        npm_version = kwargs["npm_version"]
        output_name = kwargs.get("output_name", "dist")

        # Host shared versions injected by the runner; fall back to the routine defaults.
        shared_versions = None
        raw = os.environ.get("PLUGIN_SHARED_VERSIONS")
        if raw:
            try:
                shared_versions = json.loads(raw)
            except json.JSONDecodeError:
                print(f"WARNING: could not parse PLUGIN_SHARED_VERSIONS={raw!r}; using defaults")

        npm_source_dir = os.environ.get("PLUGIN_NPM_SOURCE_DIR")
        registry = os.environ.get("PLUGIN_NPM_REGISTRY")
        mode = os.environ.get("PLUGIN_NPM_SOURCE_MODE")  # None -> build routine default ("auto")

        print(f"build_frontend_plugin: building {npm_name}@{npm_version}")
        print(f"  source mode: {mode or 'auto'}")
        print(f"  npm source dir: {npm_source_dir}")
        print(f"  shared versions: {shared_versions or host_shared}")

        out_dir = tempfile.mkdtemp(prefix="nf-plugin-dist-")
        result = build_frontend(
            npm_name, npm_version, out_dir,
            shared_versions=shared_versions,
            npm_source_dir=npm_source_dir,
            registry=registry,
            mode=mode,
        )

        # Write the built dist/ as a directory dataset into the project bucket.
        dataset_id = str(uuid.uuid4())
        dataset_prefix = (
            f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}"
        )
        print(f"Writing built remote to dataset {dataset_id}")

        for root, _dirs, files in os.walk(out_dir):
            for fname in files:
                local_path = os.path.join(root, fname)
                rel = os.path.relpath(local_path, out_dir).replace(os.sep, "/")
                dest = f"{dataset_prefix}/{rel}"
                with open(local_path, "rb") as src, fsspec.open(dest, "wb", **storage_kwargs) as dst:
                    dst.write(src.read())

        info = {
            "id": dataset_id,
            "mime_type": "application/x-mf-remote",
            "dataset_name": output_name,
            "files": {"application/x-mf-remote": f"{dataset_prefix}/remoteEntry.js"},
            "parts": {},
            "plugin": {
                "remote_name": result["remote_name"],
                "npm_name": npm_name,
                "npm_version": npm_version,
                "built_against": result["built_against"],
            },
        }
        info_url = f"{dataset_prefix}/info.json"
        with fsspec.open(info_url, "w", **storage_kwargs) as f:
            json.dump(info, f, indent=2)

        # Mirror the create_environment pattern: write a top-level plugin.json that the backend reads
        # on job completion (in ProcessVersion._create_outputs) to auto-register this build as a
        # Plugin / PluginVersion. There is NO separate register API call — registration is a side
        # effect of the build completing, exactly like environment.json -> Environment.
        plugin_json = {
            "remote_name": result["remote_name"],
            "display_name": npm_name,
            "npm_name": npm_name,
            "npm_version": npm_version,
            "built_against": result["built_against"],
            "output_dataset_id": dataset_id,
            "process_version": process_version,
        }
        plugin_json_url = f"{storage_base}/processes/{process_id}/plugin.json"
        with fsspec.open(plugin_json_url, "w", **storage_kwargs) as f:
            json.dump(plugin_json, f, indent=2)

        print(f"build_frontend_plugin: wrote plugin.json for auto-registration")
        print(f"build_frontend_plugin: output dataset ID = {dataset_id}")
        return {
            "status": "success",
            "output_name": output_name,
            "dataset_id": dataset_id,
            "remote_name": result["remote_name"],
            "built_against": result["built_against"],
        }

import os
import sys
import json
import subprocess
import requests
from datetime import datetime

try:
    # Try modern importlib.metadata first (Python 3.10+)
    from importlib.metadata import entry_points

    def get_entry_points(group):
        eps = entry_points()
        if hasattr(eps, 'select'):
            # Python 3.10+ API
            return eps.select(group=group)
        else:
            # Python 3.9 API
            return eps.get(group, [])
except ImportError:
    # Fallback to pkg_resources for older Python
    import pkg_resources

    def get_entry_points(group):
        return pkg_resources.iter_entry_points(group)


def get_storage_kwargs(refresher_process=None):
    """Get storage configuration for fsspec.

    The backend builds the fsspec kwargs (via the project's StorageProtocolHandler) and hands them
    to the pod as STORAGE_KWARGS_JSON — a protocol-general dict passed straight to
    fsspec.open(url, **kwargs). fsspec dispatches on the URL scheme in STORAGE_BASE (s3/gs/…), so
    there is no protocol-specific construction here. See docs/plans/per-project-storage-routing.md.

    For CREDENTIAL_STRATEGY=short-lived, refresher_process is the running refresher subprocess and
    this returns a RefreshableStorageKwargs — a live view onto CREDENTIALS_FILE, re-read on every
    single fsspec call, rather than a plain dict computed once here. See
    storage_credentials_client.py for why: env vars can't be updated on an already-running process,
    so they're only good for the very first mint, not for a 36h job.
    """
    initial_kwargs = json.loads(os.environ.get('STORAGE_KWARGS_JSON') or '{}')

    if os.environ.get('CREDENTIAL_STRATEGY') == 'short-lived':
        from storage_credentials_client import RefreshableStorageKwargs
        return RefreshableStorageKwargs(
            initial_kwargs=initial_kwargs,
            refresher_process=refresher_process,
            refresher_env=os.environ.copy(),
        )

    return initial_kwargs


def main():
    # Get config from env
    process_type = os.environ['PROCESS_TYPE']
    process_id = os.environ['PROCESS_ID']
    version = os.environ['VERSION']
    project_id = os.environ['PROJECT_ID']
    parameters_json = os.environ['PARAMETERS_JSON']
    backend_url = os.environ['BACKEND_URL']
    storage_base = os.environ['STORAGE_BASE']
    credential_strategy = os.environ.get('CREDENTIAL_STRATEGY', 'static-key')

    # Parse parameters
    parameters = json.loads(parameters_json)

    print(f"Running process type: {process_type}")
    print(f"Process ID: {process_id}")
    print(f"Project ID: {project_id}")
    print(f"Storage base: {storage_base}")
    print(f"Credential strategy: {credential_strategy}")

    refresher_process = None
    if credential_strategy == 'short-lived':
        from storage_credentials_client import write_credentials_atomic, spawn_refresher

        # Seed the credentials file with the fsspec kwargs the job was launched with, so the very
        # first storage access (before the refresher has had a chance to run once) already has
        # something to read instead of relying on env vars that fsspec/boto never picks up here.
        write_credentials_atomic({
            "kwargs": json.loads(os.environ.get('STORAGE_KWARGS_JSON') or '{}'),
            "expires_at": os.environ.get('STORAGE_CREDENTIALS_EXPIRES_AT') or None,
        })
        refresher_process = spawn_refresher(os.environ.copy())
        print(f"Started storage-credential refresher subprocess (pid {refresher_process.pid})")

    try:
        # Load process class from entrypoint
        process_class = None
        for entry_point in get_entry_points('ymerflow.process_types'):
            if entry_point.name == process_type:
                process_class = entry_point.load()
                break

        if process_class is None:
            raise ValueError(f"Unknown process type: {process_type}")

        print(f"Loaded process class: {process_class}")

        # Inject storage context into parameters
        storage_context = {
            'process_id': process_id,
            'project_id': project_id,
            'version': version,
            'storage_base': storage_base,
            'storage_kwargs': get_storage_kwargs(refresher_process)
        }

        # Execute process class run method with storage context
        result = process_class.run(storage_context=storage_context, **parameters)

        print(f"Execution completed successfully")
        print(f"Result: {result}")

        # Report outputs to backend if any were generated
        if result and isinstance(result, dict) and 'outputs' in result:
            print(f"Reporting outputs to backend: {result['outputs']}")
            # TODO: POST to backend to register outputs
            # requests.post(f"{backend_url}/process/{process_id}/outputs", json=result['outputs'])

        sys.exit(0)

    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    finally:
        # Don't leave the refresher subprocess running after the pod's main container should have
        # exited — the pod would otherwise hang waiting on a lingering child.
        if refresher_process is not None and refresher_process.poll() is None:
            refresher_process.terminate()
            try:
                refresher_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                refresher_process.kill()


if __name__ == '__main__':
    main()

import os
import sys
import json
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


def get_storage_kwargs():
    """Get storage configuration for fsspec."""
    kwargs = {}
    if os.environ.get('STORAGE_ENDPOINT'):
        kwargs['client_kwargs'] = {'endpoint_url': os.environ['STORAGE_ENDPOINT']}
    return kwargs


def main():
    # Get config from env
    process_type = os.environ['PROCESS_TYPE']
    process_id = os.environ['PROCESS_ID']
    version = os.environ['VERSION']
    project_id = os.environ['PROJECT_ID']
    parameters_json = os.environ['PARAMETERS_JSON']
    backend_url = os.environ['BACKEND_URL']
    storage_base = os.environ['STORAGE_BASE']

    # Parse parameters
    parameters = json.loads(parameters_json)

    print(f"Running process type: {process_type}")
    print(f"Process ID: {process_id}")
    print(f"Project ID: {project_id}")
    print(f"Storage base: {storage_base}")

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
            'storage_base': storage_base,
            'storage_kwargs': get_storage_kwargs()
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
        # Let the exception propagate to debug_runner.py for pdb
        print(f"ERROR: {str(e)}", file=sys.stderr)
        raise


if __name__ == '__main__':
    main()

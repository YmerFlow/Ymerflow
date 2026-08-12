#!/usr/bin/env python
"""Collect process type schemas from entrypoints and generate JSON."""

import json
import sys

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


def main():
    """Collect all process type schemas and write to JSON."""
    schemas = {}

    print("Collecting process type schemas...")

    for entry_point in get_entry_points('ymerflow.process_types'):
        try:
            print(f"  Loading {entry_point.name}...")
            process_class = entry_point.load()
            schema = process_class.schema()
            # Wrap schema in the expected format: { "schema": {...} }
            schemas[entry_point.name] = {"schema": schema}
            print(f"    ✓ Schema collected for {entry_point.name}")
        except Exception as e:
            print(f"    ✗ Error loading {entry_point.name}: {e}", file=sys.stderr)
            sys.exit(1)

    # Write schemas to file
    output_path = '/app/process_schemas.json'
    print(f"\nWriting schemas to {output_path}...")

    with open(output_path, 'w') as f:
        json.dump(schemas, f, indent=2)

    print(f"✓ Successfully wrote {len(schemas)} schemas")
    print(f"\nAvailable process types: {', '.join(schemas.keys())}")


if __name__ == '__main__':
    main()

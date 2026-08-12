from pathlib import Path

# The main (core) alembic version directory, exposed for the ymerflow.migration_dirs entry point
# so core is discovered the same way plugin migration branches are.
path = Path(__file__).parent / "alembic" / "versions"

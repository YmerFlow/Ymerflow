from setuptools import setup, find_namespace_packages

setup(
    name='ymerflow-backend',
    version='0.1.0',
    description='Nagelfluh host backend (FastAPI app + nagelfluh.* entry points).',
    # backend/ has no __init__.py (implicit namespace package); enumerate it as a namespace
    # package so the existing tree — including backend/alembic — is packaged without adding
    # __init__.py files that would change import semantics.
    packages=find_namespace_packages(include=['backend', 'backend.*']),
    python_requires=">=3.11",   # matches the python:3.11-slim runtime image
    install_requires=[
        'setuptools',
        'packaging',
        'fastapi',
        'uvicorn',
        'watchfiles',
        'websockets',
        'libaarhusxyz>=0.0.41',
        'msgpack-numpy',
        'projnames',
        'PyJWT',
        'python-multipart',
        'sqlalchemy[asyncio]',
        'aiosqlite',
        'alembic',
        'passlib',
        'bcrypt<5.0.0',
        'python-jose[cryptography]',
        'fsspec',
        's3fs',
        'minio',
        'pydantic-settings',
        'kubernetes-asyncio',
        'kubernetes',
        'PyYAML',
        'click',
        'python-dotenv',
        'asyncpg',
        'psycopg2-binary',
        'aiosmtplib',
        'fastapi-mcp',
        'mcp<2.0.0',  # fastapi-mcp 0.4.0 breaks on mcp 2.0.0 (Server.__init__ became kw-only); no fastapi-mcp release supports mcp 2.x yet

        # Frontend-plugin build harness — imported by backend/services/job_orchestrator.py
        # (HOST_SHARED_VERSIONS) and run in-pod by the build_frontend_plugin process type. A
        # backend library dependency, NOT a hook plugin (those install from BACKEND_PLUGINS via
        # scripts/install-backend-plugins.sh).
        'ymerflow-plugin-build @ git+https://github.com/YmerFlow/Ymerflow-plugin-sdk.git',
    ],
    entry_points={
        # Core registers itself in the same groups plugins use, so downstream discovery treats
        # core and plugins identically (see backend/alembic/env.py and backend/bin/yf-*).
        'nagelfluh.models': [
            'nagelfluh = backend.models',
        ],
        'nagelfluh.migration_dirs': [
            'nagelfluh = backend.migration_path:path',
        ],
        'nagelfluh.hooks': [
            'storage_protocol_handlers = backend.services.storage_protocols:storage_protocol_handlers',
            'cluster_provider_handlers = backend.services.cluster_providers:cluster_provider_handlers',
            'registry_protocol_handlers = backend.services.registry_protocols:registry_protocol_handlers',
        ],
    },
)

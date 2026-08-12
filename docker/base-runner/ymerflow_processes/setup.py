"""Setup script for YmerFlow process types."""

from setuptools import setup, find_packages

setup(
    name="ymerflow-processes",
    version="0.1.0",
    description="Process type implementations for YmerFlow",
    packages=find_packages(),
    install_requires=[
        "fsspec",
        "s3fs",
        "gcsfs",
        "requests",
        "libaarhusxyz>=0.0.41",
        "pandas",
        "projnames",
        "msgpack",
        "msgpack-numpy",
        "geopandas",
    ],
    entry_points={
        "nagelfluh.process_types": [
            "create_environment=ymerflow_processes.fake_processes:create_environment",
            "compound_filter=ymerflow_processes.compound_filter:compound_filter",
            "build_frontend_plugin=ymerflow_processes.build_frontend_plugin:build_frontend_plugin",
        ],
    },
)

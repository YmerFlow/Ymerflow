"""Setup script for magnetic survey process types."""

from setuptools import setup, find_packages

setup(
    name="mag-processes",
    version="0.1.0",
    description="Magnetic survey process type implementations for YmerFlow",
    packages=find_packages(),
    install_requires=[
        "AirMagTools @ git+https://github.com/SagebrushGeoTools/AirMagTools.git",
        "mag-inversion @ git+https://github.com/SagebrushGeoTools/simplemag.git",
        "fsspec",
        "s3fs",
        "gcsfs",
        "swaggerspect>=0.1.6",
    ],
    entry_points={
        "nagelfluh.process_types": [
            "import_mag=mag_processes.import_process:MagCSVImporter",
            "process_mag=mag_processes.processing_process:MagProcessing",
            "equiv_source_mag=mag_processes.equiv_source_process:MagEquivSource",
            "inversion_3d_mag=mag_processes.inversion_3d_process:MagInversion3D",
        ],
    },
)

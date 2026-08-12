"""Setup script for AEM process types."""

from setuptools import setup, find_packages

setup(
    name="aem-processes",
    version="0.1.0",
    description="AEM (Airborne Electromagnetic) process type implementations for YmerFlow",
    packages=find_packages(),
    install_requires=[
        "fsspec",
        "s3fs",
        "gcsfs",
        "libaarhusxyz[normalisation,3d] @ git+https://github.com/YmerFlow/libaarhusxyz.git", #"libaarhusxyz[normalisation,3d]>=0.0.41",
        "numpy",
        "pandas",
        "msgpack",
        "msgpack-numpy",
        "python-slugify",
        "pyyaml",
        "swaggerspect>=0.1.6",
        "utm",  # Required by SimPEG
        "scipy",     # Interpolation for gridding (scipy methods)
        "pyinterp==2025.11.0",  # Parallel 3-D interpolation; last release requiring Boost >= 1.79 (Trixie has 1.83)
        "pyproj",    # UTM → geographic coordinate conversion for pyinterp
        "xarray",    # Dataset construction for gridding
        "webxtile>=0.0.8",
    ],
    extras_require={
        'all': [
            "emeraldprocessing @ git+https://github.com/YmerFlow/emerald-processing-em.git",
            "simpeg @ git+https://github.com/YmerFlow/simpeg.git@simpleem3",
            "emerald-monitor @ git+https://github.com/YmerFlow/emerald-monitor",
        ]
    },
    entry_points={
        "ymerflow.process_types": [
            "import_skytem=aem_processes.import_process:LibaarhusXYZImporter",
            "import_ymerflow_aem=aem_processes.import_msgpack_process:MsgpackImporter",
            "process_tem=aem_processes.processing_process:Processing",
            "invert_tem=aem_processes.inversion_process:Inversion",
            "forward_tem=aem_processes.forward_process:Forward",
            "grid_tem=aem_processes.gridding_process:Gridding",
        ],
        "simpeg.static_instrument": [
            "Single moment TEM=SimPEG.electromagnetics.utils.static_instrument:SingleMomentTEMXYZSystem",
            "Dual moment TEM=SimPEG.electromagnetics.utils.static_instrument:DualMomentTEMXYZSystem",
        ],
    },
)

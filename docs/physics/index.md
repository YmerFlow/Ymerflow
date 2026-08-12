# Physics & Scientific Methods

This directory documents the scientific methods and modelling approaches implemented in YmerFlow's processing pipelines. Each document covers a self-contained group of processes, including the mathematical formulations, algorithms, and links to relevant peer-reviewed literature.

## Pipelines

### Airborne Electromagnetics (AEM)

| Document | Description |
|---|---|
| [AEM Data Processing](aem-pipeline.md) | Corrections (altitude/topo, tilt, moving average), noise modelling, and data culling (roll/pitch/alt, STD, slope, curvature, geometry) |
| [AEM Inversion & Forward Modelling](aem-inversion.md) | 1D layered EM inversion (SimPEG), dual-moment system description (SkyTEM), regularization, IRLS, forward modelling |
| [AEM 3D Gridding](aem-gridding.md) | Step-function vertical assignment and 3D interpolation (scipy/pyinterp) of layered resistivity models to regular voxel grids |

**AEM pipeline**: Import (XYZ/GEX or msgpack) → Processing → Inversion → Forward modelling → 3D Gridding

### Airborne Magnetics

| Document | Description |
|---|---|
| [Magnetics Processing](magnetics-pipeline.md) | QC filters: 4th difference noise, diurnal chord analysis, drape analysis, Butterworth filters (derived from GSC standards) |
| [Magnetics Inversion](magnetics-inversion.md) | Equivalent source gridding (flat-layer dipole inversion) and full 3D OcTree inversion (susceptibility/MVI/amplitude) via SimPEG |

**Magnetics pipeline**: Import (CSV) → Processing (QC) → Equivalent source gridding → 3D inversion

### Infrastructure

| Document | Description |
|---|---|
| [Common Infrastructure](infrastructure.md) | Sensitivity matrix caching, data formats (msgpack, webxtile), entry-point registration, swaggerspect schema generation |

## Key References

- **AEM layered inversion**: Auken, E., Christiansen, A. V., Westergaard, J. H., Kirkegaard, C., Foged, N., & Viezzoli, A. (2009). "An integrated processing scheme for high-resolution airborne electromagnetic surveys, the SkyTEM system." *Exploration Geophysics*, 40(2), 184-192. DOI: [10.1071/eg08128](https://doi.org/10.1071/eg08128)
- **Magnetic Vector Inversion (MVI)**: Lelièvre, P. G., & Oldenburg, D. W. (2009). "A 3D total magnetization inversion applicable when significant, complicated remanence is present." *Geophysics*, 74(3), L21-L30. DOI: [10.1190/1.3103249](https://doi.org/10.1190/1.3103249)
- **Amplitude magnetic inversion**: Li, Y., Oldenburg, D. W., Farquharson, C. G., & Shekhtman, R. (2017). "Magnetic amplitude inversion for determining magnetization." *Geophysics*, 82(2). DOI: [10.1190/geo2016-0302.1](https://doi.org/10.1190/geo2016-0302.1)
- **IRLS sparse regularization**: Farquharson, C. G., & Oldenburg, D. W. (1998). "Non-linear inversion using general measures of data misfit and model structure." *Geophysical Journal International*, 134(1), 213-227. DOI: [10.1046/j.1365-246x.1998.00555.x](https://doi.org/10.1046/j.1365-246x.1998.00555.x)
- **SimPEG framework**: Cockett, R., Kang, S., Heagy, L. J., Pidlisecky, A., & Oldenburg, D. W. (2015). "SimPEG: An open source framework for simulation and gradient based parameter estimation in geophysical applications." *Computers & Geosciences*, 85, 142-154. DOI: [10.1016/j.cageo.2015.09.015](https://doi.org/10.1016/j.cageo.2015.09.015)
- **Aarhus Workbench**: Auken, E., Foged, N., & Sørensen, K. I. (2002). "Model recognition by 1-D laterally constrained inversion of resistivity data." *Geophysics*, 67(5), 1468-1475. DOI: [10.1190/1.1512750](https://doi.org/10.1190/1.1512750)
- **GSC magnetic QC**: Geological Survey of Canada, standard magnetic QC procedures (4th difference noise, diurnal chord analysis).

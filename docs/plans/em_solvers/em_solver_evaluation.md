# EM Solver Evaluation for YmerFlow Integration

*Date: 2026-06-13 — Updated with deep comparative research*

## Context: What YmerFlow Already Has

YmerFlow has **full SimPEG support** for the following workflows (all production-ready):

### AEM (TDEM)
| Process | What it does |
|---|---|
| `import_skytem` | Imports SkyTEM XYZ+GEX files; normalises to Aarhus XYZ msgpack |
| `process_tem` | Full processing pipeline: tilt correction, altitude/DTM correction, culling (roll/pitch/altitude/slope/curvature/std), moving-average filter, noise model |
| `invert_tem` | 1D laterally constrained inversion (LCI) via `Simulation1DLayeredStitched`; dual-moment from GEX; L2 smooth + IRLS sparse models; InexactGaussNewton with beta cooling; Delaunay triangulation spatial coupling |
| `forward_process` | Forward modeling from a resistivity model (XYZ format → synthetic dB/dt) |

- **System format**: GEX (SkyTEM proprietary). Dual-moment waveform, tilt, gate factors all read from GEX.
- **Inversion type**: deterministic, gradient-based, fixed layer count, produces **point estimates only**.
- **Regularisation**: laterally constrained L2 (smooth) + optional IRLS (sparse/blocky). No uncertainty output.
- **AEM systems**: SkyTEM only (GEX-driven). No native support for Tempest, VTEM, RESOLVE, or other systems.

### Magnetics
Equivalent source gridding + full 3D OcTree susceptibility/MVI inversion, all SimPEG-based.

---

## Integration Model

Every YmerFlow process type — regardless of the solver's implementation language — follows the same wrapper pattern:

```python
class invert_tem_foo:
    @classmethod
    def run(cls, storage_context=None, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            # 1. Download inputs from S3/MinIO via fsspec
            download_via_fsspec(kwargs['input_data'], tmp, storage_context)
            # 2. Convert to solver's native format
            write_input_files(tmp, kwargs)
            # 3. Run the solver as a subprocess
            subprocess.run(['solver_binary', '--input', tmp, '--output', tmp], check=True)
            # 4. Convert outputs back to Aarhus XYZ / msgpack
            result_xyz = read_output_files(tmp)
            # 5. Upload to storage
            dataset_url = write_dataset(result_xyz, storage_context)
        return {'status': 'success', 'outputs': {'result': dataset_url}}
```

This means **implementation language is not a criterion**. C++, Fortran, Julia, or any other compiled language is equally feasible as long as the binary can be included in the Docker image. The real integration cost drivers are:

- **Format conversion effort**: how different is the solver's native I/O from Aarhus XYZ/GEX?
- **Docker build complexity**: does it need a compiler, special libs (FFTW, MPI, FEniCS, Julia runtime)?
- **Licence**: does it permit use in a commercial SaaS context?

---

## Gap Analysis

The evaluation question for each remaining solver is: **what new capability does it bring to YmerFlow that SimPEG does not already provide?**

| Gap | Category |
|---|---|
| **G1. Stochastic/Bayesian AEM inversion** | Algorithm: rj-MCMC → full posterior PDFs; uncertainty maps; depth-of-investigation from posterior width |
| **G2. Multi-system AEM support** | Non-SkyTEM TDEM systems (Tempest, VTEM) and FDEM AEM systems (RESOLVE, Dighem, HEM) — requires validated system descriptions |
| **G3. 3D target body forward modeling** | Thin conductive plate bodies (up to 9 plates) in a layered host; 1D LCI smears these conductors incorrectly — wrong depth, geometry, conductance |
| **G4. Ground FDEM (coil) surveys** | Instrument class entirely different from AEM: EM31, EM38, CMD, DUALEM; SimPEG has no dedicated workflow for this |
| **G5. 3D magnetotellurics** | MT inversion is in SimPEG but immature and non-standard; ModEM is the industry format standard for EDI data |
| **G6. 3D CSEM** | Marine/land controlled-source EM; a distinct market from AEM |

Solvers that fill none of these gaps — because SimPEG already covers their method well — are ranked at the bottom regardless of their standalone quality.

---

## Ranked Evaluation

### Tier 1 — High marginal value: fills genuine gaps

---

#### 1. GeoBIPy
*Gap filled: G1 (Bayesian inversion), G2 (dual-moment TDEM)*

| | |
|---|---|
| **URL** | https://github.com/DOI-USGS/geobipy |
| **Language** | Python (94.5%), Fortran (5%) |
| **License** | USGS public domain (Python codebase); GPL-2.0 for one Fortran component |
| **Activity** | Very active — v2.3.3 (March 2026), 1854 commits |
| **AEM features** | Trans-dimensional rj-MCMC Bayesian inversion; full posterior PDFs; piecewise-linear waveform (arbitrary waveform); multi-moment TDEM; credible intervals; DOI from posterior width |
| **Python API** | Yes — native; `pip install geobipy` |
| **Docker** | Moderate — MPI (mpi4py) required; HDF5 |
| **Data formats** | HDF5 via h5py; `TdemSystem` class for system definition; **no native Aarhus XYZ reader** (adapter needed) |

**What it adds beyond SimPEG:**

GeoBIPy uses **reversible-jump Markov Chain Monte Carlo (rj-MCMC)**, the same Bayesian algorithm used by GA-AEM's stochastic mode and HiQGA's MCMC mode. It does not produce a single resistivity model — it samples the full posterior probability distribution P(model | data), with the number of layers as a free parameter. Outputs include:

- Resistivity vs. depth **posterior PDFs**: a probability image showing not just the best model but how certain the data are at each depth
- **Interface-depth probability**: reveals where layer boundaries are well-constrained vs. ambiguous
- **Layer-count posterior**: shows whether the data support 2, 3, or 5 layers
- **Credible intervals** at 68% and 95% level — equivalent to ±1σ and ±2σ but fully nonlinear

This is the **uncertainty quantification differentiator** for YmerFlow. A user who runs SimPEG's LCI gets a smooth model. A user who runs GeoBIPy on the same data gets the same model *plus a probability map* that tells them which parts of the model are geologically reliable.

GeoBIPy processes soundings independently (no spatial coupling), which is a trade-off vs. SimPEG LCI. Spatial coherence comes from data density; lateral constraints are an active research feature. Computationally it requires MPI and scales via embarrassingly parallel MCMC chains — designed for HPC clusters. Not suitable for realtime turnaround; suited for post-survey detailed analysis of priority areas.

**Used by USGS** for national AEM programs (Alaska permafrost, Great Plains aquifers). The Python API makes it the easiest Bayesian AEM solver to wrap as a YmerFlow process type.

**Integration path**: Write a `libaarhusxyz` → GeoBIPy HDF5 adapter; wrap as `invert_tem_bayesian` process with MPI-enabled K8s pod (multi-container job). System parameters entered via `TdemSystem` constructor (similar to GEX-to-SimPEG mapping already done).

---

#### 2. empymod (as standalone FDEM forward process)
*Gap filled: G2 (FDEM AEM: RESOLVE, Dighem, HEM)*

| | |
|---|---|
| **URL** | https://github.com/emsig/empymod |
| **Language** | Python |
| **License** | Apache-2.0 |
| **Activity** | Very active — v2.6.0 (January 2025), updated June 2026 |
| **AEM features** | 1D layered-earth forward modeling: all coil configurations (HCP, VCP, coaxial), arbitrary waveform (v2.6.0), FDEM + TDEM, VTI anisotropy; 100–1000× faster per sounding than SimPEG for pure 1D |
| **Python API** | Yes — native |
| **Docker** | Trivial |

**What it adds beyond SimPEG:**

YmerFlow uses SimPEG's TDEM stack, which has no configured process type for **frequency-domain helicopter AEM** systems: RESOLVE (CGG), Dighem (Aerodat), HEM (Geotech). These measure in-phase and quadrature response at multiple frequencies and are widely used for base metal exploration and groundwater. empymod models all RESOLVE-type coil geometries (HCP, coaxial) and frequencies directly and is the de-facto standard forward engine for 1D FDEM AEM.

The v2.6.0 addition of **arbitrary waveform support** also makes it directly competitive with SimPEG for TDEM forward modeling — and about 100–1000× faster per sounding, because it uses a semi-analytical DLF approach rather than sparse matrix solvers. This matters as a standalone "forward model" process type for synthetic data generation, sensitivity testing, and as the inner engine of a custom inversion workflow.

empymod is the lowest integration cost of any solver on this list and the highest utility-to-effort ratio. A standalone `forward_1d_fdem` process type serving RESOLVE-type users can be written in under 100 lines.

---

#### 3. GA-AEM
*Gap filled: G2 (multi-system: Tempest, VTEM, GeoTEM, SPECTREM + stochastic mode) — with significant licence caveat*

| | |
|---|---|
| **URL** | https://github.com/GeoscienceAustralia/ga-aem |
| **Language** | C++ |
| **License** | ⚠️ **GPL v2** — Crown Copyright Commonwealth of Australia. Not permissive; SaaS deployment requires legal review or commercial licence from Geoscience Australia |
| **Activity** | Active — v2.0.3 (November 2024) |
| **AEM features** | Deterministic Gauss-Newton (`galeisbstdem`); **trans-dimensional rj-MCMC** with parallel tempering (`garjmcmctdem`); system-agnostic via `.stm` files |
| **Wrapper model** | Subprocess to CLI binaries (`galeisbstdem`, `garjmcmctdem`); also exposes `gatdaem1d.so` shared library for forward modeling/derivatives if needed |
| **Docker build** | Moderate — FFTW required; MPI + NetCDF optional for stochastic mode |
| **Data formats** | ASEGGDF2 (.dfn/.dat) — the international AEM exchange format; NetCDF (experimental) |

**What it adds beyond SimPEG:**

**System coverage**: GA-AEM has validated `.stm` system files for Tempest, VTEM, GeoTEM, and SPECTREM — the commercial systems widely used outside the SkyTEM ecosystem (particularly in Australia, Canada, South Africa). These systems cannot be run directly through YmerFlow's GEX-based `invert_tem` without a GEX equivalent. GA-AEM's `.stm` format is the natural bridge.

**ASEGGDF2 format**: The international AEM exchange standard used by Geoscience Australia, CSIRO, and most survey contractors. Users with ASEGGDF2 archives cannot currently feed data into YmerFlow without conversion.

**Stochastic mode** (`garjmcmctdem`): Same rj-MCMC algorithm as GeoBIPy but the GA reference implementation for Tempest. Validated against decades of Australian national AEM surveys.

**Critical limitation**: **GPL v2 licence**. Building a commercial SaaS on GPL v2 code is legally problematic without releasing the wrapper. Options: (a) negotiate a commercial licence from Geoscience Australia, or (b) take legal advice on whether a subprocess-isolated container is a "separate program" under GPL v2.

**Integration path**: Build Docker image with GA-AEM compiled (FFTW + optional MPI). Write Aarhus XYZ ↔ ASEGGDF2 adapter. Standard subprocess wrapper. The real cost is the format adapter and the licence resolution, not the language. Unlocks every operator using Tempest, VTEM, or ASEGGDF2 archives.

---

#### 3. HiQGA.jl
*Gap filled: G1 (MCMC inversion), G2 (multi-system), with more efficient MCMC*

| | |
|---|---|
| **URL** | https://github.com/GeoscienceAustralia/HiQGA.jl |
| **Language** | Julia |
| **License** | MIT |
| **Activity** | Very active — v0.5.3 (May 2026) |
| **AEM features** | Deterministic GN; fixed-dim MCMC; **trans-D rj-MCMC**; **gradient MCMC (NUTS/HMC)** — more efficient than random-walk; SkyTEM, Tempest, VTEM, RESOLVE validated |
| **Wrapper model** | Subprocess to Julia executable; Julia runtime (~500 MB) in Docker image; first-run precompilation delay (~1–2 min) can be baked into image build |
| **Docker build** | Moderate — Julia runtime + `Pkg.precompile()` during image build eliminates runtime delay |
| **Data formats** | HDF5 (JLD2) / CSV; no native Aarhus XYZ — adapter needed |

**What it adds beyond SimPEG and beyond GeoBIPy:**

HiQGA is the most algorithmically advanced of the three stochastic solvers. Its **gradient MCMC (NUTS — No U-Turn Sampler / Hamiltonian MC)** uses gradient information (the Jacobian) to propose more efficient MCMC steps. This can reduce the number of forward calls needed to characterise the posterior by 10–100× compared to random-walk rj-MCMC (GeoBIPy / GA-AEM). For surveys where per-sounding MCMC is computationally expensive, HiQGA's NUTS approach may make Bayesian inversion practically feasible on moderate hardware rather than requiring an HPC cluster.

Additional value: HiQGA covers the widest range of inversion strategies in a single package (deterministic, fixed-D MCMC, trans-D MCMC, gradient MCMC), enabling comparative analysis.

The integration challenge is **Docker image size** (Julia runtime adds ~500 MB) and precompilation, but both are solvable at image build time. MIT licence removes the GA-AEM licence risk entirely.

---

#### 4. P223 Suite (LeroiAir / ArjunAir)
*Gap filled: G3 (3D target body forward modeling)*

| | |
|---|---|
| **URL** | https://github.com/prisae/P223_Public |
| **Language** | Fortran 90 |
| **License** | MIT (since 2023) |
| **Activity** | Moderate — 2023 licence change; last commit 2023 |
| **AEM features** | **LeroiAir**: 3D thin conductive plate bodies (up to 9 plates) in layered host, arbitrary orientation; **ArjunAir**: 2.5D FEM for profiling |
| **Wrapper model** | Subprocess to Fortran binaries; Python utility scripts for pre/post-processing already provided in repo |
| **Docker build** | Low — `apt-get install gfortran` + `make install`; no exotic dependencies |
| **Data formats** | CFL control files (ASCII text); output in OUT/MV1/MF1 binary formats |

**What it adds beyond SimPEG:**

SimPEG's `Simulation1DLayeredStitched` assumes the earth is horizontally layered and laterally slowly varying. This is an excellent model for sedimentary basins, aquifer systems, and permafrost. However, it **fails fundamentally for discrete 3D conductors** such as:

- Massive sulfide ore bodies (VMS, Ni-Cu deposits)
- Conductive graphite horizons that dip steeply
- Anthropogenic targets (buried tanks, pipes)

When a SkyTEM or VTEM survey flies over a dipping conductive plate, the 1D LCI model interprets it as a conductive layer smeared horizontally — wrong depth, wrong geometry, wrong conductance estimate. LeroiAir models the conductor as a parameterized plate (strike, dip, plunge, depth, conductance, along-strike and down-dip extent) and computes the correct 3D EM response of the plate in a layered background. This is the standard tool for **target characterisation** in mineral exploration AEM.

This is not an inversion tool but a **forward modeling** tool. The workflow is: run SimPEG LCI to get the background layered model → identify anomalies in the LCI residuals → use LeroiAir to forward-model the anomaly with various plate geometries → match the observed data to determine plate parameters.

**Integration**: Subprocess wrapper + ASCII control file generator from YmerFlow parameters. The most natural process type would be `forward_3d_plate` that takes a plate parameterization (from the UI) + background LCI model + survey geometry and produces synthetic AEM data for comparison.

---

#### 5. EMagPy
*Gap filled: G4 (ground FDEM coil surveys — entirely different instrument class from AEM)*

| | |
|---|---|
| **URL** | https://pypi.org/project/emagpy/ |
| **Language** | Python |
| **License** | GPL-3.0 |
| **Activity** | Active — last commit May 2026 |
| **AEM features** | Ground FDEM only (not airborne) |
| **Python API** | Yes — native; `pip install emagpy` |
| **Docker** | Trivial |
| **Data formats** | CSV with `HCP1.2f` column naming convention |

**What it adds beyond SimPEG:**

EMagPy targets **ground-deployed frequency-domain EM coil sensors**: GF Instruments CMD series, Dualem 1S/2S/21S/42S, Geonics EM31/EM38/EM34. These are dragged or hand-carried sensors operating at low induction number, widely used for:

- Precision agriculture (soil salinity/clay mapping)
- Shallow environmental contamination surveys
- Archaeological geophysics
- Near-surface geological mapping

SimPEG does have a 1D FDEM simulation, but it has no dedicated processing pipeline for these instruments, no CSV input format for the specific column naming conventions used by CMD/Dualem exporters, and no automated sensor-geometry handling (coil separation, height above ground, orientation). EMagPy packages all of this in a clean Python API.

This opens a **different user community** from AEM operators: environmental consultants, agronomists, archaeologists. Ground FDEM surveys are far more numerous than AEM surveys (much lower entry cost), and a cloud-based processing service for them is an underserved market.

**License note**: GPL-3.0. The GPL's network use provision (Affero GPL) does not apply here since it's plain GPL-3.0, but using GPL libraries in a SaaS product should be reviewed with counsel. The process type container runs GPL code in isolation (not linked to the YmerFlow codebase), which substantially reduces the concern.

---

#### 6. ModEM
*Gap filled: G5 (3D MT with EDI format compatibility)*

| | |
|---|---|
| **URL** | https://github.com/magnetotellurics/ModEM |
| **Language** | Fortran (+ optional CUDA/HIP) |
| **License** | Apache-2.0 |
| **Activity** | Active — last commit February 2026 |
| **AEM features** | None — MT only |
| **Wrapper model** | Subprocess to `Mod3DMT` binary; `pyModEM` Python package handles file I/O |
| **Docker build** | Moderate — gfortran + MPI; CUDA optional (GPU acceleration) |
| **Data formats** | EDI (industry standard MT format); plain-text model files |

**What it adds beyond SimPEG:**

SimPEG does have a Natural Source EM (NSEM) module for 3D MT, but it has known boundary condition issues (GitHub #1767) and is much less actively maintained than SimPEG's AEM modules. More critically, **SimPEG does not speak EDI**. EDI (Electrical Data Interchange) is the universal MT data format produced by every MT acquisition system and processed by every MT processing software (BIRRP, EMTF, Metronix, Phoenix). A MT practitioner's workflow starts with EDI files. An integration that can't read EDI can't serve MT users.

ModEM is **the de facto standard 3D MT inversion code** in the research and exploration community. Its output format (plain-text model files) is understood by visualisation tools like ModEM-gui, MTPy, and GMT. GPU support (CUDA/HIP) makes it competitive for large 3D models.

The case for ModEM integration: AEM surveys are routinely combined with MT surveys for complementary depth coverage. AEM resolves conductivity structure to ~300–500 m depth; MT extends this to several km. An operator doing both surveys in one field campaign naturally wants one platform. If YmerFlow handles AEM and refers the MT data elsewhere, that's friction. If it handles both, it captures the whole multi-method workflow.

**Integration path**: Subprocess wrapper around the ModEM executable; write Python utilities to translate from project data to EDI input, run `Mod3DMT`, and parse the text output. `pyModEM` helps with the file I/O. Not trivial but well-defined.

---

### Tier 2 — Moderate marginal value

---

#### 8. emg3d
*Gap filled: G6 (3D CSEM forward modeling)*

| | |
|---|---|
| **URL** | https://github.com/emsig/emg3d |
| **Language** | Python |
| **License** | Apache-2.0 |
| **Activity** | Very active — v1.9.1 (March 2026) |
| **What it adds** | 3D CSEM forward modeling in Python; multigrid FD solver; complements empymod (1D) for 3D validation. SimPEG overlaps significantly here. Main value: the `emsig` ecosystem (empymod + emg3d) is the standard for academic CSEM/MT forward modeling. A joint empymod + emg3d 1D-to-3D comparison workflow is useful but niche within YmerFlow's target market. |
| **Integration effort** | Trivial (pure Python) |

---

#### 9. PyGimli
*Gap filled: ERT/IP surveys + multi-method joint inversion*

| | |
|---|---|
| **URL** | https://www.pygimli.org |
| **Language** | Python / C++ |
| **License** | Apache-2.0 |
| **Activity** | Very active — v1.6.0 (May 2026), new SCCI framework |
| **What it adds** | ERT, IP, seismic refraction inversion; joint multi-method inversion framework. SimPEG also does ERT/IP. PyGimli's main differentiator is its Structurally Coupled Co-operative Inversion (SCCI, added v1.6.0) framework for coupling ERT + EM datasets. Relevant if YmerFlow expands to ground-based multi-method surveys alongside AEM. |
| **Integration effort** | Easy (Python API, conda installable) |

---

#### 10. P223 ArjunAir
*Gap filled: G3 (2.5D profiling — complement to LeroiAir)*

Lower priority than LeroiAir. ArjunAir is a more computationally expensive 2.5D FEM and is used for profiling surveys where LeroiAir's plate model is insufficient (e.g., gradational 2D conductors). It uses the same P223 Fortran codebase and would be packaged alongside LeroiAir naturally. Separately, not worth the integration effort.

---

#### 11. TEM1D
*Marginal gap: independent 1D TDEM reference / AarhusInv-lineage benchmarking*

| | |
|---|---|
| **URL** | https://github.com/hydrogeophysicsgroup/TEM1D |
| **Language** | Fortran |
| **License** | MIT |
| **Activity** | Active — Jan 2026 |
| **Wrapper model** | Subprocess to Fortran binary; `gfortran` compile; MIT licence |
| **What it adds** | 1D TDEM forward modeling and sensitivities (Christensen group, same lineage as AarhusInv/SCI). The reference implementation for the forward model underlying Aarhus Workbench. SimPEG's `Simulation1DLayeredStitched` solves the same problem. Only worth integrating if a validated discrepancy with SimPEG needs resolving, or for exact AarhusInv compatibility testing. Docker build and subprocess wrapper would be straightforward. |

---

### Tier 3 — Low or no marginal value over SimPEG

Solvers in this tier are either: (a) covered by SimPEG's existing AEM/EM/magnetics support (all could in principle be wrapped via subprocess, but doing so adds no capability); (b) MATLAB-only (MATLAB is not in the Docker image and is not freely licensable, making these genuinely unusable); (c) inactive or restrictively licensed; or (d) address methods — marine CSEM, academic 3D MT — outside the YmerFlow user base. Language alone is not a reason for low ranking.

| Name | Mode | Language | Why low marginal value |
|---|---|---|---|
| **FDEM1D** | 1D FDEM | Python/MATLAB | SimPEG + empymod cover 1D FDEM; GPL-3.0 |
| **custEM** | 3D FEM | Python+FEniCS | SimPEG covers 3D FDEM/TDEM; FEniCS install complex; LGPL; superseded by custemx |
| **FEMTIC** | 3D MT | C++ | SimPEG + ModEM cover 3D MT; no unique differentiator |
| **GoFEM** | 2D MT/CSEM | C++ | SimPEG covers 2D MT; unknown licence |
| **MT2D** | 2D MT | C++ | No public repo; SimPEG covers |
| **GEMMIE** | 3D MT | Fortran | SimPEG + ModEM cover 3D MT |
| **libEMMI / libEMMI_MGFD** | 3D CSEM | C | Marine CSEM focus; emg3d covers same in Python; unknown licence |
| **EMFEM** | 3D FDEM | C++ | SimPEG covers 3D FDEM; unknown licence |
| **GEMM3D** | 3D MT/CSEM | Fortran | SimPEG + ModEM cover MT/CSEM |
| **EM3DANI** | 3D MT anisotropic | Julia | Niche anisotropic MT; SimPEG has anisotropic MT |
| **elfe3D (elle3D)** | 3D CSEM | C | Marine CSEM only; emg3d is better Python alternative |
| **MTGeophysics.jl** | 1D/2D/3D MT | Julia | SimPEG covers MT; no unique capability |
| **PETGEM** | 3D CSEM | Python/C | Marine CSEM only; SimPEG covers |
| **jif3d** | Joint inversion | C++ | SimPEG covers joint inversion more flexibly |
| **MARE2DEM** | Marine MT/CSEM | Fortran+MATLAB; marine-only; no Python |
| **WPTEM3D** | 3D ground TDEM | MATLAB+Fortran; SimPEG covers; no Python |
| **FEMIC** | 1D FDEM | MATLAB only |
| **FDEMtools3** | 1D FDEM | MATLAB only |
| **ES-RTD-FDEM** | 1D FDEM | MATLAB only |
| **FEMT2D** | 2D MT | MATLAB only |
| **OCCAM1DCSEM** | 1D CSEM/MT | Fortran+MATLAB; 2009 vintage; inactive |
| **OCCAM2DMT** | 2D MT | Fortran+MATLAB; 2009 vintage; inactive; SimPEG + ModEM cover |
| **EEMverter** | Multi-method | Appears commercial/closed; not open source |

---

## Summary: Ranking by Marginal Value

All solvers are integrated via the same subprocess wrapper pattern (fsspec download → subprocess → fsspec upload). Integration effort reflects **format conversion complexity** and **Docker build complexity**, not programming language.

| Rank | Solver | Gap | Licence | What you actually gain | Format adapter | Docker build |
|------|--------|-----|---------|----------------------|---------------|--------------|
| 1 | **GeoBIPy** | G1 | USGS public domain¹ | rj-MCMC → full posterior PDFs, credible intervals, DOI maps. Uncertainty quantification tier. Soundings processed independently (complements SimPEG LCI). | XYZ → HDF5 | Easy (pip) |
| 2 | **empymod** | G2 (FDEM AEM) | Apache-2.0 | FDEM AEM (RESOLVE, Dighem, HEM): HCP/coaxial coil geometries; 100–1000× faster 1D forward than SimPEG. | XYZ cols → arrays | Trivial (pip) |
| 3 | **GA-AEM** | G1 + G2 | ⚠️ GPL v2 | Trans-D stochastic inversion + Tempest/VTEM/GeoTEM multi-system. High user impact. **Resolve licence before commercial deploy.** | XYZ ↔ ASEGGDF2 | Moderate (FFTW + compile) |
| 4 | **HiQGA.jl** | G1 + G2 | MIT | Gradient MCMC (NUTS/parallel tempering) — most efficient Bayesian sampling of the three; multi-system. | XYZ → CSV/HDF5 | Moderate (Julia runtime + precompile) |
| 5 | **P223 LeroiAir** | G3 | MIT | 3D plate-body AEM forward modeling. Correct model for tabular discrete conductors (sulfide ore) that 1D LCI misrepresents. | XYZ → CFL text | Easy (gfortran) |
| 6 | **EMagPy** | G4 | GPL-3.0 | Ground FDEM coil surveys (EM31/EM38/CMD/DUALEM). Different user market. GPL review needed. | CSV coil format | Trivial (pip) |
| 7 | **ModEM** | G5 | Apache-2.0 | Industry-standard 3D MT + EDI format. Multi-method AEM+MT workflows. | EDI format | Moderate (gfortran + MPI) |
| 8 | **emg3d** | G6 | Apache-2.0 | 3D CSEM forward modeling; pure Python; complements empymod. Niche. | XYZ cols → arrays | Trivial (pip) |
| 9 | **PyGimli** | ERT/IP | Apache-2.0 | ERT, IP, joint inversion. Relevant if expanding to multi-method. | .dat format | Easy (conda) |
| 10 | **P223 ArjunAir** | G3 (2.5D) | MIT | 2.5D FEM — bundled with LeroiAir, lower standalone priority. | Same as LeroiAir | Easy (same build) |
| 11 | **TEM1D** | None new | MIT | AarhusInv-lineage 1D TDEM forward code. SimPEG covers same method. Benchmarking only. | XYZ → text | Easy (gfortran) |
| 12–35 | *See Tier 3 table* | None | varies | Covered by SimPEG, or MATLAB-only, or inactive, or niche market. | — | — |

¹ GeoBIPy Python codebase: USGS public domain. One Fortran component: GPL-2. The GPL component may be replaceable with scipy equivalents.

---

## Recommended Integration Sequence

### Phase 1 — Low-hanging fruit (trivial effort, real gaps)

**empymod** (`forward_fdem_1d`, `forward_tdem_1d`) — pure Python, Apache-2.0, zero new dependencies. Write one process type class to expose 1D FDEM forward modeling for RESOLVE/Dighem/HEM users and fast synthetic TDEM data generation. Validates the "forward model without inversion" process pattern. Estimated: 1–2 days.

**GeoBIPy** (`invert_tem_bayesian`) — Python-native, USGS public domain. Write the `libaarhusxyz` → GeoBIPy HDF5 format adapter, deploy an MPI-enabled K8s pod. The uncertainty quantification output (posterior PDFs, credible interval maps) is the clearest premium-tier feature on this list — directly differentiates from "another AEM platform". Estimated: 1–2 weeks.

### Phase 2 — Unlock non-SkyTEM operators (highest user growth potential)

**GA-AEM** (`invert_tem_gaaem`, `invert_tem_stochastic`) — **resolve licence first**: either negotiate a commercial licence from Geoscience Australia, or seek legal opinion on subprocess isolation under GPL v2. Once resolved: write ASEGGDF2 ↔ Aarhus XYZ adapter, build Docker image with FFTW + compiled GA-AEM binaries. Unlock Tempest, VTEM, GeoTEM operators. Estimated: 3–4 weeks after licence resolution.

### Phase 3 — Mineral exploration workflows

**P223 LeroiAir** (`forward_3d_plate`) — subprocess Fortran binary, CFL control file generator from UI parameters. Targets hard-rock mineral exploration (sulfide detection, plate characterisation). Estimated: 1–2 weeks.

**ModEM** (`invert_mt_3d`) — subprocess C++ binary, EDI format adapter. Covers the MT leg of multi-method mineral exploration surveys. Estimated: 2–3 weeks.

### Phase 4 — Ecosystem expansion

**HiQGA.jl** (`invert_tem_hiqga`) — MIT licence, most advanced MCMC algorithm. Build Julia runner base image. Requires data format adapter and juliacall or subprocess bridge. Estimated: 2–3 weeks.

**EMagPy** (`invert_fdem_ground`) — GPL-3.0 requires review; otherwise trivial to integrate. Opens agriculture/environment/archaeology market. Estimated: 3–5 days after licence clearance.

---

## Data Format Compatibility Notes

| Format | Used by | YmerFlow adapter status |
|---|---|---|
| **Aarhus XYZ + GEX** (msgpack) | Native YmerFlow | Already implemented |
| **ASEGGDF2** (.dfn/.dat) | GA-AEM | Needs new adapter |
| **HDF5** (GeoBIPy format) | GeoBIPy | Needs new adapter |
| **EDI** | ModEM, MT community | Needs new adapter |
| **CFL control files** | P223 | Needs generator |
| **CSV coil format** | EMagPy | Needs new adapter |
| **NumPy arrays** | empymod, emg3d | Trivial (XYZ columns → arrays) |

A shared **`nagelfluh_aem_adapters`** Python package containing these format converters would avoid duplication across process types and is worth building before Phase 2.

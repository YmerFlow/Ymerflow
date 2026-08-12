# Backend as an Installable Package — Plan

## Goal

Package the backend as a real, pip-installable Python distribution with a root `setup.py`, install
it (editable) into the venv and the image, and have the backend **register its own core
`nagelfluh.*` entry points the same way plugins do**. This removes the three places where core is
special-cased against plugins today — the direct `import backend.models`, the hardcoded main
migration-version directory, and the bare-`except` swallowing that surrounds both.

This plan is **only about packaging + unifying discovery of the registrations that already exist**
(models, migration dirs). It deliberately does **not** add any new hook. In particular it does not
touch storage/credential logic — that is a separate plan implemented on top of this one, and the
`nagelfluh.hooks` entry-point slot this plan establishes in `setup.py` is where such a future hook
will register.

## Background — current state

- **The backend is not a package at all.** There is no `setup.py` / `pyproject.toml` anywhere, and
  no `backend/__init__.py`. `backend` is an *implicit namespace package* (PEP 420), importable only
  because the process's working directory (repo root) is on `sys.path`:
  - `backend/run.sh:7` `cd`s to the repo root and runs `uvicorn backend.main:app` (comment on
    line 6: *"Change to parent directory so Python can find the 'backend' module"*).
  - `backend/bin/yf-migrate` and `yf-makemigrations` each manually
    `sys.path.insert(0, _project_root)` for the same reason.
- **Dependencies live in `backend/requirements.txt`** (26 packages + one git URL,
  `ymerflow-plugin-build @ git+…`), installed via `pip install -r` in two places:
  - `dev/runall.sh:106`
  - `backend/Dockerfile:13-14`
- **Plugins, by contrast, *are* packages** (`plugins/billing/setup.py`) installed via
  `scripts/install-backend-plugins.sh` (local paths install editable; PyPI/git install normally).
  They register `nagelfluh.hooks`, `nagelfluh.models`, and `nagelfluh.migration_dirs` entry points
  that the host discovers at runtime.
- **Three core discovery points are special-cased** — core does by direct wiring what plugins do
  by entry point:
  1. `backend/alembic/env.py:13` — `import backend.models` **directly**, while plugin models come
     from the `nagelfluh.models` entry point (lines 23-30).
  2. `backend/bin/yf-migrate:_build_config` — hardcodes `main_versions =
     script_location/versions` and only *appends* plugin dirs from `nagelfluh.migration_dirs`.
  3. `backend/bin/yf-makemigrations:_build_config` — the same hardcoded `main_versions`
     prepend.
- **Bare-`except Exception: pass` around entry-point loading** in `backend/alembic/env.py:16-20`
  and `:23-30` silently swallow plugin import/registration errors — a direct violation of CLAUDE.md
  rule 8 ("never swallow errors"). This plan rewrites those blocks, so it fixes them.

## Architecture Summary

- **Root `setup.py`** (repo root, `setup.py` only — no `pyproject.toml`, since the backend needs no
  build-system dependencies or imperative build step, unlike `plugins/billing` which builds a
  frontend). Distribution name `ymerflow-backend`; the importable package stays `backend`
  (renaming the import root to `nagelfluh` would touch every `from backend.X import …` and is
  explicitly out of scope). Packages enumerated with
  `find_namespace_packages(include=['backend', 'backend.*'])` so the existing `__init__`-less tree
  (notably `backend/alembic/`) is packaged as-is with no new `__init__.py` files.
- **Editable install everywhere** (`pip install -e .`) — in dev *and* in the image. This keeps
  `backend.main:app`, `--reload-dir backend`, and the path-based data-file loads
  (`widget_schemas.json` via `Path(__file__).parent.parent`, the alembic `version_locations`)
  working unchanged, and avoids having to enumerate `package_data` for those non-Python files.
- **Dependencies move into `setup.py`'s `install_requires`** (verbatim from
  `backend/requirements.txt`, including the `ymerflow-plugin-build` git URL as a PEP 508 direct
  reference). `backend/requirements.txt` is deleted; both install sites switch to
  `pip install -e .`.
- **Core registers its own entry points in `setup.py`**, identical in shape to what
  `plugins/billing/setup.py` already does:
  - `nagelfluh.models: nagelfluh = backend.models`
  - `nagelfluh.migration_dirs: nagelfluh = backend.migration_path:path`
  - (a `nagelfluh.hooks` block is **not** added now — core implements no hook yet; it is the future
    home for one, but this plan adds nothing there.)
- **All three special-cased sites collapse to "core is just another registrant."** With core in the
  `nagelfluh.models` / `nagelfluh.migration_dirs` groups, `env.py` drops its direct
  `import backend.models`, and both migrate scripts drop the hardcoded `main_versions` — each simply
  iterates every entry point in the group (core + plugins). The bare-`except` blocks go with them.
- **Install-order consequence:** entry points are read from *installed* distribution metadata, so
  the backend must be `pip install -e .`'d before it runs, and re-installed whenever `setup.py`'s
  entry points change (source edits to `.py` files do **not** require reinstall; entry-point edits
  do). Both install scripts already run before the server starts, so this only adds a documentation
  note for the entry-point-edit case.

---

## Phase 1 — Package the backend

### 1.1 Root `setup.py`

**New file: `setup.py`** (repo root)

```python
from setuptools import setup, find_namespace_packages

setup(
    name='ymerflow-backend',
    version='0.1.0',
    description='YmerFlow host backend (FastAPI app + nagelfluh.* entry points).',
    # backend/ has no __init__.py (implicit namespace package); enumerate it as a namespace
    # package so the existing tree — including backend/alembic — is packaged without adding
    # __init__.py files that would change import semantics.
    packages=find_namespace_packages(include=['backend', 'backend.*']),
    python_requires=">=3.11",   # matches the python:3.11-slim runtime image
    install_requires=[
        'setuptools',
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
        'click',
        'python-dotenv',
        'asyncpg',
        'psycopg2-binary',
        'aiosmtplib',
        'fastapi-mcp',
        # Frontend-plugin build harness — imported by backend/services/job_orchestrator.py
        # (HOST_SHARED_VERSIONS) and run in-pod by the build_frontend_plugin process type. A
        # backend library dependency, NOT a hook plugin (those install from BACKEND_PLUGINS via
        # scripts/install-backend-plugins.sh).
        'ymerflow-plugin-build @ git+https://github.com/YmerFlow/Ymerflow-plugin-sdk.git',
    ],
    entry_points={
        # Core registers itself in the same groups plugins use, so downstream discovery treats
        # core and plugins identically (see Phase 2). No nagelfluh.hooks block yet — core
        # implements no hook today; this is where a future core hook would be added.
        'nagelfluh.models': [
            'nagelfluh = backend.models',
        ],
        'nagelfluh.migration_dirs': [
            'nagelfluh = backend.migration_path:path',
        ],
    },
)
```

### 1.2 Core migration-dir path export

**New file: `backend/migration_path.py`** — mirrors `plugins/billing/billing/migrations/__init__.py`
(`path = Path(__file__).parent / "versions"`) so the `nagelfluh.migration_dirs` entry point resolves
the same way as any plugin's:

```python
from pathlib import Path

# The main (core) alembic version directory, exposed for the nagelfluh.migration_dirs entry point
# so core is discovered the same way plugin migration branches are.
path = Path(__file__).parent / "alembic" / "versions"
```

A dedicated tiny module is used rather than adding `backend/alembic/__init__.py`, to avoid making
the alembic directory an importable package (alembic loads `env.py` by path via `script_location`,
not by import).

### 1.3 Delete `backend/requirements.txt`

Its contents now live in `setup.py`'s `install_requires` (1.1). Remove the file so there is a single
source of truth for backend dependencies.

### 1.4 Wire the editable install into dev

**`dev/runall.sh:106`** — replace
```bash
pip install -q -r backend/requirements.txt
```
with
```bash
pip install -q -e .
```
This stays *before* the `scripts/install-backend-plugins.sh` call (line ~113) and the migration run
(`env/bin/python backend/bin/yf-migrate`, line ~200), so the backend's own entry points are
registered before either plugins install or migrations run.

### 1.5 Wire the editable install into the image

**`backend/Dockerfile`** — replace the `requirements.txt` copy/install (lines 13-14) with an
editable install of the copied source, and reorder so the backend is installed before plugins:

```dockerfile
WORKDIR /app

# Install the backend package (editable) from source. Editable keeps widget_schemas.json and the
# alembic tree resolvable by path and avoids enumerating package_data for them.
COPY setup.py setup.py
COPY backend/ backend/
RUN pip install --no-cache-dir -e .

# Server-side backend plugins (unchanged mechanism) — installed AFTER the backend so their
# lazily-imported host modules are present in the image.
ARG BACKEND_PLUGINS=""
COPY plugins/ plugins/
COPY scripts/install-backend-plugins.sh scripts/install-backend-plugins.sh
RUN BACKEND_PLUGINS="$BACKEND_PLUGINS" bash scripts/install-backend-plugins.sh

COPY docker/update_bootstrap_environment.py update_bootstrap_environment.py

EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Trade-off (see Open Questions): because `pip install -e .` needs `backend/` present to build its
metadata, the dependency-install layer can no longer be cached independently of backend source
changes the way the old `COPY requirements.txt` → `pip install -r` two-step did.

### 1.6 `backend/run.sh` — no change required

`run.sh` still `cd`s to the repo root and runs `uvicorn backend.main:app`; the editable install only
*adds* a second, path-independent way for `backend` to resolve, so nothing breaks. Left as-is to keep
this plan's diff minimal.

At the end of Phase 1 the backend is an installed package but discovery is byte-for-byte unchanged:
`env.py` still `import backend.models` directly and the migrate scripts still hardcode the main
version dir. Nothing depends on the new entry points yet.

---

## Phase 2 — Core discovered via its own entry points

Now that core registers `nagelfluh.models` and `nagelfluh.migration_dirs` (Phase 1.1), remove the
three special-cased sites so core is discovered exactly like a plugin, and drop the bare-`except`
swallowing.

### 2.1 `backend/alembic/env.py`

Replace the direct import + bare-`except` plugin loop (lines 11-30) with a single loop over **all**
`nagelfluh.models` entry points (core `backend.models` is now among them) and no error swallowing:

```python
import importlib
import importlib.metadata

from backend.database import Base
from backend.config import settings

# Import every registered model module (core + plugins) so autogenerate sees all tables. Core
# registers backend.models under nagelfluh.models in setup.py, so it is discovered here too —
# no separate `import backend.models`.
for ep in importlib.metadata.entry_points(group='nagelfluh.models'):
    importlib.import_module(ep.value)

# Call the register_models fan-out hook (plugins that build metadata imperatively). Errors
# propagate — a plugin that fails to register its models must fail loudly, not silently.
from backend.hooks import hooks
hooks.run.register_models()
```

Notes:
- The old `import backend.models  # noqa` is gone — it now arrives via the entry-point loop.
- Both former `try/except Exception: pass` blocks are removed; import/registration failures now
  surface (CLAUDE.md rule 8).
- `hooks.run.register_models()` is retained (it is a distinct, plugin-facing imperative path); only
  its swallowing wrapper is removed. Whether `register_models` is redundant with the
  `nagelfluh.models` entry point is a pre-existing plugin-facing question, out of scope here.

### 2.2 `backend/bin/yf-migrate`

`_build_config` currently hardcodes the main version dir and only conditionally sets
`version_locations`. Since core now registers its own `nagelfluh.migration_dirs` entry point, build
`version_locations` purely from the entry points (core + plugins), always:

```python
def _build_config():
    ini_path = os.path.join(_project_root, "backend", "alembic.ini")
    cfg = Config(ini_path)

    # Every version directory — core and plugins — comes from nagelfluh.migration_dirs now.
    # Core registers backend/alembic/versions there (setup.py), so it is no longer special-cased.
    version_dirs = [
        str(ep.load())
        for ep in importlib.metadata.entry_points(group='nagelfluh.migration_dirs')
    ]
    if version_dirs:
        cfg.set_main_option("version_locations", os.pathsep.join(version_dirs))

    return cfg
```

The bare `try/except Exception: pass` around `ep.load()` (present in the current version) is
dropped — a plugin whose migration dir cannot be resolved should fail the migration run, not be
silently skipped into a partial schema.

`script_location` (from `alembic.ini`) still points at `backend/alembic` for `env.py`; only
`version_locations` is now fully entry-point-driven. `alembic.ini`'s default
`version_locations = %(here)s/alembic/versions` is left untouched as the fallback for running bare
`alembic` without this wrapper.

### 2.3 `backend/bin/yf-makemigrations`

Same de-special-casing in its `_build_config`: drop the hardcoded `main_versions` prepend and build
the dir list from the entry points alone (which now include core), so the core versions directory is
not listed twice:

```python
def _build_config(version_dirs):
    ini_path = os.path.join(_project_root, "backend", "alembic.ini")
    cfg = Config(ini_path)
    if version_dirs:
        cfg.set_main_option("version_locations", os.pathsep.join(version_dirs))
    return cfg
```

`main()` already computes `all_plugin_dirs = [str(ep.load()) for ep in eps]` from the entry points —
that list now includes core and is passed straight to `_build_config` (rename to `all_version_dirs`
for clarity). Per-plugin branch resolution (`head=f"{plugin_name}@head"`, `version_path=…`) is
unchanged; core migrations continue to be authored with plain `alembic -c backend/alembic.ini
revision` (no branch label), as today.

---

## Implementation Order

1. **Phase 1** — add `setup.py` + `backend/migration_path.py`, delete `backend/requirements.txt`,
   switch `dev/runall.sh` and `backend/Dockerfile` to `pip install -e .`. Verify the app boots and
   migrations run with discovery logic *unchanged* (core still imported directly / hardcoded). This
   isolates "is it installable and does everything still work" from any discovery change.
2. **Phase 2** — flip `env.py`, `yf-migrate`, and `yf-makemigrations` to
   entry-point-only discovery and remove the bare-`except` blocks. Verify: a fresh DB migrates to
   head (core + billing branches), `yf-makemigrations billing "…"` still targets the billing
   branch, and a deliberately broken plugin entry point now raises instead of being swallowed.

Each phase is independently testable and independently revertible.

## Open Questions / Risks

- **Docker layer caching.** Moving deps into `setup.py` + editable install means backend source
  changes bust the dependency-install layer (the old `COPY requirements.txt` step cached deps
  separately). Acceptable for correctness/single-source-of-truth; if CI build time regresses
  noticeably, a thin constraints file copied first purely as a cache key is a possible later
  mitigation — not done now, since the user chose deps-in-`setup.py`.
- **Entry-point reinstall discipline.** Editing `setup.py`'s `entry_points` requires re-running
  `pip install -e .` for the change to be visible (metadata, not source, drives discovery). Source
  `.py` edits do not. Worth a one-line note in `docs/development.md` when this lands.
- **`register_models` vs `nagelfluh.models` redundancy.** Phase 2.1 keeps both paths. Consolidating
  them is a pre-existing, plugin-facing decision and is intentionally not part of this plan.
- **`python_requires`.** Pinned to `>=3.11` to match the runtime image; dev machines using an older
  system `python3` for the venv would need to be on 3.11+. Confirm no dev is on <3.11 before merging,
  or relax to `>=3.9` (billing's floor).
```
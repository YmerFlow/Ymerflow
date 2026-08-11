# Plugin Migration Directories

## Goal

Allow backend plugins to ship their own Alembic migrations inside their Python package,
discovered automatically — matching the Django app-migrations model. No manual registration in the
host repo; installing a plugin is enough.

---

## Background & Constraints

- **Never drop data on uninstall.** Plugin migrations must only ever add schema. Dropping
  tables/columns on plugin removal is explicitly forbidden. Downgrade migrations may be written but
  must not be run automatically.
- **Works installed or editable.** Discovery uses `importlib.metadata` entry points, which work for
  both `pip install -e .` and wheel-installed packages.
- **`alembic upgrade heads` is the migration command.** Singular `head` is wrong with multiple
  branches and should be replaced by a wrapper.

### Pre-existing complication

`user_transactions` and the `transactiontype` enum were created in `59e0619beed9` (the initial
schema), before the plugin system existed. These tables are billing-flavoured but they live in the
core schema. Moving them out of the initial schema is **out of scope** for this plan; billing branch
migrations simply extend them.

---

## Design

### Django analogy

| Django | This system |
|---|---|
| Each app's `migrations/` directory | Each plugin's `migrations/versions/` directory |
| `INSTALLED_APPS` discovery | `nagelfluh.migration_dirs` entry point group |
| `(app_label, name)` identity | Alembic branch label + revision ID |
| `manage.py migrate` | `yf-migrate` wrapper → `alembic upgrade heads` |
| `manage.py makemigrations billing` | `yf-makemigrations billing` wrapper |

### Entry point conventions (two groups)

```
[project.entry-points."nagelfluh.migration_dirs"]
billing = "billing.migrations:path"
#          ↑ module            ↑ attribute — a pathlib.Path to the versions/ directory

[project.entry-points."nagelfluh.models"]
billing = "billing.models"
#          ↑ module to import so its SQLAlchemy models appear in Base.metadata for autogenerate
```

### Dynamic `env.py`

`backend/alembic/env.py` discovers both groups at runtime:

1. Import all `nagelfluh.models` modules → populates `Base.metadata`.
2. Collect all `nagelfluh.migration_dirs` paths → build `version_locations` list
   (main `versions/` dir + one entry per plugin).
3. Pass `version_locations` to `context.configure()` in both online and offline modes.
4. Label the main branch as `main` in `alembic.ini` and/or via `script.py.mako`.

### Wrapper commands

Two thin shell scripts (or a `nagelfluh.cli` entry point) in `backend/bin/`:

**`yf-migrate`**
```bash
#!/bin/bash
alembic -c backend/alembic.ini upgrade heads
```

**`yf-makemigrations`**
```bash
#!/bin/bash
# Usage: yf-makemigrations <plugin_name> "migration message"
PLUGIN=$1
MSG=$2
# Resolve version path from entry point
VPATH=$(python -c "
import importlib.metadata
eps = importlib.metadata.entry_points(group='nagelfluh.migration_dirs')
ep = next(e for e in eps if e.name == '$PLUGIN')
print(ep.load())
")
alembic -c backend/alembic.ini revision --autogenerate \
  --head="${PLUGIN}@head" \
  --version-path="$VPATH" \
  -m "$MSG"
```

---

## Migration Chain After Cleanup

### Current main chain (relevant section)

```
... → 7a1b2c3d4e5f (update_default_workspace_layout)
    → a1b2c3d4e5f6 (fix_transactiontype_enum_values)   ← BILLING
    → c1d2e3f4a5b6 (project_membership)
    → d2e3f4a5b6c7 (api_keys)
    → e1f2a3b4c5d6 (add_storage_status)
    → f3a4b5c6d7e8 (add_storage_credentials)
    → a5b6c7d8e9f0 (add_process_tags)
    → b7c8d9e0f1a2 (add_flow_position_to_processes)
    → c2d3e4f5a6b7 (billing_and_is_admin)               ← MIXED
    → d3e4f5a6b7c8 (add_plugin_tables)
    → e2f3a4b5c6d7 (seed_initial_admin)
    → f4b5c6d7e8a9 (billing_plan_tables)                ← BILLING
    → a9b0c1d2e3f4 (extend_user_transactions)            ← BILLING
    → g5c6d7e8f9a0 (add_billing_invites)                ← BILLING
```

### Target: two independent heads

**Main chain** (unchanged except trimming `c2d3e4f5a6b7` and removing `a1b2c3d4e5f6`):

```
... → 7a1b2c3d4e5f
    → c1d2e3f4a5b6   (down_revision changed: was a1b2c3d4e5f6, now 7a1b2c3d4e5f)
    → d2e3f4a5b6c7
    → e1f2a3b4c5d6
    → f3a4b5c6d7e8
    → a5b6c7d8e9f0
    → b7c8d9e0f1a2
    → c2d3e4f5a6b7   (trimmed: only is_admin + drop cost cols; no user_balances)
    → d3e4f5a6b7c8
    → e2f3a4b5c6d7   ← MAIN HEAD
```

**Billing branch** (in `plugins/billing/billing/migrations/versions/`):

```
[billing root]          down_revision=None, branch_labels=('billing',), depends_on=('b7c8d9e0f1a2',)
    → f4b5c6d7e8a9     down_revision=[billing root rev id], branch_labels=None, depends_on=None
    → a9b0c1d2e3f4     down_revision=f4b5c6d7e8a9
    → g5c6d7e8f9a0     down_revision=a9b0c1d2e3f4     ← BILLING HEAD
```

`alembic heads` shows exactly two entries. `yf-migrate` runs `upgrade heads` to advance both.

### What goes in the billing root migration

Content drawn from two existing migrations (now removed from main):
- From `a1b2c3d4e5f6`: fix `transactiontype` enum values in `user_transactions`
- From `c2d3e4f5a6b7`: create `user_balances` table, migrate `users.balance` data, drop `users.balance`

`depends_on = ('b7c8d9e0f1a2',)` ensures the main chain is at least at `b7c8d9e0f1a2` (after flow
position was added) before any billing migration runs. Since `user_transactions` was created in the
initial schema, the billing root does not need to create it.

### What stays in `c2d3e4f5a6b7` (trimmed, in main chain)

- Add `is_admin` column to `users` (core feature; not billing-specific)
- Drop `process_versions.max_reserved_cost` and `process_versions.actual_cost` (core cleanup)
- Remove the `user_balances` creation, balance data migration, and `users.balance` drop

---

## Implementation Tasks

### Phase 1 — Framework

**1.1 Modify `backend/alembic/env.py`**
- Discover `nagelfluh.models` entry points; import each module before any autogenerate step.
- Discover `nagelfluh.migration_dirs` entry points; collect paths.
- Build `version_locations` = `[main_versions_dir] + [str(p) for p in plugin_paths]`.
- Pass `version_locations=version_locations` to `context.configure()` in both
  `run_migrations_offline()` and `run_migrations_online()`.
- Wrap entry-point discovery in a try/except so a broken plugin doesn't prevent migrations from
  running.

**1.2 Update `backend/alembic.ini`**
- Add `version_locations = backend/alembic/versions` as the base (plugins add to it dynamically).
- Optionally label the main branch: add `[post_write_hooks]` or set `branch_labels = main` on the
  next new main-chain migration.

**1.3 Add wrapper scripts**
- Create `backend/bin/yf-migrate` (see Design section).
- Create `backend/bin/yf-makemigrations` (see Design section).
- Make both executable (`chmod +x`).
- Update `backend/requirements.txt` if a CLI entry point is preferred over shell scripts.
- Update deployment docs to use `yf-migrate` instead of `alembic upgrade head`.

---

### Phase 2 — Billing plugin scaffold

**2.1 Create migration package inside billing plugin**

```
plugins/billing/billing/migrations/__init__.py
plugins/billing/billing/migrations/versions/   (empty dir, will hold migration files)
```

`__init__.py` content:
```python
from pathlib import Path
path = Path(__file__).parent / "versions"
```

**2.2 Register entry points in `plugins/billing/setup.py`**

Add to `entry_points`:
```python
'nagelfluh.migration_dirs': [
    'billing = billing.migrations:path',
],
'nagelfluh.models': [
    'billing = billing.models',
],
```

**2.3 Reinstall billing plugin** so entry points are discovered:
```bash
pip install -e plugins/billing/
```

---

### Phase 3 — Billing migration cleanup

**3.1 Trim `c2d3e4f5a6b7_billing_and_is_admin.py`** (stays in `backend/alembic/versions/`)

Remove from `upgrade()`:
- The `user_balances` table creation
- The `INSERT INTO user_balances ...` data migration
- The `op.drop_column('users', 'balance')` call

Remove from `downgrade()`:
- The `op.add_column('users', ...)` for balance
- The `UPDATE users SET balance = ...` copy-back
- The `op.drop_table('user_balances')`

Keep: `is_admin` add/remove, and the two `process_versions` column drops (with their try/except).

**3.2 Remove `a1b2c3d4e5f6` from the main chain**

Edit `c1d2e3f4a5b6_project_membership.py`:
```python
down_revision = '7a1b2c3d4e5f'   # was: 'a1b2c3d4e5f6'
```

Delete `backend/alembic/versions/a1b2c3d4e5f6_fix_transactiontype_enum_values.py`.

**3.3 Create billing root migration**
in `plugins/billing/billing/migrations/versions/a1b2c3d4e5f6_initial_billing.py`
(reuse the old revision ID to keep history traceable, or pick a new one — implementer's call)

```python
revision = 'a1b2c3d4e5f6'        # or a new ID
down_revision = None
branch_labels = ('billing',)
depends_on = ('b7c8d9e0f1a2',)
```

`upgrade()` combines:
- Fix `transactiontype` enum values (from the deleted `a1b2c3d4e5f6`)
- Create `user_balances` table (from the trimmed `c2d3e4f5a6b7`)
- Migrate `users.balance` → `user_balances`
- Drop `users.balance`

`downgrade()` reverses the above (in order).

**3.4 Move remaining billing migrations** to `plugins/billing/billing/migrations/versions/`

Files to move: `f4b5c6d7e8a9_billing_plan_tables.py`, `a9b0c1d2e3f4_extend_user_transactions.py`,
`g5c6d7e8f9a0_add_billing_invites.py`.

Edit `f4b5c6d7e8a9_billing_plan_tables.py`:
```python
down_revision = 'a1b2c3d4e5f6'   # was: 'e2f3a4b5c6d7' (main chain); now follows billing root
branch_labels = None
depends_on = None
```

`a9b0c1d2e3f4` and `g5c6d7e8f9a0` need no changes to their `down_revision` (they already chain
within the billing sequence). Delete these three files from `backend/alembic/versions/`.

**3.5 Verify**

```bash
alembic -c backend/alembic.ini heads
# Expected output: two lines — main head (e2f3a4b5c6d7) and billing head (g5c6d7e8f9a0)

alembic -c backend/alembic.ini history --verbose
# Should show two separate branch trees

yf-migrate   # dry-run with --sql to inspect; then run for real
```

---

### Phase 4 — Documentation

**4.1 Update `plugins/billing/CLAUDE.md`**

Add a "Database Migrations" section:
- How to run `yf-makemigrations billing "description"` to autogenerate
- How to run `yf-migrate` to apply
- Rule: never write a migration that drops tables or columns
- Where migration files live (`billing/migrations/versions/`)

**4.2 Update plugin SDK `CLAUDE.md`**

Add a "Database Migrations" section covering:
- The two entry point groups and what they do
- Plugin package structure (`migrations/__init__.py` with `path`, `versions/`)
- How to write the first migration (branch root pattern with `down_revision=None`,
  `branch_labels=('<plugin_name>',)`, `depends_on=('<last_safe_main_revision>',)`)
- How subsequent migrations chain normally within the branch
- `yf-makemigrations <plugin> "message"` for autogenerate
- `yf-migrate` for applying all branches
- **Hard rule**: migrations may never drop tables or columns — uninstalling a plugin must leave the
  schema untouched
- Cross-branch `depends_on`: when and how to use it (e.g., billing root depends on the main chain
  reaching a stable point before billing tables are added)
- Note that `alembic upgrade head` (singular) is wrong in a multi-branch setup — always use
  `yf-migrate`

**4.3 Update deployment docs**

Replace all occurrences of `alembic upgrade head` with `yf-migrate` in
`docs/deployment.md` and `docs/development.md`.

---

## Non-goals

- Moving `user_transactions` or `transactiontype` enum out of the initial schema.
- Running plugin downgrade migrations automatically (never drops data).
- Frontend migration support (not applicable).

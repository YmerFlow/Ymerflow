# Great Rename — Backend Local/Internal Default Strings

## Goal

Rename the backend default-value strings that are **internal implementation details** with no
tie to already-provisioned cloud resources: the local SQLite filename, the plugin npm source
directory path, the default outgoing-email domain, and an internal content-type string. These are
lower-risk than `great-rename-5-k8s-cloud-infra.md` (nothing here names a resource that already
exists in a live cluster or cloud project) but aren't zero-risk either — the SQLite filename in
particular is a real file on disk for anyone currently running the backend locally.

Explicitly **not** in this plan (moved to `great-rename-5-k8s-cloud-infra.md` because they name or
gate access to resources that may already be provisioned for real):
default container-registry username/password (`backend/run.sh`, `backend/bin/yf-deploy-app`, the
`50dd9ce3311b_add_registry_backends_table.py` seed migration), and `storage_bucket_prefix`
(`backend/config.py:22`) — confirmed live via `config.env.gcp`'s `STORAGE_CONFIG_JSON` already
overriding it with real GCS bucket-prefix `"nagelfluh-"`.

## Background — current state

- **SQLite DB filename**, default `sqlite:///./nagelfluh.db`:
  - `backend/config.py:13` — `database_url: str = "sqlite:///./nagelfluh.db"` (the
    `Settings` default used when `DATABASE_URL` isn't set in the environment)
  - `backend/cli.py:31` — a second, independent default:
    `os.getenv("DATABASE_URL", "sqlite:///./nagelfluh.db")`
  - `backend/bin/yf-build-and-push:51` — `os.getenv('DATABASE_URL',
    'sqlite:///./nagelfluh.db').replace(...)` (derives something from the DB URL; read the
    surrounding code during implementation to confirm what)
  - `backend/test_log_manager_integration.py:92` — a comment/help string only:
    `print("  Run: sqlite3 backend/nagelfluh.db ...")`
  - This filename is only ever reached when `DATABASE_URL` is unset — i.e., local dev without a
    configured Postgres. Any developer currently running that way has a real `nagelfluh.db` file
    on disk; renaming the default doesn't move their data, it just means the *next* unconfigured
    run creates a fresh, empty `ymerflow.db` next to the old one.
- **Plugin npm source directory**, `backend/config.py:87`:
  `plugin_npm_source_dir: str = "/var/lib/nagelfluh/plugin-npm-source"`. A local filesystem path
  used when serving plugin frontend assets from source during development
  (`backend/plugin_assets.py` territory). Referenced in comments in `config.env.example:145` /
  `config.env.gcp:145` / `config.env.local:147` / `config.env.mixed:136` as the commented-out
  `# PLUGIN_NPM_SOURCE_DIR=/var/lib/nagelfluh/plugin-npm-source` example value.
- **Default outgoing email domain**, `backend/config.py:67`:
  `smtp_from_email: str = "noreply@nagelfluh.example.com"`. An `.example.com` placeholder,
  overridden by real config wherever email actually needs to send — pure cosmetic default.
- **Custom content-type string**, `backend/routers/datasets.py:83`: docstring/code reference to
  `"application/vnd.nagelfluh.stats+json"`, a vendor MIME type this backend itself both produces
  and is the only consumer of (confirmed: not a value ever persisted to a database row — it's
  constructed per-request as a response `Content-Type` header, so renaming it has no stored-data
  compatibility concern the way `great-rename-4-process-type-identifiers.md`'s process-type key
  does). Any external client that has hard-coded a check against this exact string would need to
  update too, but none is known to exist outside this codebase.

## Design decisions

- **SQLite filename**: rename the default to `sqlite:///./ymerflow.db` in all three code sites
  (`config.py`, `cli.py`, `yf-build-and-push`) and update the help text in
  `test_log_manager_integration.py`. Old `nagelfluh.db` files are left in place, untouched — not
  deleted, not migrated, not symlinked. Anyone relying on local-dev SQLite should rename or
  recreate their own file after pulling this change (call out in the PR description, not handled
  by code).
- **Plugin npm source dir / email domain / MIME type**: straight string rename, no compatibility
  shim needed for any of the three — all are either pure local dev-machine paths, cosmetic
  placeholder domains, or self-contained backend-internal protocol strings.

## Implementation Steps

1. Rename the SQLite default in `backend/config.py:13`, `backend/cli.py:31`, and
   `backend/bin/yf-build-and-push:51`; update the comment in
   `backend/test_log_manager_integration.py:92`. Grep `nagelfluh\.db` afterward to confirm no
   other default string was missed.
2. Rename `plugin_npm_source_dir`'s default in `backend/config.py:87` and the four
   `config.env.*` comment lines that show it as an example value.
3. Rename `smtp_from_email`'s default domain in `backend/config.py:67`.
4. Rename the MIME type string in `backend/routers/datasets.py:83`.
5. Restart the local backend (already auto-reloading per `CLAUDE.md` — no manual restart needed,
   just confirm no startup error) and, if running against SQLite locally, manually rename your
   own `backend/nagelfluh.db` → `backend/ymerflow.db` (or delete it and let the app recreate an
   empty one) so `DATABASE_URL`-unset local runs keep working against real data instead of
   silently starting from empty.

## Resolved decisions (settled 2026-08-12)

- **Leave old local files in place, don't auto-migrate** — confirmed. Consistent with the wider
  "no data migration, redeploy from scratch" strategy (`great-rename-5-k8s-cloud-infra.md`): the
  local-dev SQLite filename is a dev-machine concern, and each developer renames/recreates their
  own `nagelfluh.db` after pulling. No code handles it.

## Open Questions

- [ ] None outstanding.

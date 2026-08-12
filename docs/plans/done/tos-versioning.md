# Terms of Service versioning and re-agreement

## Goal

Move the Terms of Service from a static file into the database, versioned. Admins create new
versions from a new Admin tab. Every user's most-recent agreed version is recorded. At signup, the
user must agree to the current version before the account is created (as today, just DB-backed
instead of file-backed). At login, if the current version is newer than what the user last agreed
to, they're shown a blocking "please agree" modal before being let into the app; agreeing records
that acceptance. Nothing outside the signup/login flows is gated — a user who never logs in again
simply never gets asked again.

## Background & Current State

### Existing (unversioned) ToS-at-signup flow

This whole feature already exists in a simpler, non-versioned form, added by
`docs/plans/done/tos-signup-modal.md`. Its own "Out of scope" section explicitly deferred exactly
what this plan builds:

> Persisting acceptance (who/when/what version) — separate future plan.
> Re-prompting existing users or on ToS text changes.

Current pieces:
- `backend/config.py:49-53` — `tos_file: Optional[str] = None` (`TOS_FILE` in `config.env`).
- `backend/routers/auth.py:91-105` — `GET /auth/tos`, public, reads `settings.tos_file` fresh off
  disk on every request, returns `{"text": ...}` or `{"text": null}` if unset.
- `frontend/src/datamodel/api.js:158-161` / `useAuthQueries.js:38-43` — `getTos()` / `useTos()`.
- `frontend/src/LandingPage.jsx` — `SignInCard`: `useTos()` (line 59), `handleSignUp` (line 86)
  opens a blocking `Modal` (line 221, `backdrop="static"`, plain `whiteSpace: 'pre-wrap'` text, no
  Markdown) instead of signing up directly whenever `tos?.text` is set; `handleAgreeTos` (line 95)
  closes the modal and fires the signup mutation. Login (`handleSignIn`, line 61) is completely
  untouched by ToS today.
- `docs/tos.md` — placeholder sample text shipped so the feature works out of the box in dev.

No DB column, no migration, nothing versioned. This plan supersedes that mechanism rather than
adding a second, parallel one (see Design Decision 5).

### Auth model

- Stateless JWT, no server sessions/cookies (`backend/services/auth_service.py`). `get_current_user`
  decodes the bearer token's `sub` (username) and loads the `User` row; there's also an API-key
  (`apk_`) and upload-token (`upt_`) path through the same dependency, used by automation/uploads
  with no UI to show a modal in.
- `User` model — `backend/models/user.py:9-18`: `id`, `username`, `email`, `password_hash`,
  `is_admin`, `preferences` (JSON), `created_at`. `to_dict()` (lines 24-35) is what's returned to
  the frontend on login/signup/account fetch, and fans out through `hooks.run.user_to_dict(self)`
  for plugin-contributed fields — but it's a **sync** method with no DB session, so it can't itself
  join to a versions/acceptances table; any "does this user need to re-agree" computation has to
  happen in the request handler, not inside `to_dict()`.
- `is_admin` boolean + `require_admin` dependency (`backend/auth_deps.py`) is the only
  authorization primitive — no roles system. Used throughout `backend/routers/admin.py` and the
  `/auth/admin/*` routes in `backend/routers/auth.py:380-416`.
- Signup: `POST /auth/signup` (`backend/routers/auth.py:27-88`) creates the `User` row, then
  `create_access_token`, returns `{access_token, token_type, user}`.
- Login: `POST /auth/login` (lines 108-139) verifies the password, `create_access_token`, returns
  the same shape.

### Frontend session handling

- `frontend/src/AuthContext.jsx` — plain context; `login(userData, authToken)` sets state, persists
  to `localStorage`, and sets a one-shot `justAuthenticatedRef` (`consumeJustAuthenticated()`)
  consumed by things like the billing plugin's `ContractGuard` to distinguish "just logged in" from
  "restored an existing session from localStorage on page load."
- **This plan does not need that mechanism.** Per the confirmed design decision below, the
  re-agreement check only ever happens synchronously inside the login/signup handlers in
  `SignInCard` itself — never on page load/session-restore — so there's no risk of it firing on a
  refresh regardless of whether `consumeJustAuthenticated` is involved.

### Admin tab pattern

- `frontend/src/AdminPage.jsx:54-91` — `builtinTabs` array (`users`, `clusters`, `storage`), each
  `{ key, title, render }`, passed to the generic `TabbedPage` (`frontend/src/TabbedPage.jsx`). A
  new tab is one more array entry.
- `frontend/src/StorageBackendsAdminPanel.jsx` is the best template for a new admin CRUD panel:
  list view + a `Modal` form for create, TanStack Query hooks for list/create/update, no
  delete/edit-in-place for anything that should stay an immutable record.

### Versioned-content precedent

- `backend/models/workspace.py:9-65` — `Workspace` (parent) + `WorkspaceVersion` (immutable,
  numbered child rows, `UniqueConstraint(workspace_id, version)`, `created_by`/`created_at`). This
  is the shape to copy for `TosVersion`, minus the parent table — there's only ever one global ToS
  "document," so version rows don't need a separate parent, just a flat numbered sequence.
- `backend/alembic/versions/af672e56b096_workspace_versioning_and_sharing.py` is the migration
  template (add table, `UniqueConstraint`, FK to `users`).

## Design Decisions (confirmed with user)

1. **Acceptance storage: full history, not just "latest version" columns on `users`.** A separate
   `user_tos_acceptances` table records every `(user, version, accepted_at)`, not just two columns
   holding the latest. Chosen over the simpler two-column approach for audit defensibility — if a
   ToS dispute ever comes up, there's a full record of exactly when each user agreed to exactly
   which version's text, not just their most recent state.
2. **Enforcement: frontend-only, and only inside the explicit login/signup handlers.** No
   `require_tos_accepted` dependency, no gating of any other route. The check ("does the current
   user's latest acceptance cover the current ToS version?") runs once, synchronously, as part of
   the `POST /auth/login` / `POST /auth/signup` request/response cycle, and the modal is driven
   directly off that response inside `SignInCard`. A long-lived session that never calls `login()`
   again (token still valid, tab left open, or restored from `localStorage` on refresh) is never
   interrupted, even across a ToS update — this is deliberate, not an oversight: re-agreement is
   purely a login/signup-time event, not an app-wide persistent gate.
3. **No admin exemption.** Admins must agree to new ToS versions like anyone else, including the
   admin who authored the version. (Contrast with the billing plugin's `ContractGuard`, which does
   exempt admins from its own gate — that's a paywall exemption, not applicable here.)
4. **No grandfathering.** Every user — including all pre-existing accounts — starts with zero
   acceptance rows. Nobody is auto-imported into having "already agreed" to anything. Concretely:
   right after this ships, `GET /auth/tos` returns "no version yet" (see Decision 5) until an admin
   creates the first version, and only from that point does anyone see a modal at all.
5. **Repurpose `GET /auth/tos` and drop `TOS_FILE` entirely.**
   Rather than running two parallel ToS mechanisms, `GET /auth/tos` starts serving the latest
   *database* version (`{version, body}`) instead of reading `settings.tos_file` off disk.
   `tos_file`/`TOS_FILE` become obsolete and are removed. **The migration itself seeds version 1**,
   using the current `docs/tos.md` placeholder text verbatim (see Migration below) — so there is
   always at least one version in the DB from the moment this ships, rather than requiring a manual
   admin step first. `docs/tos.md` is then deleted as a standalone file; its content lives on as the
   seeded row's text (and from there is just an ordinary, admin-editable-via-new-version row like any
   other). If an operator had a real, custom `TOS_FILE` configured, they still need to manually
   create a new version with their own text after upgrading (the seed only guarantees "not empty,"
   it doesn't know about any deployment-specific file) — this is unavoidable since `TOS_FILE`'s
   whole point was being a filesystem path, and a migration can't discover an arbitrary
   deployment's path at authoring time.
6. **Render ToS body as Markdown, not plain `pre-wrap` text.**
   `markdown-to-jsx` is already a dependency and already used for `hosted_version_text`
   (`LandingPage.jsx:255`); using it for the (now admin-authored, possibly multi-section) ToS body
   in both the signup and re-agreement modals is strictly better than today's plain-text rendering.
7. **Versions are immutable.** Once created, a `TosVersion` is never edited or deleted — matches the
   "create new versions" language in the request, and is required for Decision 1's audit trail to
   mean anything (editing version 3's text after the fact would invalidate every acceptance record
   referencing it).

## Data Model

New file `backend/models/tos.py`:

```python
class TosVersion(Base):
    __tablename__ = "tos_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(Integer, nullable=False, unique=True, index=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    def to_dict(self):
        return {
            "version": self.version,
            "body": self.body,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
        }


class UserTosAcceptance(Base):
    __tablename__ = "user_tos_acceptances"
    __table_args__ = (UniqueConstraint("user_id", "tos_version_id"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    tos_version_id = Column(Integer, ForeignKey("tos_versions.id", ondelete="CASCADE"), nullable=False, index=True)
    accepted_at = Column(DateTime, default=datetime.utcnow, nullable=False)
```

`version` is assigned server-side as `(max existing version) + 1` when an admin creates a new one —
never client-supplied — so there's no possibility of a version-number collision.

Register both in `backend/models/__init__.py` (alongside the existing `Workspace`/`WorkspaceVersion`
import) so Alembic's `env.py` autogenerate sees them.

### Migration

New revision under `backend/alembic/versions/`, chained off the current head
(`f6a7b8c9d0e1_seed_default_cluster.py` is the current tail — verify with `alembic -c
backend/alembic.ini heads` at implementation time since other work may land first). Generate the
id with `python3 -c "import uuid; print(uuid.uuid4().hex[:12])"` per CLAUDE.md rule 9 and verify
uniqueness with `grep -rn "revision = '<id>'" --include=*.py .` before committing — do not hand-write
one.

`upgrade()`:
1. `op.create_table(...)` for `tos_versions` and `user_tos_acceptances` (no backfill of
   `user_tos_acceptances` — it starts genuinely empty, consistent with Decision 4's "no
   grandfathering").
2. Seed exactly one `tos_versions` row (`version=1`, `created_by=NULL`) via raw
   `sa.table()`/`op.execute(sa.text(...))`, following the `e2f3a4b5c6d7_seed_initial_admin.py`
   pattern of doing data seeding directly in a migration. The body text is the current
   `docs/tos.md` content, copied **verbatim into the migration file as a Python string literal** —
   not read from `docs/tos.md` at migration-run time, since that file is being deleted as part of
   this same change (Decision 5) and a migration must not depend on a repo file that may not exist
   by the time it runs in some other environment/order. One small edit to the copied text: its
   closing line currently says "Replace this file's contents with your own terms, or point
   `TOS_FILE` in `config.env` at a different file" — since `TOS_FILE` is being removed, reword that
   sentence in the seeded copy to point at the new admin tab instead
   (e.g. "Replace this text with your own terms using the Admin → Terms of Service tab.").

`downgrade()` drops both tables (the seed row goes with `tos_versions`, no separate cleanup needed).

## Backend Changes

### `backend/models/tos.py` (new), `backend/models/__init__.py` (register)

As above.

### `backend/routers/auth.py`

- **`GET /auth/tos`** (existing route, repurposed): query the max-`version` `TosVersion` row;
  return `{"version": v.version, "body": v.body}` or `{"version": None, "body": None}` if none
  exists. Still public/unauthenticated (needed before signup).
- **`POST /auth/signup`**: request body gains `agreed_tos_version: Optional[int]`. If a
  `TosVersion` currently exists, require `agreed_tos_version == latest.version` (400 otherwise —
  guards against stale text if an admin publishes a new version mid-signup); if it matches, create
  a `UserTosAcceptance` row for the new user in the same transaction as the `User` row. If no
  `TosVersion` exists at all, `agreed_tos_version` is ignored (mirrors today's "unset ⇒ unaffected"
  behavior from `tos-signup-modal.md` Decision 5).
- **`POST /auth/login`**: after verifying credentials, compute the user's latest accepted version
  (`SELECT MAX(tos_versions.version) JOIN user_tos_acceptances WHERE user_id = ...`) and compare to
  the global latest. Add `"tos_pending": {"version": v, "body": b}` to the response when the user's
  acceptance is behind (including "never accepted anything" when a `TosVersion` exists), else
  `"tos_pending": null`. This is the one new bit of response shape — deliberately not folded into
  `user.to_dict()`, since that method has no DB session to compute it (see Background above).
- **`POST /auth/tos/accept`** (new, authenticated via `get_current_user`, not admin-only): body
  `{"version": int}`; look up that `TosVersion`, create the `UserTosAcceptance` row for
  `auth.user.id` (swallow/ignore the `UniqueConstraint` violation if already recorded — same
  `IntegrityError` pattern as `update_email`, not a silent `except: pass`, an explicit
  already-accepted no-op response). 404 if the version doesn't exist.

### New admin routes (`backend/routers/auth.py` "Admin endpoints" section, or a new
`backend/routers/admin_tos.py` mounted alongside — match whichever `backend/routers/admin.py`
convention is live at implementation time)

- **`GET /admin/tos-versions`** (`require_admin`): list all `TosVersion` rows, newest first, each
  with `created_by` resolved to a username for display.
- **`POST /admin/tos-versions`** (`require_admin`): body `{"body": str}`; creates a new `TosVersion`
  with `version = (current max or 0) + 1`, `created_by = auth.user.id`.

### `backend/config.py`

Remove `tos_file` and its doc comment (lines 49-53). Remove the corresponding `TOS_FILE` line (if
present) from `config.env.example`.

### `docs/tos.md`

Delete the file once its content has been copied into the seed migration (see Migration above) —
there's no longer a file-based fallback for it to serve.

## Frontend Changes

### `frontend/src/datamodel/api.js`

- `getTos()` — unchanged call site, response shape changes (`{version, body}`).
- `signup(username, password, email, agreedTosVersion)` — add `agreed_tos_version` to the POST body
  when provided.
- New `acceptTos(version)` → `POST /auth/tos/accept`.
- New `listAdminTosVersions()` / `createAdminTosVersion(body)` → `GET`/`POST /admin/tos-versions`.

### `frontend/src/datamodel/useAuthQueries.js`

- `useTos()` — unchanged shape, same `['tos']` query key.
- New `useAcceptTos()` — plain mutation, no cache to invalidate (nothing else reads acceptance
  state client-side).
- New `useAdminTosVersions()` / `useCreateAdminTosVersion()` — same list+create+invalidate pattern
  as `useAdminStorageBackends`/`useCreateAdminStorageBackend` (`useAuthQueries.js:154-167`).

### `frontend/src/LandingPage.jsx` — `SignInCard`

- Signup path: swap the existing modal's `whiteSpace: 'pre-wrap'` body text for
  `<Markdown>{tos?.body}</Markdown>` (Decision 6); `doSignup()` passes `tos?.version` through as
  `agreedTosVersion` to the signup mutation. `tos?.text` checks become `tos?.body`.
- Login path (new): `handleSignIn`, after `loginMutation.mutateAsync` resolves and
  `setAuthToken(result.access_token)` runs (today's line 67, unchanged — this already happens
  before `authLogin`), branch on `result.tos_pending`:
  - **Absent** → call `authLogin(result.user, result.access_token)` exactly as today.
  - **Present** → hold `{user, access_token, tos_pending}` in local state, show a new blocking
    `Modal` (`backdrop="static"`, no header close button, body via `<Markdown>`) with a single "I
    Agree" action (no "Cancel and continue" — agreeing is mandatory to proceed). A "Cancel"/"Not
    now" button, if present, aborts the login instead of dismissing the requirement:
    `setAuthToken(null)` and stay on the sign-in form, i.e. it does **not** call `authLogin`.
    "I Agree" calls `acceptTosMutation.mutateAsync({ version: tos_pending.version })` (the token is
    already set on `apiClient` from the earlier `setAuthToken` call, so this is authenticated) then
    `authLogin(user, access_token)`.

### `frontend/src/AdminPage.jsx`

Add a fourth `builtinTabs` entry: `{ key: 'tos', title: 'Terms of Service', render: () =>
<TosAdminPanel /> }`.

### `frontend/src/TosAdminPanel.jsx` (new)

Modeled directly on `StorageBackendsAdminPanel.jsx`: a table of existing versions (version number,
created-by username, created-at, truncated body preview) newest first via `useAdminTosVersions()`,
and a "Create New Version" button opening a `Modal` with a `Form.Control as="textarea"` for the
body (plus a live `<Markdown>` preview alongside, mirroring the write-then-preview UX the body text
deserves) submitting via `useCreateAdminTosVersion()`. No edit/delete actions (Decision 7).

## Rollout / Compatibility

- On deploy, the migration seeds `tos_versions` version 1 with the (lightly reworded, see Migration
  above) `docs/tos.md` text; `user_tos_acceptances` starts empty. `GET /auth/tos` immediately
  returns that version 1 — there's no "no ToS configured" state anymore, unlike today's
  `TOS_FILE`-unset behavior.
- Because of Decision 4 (no grandfathering), **every existing user** — not just new signups — has
  zero acceptance rows, so every existing user is shown the re-agreement modal on their very next
  login after this ships, even though the seeded text is just the generic placeholder. This is a
  direct, expected consequence of "always at least one version" + "no grandfathering" together —
  flagging it here since it's a visible behavior change on rollout day, not a bug.
- If the deployment previously had `TOS_FILE` configured with real, custom ToS text, that text is
  **not** carried over automatically (the seed only knows about `docs/tos.md`, not an arbitrary
  deployment's file path) — an admin should replace version 1 with a real version 2 via the new
  admin tab, ideally before or shortly after deploying, so users agree to the real terms rather than
  the placeholder.
- `TOS_FILE`/`tos_file` stop being read anywhere; remove the `config.env` entry if present in any
  deployed `config.env` (not `config.env.example` — that's tracked in the repo and updated as part
  of this change; live deployment `config.env` files are the operator's to edit).

## Implementation Steps (PR-sized)

1. **Backend models + migration**: `backend/models/tos.py`, registration, Alembic revision
   (including the version-1 seed copied from `docs/tos.md`), delete `docs/tos.md`.
2. **Backend endpoints**: repurpose `GET /auth/tos`, add `POST /auth/tos/accept`, extend
   `signup`/`login`, add the two `/admin/tos-versions` routes. Remove `settings.tos_file` and
   `docs/tos.md`.
3. **Admin UI**: `TosAdminPanel.jsx` + `AdminPage.jsx` tab, `api.js`/`useAuthQueries.js` additions
   for the admin CRUD pair.
4. **Signup modal migration**: switch `SignInCard`'s existing modal from file-backed `tos.text` to
   DB-backed `tos.body` + Markdown + `agreedTosVersion` plumbing.
5. **Login re-agreement modal**: new blocking modal + `acceptTos` wiring in `SignInCard`.

## Verification

- Fresh DB after migration: `tos_versions` has exactly one row (`version=1`, the seeded
  `docs/tos.md` text); `GET /auth/tos` returns it. Signup shows the (now Markdown-rendered) ToS and
  records `agreed_tos_version=1`; a pre-existing user's next login shows the re-agreement modal
  (since they have zero acceptances), and after agreeing, a second login does **not** show it again.
- Admin creates version 2: a user who already accepted version 1 sees the modal again on next
  login; a brand new signup goes straight to version 2 with no extra prompt.
- An already-logged-in session (token still valid, page refreshed, no explicit login) is never
  interrupted by a new version appearing — confirms Decision 2's "login/signup-time only" scope.
- Admin login is gated identically to a non-admin's (Decision 3) — verify by having an admin account
  with a stale acceptance log in and see the same modal.
- API-key (`apk_`) and upload-token (`upt_`) authenticated requests are completely unaffected (no
  route outside `/auth/login`, `/auth/signup`, `/auth/tos`, `/auth/tos/accept` even looks at
  acceptance state).

## Open Questions

None — all design decisions above are confirmed.

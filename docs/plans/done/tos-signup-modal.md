# Terms of Service acceptance modal on signup

## Goal

Before a new account is actually created, show the user a blocking modal containing the Terms of
Service text. They must click "I Agree" for the signup request to be sent; closing/cancelling the
modal aborts signup and returns them to the form. The ToS text itself is configured via
`config.env` so operators can edit it without a code change.

## Design decisions (confirmed with user)

1. **ToS content source**: `config.env` holds a **file path**, not the text itself (env files are
   awkward for multi-paragraph text). New var `TOS_FILE=docs/tos.md`. The backend reads the file's
   contents at request time (no caching) so edits to the file take effect without a restart.
2. **Trigger point**: the modal appears **after the user clicks "Sign Up" on the existing form,
   before the `POST /auth/signup` request is sent**. Username/password/email stay in local
   component state; "I Agree" in the modal is what actually fires the signup mutation. This is
   different from both a post-account-creation interstitial and an inline form checkbox.
3. **Existing users**: **out of scope**. Only the signup path is gated; login is untouched, no
   retroactive prompt for accounts created before this ships.
4. **Persistence/versioning**: **none**. No DB column, no migration, no "accepted_tos_at" field,
   no hash/version tracking. This is purely a client-side gate in front of the signup call. Proper
   "who agreed to what, when" tracking is an explicitly separate, later piece of work.
5. **If `TOS_FILE` is not configured** (unset, or file missing): the signup flow behaves exactly
   as it does today — no modal, direct signup. This keeps existing/self-hosted deployments that
   haven't set up ToS text unaffected. (Flagging this as a default here rather than asking again —
   shout if you'd rather it hard-fail instead.)

## Current state

- Signup form: `frontend/src/LandingPage.jsx` — `SignInCard`'s `handleSignUp` (line 61) calls
  `signupMutation.mutateAsync(...)` directly on form submit, then logs the user in immediately.
- Signup endpoint: `backend/routers/auth.py:27-88` (`POST /auth/signup`), public, no ToS concept.
- `backend/config.py` — `pydantic_settings.BaseSettings` reading `config.env`; no file-reading
  settings exist yet, only scalars/JSON.
- Frontend uses **react-bootstrap** `Modal`. The established blocking-modal pattern (non-dismissible
  via outside click) is `frontend/src/AccountPage.jsx:412`: `<Modal show={...} onHide={...}
  backdrop="static">`. We'll use `backdrop="static"` and no header close button, but the Cancel
  button will still call `onHide` (dismissible only via explicit choice, not backdrop/escape).
- No existing precedent for exposing a `config.env` value to the frontend at runtime — this adds
  the first one, via a small public backend endpoint (mirrors the existing public
  `GET /auth/invites/{token}` pattern of an unauthenticated read-only endpoint under `/auth`).

## Implementation

### 1. `config.env` / `backend/config.py`

- Add to `config.env.example` (commented out, documenting the default-off behavior):
  ```
  # Path to a file (relative to the backend's working directory, or absolute) containing the
  # Terms of Service shown to new users before signup. If unset, no ToS modal is shown and signup
  # proceeds directly, unchanged from today's behavior.
  # TOS_FILE=docs/tos.md
  ```
- Add `tos_file: Optional[str] = None` to `Settings` in `backend/config.py` (`# TOS_FILE in config.env`).
- Add a placeholder `docs/tos.md` with sample/lorem ToS text so the feature is demonstrable
  out of the box in dev (mirrors how `config.env.example` ships working defaults elsewhere).

### 2. Backend endpoint

- New public route in `backend/routers/auth.py`, e.g. `GET /auth/tos`:
  - If `settings.tos_file` is unset → `{"text": null}`.
  - Else read the file (propagate any read error normally — no silent swallowing per project
    rule 8) and return `{"text": "<contents>"}`.
  - No auth required (needed before the user has a token).

### 3. Frontend

- `frontend/src/datamodel/useAuthQueries.js`: add `useTos()` — a TanStack Query hook (`GET
  /auth/tos`), consistent with the "always use query hooks" rule even though this isn't
  process/dataset data (it's the same axios/query-client setup as `useLogin`/`useSignup`).
- `frontend/src/LandingPage.jsx`, `SignInCard`:
  - Fetch ToS via `useTos()`.
  - Add local state `showTosModal`.
  - `handleSignUp`: `e.preventDefault()`; if `tos?.text` is present, open the modal instead of
    calling the mutation directly; if absent, call the mutation directly (today's behavior).
  - New `Modal` (react-bootstrap, `backdrop="static"`, no header close button) showing the ToS
    text (scrollable body for long text) with two buttons:
    - **I Agree** → closes modal, calls `signupMutation.mutateAsync(...)` with the already-entered
      form values, then `setAuthToken`/`authLogin` as today.
    - **Cancel** → closes modal, no request sent, user stays on the signup form.

## Out of scope (explicitly deferred)

- Persisting acceptance (who/when/what version) — separate future plan.
- Re-prompting existing users or on ToS text changes.
- Rendering ToS as Markdown/HTML (plain text in a scrollable `<pre>`-like block is enough for v1
  unless you'd rather it support Markdown now).

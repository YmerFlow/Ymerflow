# Plan: Content-aware date-serial tags for the base-runner image

## Goal

Replace the mutable `ymerflow-base-runner:bootstrap` tag that `docker/build.sh` produces with an
**immutable** tag of the form

```
<env-slug>-<YYYY-MM-DD>-<serial>      e.g.  bootstrap-2026-10-18-0
```

minted so that **two builds with different image content always get different tags, and two builds
with identical content reuse the same tag**. `serial` restarts at `0` each day and increments by 1
for each *additional, content-different* image built on that same day.

This makes runner redeploys correct by construction under the `imagePullPolicy: IfNotPresent` the
job orchestrator already uses — a node can never serve a stale cached image under a tag that now
means different content, because the tag changes whenever the content does.

## Background — the bug this fixes

`docker/build.sh` tags the base-runner image with `ENV_TAG` = the lowercased environment name
(`bootstrap`). That tag is **mutable**: every rebuild re-pushes new content under the same string.
Process jobs run with `imagePullPolicy: IfNotPresent` (`backend/services/job_orchestrator.py:165`),
so a node that has *any* image cached under `…/ymerflow-base-runner:bootstrap` keeps using it and
never pulls the rebuild.

This was hit in production: `adlfs` was added to `config.env`'s `BASE_RUNNER_PARAMS_JSON`, the image
was rebuilt on the host (adlfs present) and pushed, but the minikube node kept running a 3-week-old
cached `:bootstrap` image with no `adlfs`, so `create_environment` jobs kept failing with
`ModuleNotFoundError: No module named 'adlfs'` when writing `az://…/environment.json`. The only
workaround was manually evicting the node's cached tag and re-pulling.

This is the **same bug class** the app images (`ymerflow-backend` / `ymerflow-frontend`) already
fixed by moving from the floating `:prod` tag to a content-addressed tag — see
`docs/plans/done/versioned-app-image-tags.md`. The base-runner image is the last image still on a
mutable tag. (User-created environments are already immutable: the in-pod `create_environment` path
tags each build `{process_id}-{version}`, so they are out of scope here.)

## Design decisions

### 1. "Did the image change?" is answered by inspecting the *built* image, not by resolving deps up-front

The runner's `python_packages` (`BASE_RUNNER_PARAMS_JSON`) include unpinned `git+https://…` URLs
(process-sdk, aem-processes, mag-processes, plugin-processes). Rather than resolve each dependency to
a commit id *before* building (which would need `git ls-remote` or installing those packages into the
host venv), we let the build happen and then read what actually landed in the image:

```
docker run --rm --entrypoint pip <locally-built-temp-image> freeze
```

`pip freeze` renders every installed distribution as `pkg==version` and every VCS install as
`pkg @ git+https://…@<40-char-commit-sha>`, including transitive dependencies. The **fingerprint** is
`sha256` of that output with lines sorted and stripped. This is ground truth for the image's Python
environment, needs no `#egg=` fragments, no network, and no host installs. It reuses the pattern
`docker/build.sh` already relies on to pull `/app/process_schemas.json` out of the freshly built
image (a `docker run --entrypoint` read of the local build), so no Dockerfile change is required.

Boundary: the fingerprint covers the **Python environment only** — not apt/system layers, Node, the
kaniko copy, or the `base_image` digest. Guaranteeing the *build itself* reflects current upstream
(cache busting / `--no-cache`) is **explicitly out of scope** (see Out of scope); this plan only
decides the tag from whatever content the build produced.

### 2. Tag format: `<env-slug>-<YYYY-MM-DD>-<serial>`

- `<env-slug>` is the existing `ENV_TAG` (`docker/build.sh` lowercases the environment name, e.g.
  `Bootstrap` → `bootstrap`). Lowercase is kept because the same slug names Kubernetes objects
  (`runner-schemas-<slug>`, `db-update-<slug>`) which must be lowercase. For the default env the tag
  is therefore `bootstrap-<date>-<serial>`.
- `<YYYY-MM-DD>` is the build host's local date (`date +%F`).
- `<serial>` starts at `0` on the first content-different image of a given day and increments by 1 per
  additional content-different image that same day. A new day resets it to `0`.

### 3. State lives in a host-local, gitignored file

A new `.runner-image-tag.json` at the project root, mode 0600, gitignored — mirroring how
`.deploy-config.json` is already a host-local per-deploy artifact. Shape, keyed by env slug so one
file serves every environment name:

```json
{ "bootstrap": { "fingerprint": "<sha256>", "tag": "bootstrap-2026-10-18-0" } }
```

The decision logic needs exactly two facts about the previous build — its fingerprint (to tell
"same vs different") and its tag (to parse the date + serial) — and this file holds both. This is a
deliberate single-host assumption, matching the existing single prod server; `.deploy-config.json`
already assumes the same.

Considered alternatives, rejected to keep blast radius small:
- **Registry as source of truth** (store the fingerprint as an OCI label, enumerate existing tags):
  the `RegistryProtocolHandler` interface has no list-tags method, so this needs new per-protocol
  code (docker-v2 / gar / acr). Noted as a future robustness upgrade (see Optional enhancement).
- **DB `Environment` row**: host-side `build.sh` reaching the ClusterIP-only Postgres in prod is the
  awkwardness the existing `--resolve-only` dance exists to avoid.

### 4. Decision procedure

Let `F` = fingerprint of the just-built temp image; `(F_prev, tag_prev)` = state for this slug.

- **`F == F_prev`** → identical content. **Reuse `tag_prev`**: do not mint a tag, do not push (the
  image is already in the registry under `tag_prev`), leave `Environment.docker_image` pointing at it.
  Nothing on any node needs to change.
- **`F != F_prev`** (or no state) → new content. Compute `serial`: if `tag_prev`'s date equals today's
  date, `serial = serial_prev + 1`, else `serial = 0`. New tag = `<slug>-<today>-<serial>`. Tag the
  temp image to the new tag, push it, update `Environment.docker_image`, and rewrite the state file to
  `{F, new_tag}`.

With no state file (first run, or it was deleted) and content that happens to match a tag already in
the registry, `serial` resets to `0` and could in principle re-push over an existing `-0` of that day
with identical content — harmless (same bytes). The Optional enhancement removes even this edge.

### 5. `imagePullPolicy` needs no change

The app-image plan had to *revert* an `imagePullPolicy: Always` stopgap after making tags immutable.
Here the runner jobs are **already** on `IfNotPresent` (`job_orchestrator.py:165`), which becomes
correct the moment the tag is immutable. No pull-policy edits are part of this plan.

## Implementation steps

All changes are confined to the **Nagelfluh repo** (`docker/build.sh` + one new `backend/bin` script
+ `.gitignore`). No change to the `Ymerflow-process-sdk` `params_to_dockerfile` is needed (Design
decision 1 uses a runtime `pip freeze`, not a baked file), so the host and in-pod Dockerfiles do not
drift and no cross-repo git push is required.

1. **Add `backend/bin/yf-resolve-runner-image-tag`** (mirrors `yf-resolve-app-image-tag`'s role).
   Inputs: env slug, the `pip freeze` text (stdin or a path), today's date, and the state-file path.
   - Computes `F = sha256(sorted, stripped freeze lines)`.
   - Reads `.runner-image-tag.json`, applies the Design-decision-4 procedure.
   - Prints to stdout a small JSON: `{"tag": "...", "changed": true|false}`. Does **not** write the
     state file itself (build.sh writes it only after a successful push — step 4 — so a failed push
     never advances the serial). All diagnostics to stderr, consistent with the other `yf-*` scripts.

2. **Split build-only / push-only in `backend/bin/yf-build-and-push`** so build.sh can build, inspect,
   then push the *decided* tag without a second build:
   - `--build-only <dockerfile> <ctx> <local_ref> [build args…]` → `docker build -t <local_ref>`, no
     push, nothing to stdout.
   - `--push <local_ref> <repository> <tag>` → `docker tag` + the existing `handler.push_image(...)`,
     print the pushed ref (today's full-build mode stays as a convenience wrapper over the two).

3. **Rework the build/extract/tag section of `docker/build.sh`:**
   1. Synthesize the Dockerfile (unchanged — `params_to_dockerfile`).
   2. `yf-build-and-push --build-only … ymerflow-base-runner:__build` to a throwaway local tag.
   3. Extract as today: `process_schemas.json` **and** `pip freeze` — both via
      `docker run --rm --entrypoint … ymerflow-base-runner:__build`.
   4. `TAG_JSON=$(… yf-resolve-runner-image-tag --slug "$ENV_TAG" --freeze <(printf %s "$FREEZE") …)`.
   5. If `changed`: `yf-build-and-push --push ymerflow-base-runner:__build ymerflow-base-runner "$TAG"`
      → `FULL_IMAGE`; then write `.runner-image-tag.json`.
      If not `changed`: skip the push; resolve `FULL_IMAGE` for the existing `$TAG` via the registry
      handler's `direct_image_url` / `image_url` (no new build, no push).
   6. Feed `FULL_IMAGE` + the extracted schemas into the existing environment-update path unchanged
      (dev: `docker/update_bootstrap_environment.py`; prod: the `db-update-<slug>` Job) so
      `Environment.docker_image` always names the correct immutable tag. Running the update even on
      the unchanged path is idempotent and self-heals a drifted pointer.

4. **`.gitignore`**: add `/.runner-image-tag.json` (next to the existing `.deploy-config.json` entry).

5. **No `imagePullPolicy` change** (Design decision 5). Leave `job_orchestrator.py:165` as is.

## Testing

Run on prod (`ssh <prod-host>`, `cd <deploy-dir>`) against the minikube
cluster, or in dev:

1. **No-change rebuild is a no-op tag:** run `docker/build.sh` twice with no changes. Second run must
   print "unchanged, reusing `bootstrap-<date>-0`", push nothing, and leave `Environment.docker_image`
   and the node's cache untouched.
2. **Content change mints a new serial:** add a package to `BASE_RUNNER_PARAMS_JSON.python_packages`,
   rebuild. Expect `bootstrap-<date>-1` (same day) or `-0` (new day), a push, and
   `Environment.docker_image` updated to the new tag.
3. **Node actually runs the new image:** with the tag changed, confirm a fresh `create_environment`
   run pulls the new image (`IfNotPresent` pulls because the tag is new) — reproduce the original
   failure's fix by confirming `adlfs` is importable in the job and the `az://…/environment.json`
   write succeeds.
4. **Serial math across a day boundary:** simulate `tag_prev` from a prior date in the state file; a
   content change must produce `-0`, not `prev+1`.

## Out of scope

- **Build freshness / cache correctness.** Whether the build picks up the latest upstream commit of an
  unpinned `git+…` dependency is the operator's concern (`docker build --no-cache` etc.). This plan
  reads whatever content the build produced and tags accordingly; it does not force reinstalls. All
  `python_packages` share one cached `RUN pip install` layer
  (`ymerflow_runner/params_to_dockerfile.py`), so without `--no-cache` an upstream-only change can be
  masked by Docker's layer cache — and the fingerprint will faithfully report "unchanged".
- **System/base-image layers.** apt packages, Node, the kaniko executor copy, and the `base_image`
  digest are not in the fingerprint (Design decision 1 boundary).
- **User-created environments.** Already immutable (`{process_id}-{version}`); untouched.
- **Multi-host / state recovery.** The state file assumes a single build host.

## Optional enhancement (not required)

Bake the fingerprint into the image as an OCI `LABEL` (a `--label` on the `--push`/build step) so each
pushed image is self-describing. Combined with a future `list_tags` on `RegistryProtocolHandler`, this
would let the serial/fingerprint be recovered from the registry itself, removing the single-host
state-file assumption (Design decision 3's rejected alternative).

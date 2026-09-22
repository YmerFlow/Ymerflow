# Plan: Isolate the in-pod kaniko build so it stops corrupting the runner's own environment

> **2026-09-19 revision.** This plan was originally drafted against a stale snapshot of
> `Ymerflow-process-sdk` (the gitignored `Nagelfluh/deps/Ymerflow-process-sdk` clone, stuck at the
> extract commit `67d49a3`, 2026-09-14). The **live, authoritative** copy — the one the dev env's
> editable install resolves `ymerflow_runner` to, and the one `docker/build.sh` pulls from the
> `git+https://github.com/YmerFlow/Ymerflow-process-sdk.git` URL — is **`~/Projects/beta/Ymerflow-process-sdk`**,
> HEAD `a20462b` (2026-09-17), which is strictly *newer* (`67d49a3` is its ancestor). The live
> `create_environment.py` has since grown **three hard-won kaniko workarounds** the original plan
> never saw. This revision reconciles the chroot fix with them. **Edit the `~/Projects/beta` copy,
> not `deps/`.**

## Problem

`create_environment` runs the kaniko executor **inline, inside the runner pod, against the pod's own
root filesystem**. Kaniko is designed to *own* the filesystem of the container it runs in: it
extracts the base image over `/`, runs the Dockerfile's `RUN` steps against the real filesystem, and
snapshots the diffs. We copy `/kaniko/executor` into the base-runner image (`params_to_dockerfile.py`,
`install_kaniko`, as `/kaniko-executor`) and run it there — so every environment build **mutates the
live runner's `/usr/local/lib/python3.11/site-packages`** and, in fact, replaces the runner's entire
rootfs with the freshly-built image's. This can never be robust.

It broke in production on 2026-09-19:

- `create_environment.py` does `import fsspec` at module top → caches `fsspec.utils` in
  `sys.modules` at the base-runner's version, but **not** `fsspec.asyn` (loaded lazily, only when an
  async filesystem like s3fs is first imported).
- Kaniko's `RUN pip install …` (fsspec/s3fs are **unpinned**) installs the latest fsspec into the
  shared `site-packages`, overwriting the runner's.
- The post-build `fsspec.open("s3://…/environment.json")` triggers the *first* `import s3fs` →
  `fsspec.asyn`, read **fresh from the now-mutated disk**. New `asyn.py` does `from .utils import
  check_contained`, but `fsspec.utils` is the **old** cached version → `ImportError: cannot import
  name 'check_contained'`.

**Trigger:** the `Bootstrap` base-runner image ships fsspec 2026.7.0; fsspec/s3fs 2026.9.0 (which
added `check_contained`) hit PyPI 2026-09-18 17:50. Earlier runs (v6 Sep 16, v7 Sep 17) had kaniko
install the same 2026.7.0 the runner had cached → no skew. The first run after the release (v8 Sep 19)
installed 2026.9.0 `asyn.py` over a cached 2026.7.0 `utils` → crash. No code of ours changed; a PyPI
release exposed a latent design flaw.

### Scope: `create_environment` ONLY

The original plan claimed `build_frontend_plugin` "has the identical bug" and asked to switch it to
the same helper. **That is a misdiagnosis** (confirmed 2026-09-19, user-confirmed scope decision):
`build_frontend_plugin.py` never invokes kaniko — it calls `ymerflow_plugin_build.build_frontend`,
which does `npm pack` + `npm install` + a Vite Module-Federation build into a temp `out_dir`. An
npm/Vite build cannot overwrite Python `site-packages`, so the fsspec-skew crash is physically
impossible there and there is no `/kaniko-executor` invocation to switch. **This plan touches only
`create_environment.py`.**

## The live code already fights the same fire — with three workarounds

The current `create_environment.py` (beta `a20462b`) carries three kaniko patches. The chroot fix
must be reconciled with each — one is subsumed, two must be preserved.

1. **`/kaniko` reservation → `KANIKO_DIR=/kaniko-parent`** (`create_environment.py:178-189`). Kaniko
   reserves its working dir (`/kaniko`) and excludes it from the built image's stages, so a Dockerfile
   containing `COPY --from=kaniko /kaniko/executor /kaniko-executor` (present whenever `install_kaniko`
   is on) dies with `lstat /kaniko/0/kaniko/executor: no such file`. Fixed by pre-creating `/kaniko`
   and setting `KANIKO_DIR=/kaniko-parent` so `/kaniko` is an ordinary readable path in the build.
   → **This is about the *image kaniko builds*, not where kaniko's rootfs lands. The chroot does NOT
   remove it: kaniko inside the chroot still reserves `/kaniko` by default. PRESERVE it** (the helper
   must reproduce the `/kaniko` + `KANIKO_DIR` setup *inside* the chroot for `install_kaniko` builds).

2. **Registry `:443` auth-stripping → push to bare host** (`create_environment.py:115-145,208,219-227,276`).
   go-containerregistry (kaniko's push library) treats `host:443` and `host` as different hosts and
   strips the `Authorization` header on the port-only redirect nginx returns → anonymous PATCH → 401.
   Fixed by pushing to the **bare host** (`push_registry_url`/`push_image_name`), keying the docker
   `config.json` `auths` map to the bare host, and having crane pull from the bare host too — while the
   **stored** `docker_image` ref keeps the `:443` form (pods pull it via containerd, which tolerates
   the redirect, and the imagePullSecret is keyed to `host:443`).
   → **Orthogonal to isolation. PRESERVE entirely.** The caller passes `push_image_name` as kaniko's
   `--destination` and as crane's pull ref; the auths key stays `push_registry_url`.

3. **rootfs-wipe survival hacks → `--ignore-path` crane + extract_dir, DOCKER_CONFIG juggling**
   (`create_environment.py:191-202,213-214,229-246,265-299`). Because kaniko replaces the pod's `/`
   with the built image, the live code keeps the crane binary and a schema-extraction workspace alive
   by adding them to kaniko's `--ignore-path`, and writes the docker config into two surviving
   locations (`/kaniko/.docker` for kaniko — which `KANIKO_DIR` forces it to read from — and the
   ignore-pathed `extract_dir/.docker` for crane).
   → **This is exactly the disease the chroot cures. The chroot SUBSUMES all of #3.** With kaniko
   confined to a throwaway chroot rootfs, the pod's `/` (crane binary, `site-packages`, tmpdir) is
   never touched, so there are no survival hacks: crane runs normally against the pod fs, and crane's
   docker config is a single ordinary tmpdir. **REMOVE #3.**

Two more live behaviors to keep (independent of isolation, both improvements over the original):
- **Stream, don't capture** — `subprocess.run(kaniko_args, cwd=tmpdir)` with no `capture_output`, so
  build progress streams live to the pod stdout/log stream (`create_environment.py:250-258`).
- **No hardcoded subprocess timeout** — the only build bound is the Job's `activeDeadlineSeconds`; the
  old 10-min `timeout=600` capped big compiles (simpeg/pyinterp) regardless of the process timeout.
  The helper must NOT reintroduce an inner timeout.

## Recommended approach — Option C: chroot the kaniko build inside the same pod

Run kaniko in a **child process that `chroot()`s into a prepared throwaway rootfs, then `exec`s the
executor**. Kaniko extracts the base image into the *chroot's* `/`, runs `pip install` there,
snapshots, and pushes to the registry — all inside the chroot. The **parent runner process keeps the
pod's real `/` pristine**, so the post-build `crane export` + `fsspec.open()` run against an
unmodified `site-packages`. Same single billed pod, no new RBAC, no extra pods.

### Rejected alternatives
- **Eager-import the storage stack before kaniko (`import s3fs` up top).** A hack around the symptom.
  Kaniko still trashes the pod filesystem; any other post-build disk/code access stays fragile.
- **Run kaniko in a separate Job/pod.** Requires the runner SA to create pods, and those build pods
  run **outside the process billing model** (unbilled compute). Unacceptable.

### Why it works with the capabilities we already have
The Job pod sets **no `securityContext`** (`job_orchestrator.py`), so it runs as **root** with the
**default container capability set**:
- `CAP_SYS_CHROOT` (default) → `chroot()` works.
- `CAP_MKNOD` + `CAP_CHOWN`/`CAP_DAC_OVERRIDE`/`CAP_FOWNER` (default) → we can create the few `/dev`
  nodes kaniko/pip need *inside* the chroot, and kaniko's image extraction (chown, mknod) works.
- **`CAP_SYS_ADMIN` is NOT default** → we cannot `mount`, so we cannot bind-mount `/proc`, `/sys`,
  `/dev`. The design avoids needing real mounts (below).

Only viable because the namespace is not PodSecurity-`restricted` (current kaniko already runs as
root writing to `/`, which `restricted` would forbid). Confirm the namespace stays baseline/privileged.

### What must be staged into the chroot (all by copy / mknod — no mounts)
1. The kaniko executor. In the outer image it lives at **`/kaniko-executor`** (dash — see
   `params_to_dockerfile`'s `COPY --from=kaniko /kaniko/executor /kaniko-executor`). Stage it inside
   the chroot **mirroring the pod layout the KANIKO_DIR workaround expects**: binary at
   `$ROOT/kaniko-executor`, an empty `$ROOT/kaniko` dir, and run kaniko with `KANIKO_DIR=/kaniko-parent`
   (so `install_kaniko` builds whose Dockerfile does `COPY --from=kaniko /kaniko/executor` still work
   — workaround #1, now applied *inside* the chroot).
2. CA certs (`/etc/ssl/certs`, copytree-dereferenced so the chroot is self-contained),
   `/etc/resolv.conf` and `/etc/hosts` — so kaniko can pull the base image and push over TLS with DNS
   and resolve local names.
3. The docker `config.json` (registry auth, **keyed to `push_registry_url`** — workaround #2). With
   `KANIKO_DIR` set, kaniko resets `DOCKER_CONFIG` to `<KANIKO_DIR>/.docker` at startup and reaches it
   by copying `/kaniko` → `/kaniko-parent`; so write the config to `$ROOT/kaniko/.docker/config.json`
   so it rides that copy (matching the live comment at `create_environment.py:229-244`).
4. The synthesized `Dockerfile` (build context) at `$ROOT/context/Dockerfile`.
5. Device nodes via `mknod`: `/dev/{null,zero,random,urandom}`.
6. A **static minimal `/proc/self/mountinfo`** (one line for `/`) — kaniko reads this to build its
   snapshot ignore-list; a real `/proc` needs a mount we can't do.

### The `/proc` question — VALIDATED (spike passed 2026-09-19)
Kaniko (v1.24.0) reads `/proc/self/mountinfo` and **errors immediately if it is absent** (verified:
`failed to initialize ignore list: … open /proc/self/mountinfo: no such file or directory`). A
**static faked file works**: with a single line (`1 0 0:1 / / rw,relatime - overlay overlay rw`)
written to `$ROOT/proc/self/mountinfo`, kaniko builds normally.

Spike (host Docker, throwaway container, **exactly the k8s default cap set** — `SYS_CHROOT`+`MKNOD`
present, **`SYS_ADMIN` absent**): from a `python:3.11-slim`+fsspec-2026.7.0 image with
`/kaniko/executor` copied in, staged a chroot (certs, resolv.conf, mknod'd `/dev`, fake
`/proc/self/mountinfo`) and ran `chroot $ROOT /kaniko/executor --force --no-push …` building a
Dockerfile whose `RUN pip install fsspec==2026.9.0 s3fs==2026.9.0` mimics the prod version
divergence. Result: build completed (full-fs snapshot taken), and the **outer** image's fsspec
stayed 2026.7.0 with `asyn.py`+`utils.py` md5 **byte-identical** before and after, `import s3fs`
still working. Isolation holds; **no `CAP_SYS_ADMIN`/`securityContext`/backend change needed.**

Invocation details the spike surfaced:
- **`--force` is required.** Inside a chroot kaniko's "am I in a container?" heuristic fails and it
  refuses without it. `--force` is correct/safe here precisely *because* we've contained it.
- **`--ignore-path` for `/proc`, `/dev`, `/context` only — NOT `/kaniko`.** These scaffolding
  ignore-paths keep our staging out of the snapshot. **Do not add `--ignore-path=/kaniko`**: an
  `install_kaniko=true` Dockerfile does `COPY --from=kaniko /kaniko/executor …`, and ignoring
  `/kaniko` makes kaniko skip that cross-stage *source* (`Not adding /kaniko/executor because it is
  ignored`), so the copy fails with `lstat /kaniko-parent/0/kaniko/executor: no such file`. `/kaniko`
  needs no ignoring anyway — `KANIKO_DIR=/kaniko-parent` makes kaniko relocate and delete `/kaniko`
  at startup (before any snapshot) and auto-ignore its `/kaniko-parent` workdir. (These are
  *scaffolding* ignore-paths, unrelated to the old #3 crane/extract-dir survival ignore-paths, which
  the chroot removes entirely.)
- **Stage `/etc/hosts` too** (alongside certs + resolv.conf) so local names resolve.

### The `install_kaniko` + `KANIKO_DIR` interaction inside the chroot — VALIDATED (spike passed 2026-09-19)
The original spike exercised only `install_kaniko=false`. This revision extended it to
`install_kaniko=true` (a Dockerfile with `FROM …/executor AS kaniko` + `COPY --from=kaniko
/kaniko/executor /kaniko-executor` + `RUN pip install fsspec==2026.9.0`), run through the **real
`kaniko_build` helper** in a default-cap container (SYS_ADMIN absent) against a throwaway registry.
Result once `--ignore-path=/kaniko` was removed (see above): build + push clean, the pushed image
contains `/kaniko-executor`, and the outer image's fsspec stayed **byte-identical** (isolation holds).
The `install_kaniko=false` regression also passed (builds, no stray `/kaniko-executor` leaked, fsspec
present in the built image). `KANIKO_DIR=/kaniko-parent` is retained (matches the proven live-pod
behavior); the auth-ride to `/kaniko-parent/.docker` is covered by the prod smoke test (the throwaway
registry was unauthenticated).

### Code shape
Add a shared helper in the process SDK, e.g.
`ymerflow_runner.kaniko_build(dockerfile_text, destination, *, registry_url, registry_auth, extra_args=(), executor_path="/kaniko-executor")`
that: builds the chroot, sets up `/kaniko` + `KANIKO_DIR=/kaniko-parent`, `mknod`s devices, writes the
fake `mountinfo`, writes the auth `config.json` (keyed to the caller-provided registry host) into
`$ROOT/kaniko/.docker`, then `subprocess.run(["chroot", root, "/kaniko-executor", "--force", …])`
**streaming (no `capture_output`) and with no inner timeout**. `crane export` and all storage writes
stay in the **parent**, outside the chroot, against the pristine pod filesystem — so crane needs no
`--ignore-path`, no survival dir, just an ordinary tmpdir `DOCKER_CONFIG`.

`create_environment.py` keeps computing `full_image_name` (`:443`, stored) vs `push_image_name`
(bare host, for kaniko `--destination` and crane pull) and passes `push_image_name` +
`push_registry_url` into the helper. The `--insecure`/`--skip-tls-verify*` flags pass through
`extra_args`.

## Deployment impact — backend redeploy? new images?

The fix lives in the **runner-side SDK** baked into runner images; the backend never imports it.

- **Backend redeploy: NO** (spike-confirmed for the common path). The static-`/proc` route works with
  default caps, so nothing in `job_orchestrator.py` changes — no `securityContext`, no
  `CAP_SYS_ADMIN`, no RBAC.
- **Images — rebuild the base-runner / `:bootstrap` image (required).** `create_environment` runs in
  the `Bootstrap` environment, so the fix ships only when the base-runner image is rebuilt with the
  fixed SDK: run `docker/build.sh` (pip-installs the git SDKs fresh, then
  `update_bootstrap_environment.py` re-registers `Bootstrap`). Rebuild any `public-launch-*`
  base-runners too if used to run `create_environment`.
- **Not "all images."** Custom environments only need rebuilding if they are themselves used to *run*
  `create_environment` (`install_kaniko=true` envs). Pure processing/inversion envs keep working
  untouched. Once a fixed `Bootstrap` exists, re-running `create_environment` from it regenerates
  fixed custom envs.
- **Git-URL dep gotcha:** the SDK fix must be **committed AND pushed** to
  `github.com/YmerFlow/Ymerflow-process-sdk` (from the `~/Projects/beta/Ymerflow-process-sdk` checkout)
  before `build.sh` rebuilds — a local-only commit is not picked up by the fresh pip install.

## Implementation steps (spike passed for the common path — one interaction still to validate)

1. **In `~/Projects/beta/Ymerflow-process-sdk`** (NOT `deps/`), add
   `ymerflow_runner/kaniko_build.py` with `kaniko_build(dockerfile_text, destination, *,
   registry_url, registry_auth, extra_args=(), executor_path="/kaniko-executor")` that stages the
   chroot (copy `/kaniko-executor` → `$ROOT/kaniko-executor`; empty `$ROOT/kaniko`; copy
   `/etc/ssl/certs` + `resolv.conf`; write auth `config.json` keyed to `registry_url` at
   `$ROOT/kaniko/.docker`; write Dockerfile to `$ROOT/context/Dockerfile`; `mknod`
   `/dev/{null,zero,random,urandom}`; write static `/proc/self/mountinfo`) then
   `subprocess.run(["chroot", root, "/kaniko-executor", "--force", "--ignore-path=/proc",
   "--ignore-path=/dev", "--ignore-path=/kaniko", "--ignore-path=/context",
   "--context=dir:///context", "--dockerfile=/context/Dockerfile", f"--destination={destination}",
   *extra_args], env={**os.environ, "KANIKO_DIR": "/kaniko-parent"})` — **streaming, no timeout**.
   `rmtree` the chroot in a `finally`.
2. Switch `create_environment.py` to call the helper with `push_image_name` + `push_registry_url` and
   the `--insecure`/`--skip-tls-verify*` flags via `extra_args`. **Delete workaround #3** (crane/
   extract_dir `--ignore-path`, the two-location DOCKER_CONFIG juggling, the `/kaniko/.docker` +
   `crane_config_dir` split): crane now runs in the parent against the pristine fs with an ordinary
   tmpdir `DOCKER_CONFIG`, pulling `push_image_name`. **Keep workaround #2** (bare-host push/pull,
   stored `:443` ref) and rely on the helper for workaround #1 (`/kaniko` + `KANIKO_DIR`).
3. Confirm the base-runner still bakes `/kaniko-executor` + `ca-certificates` (it does) and the chroot
   copies certs from where they actually live (`/etc/ssl/certs`).
4. Commit + push the SDK repo (git-URL dep).
5. Rebuild base-runner via `docker/build.sh`; confirm `Bootstrap` re-registered.

## Testing

- **Spike (gate, `install_kaniko=false` — passed):** kaniko completes in the chroot; outer
  `site-packages` byte-identical; no stray `/kaniko-executor` leaks into the built image.
- **Spike (gate, `install_kaniko=true` — passed 2026-09-19):** the real `kaniko_build` helper builds
  a `COPY --from=kaniko /kaniko/executor` Dockerfile in the chroot and pushes; pushed image contains
  `/kaniko-executor`; outer fsspec byte-identical. Gated on removing `--ignore-path=/kaniko` (see the
  invocation-details note above).
- **Repro-of-original:** in a base-runner container, `import fsspec`, `pip install fsspec==2026.9.0`
  (simulating the old in-place mutation), then `fsspec.open("s3://…")` → reproduces the crash. With
  the chroot build, the outer fsspec is never mutated, so the crash cannot occur.
- **Prod:** re-run `create-clustered-inv`; confirm `DONE` + a new `clustered-inv` env row (verifies
  both the isolation AND that the preserved `:443`/bare-host push still authenticates against the real
  prod registry).

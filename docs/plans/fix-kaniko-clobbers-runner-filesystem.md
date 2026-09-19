# Plan: Isolate the in-pod kaniko build so it stops corrupting the runner's own environment

## Problem

`create_environment` and `build_frontend_plugin` run the kaniko executor **inline, inside the runner
pod, against the pod's own root filesystem**. Kaniko is designed to *own* the filesystem of the
container it runs in: it extracts the base image over `/`, runs the Dockerfile's `RUN` steps against
the real filesystem, and snapshots the diffs. We copy `/kaniko/executor` into the base-runner image
(`params_to_dockerfile.py`, `install_kaniko`) and run it there — so every environment build
**mutates the live runner's `/usr/local/lib/python3.11/site-packages`**. This can never be robust.

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
release exposed a latent design flaw. `build_frontend_plugin` has the identical bug
(`build_frontend_plugin.py:125,142,158` do `fsspec.open()` writes after the kaniko build).

## Where the design went wrong

`create_environment` was "fully implemented" from the start and **no plan ever scrutinised the
kaniko execution model**. `docs/architecture/environment.md` justifies kaniko as "needs no Docker
daemon, works in an unprivileged container" — the reasoning stopped at *daemonless + unprivileged*
and missed that kaniko **destroys the container's filesystem as a side effect**, so the runner must
not keep using that filesystem afterward (it does). `docs/plans/done/extract-runner-sdk-and-process-
repos.md` refactored only the shared *Dockerfile text* and explicitly left the build engine
(in-pod kaniko) out of scope, carrying the flaw forward.

## Rejected alternatives

- **Eager-import the storage stack before kaniko (`import s3fs` up top).** Rejected: a hack around
  the symptom. Kaniko still trashes the pod filesystem; any other post-build disk/code access stays
  fragile. Fixes one import path, not the disease.
- **Run kaniko in a separate Job/pod (sidecar or one-shot Job).** Rejected: it requires the runner's
  service account to be able to create pods, and those build pods would run **outside the process
  billing model** (unbilled compute). Unacceptable.

## Recommended approach — Option C: chroot the kaniko build inside the same pod

Run kaniko in a **child process that `chroot()`s into a prepared throwaway rootfs, then `exec`s the
executor**. Kaniko extracts the base image into the *chroot's* `/`, runs `pip install` there,
snapshots, and pushes to the registry — all inside the chroot. The **parent runner process keeps the
pod's real `/` pristine**, so the post-build `crane export` + `fsspec.open()` run against an
unmodified `site-packages`. Same single billed pod, no new RBAC, no extra pods.

### Why it works with the capabilities we already have
The Job pod sets **no `securityContext`** (`job_orchestrator.py` — container and pod specs have
none), so it runs as **root** with the **default container capability set**:

- `CAP_SYS_CHROOT` (default) → `chroot()` works.
- `CAP_MKNOD` + `CAP_CHOWN`/`CAP_DAC_OVERRIDE`/`CAP_FOWNER` (default) → we can create the few `/dev`
  nodes kaniko/pip need *inside* the chroot, and kaniko's image extraction (chown, mknod) works.
- **`CAP_SYS_ADMIN` is NOT default** → we cannot `mount`, so we cannot bind-mount `/proc`, `/sys`,
  `/dev`. The design must avoid needing real mounts (see below).

Note: this is only viable because the namespace is not PodSecurity-`restricted` (current kaniko
already runs as root writing to `/`, which `restricted` would forbid). Confirm the namespace stays
baseline/privileged.

### What must be staged into the chroot (all by copy / mknod — no mounts)
1. `/kaniko/executor` (the binary we already `COPY --from=kaniko`) + a writable `/kaniko` scratch dir.
2. CA certs (`/etc/ssl/certs`, from the base-runner's `ca-certificates`) and `/etc/resolv.conf` — so
   kaniko can pull the base image and push over TLS with DNS.
3. The Docker `config.json` (registry auth) at the path kaniko reads (`DOCKER_CONFIG`).
4. The build context + synthesized `Dockerfile` (already written to a tmpdir today — put it inside
   the chroot instead).
5. Device nodes via `mknod`: `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` (Python 3.6+
   uses `getrandom()` not `/dev/urandom`, but shells/tools in RUN steps still expect `/dev/null`).
6. A **static minimal `/proc/self/mountinfo`** (one line for `/`) — kaniko reads this to build its
   snapshot ignore-list; a real `/proc` needs a mount we can't do. This is the one real risk (below).

### The `/proc` question — VALIDATED (spike passed 2026-09-19)
Kaniko (v1.24.0) reads `/proc/self/mountinfo` and **errors immediately if it is absent** (verified:
`error building image: failed to initialize ignore list: … open /proc/self/mountinfo: no such file
or directory`). A **static faked file works**: with a single line
(`1 0 0:1 / / rw,relatime - overlay overlay rw`) written to `$ROOT/proc/self/mountinfo`, kaniko
builds normally.

Spike (host Docker, throwaway container, **exactly the k8s default cap set** — `CapEff a80425fb`:
`SYS_CHROOT`+`MKNOD` present, **`SYS_ADMIN` absent**): from a `python:3.11-slim`+fsspec-2026.7.0 image
with `/kaniko/executor` copied in, staged a chroot (certs, resolv.conf, mknod'd `/dev`, fake
`/proc/self/mountinfo`) and ran `chroot $ROOT /kaniko/executor --force --no-push …` building a
Dockerfile whose `RUN pip install fsspec==2026.9.0 s3fs==2026.9.0` mimics the prod version
divergence. Result: build completed (`IN-BUILD fsspec 2026.9.0`, full-fs snapshot taken), and the
**outer** image's fsspec stayed 2026.7.0 with `asyn.py`+`utils.py` md5 **byte-identical** before and
after, `import s3fs` still working. Isolation holds; **no `CAP_SYS_ADMIN`/`securityContext`/backend
change needed.**

Two invocation details the spike surfaced:
- **`--force` is required.** Inside a chroot kaniko's "am I in a container?" heuristic fails and it
  refuses (exits without building, only printing "run with the --force flag"). `--force` is correct
  and safe here precisely *because* we've contained it in the chroot.
- **Add `--ignore-path`** for `/proc`, `/dev`, `/kaniko`, `/context`, `/out.tar` so our staging
  scaffolding is excluded from the snapshot and doesn't bloat / pollute the built image layers.

### Code shape
Add a shared helper in the process SDK, e.g. `ymerflow_runner.kaniko_build(dockerfile_text,
destination, registry_auth, ...)`, that: builds the chroot, `mknod`s devices, writes the fake
`mountinfo`, then `subprocess.run(["chroot", root, "/kaniko/executor", "--context=dir:///context",
...])`. Both `create_environment.py` and `build_frontend_plugin.py` call it instead of shelling out
to `/kaniko-executor` directly, so the isolation lives in one place and can't drift. `crane export`
and all storage writes stay in the parent, outside the chroot.

## Deployment impact — backend redeploy? new images?

The fix lives in the **runner-side SDK** baked into runner images; the backend never imports it.

- **Backend redeploy: NO** (spike-confirmed). The static-`/proc` route works with default caps, so
  nothing in `job_orchestrator.py` changes — no `securityContext`, no `CAP_SYS_ADMIN`, no RBAC.
- **Images — rebuild the base-runner / `:bootstrap` image (required).** `create_environment` and
  `build_frontend_plugin` run in the `Bootstrap` environment, so the fix ships only when the
  base-runner image is rebuilt with the fixed SDK: run `docker/build.sh` (pip-installs the git SDKs
  fresh, then `update_bootstrap_environment.py` re-registers `Bootstrap`). Rebuild the
  `public-launch-*` base-runners too if any are used to run these two process types.
- **Not "all images."** Custom environments (`env-clustered-inv`, …) bundle the SDK but only need
  rebuilding if they are themselves used to *run* `create_environment`/`build_frontend_plugin`
  (`install_kaniko=true` envs). Pure processing/inversion envs keep working untouched. Once a fixed
  `Bootstrap` exists, re-running `create_environment` from it regenerates fixed custom envs.
- **Git-URL dep gotcha:** the SDK fix must be **committed AND pushed** to the GitHub repos before
  `build.sh` rebuilds — a local-only commit is not picked up by the fresh pip install.

## Implementation steps (spike passed — ready to build)

1. Add `ymerflow_runner.kaniko_build(dockerfile_text, destination, registry_auth, …)` that stages the
   chroot (copy `/kaniko/executor` + `/etc/ssl/certs` + `resolv.conf` + docker `config.json` + build
   context; `mknod` `/dev/{null,zero,random,urandom}`; write the static `/proc/self/mountinfo`) then
   `subprocess.run(["chroot", root, "/kaniko/executor", "--force",
   "--ignore-path=/proc", "--ignore-path=/dev", "--ignore-path=/kaniko", "--ignore-path=/context",
   "--context=dir:///context", "--dockerfile=/context/Dockerfile", "--destination=…"])`.
2. Switch `create_environment.py` and `build_frontend_plugin.py` to call it; remove the direct
   `/kaniko-executor` invocation. `crane export` + all `fsspec.open()` writes stay in the parent,
   outside the chroot.
3. Confirm the base-runner still bakes `/kaniko/executor` + `ca-certificates` (it does) and that the
   chroot copies certs from where they actually live.
4. Commit + push the SDK repos (git-URL deps).
5. Rebuild base-runner via `docker/build.sh`; confirm `Bootstrap` re-registered.

## Testing

- **Spike (gate):** as above — kaniko completes in the chroot; outer `site-packages` unchanged;
  `import s3fs` works in the outer image afterward.
- **Repro-of-original:** in a base-runner container, `import fsspec`, `pip install fsspec==2026.9.0`
  (simulating the old in-place mutation), then `fsspec.open("s3://…")` → reproduces the crash. With
  the chroot build, the outer fsspec is never mutated, so the crash cannot occur.
- **Prod:** re-run `create-clustered-inv`; confirm `DONE` + a new `clustered-inv` env row. Run
  `build_frontend_plugin`; confirm dataset upload + `plugin.json` write.

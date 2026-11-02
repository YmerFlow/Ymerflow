# `create_environment` image push fails: manifest HEAD redirect-loops on `registry.ymerflow.earth`

## Status: RESOLVED — 2026-10-30

Root cause was **client-side**: `create_environment` ran kaniko with `--insecure`, which
forces go-containerregistry onto plain HTTP. The public registry edge is HTTPS-only and
301-redirects every HTTP request to HTTPS; under `--insecure` go-containerregistry coerces
the redirect target back to HTTP and reissues, ping-ponging http↔https until it hits its
10-redirect ceiling and aborts the manifest `HEAD`.

Fixed by dropping `--insecure`/`--insecure-pull` from the kaniko push in
`deps/Ymerflow-process-sdk/ymerflow_runner/create_environment.py` (so it talks HTTPS directly).
Verified in production: process `42bc224f-48ee-401d-ab03-0e0befcd3d0b` **v4** (2026-10-30)
pushed cleanly and registered the environment —

```
19:30:17  Pushing image to registry.ymerflow.earth/proj-2e02c2b4-…/env-ymerflow-proc-fastcoeff:…-4
19:30:53  ✓ Image built and pushed successfully: registry.ymerflow.earth:443/…/…-4
19:32:46  Environment creation complete        (process state: DONE)
```

— where v1/v2/v3 all died in ~1 s with `stopped after 10 redirects`.

The rest of this document is kept as the diagnosis record: the original symptom, the two
**wrong** theories it went through and why they were wrong, the actual root cause, the fix, and
the deployment gotchas that made the fix hard to land.

---

## Symptom (what the build job saw)

The kaniko build completed — all layers built, schemas extracted
(`Available process types: … yf_process_tem, yf_qc_tem, … invert_tem …`) — and then died at
the push step:

```
INFO[0588] Pushing image to registry.ymerflow.earth/proj-2e02c2b4-…/env-ymerflow-proc-fastcoeff:42bc224f-…-2
error pushing image: failed to push to destination
  registry.ymerflow.earth/proj-2e02c2b4-…/env-ymerflow-proc-fastcoeff:42bc224f-…-2:
  Head "https://registry.ymerflow.earth/v2/proj-2e02c2b4-…/env-ymerflow-proc-fastcoeff/manifests/42bc224f-…-2":
  stopped after 10 redirects
ERROR: Kaniko build failed with exit code 1
```

`stopped after 10 redirects` is go-containerregistry's (kaniko's registry client) ceiling on
redirect-following — the request keeps getting a 3xx whose `Location` leads to another 3xx.
Reproduced on 2026-10-28 (v1), 2026-10-29 (v2) and 2026-10-30 (v3, after an unrelated
"registry fix"), always in project `2e02c2b4-910d-4bd8-9051-bdf238bbeca1` from the superpublic
**Bootstrap** env on the Default Cluster (minikube). The push died in **~1 second** every time —
a tight loop, not a network stall.

## Root cause (confirmed)

`create_environment` built the push command in
`deps/Ymerflow-process-sdk/ymerflow_runner/create_environment.py` with, among others, kaniko's
`--insecure` and `--insecure-pull`. Those flags do **not** mean "tolerate a self-signed cert" —
they force go-containerregistry to address the registry over plain **HTTP**.

But every push goes through the external edge `registry.ymerflow.earth:443`
(`frontend/40-tls.sh`'s `emit_proxy` block, exposed via the frontend `:443`/NodePort 30443),
which is HTTPS-only and 301-redirects all HTTP to HTTPS. The sequence kaniko hits:

1. `HEAD http://registry.ymerflow.earth/v2/…/manifests/…` (http because `--insecure`)
2. edge → `301 Location: https://…/manifests/…`
3. go-containerregistry follows to https, then — because the registry is flagged insecure —
   **coerces the target back to `http://`** and reissues
4. → `301` → https → coerce to http → `301` → … 10× → abort.

The push *target* was never the problem and is unchanged (always the official external
`registry.ymerflow.earth:443`, per the project rule that in-cluster jobs must use the official
address, not an in-cluster shortcut). The defect was purely the forced **scheme**.

### Evidence (prod, authenticated, read-only)

- Authenticated **HTTPS** `GET /v2/` → `200`; authenticated manifest `HEAD` → `404`; **zero
  redirects** — host-level *and* from inside a cluster pod. The edge and backing `registry:2`
  are completely healthy over HTTPS and the edge does **not** drop auth.
- The edge's HTTP→HTTPS 301 is a single clean hop for a well-behaved client (`curl`, a plain
  Python client that re-sends auth on redirect): http → 301 → https → `200`/`404`, done.
- `crane 0.19.0 --insecure` against the same edge returns a clean `UNAUTHORIZED` over HTTPS with
  **zero** redirects — crane's go-containerregistry probes HTTPS *first*, so it never exercises
  the http fallback. Only kaniko's `--insecure` (which coerces onto http) loops.
- The failed job log shows the push dying in ~1 s = a tight http↔https flip, not a server stall.

### Why the two earlier theories were wrong

1. **"The loop is in the authenticated nginx/`registry:2` path; fix with
   `REGISTRY_HTTP_RELATIVEURLS=true`."** Disproved: the authenticated HTTPS manifest `HEAD`
   returns a clean `404` with zero redirects. The backing `registry:2` uses **filesystem**
   storage with no `REGISTRY_HTTP_HOST`, so it emits no storage/redirect `Location` at all, and
   a manifest `HEAD` never produces one — `RELATIVEURLS` would change nothing here.
2. **"The edge drops the `Authorization` header (→ 401)."** This was a measurement artifact:
   the probe used the *local-dev* registry's credentials against the *prod* registry. With the
   correct prod credential the authenticated path returns `200`/`404`.

> **Verification trap (still true, keep in mind):** the **anonymous** `GET /v2/` and manifest
> `HEAD` return a healthy `401` whether or not kaniko loops, so a reported fix looks fine when
> probed anonymously or with a node-cached pull. Verify only with an **authenticated** push, or
> an authenticated `curl -u` manifest probe over HTTPS (must be `200`/`404`, never a 3xx).

## The fix

In `deps/Ymerflow-process-sdk/ymerflow_runner/create_environment.py`:

- **kaniko push** — removed `--insecure` and `--insecure-pull` (the HTTP-forcing flags). Kept
  `--skip-tls-verify` and `--skip-tls-verify-registry=<push host>`: those skip only *certificate
  verification* over HTTPS (needed for the self-signed cert the official address presents in
  dev) and never force HTTP, so they cannot cause the loop.
- **crane export** — kept its `--insecure`. crane folds "allow http" and "skip cert verify" into
  one flag and has no http-free variant, but it probes HTTPS first so it does **not** loop
  against the edge, while still accepting the dev self-signed cert. (Verified above.)
- **`ymerflow-*` base-image ref** — switched from the `:443` form to the bare host, matching the
  bare-host key of the staged docker `config.json`; otherwise the now-HTTPS base-image pull would
  look up auth under `…:443`, miss, and pull anonymously → 401.

The push target and the official external address are unchanged.

## Deployment gotchas that masked the fix (important)

The fix lives in the `Ymerflow-process-sdk` repo, which the base-runner installs via an
**unpinned** `git+https://…` in `BASE_RUNNER_PARAMS_JSON`, and the base-runner is tagged with the
**mutable** `ymerflow-base-runner:bootstrap`. Two caches therefore have to be busted before a
rebuilt fix actually runs — this is why v3 (2026-10-30, after the SDK fix was committed) still
failed with the old `--insecure` code:

1. **Build cache.** `docker/build.sh` → `docker build` with no `--no-cache`; all `python_packages`
   share one cached `RUN pip install` layer, so Docker reuses it and never re-fetches the new
   commit. Bust it by versioning the layer — either pin the ref
   (`…Ymerflow-process-sdk.git@<sha>`) or add/bump a `RUN echo vN` line in
   `BASE_RUNNER_PARAMS_JSON.dockerfile_instructions` (it is emitted just before the pip install).
2. **Node image cache.** Jobs run `imagePullPolicy: IfNotPresent`
   (`backend/services/job_orchestrator.py`); with the mutable `:bootstrap` tag a node that already
   has it never pulls the rebuild. Until the content-addressed tag plan lands, evict it by hand:
   `docker exec minikube docker rmi registry.ymerflow.earth:443/ymerflow-base-runner:bootstrap`
   (then the next job pulls the fresh image).

Both are the operator's concern today. `docs/plans/runner-image-date-serial-tags.md` removes #2
(content-aware immutable tag ⇒ `IfNotPresent` always pulls the right image), mirroring the
already-done `docs/plans/done/versioned-app-image-tags.md` for the app images; #1 (cache-busting
an unpinned `git+…` dep) is explicitly out of scope of that plan.

## Resolution checklist (what was done on 2026-10-30)

1. Patched `create_environment.py` (above); committed + pushed to `Ymerflow-process-sdk`.
2. Added `RUN echo v1` to `BASE_RUNNER_PARAMS_JSON.dockerfile_instructions` and redeployed — the
   host rebuilt `ymerflow-base-runner:bootstrap` with the fix and pushed it to the registry
   (digest `…bf0038…` → `…fc1bc0…`).
3. Evicted the stale `:bootstrap` from the minikube node (`docker rmi`), so `IfNotPresent` re-pulls.
4. Re-ran the build as v4 — pushed cleanly over HTTPS, environment registered. Resolved.

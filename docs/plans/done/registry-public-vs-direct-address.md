# Registry: public pull address for persistent workloads, direct address for bootstrap

## Goal & scope

Address the container registry by its **public URL** (e.g. `registry.redhog.org:443`, behind the
frontend nginx TLS edge) for every image that is pulled *after* the system is live — the **backend
Deployment** and the **runner / `Environment.docker_image`** — while keeping a **direct
node-IP:NodePort** address (self-signed, `:30500`) for the images that must be pulled *during*
bootstrap, before that edge exists: the **frontend/nginx** image, the transient **`yf-deploy-app`**
deployer Job, and the transient **migration** Job.

This removes the LAN-IP coupling the operator observed as a job-pod event:

```
[POD EVENT] Pulling image "192.168.1.179:30500/ymerflow-base-runner:bootstrap"
```

That LAN IP is `REGISTRY_PUBLIC_HOST`, today the single registry address used *everywhere*. It
should be the public URL from `config.env`, except for the narrow bootstrap-only cases above.

### Two hard robustness requirements (from the operator)

1. **No public URL in `config.env` → everything uses the node IP**, byte-for-byte today's
   behaviour. Achieved by defaulting the *public* address to the *direct* address when unset, so
   `public == direct` and every branch below collapses to one address.
2. **HTTPS termination done outside the cluster** (an external LB / reverse proxy, *not* the
   letsencrypt certbot-on-nginx path) must also work. Achieved by keying the bootstrap sequencing
   on a generic **"is the public registry reachable yet?" probe**, never on `PUBLIC_TLS` /
   certbot. When the edge is external it is already up, the probe passes instantly, and there is no
   reorder.

Out of scope: changing how the registry itself is provisioned (still docker-v2 NodePort 30500,
self-signed, per `plugins/ymerflow-minikube`); the nginx `registry.redhog.org` edge itself (already
built — see `docs/plans/done/nginx-letsencrypt-public-tls.md`); any GAR / cloud-registry protocol.

## Background — current state (verified in code)

There is exactly **one** registry address, `REGISTRY_PUBLIC_HOST:REGISTRY_PUBLIC_PORT` (config
default `$(hostname -I | awk '{print $1}')`:`30500`). Everything derives from
`DockerV2ProtocolHandler.image_prefix(config) → f"{host}:{port}"`
(`plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py`):

- **Host-side push** — `push_image()` / `configure_push_auth()` push to `host:port` (crane
  `--insecure`). All pushes happen at bootstrap, before any edge exists.
- **App-image refs + pull secret + deployer Job image** — `prod/runall-production.sh` Step 5
  builds+pushes `ymerflow-backend`/`ymerflow-frontend`; `REGISTRY_ADDR="${BACKEND_IMAGE%%/*}"`
  feeds the `ymerflow-app-pull` Secret's `--docker-server`; `BACKEND_IMAGE` is the `yf-deploy-app`
  Job's own container image (Step 9). `yf-deploy-app` (`backend/bin/yf-deploy-app`) re-resolves
  `image_url(config, "ymerflow-backend"/"ymerflow-frontend", tag)` and hands both to
  `provider.deploy_app()` → `app_deployment.apply_app_workloads()`, which applies the **migration
  Job**, **backend Deployment**, **frontend Deployment** + backend Service.
- **Runner / environment ref** — `docker/build.sh` (Step 10, *after* both app rollouts) pushes
  `ymerflow-base-runner` and persists the resulting `image_url(...)` into `Environment.docker_image`;
  `job_orchestrator.py` uses that verbatim as the Job container image, and derives the per-Job pull
  Secret server as `docker_image.split("/", 1)[0]`.

**Why the "bring nginx up first, then everything is public" idea needs care:** the thing that
*deploys* the frontend is `yf-deploy-app`, a one-shot Job packaged in the **backend image**, and it
deploys backend + frontend *together*, before nginx/cert exist. So the deployer Job image, the
migration Job, the frontend Deployment, and (today) the backend Deployment are *all* pulled during
bootstrap. Only the **runner image** (Step 10) and any **backend pod restart** happen after the
edge is up. The design below splits exactly along that line.

## Target model

### Push — always direct

All images are pushed host-side to the **direct** address (`node-IP:30500`, self-signed). Pushing
to the direct NodePort and later pulling the same digest via `registry.redhog.org:443` hit the
**same registry pod / storage** (NodePort 30500 → `registry` pod :5000; nginx edge →
`registry.registry.svc:5000` → same pod), so there is nothing to reorder on the push side and no
waiting-before-push.

### Pull / image reference — by workload role

| Container | Address | Rationale |
|---|---|---|
| transient `yf-deploy-app` Job | **direct** | runs before the edge; throwaway, like nginx |
| transient migration Job | **direct** | same — one-shot bootstrap container |
| frontend / nginx Deployment | **direct** | cannot pull its own image through itself |
| **backend Deployment** | **public** | pulled after the nginx edge is live; restarts pull public |
| runner / `Environment.docker_image` + per-Job pull Secret | **public** | pulled by job pods once live; the only address a remote cluster can reach |
| remote-cluster setup-script CA fetch / external `docker login` | **public** | already public today |

### Ordering (inside `apply_app_workloads`)

1. migration Job (direct) — may run anytime; independent of the edge.
2. frontend Deployment (direct) → nginx comes up, certbot issues/loads cert, `:443`
   `registry.redhog.org` edge goes live.
3. **Wait until the public registry probes reachable** (bounded; generic `GET {public}/v2/`
   expecting `200`/`401`, TLS-verify skipped so it works for self-signed *and* real certs). On a
   re-run / external edge this returns immediately.
4. backend Deployment (public) + expose.

**Self-healing fallback:** if the probe/wait is skipped or times out, the backend pod simply
`ImagePullBackOff`s until nginx+cert are up and then succeeds on kubelet retry — so a slow
first-boot ACME issuance degrades to "noisy but eventually converges," never a hard failure.

## Config surface

`REGISTRY_PUBLIC_HOST` / `REGISTRY_PUBLIC_PORT` take on their literal meaning — the **public**,
internet-facing address used for the backend Deployment + runner refs:

```sh
REGISTRY_PUBLIC_HOST=registry.redhog.org   # public DNS behind the nginx :443 edge
REGISTRY_PUBLIC_PORT=443
```

A new **direct** address (the self-signed node-IP:NodePort the registry is bootstrapped on) is what
the push + bootstrap-only containers use:

```sh
REGISTRY_DIRECT_HOST=<node/LAN IP>   # optional; defaults to $(hostname -I | awk '{print $1}')
REGISTRY_DIRECT_PORT=30500           # optional; defaults to 30500
```

**Defaulting rule (requirement 1):** if `REGISTRY_PUBLIC_HOST` is unset, `public` := `direct`.
Then every "public" ref is the node IP and the whole feature is inert — today's behaviour exactly.
The stock local/dev deploy (no `REGISTRY_PUBLIC_HOST`) is unchanged.

The docker-v2 `RegistryBackend.config` gains the direct pair alongside the existing keys:

```json
{ "user": "...", "password": "...",
  "host": "registry.redhog.org", "port": 443,
  "direct_host": "192.168.1.179", "direct_port": 30500 }
```

`host`/`port` stay the public (or public==direct) address so existing `image_url()` callers that
should be public need no change; `direct_host`/`direct_port` are read only by the push path and by
the explicit direct-ref call-sites.

## Implementation touch-points (draft — refine during build)

1. **`plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py`**
   - `bootstrap()` populates `direct_host`/`direct_port` (default `hostname -I` / 30500) and sets
     `host`/`port` from `REGISTRY_PUBLIC_HOST`/`PORT` **defaulting to the direct pair when unset**.
   - Add `direct_image_url(config, repo, tag)` / `direct_image_prefix(config)` (or an
     `address="direct"` kwarg) that render from `direct_host:direct_port`.
   - `push_image()` / `configure_push_auth()` target the **direct** address.
   - Self-signed cert SAN already covers `minikube ip` + the config host; ensure it covers
     `direct_host` (it is the old `host`, so already covered) — the public DNS name is served by
     nginx's LE cert, so it does **not** need to be in the registry's own SAN.
   - Add a small `is_reachable(config)` probe used by the wait in step 3 above.

2. **`backend/config.py`** — add `registry_direct_host` / `registry_direct_port`; document the
   "public defaults to direct" rule next to `registry_public_host`/`registry_public_port`.

3. **`backend/bin/yf-deploy-app`** — resolve `images["frontend"]` via the **direct** ref and
   `images["backend"]` via the **public** ref (or pass both address flavours through). The app
   pull Secret needs an entry for **each** distinct registry server the app pods use (direct for
   frontend, public for backend) — today it is one server.

4. **`backend/services/app_deployment.py` (`apply_app_workloads` / `_apply_frontend` /
   `_apply_backend`)** — order frontend → wait-for-edge → backend; migration Job uses the direct
   ref; ensure the multi-server pull Secret (dockerconfigjson with both `auths` entries) is applied
   before either Deployment.

5. **`prod/runall-production.sh`**
   - Step 1: keep `REGISTRY_PUBLIC_HOST` default only as the *direct* fallback source; export the
     direct pair; leave public unset-means-direct.
   - Step 5: push both app images to **direct**; the `yf-deploy-app` Job image (`BACKEND_IMAGE`)
     and the `ymerflow-app-pull` `--docker-server` use the **direct** address.
   - Step 6c: the app pull Secret must carry credentials for **both** the direct and public
     servers (kubelet matches the pull Secret host to the image ref host).
   - Step 10: `docker/build.sh` pushes the runner image **direct** but persists the **public** ref
     into `Environment.docker_image`.

6. **`docker/build.sh`** — push to direct, resolve+persist `FULL_IMAGE` as the public ref; the
   `db-update` Job's own container image is a transient bootstrap container → **direct**.

7. **`dev/runall.sh`** — mirror the direct-default so the local/dev path (no public URL) is
   unchanged (public==direct==node IP).

8. **`config.env.example`** (+ `.local` / `.gcp` / `.mixed` comment blocks) — document the
   public-vs-direct split and the "unset public ⇒ direct" default.

## Verification / test plan

- **(a) No public URL** (`REGISTRY_PUBLIC_HOST` unset): every image ref is `node-IP:30500`;
  `git`-diff of a rendered deploy is byte-for-byte vs. pre-change. Local `dev/runall.sh` works.
- **(b) External TLS termination** (`REGISTRY_PUBLIC_HOST=<external>`, `PUBLIC_TLS` empty): probe
  passes immediately; backend+runner refs are the external host; frontend/deployer stay direct
  (node IP, in-cluster reachable); no certbot dependency exercised.
- **letsencrypt same-box first boot**: frontend comes up, probe blocks on ACME, then backend pulls
  public; runner job pod event shows `registry.redhog.org/...` not the LAN IP.
- **letsencrypt re-run** (cert on PVC): probe passes immediately; no stall.
- Push-direct / pull-public identity: confirm a digest pushed to `node-IP:30500` is pullable via
  `registry.redhog.org:443` (same registry pod).

## Open questions to settle before/at implementation

1. **Public hostname:** `config.env` + the LE cert SAN + the nginx edge use `registry.redhog.org`;
   the operator's message said `repository.redhog.org`. Assume `registry.redhog.org` (no new
   DNS/cert/nginx work) unless a new subdomain is actually wanted.
2. **Direct address source:** default to `$(hostname -I | awk '{print $1}')` (the proven,
   currently-working value) vs `minikube ip`. Plan assumes the former.
3. **Wait vs. self-heal:** implement the explicit edge probe/wait (clean first-boot) or rely purely
   on `ImagePullBackOff` retry (simpler, noisier). Plan assumes explicit wait with self-heal as
   fallback.
4. **Multi-server app pull Secret:** confirm the kubelet host-match for a dockerconfigjson with two
   `auths` entries (direct + public) behaves as expected for the two app Deployments.

# Public registry addressing + a self-service "minikube" cluster type — Plan

## Goal & scope

Registering a second, remote cluster (e.g. a minikube instance on another host, such as `mimer`)
currently fails in two ways once you actually try to run a process on it:

1. **Image pull is unreachable.** `Environment.docker_image` is a fully-qualified image reference
   baked in at build time by `docker/build.sh`, using the *local* minikube VM's private IP
   (`$(minikube ip):30500`). That address is meaningless from any other host's cluster.
2. **Nothing sets up a newly-registered cluster's Kubernetes-side prerequisites** (namespace, Kueue
   operator + queues, RBAC, registry pull trust). Today only `dev/setup-minikube.sh` does this, by
   hand, once, against the single default/bootstrap cluster.

Both gaps were explicitly flagged and deferred to this work by earlier plans:

- `docs/plans/done/self-signed-tls-minio-registry.md` (Phase 2, "Out of scope"): *"A second machine's
  pods pulling from this registry would need a `docker-registry` imagePullSecret in the pod spec...
  plus `--insecure-registry`/CA on that node — that belongs to the multi-cluster job-dispatch work."*
- `docs/plans/done/expose-nodeports-on-host.md` (Follow-ups): *"The other machine's backend, to
  dispatch Jobs here, needs this cluster's client credentials... Out of scope for this script change;
  note it for the multi-cluster work."*

This is that work. Scope:

- Make the registry's now-publicly-exposed address (`docs/plans/done/expose-nodeports-on-host.md`)
  the one address used everywhere — local minikube included — instead of the minikube-internal IP.
- Add a **new, additive `minikube` cluster type** that turns cluster registration into: copy one
  command, paste it into an SSH shell on the target host, done. The existing `same_as_backend` and
  `kubeconfig` (generic, paste-a-kubeconfig-you-already-have) cluster types are unchanged — `minikube`
  sits alongside them, it does not replace either.

Out of scope: cloud-managed clusters (GKE/EKS/etc). Those would use the cloud provider's own registry
(GCR/Artifact Registry/ECR) with IAM-based pull auth, which sidesteps the self-signed-TLS-trust
problem entirely — a different registry *backend*, not addressed here. GKE specifically has its own
viable path (a `gcloud container node-pools ... --metadata-from-file startup-script=...` that installs
the registry's CA into every node, Standard mode only — Autopilot forbids node customization
entirely), but that's a separate future plan, not built here.

## Background — current state

(Confirmed by reading the code.)

- **Registry already exists and is already exposed.** `dev/setup-registry.sh` deploys a real
  `registry:2` (namespace `registry`) with self-signed TLS + HTTP basic auth
  (`REGISTRY_USER`/`REGISTRY_PASSWORD`), on NodePort `30500`, published on the host per
  `docs/plans/done/expose-nodeports-on-host.md`. `docker/build.sh` already builds **and pushes** — the
  "images just live in minikube's docker daemon" claim in `docs/architecture/environment.md` is stale.
- **The address baked into every image reference is minikube-internal.** `docker/build.sh` computes
  `REGISTRY_URL="$(minikube ip):30500"`, pushes there, and writes the resulting reference into
  `Environment.docker_image`. `job_orchestrator.py` uses that string verbatim as the Job's container
  `image` — it is not derived from the target `Cluster` at submission time. `prod/runall-minikube.sh`
  writes the same minikube-IP value into the backend's `REGISTRY_URL` ConfigMap entry (used only for
  in-pod secondary pulls, e.g. `build_frontend_plugin`).
- **This was a deliberate design choice that didn't anticipate remote clusters.**
  `docs/plans/done/cluster-registry-global-not-per-cluster.md` removed per-`Cluster`
  `registry_url`/`registry_auth` columns, on the premise that every cluster reaches the same one
  global registry. That premise breaks once the registry's only advertised address is a private
  per-host IP.
- **No image pull auth exists for pods.** `job_orchestrator.py`'s `V1PodSpec` sets no
  `image_pull_secrets`; nothing in the codebase creates a `kubernetes.io/dockerconfigjson` Secret.
  Local pods get away with this only because `image_pull_policy="IfNotPresent"` and the image is
  already present in minikube's own daemon from the `docker/build.sh` push.
- **No registry TLS trust exists for a remote node.** The registry's TLS is deliberately "Level A" —
  encrypt, skip verification (`docs/plans/done/self-signed-tls-minio-registry.md`) — made to work
  locally only because `dev/setup-minikube.sh` adds the registry to the local minikube VM's Docker
  `--insecure-registry` list at `minikube start` time. A different host's Docker has no such entry.
- **There is already a "copy a command, paste it into a shell" precedent** —
  `frontend/src/clusterProviders/KubeconfigClusterForm.jsx:4-5` shows (with a copy button) a
  `kubectl config view --raw --minify --flatten | sed -E "s#(server: https://)[^:]+:8443#...#"`
  one-liner, meant to be run on the target host, whose output the admin pastes into the kubeconfig
  textarea below it. The `minikube` cluster type below generalizes this into a full setup-and-callback
  script instead of a manual extract-and-paste.
- **`ClusterProvider` has no provisioning hook today.**
  `backend/services/cluster_providers/__init__.py` defines only `connect()` and `test_connection()`.
  `KubeconfigClusterProvider` (`cluster_providers/kubeconfig.py`) only normalizes the kubeconfig and
  delegates `test_connection`. Cluster types are dispatched via a `cluster_provider_handlers` hook
  (same pattern as `storage_protocol_handlers`), and the frontend's per-type form is likewise
  hook-driven (`hooks.run.cluster_provider_forms()`, `frontend/src/ClustersAdminPanel.jsx:21`) — a new
  `minikube` type plugs into both hooks without touching the existing two providers.
- **`dev/setup-minikube.sh` is pure bash and is the only place any of the app-level provisioning is
  actually built today**: creates `nagelfluh-jobs`, installs Kueue (`kubectl apply --server-side -f
  .../kueue/.../manifests.yaml`, waits for CRDs/controller/webhook), computes CPU/memory quotas from
  `MINIKUBE_CPUS`/`MINIKUBE_MEMORY`, expands `k8s/kueue/cluster-queue.yaml.in`, applies it. It never
  applies `k8s/rbac/backend-jobs-rbac.yaml` — only `prod/runall-minikube.sh`'s recursive
  `kubectl apply -R -f k8s/` does that, for the one cluster it targets. This is an existing gap worth
  closing as part of factoring this logic out (Phase 2 below), not just replicating it.
- **Minikube supports host-side file injection at `minikube start` time**: anything placed under
  `~/.minikube/files/<path>` gets copied to the corresponding path inside the node. This is the
  mechanism used for registry CA trust (Phase 3) — no in-cluster DaemonSet needed, since the setup
  script runs directly on the host with real root/SSH access.

## Design decisions (settled in discussion)

1. **Registry addressing: one public address, used everywhere, always.** Both `docker/build.sh`'s
   push and every cluster's pull (local minikube included) use the same publicly-exposed
   `host:30500` address. No per-cluster branching. Configured via a new `config.env` var (working
   name `REGISTRY_PUBLIC_HOST`, alongside the existing `MINIKUBE_APISERVER_IPS` LAN-IP pattern). Flag
   at implementation: confirm minikube's own node can route back to the host's public IP:port for its
   *own* push/pull (hairpin NAT) — if not, document as a caveat, not a redesign.
2. **New, additive `minikube` cluster type. `same_as_backend` and `kubeconfig` are unchanged.** This
   is specifically for "I stood up (or will stand up) a minikube instance on a host I have shell
   access to" — the realistic majority case for this on-prem-ish tool. The generic `kubeconfig` type
   remains for anyone who already has a kubeconfig from anywhere and doesn't need any of this
   automation.
3. **Registration flow for `minikube`, one command, one paste:**
   - Admin clicks "Add Cluster" → type `minikube`. Backend creates the `Cluster` row up front in a
     pending state, plus a **single-use, short-lived (~30–60 min) registration token**, stored hashed.
   - UI shows one command (reusing the existing copy-button UI pattern from
     `KubeconfigClusterForm.jsx`):
     ```
     curl -fsSL http://<nagelfluh-host>/static/assets/setup-minikube-remote.sh \
       | REGISTER_TOKEN=<token> bash
     ```
   - Admin pastes it into an SSH session on the target host. The script:
     - Installs minikube if the binary is missing (assumes Docker + sudo already present on the
       host — not itself installed by this script).
     - Drops the registry's CA cert into `~/.minikube/files/etc/docker/certs.d/<host:port>/ca.crt`
       *before* `minikube start`, so the very first pull is already trusted, and it survives any
       future `minikube delete && minikube start` recreate (files-based, not a live edit of a running
       node).
     - Runs (or reconciles) `minikube start`.
     - Runs the shared provisioning logic (Phase 2) — namespace, Kueue operator, RBAC, queues,
       imagePullSecret.
     - Extracts the kubeconfig using the existing sed-rewrite (host IP + docker-published apiserver
       port), same logic as today's `KUBECONFIG_COMMAND`.
     - POSTs it back: `wget --post-data=... --header="Authorization: Bearer $REGISTER_TOKEN" http://<nagelfluh-host>/admin/clusters/register-callback`.
   - Backend validates the token against the pending row (single-use — invalidated immediately on
     redemption; rejected if expired), stores the kubeconfig into that `Cluster`'s `provider_config`,
     marks it active.
   - Frontend polls the pending cluster and flips from "waiting..." to "connected" once redeemed.
   - The whole script must be **idempotent** — safe to re-paste if the callback fails partway (network
     blip, expired token before the POST lands), rather than leaving a half-provisioned host.
4. **Registry TLS trust: handled directly by the host script, no DaemonSet.** Since the script has
   real root access to the actual host, this is just a file write — the earlier DaemonSet-based
   approach (considered when we thought this had to run purely over the Kubernetes API from the
   backend) is unnecessary for this cluster type.
5. **`curl | bash` over plain HTTP is not a special risk to design around.** It's only a risk if the
   backend itself isn't proxied behind TLS — which is a choice already visible and owned by the
   operator via `config.env`/`SERVER_URL`, not something new introduced here.
6. **Shared provisioning logic is shell, not Python**, since the remote host has no YmerFlow Python
   backend installed on it. The namespace/Kueue-operator/RBAC/queue steps in `dev/setup-minikube.sh`
   get factored into a reusable script/section, sourced by both the local dev/prod bootstrap flow and
   the new remote setup script — not a Python module the shell calls into.
7. **Kueue operator install is included** (CRDs + controller + webhook + readiness waits, same as
   today's `setup-minikube.sh`) — since it now runs synchronously inside a script the admin is
   watching in their own SSH session (not inside an HTTP request to the backend), there's no need for
   the async background-task/status-polling machinery that would have been required if this ran
   through the K8s API from the backend instead.

---

## Phase 1 — Registry: always address it publicly

- `config.env.example`: add `REGISTRY_PUBLIC_HOST` (default derived from the LAN IP, same pattern as
  `MINIKUBE_APISERVER_IPS`), documented alongside the existing `REGISTRY_USER`/`REGISTRY_PASSWORD`.
- `docker/build.sh`: replace `REGISTRY_URL="$(minikube ip):30500"` with
  `REGISTRY_URL="${REGISTRY_PUBLIC_HOST}:30500"`.
- `prod/runall-minikube.sh`: the `REGISTRY_URL` ConfigMap entry uses the same public value.
- Rollout note (not a data migration): existing `Environment` rows keep whatever `docker_image` they
  were built with; they only pick up the public address the next time `docker/build.sh` runs.

## Phase 2 — Factor out shared provisioning shell logic (+ close the RBAC gap)

- Extract `dev/setup-minikube.sh`'s namespace-create, Kueue-operator-install (with CRD/controller/
  webhook readiness waits), quota computation, and Kueue queue-apply steps into a reusable script
  (e.g. `dev/lib/provision-nagelfluh-jobs.sh`), sourced by `dev/setup-minikube.sh` itself.
- Add applying `k8s/rbac/backend-jobs-rbac.yaml` to this shared routine — today only
  `prod/runall-minikube.sh`'s blanket `kubectl apply -R -f k8s/` does this; folding it into the shared
  provisioning step means local dev gets correct RBAC too, and the new remote script gets it for free.
- Add creating the `kubernetes.io/dockerconfigjson` imagePullSecret (from
  `REGISTRY_USER`/`REGISTRY_PASSWORD`) into this shared routine as well (needed by Phase 6 below
  regardless of cluster type).

## Phase 3 — Remote setup-and-callback script

- New script (e.g. `dev/setup-minikube-remote.sh`), served as a static/templated asset by the backend
  (decide at implementation whether it's a plain static file or a small endpoint that renders it with
  the backend's own `REGISTRY_PUBLIC_HOST`/`REGISTRY_USER`/`REGISTRY_PASSWORD`/CA cert baked in, so the
  pasted command needs no extra flags beyond the token).
- Steps: check for the `minikube` binary, install if missing; write the registry CA into
  `~/.minikube/files/etc/docker/certs.d/<host:port>/ca.crt`; `minikube start` (idempotent — safe if
  already running); source Phase 2's shared provisioning script; extract the kubeconfig (reuse the
  sed-rewrite logic from `KubeconfigClusterForm.jsx`'s command); POST it to the callback endpoint with
  `wget --post-data`.
- Explicitly document host assumptions (Docker + sudo already present; Linux only for now).

## Phase 4 — Backend: pending registration + single-use token + callback endpoint

- `Cluster` model: add provisioning-state fields (e.g. `provisioning_status`:
  `pending`/`awaiting_callback`/`active`/`failed`) and a token table/columns (hashed token,
  `expires_at`, redeemed-or-not) — decide at implementation whether the token lives on `Cluster`
  directly or in a small separate table.
- `admin_create_cluster`: when `cluster_type == "minikube"`, create the row + token instead of
  requiring `provider_config` up front; return the token (once) to the frontend for display in the
  command.
- New endpoint, e.g. `POST /admin/clusters/{id}/register-callback` — authenticated only by the
  bearer token (not the normal admin session, since it's called by `wget` from an arbitrary host), body
  `{"kubeconfig": "..."}`. Validates token (exists, unexpired, unused), stores
  `provider_config = {"kubeconfig": ...}`, flips status to `active`, invalidates the token immediately.

## Phase 5 — New `MinikubeClusterProvider`

- `backend/services/cluster_providers/minikube.py`: `connect()`/`test_connection()` identical to
  `KubeconfigClusterProvider` (both ultimately just hold a kubeconfig) — consider having it subclass
  or delegate to `KubeconfigClusterProvider` for those two methods, since the only real difference is
  the registration UX, not the runtime connection mechanism.
- Register it under the existing `cluster_provider_handlers` hook alongside the other two providers.

## Phase 6 — Frontend: `minikube` cluster form + pending-state UI

- New `frontend/src/clusterProviders/MinikubeClusterForm.jsx`: on selecting this type in "Add
  Cluster", triggers pending-registration creation, then shows the command with the same copy-button
  pattern as `KubeconfigClusterForm.jsx` (no manual kubeconfig textarea — this type never asks the
  admin to paste one back).
- `ClustersAdminPanel.jsx`: show provisioning status per cluster row (`pending` → `awaiting callback`
  → `active`/`failed`), polling while not yet resolved.

## Phase 7 — `imagePullSecrets` in `job_orchestrator.py`

- `V1PodSpec` construction gains `image_pull_secrets=[client.V1LocalObjectReference(name=...)]`,
  referencing the Secret created by Phase 2's shared provisioning routine — needed regardless of
  which cluster type is in play, including the local default cluster.

---

## Manual verification

- Local (default) cluster: fresh `runall`, confirm the refactored shared provisioning (Phase 2)
  produces the same end state as today (namespace, Kueue queues, RBAC — now actually applied locally
  too, imagePullSecret present); a process still runs end-to-end.
- Register `mimer` as a `minikube` cluster: copy the shown command, paste into an SSH session on
  `mimer` as `compute`, confirm the script installs minikube (if not already present), completes
  without manual intervention, and the admin UI flips to "active" once the callback lands — no manual
  kubeconfig paste, no SSH beyond the one paste.
- Submit a process targeting the `mimer` cluster: Job is admitted by Kueue and runs; pod pulls the
  runner image using the public registry address with no `x509`/`ImagePullBackOff` errors.
- Re-paste the same command on an already-provisioned `mimer` host (idempotency check) — no errors, no
  duplicate objects, callback either no-ops or is rejected cleanly if the token was already redeemed.
- Confirm an expired or already-used registration token is rejected by the callback endpoint.
- Confirm the existing `kubeconfig` (generic) and `same_as_backend` cluster types are untouched —
  register one of each, unaffected by any of the above changes.

## Open questions / follow-ups

- Static-file vs. templated-endpoint delivery for the setup script — decide at implementation.
  **Resolved:** a small unauthenticated endpoint, `GET /static/assets/setup-minikube-remote.sh`
  (`backend/routers/admin.py`). It reads `dev/setup-minikube-remote.sh.in` (a template with
  `__TOKEN_LIKE__` placeholders) and `dev/lib/provision-nagelfluh-jobs.sh` off disk, live-fetches
  the registry's TLS cert via `ssl.get_server_certificate((registry_public_host, 30500))` (no
  filesystem/Secret access needed — it's self-signed, so the presented cert *is* its own CA), and
  string-substitutes everything into one self-contained script. `backend/Dockerfile` now also
  `COPY dev/ dev/` so these two files exist at runtime in the prod image.
- Whether the registration token belongs on `Cluster` directly or a separate pending-registrations
  table — decide at implementation based on what's cleaner given the existing `Cluster` model.
  **Resolved:** on `Cluster` directly (`provisioning_status`, `registration_token_hash`,
  `registration_token_expires_at`), same pattern as `ApiKey.key_hash`. Migration
  `b94dfd20b859_cluster_registration_token.py`. Callback endpoint
  (`POST /admin/clusters/register-callback`) has **no cluster id in the path** — it looks the
  pending `Cluster` up by matching the hashed bearer token, per the literal curl example in Design
  decision 3 (the Phase 4 section's `{id}` in the URL sketch didn't match that example; the
  no-id form is what got built).
- OS/architecture assumptions for "install minikube if missing" (Linux x86_64 only, for now?).
  **Resolved:** Linux x86_64 and arm64 (`uname -m` dispatch), matching the two arches minikube's
  own release artifacts cover.
- GKE gets its own separate plan later (gcloud node-pool `startup-script` metadata), not built here.
- Not built (acceptable gaps, none blocked verification): no "regenerate token" or "delete cluster"
  endpoint — if a token expires before the callback lands, the admin's only path today is creating
  a new `minikube`-type cluster (the stale pending/failed row is harmless and stays inactive). The
  three-state `provisioning_status` (`pending`/`active`/`failed`) dropped the plan's sketched
  `awaiting_callback` — callback handling is one atomic request, so that state had no observable
  window to occupy.

# Generic config.env passthrough to the backend pod — Plan

## Goal

Core deployment code (`prod/runall-production.sh`, `backend/bin/nagelfluh-deploy-app`,
`backend/services/app_deployment.py`) must not need to know the name of every individual
`config.env` variable a plugin's runtime config depends on. Today it does — a plugin (e.g.
`ymerflow-plugin-tickets-github`, needing `TICKETS_GITHUB_REPO_OWNER`/`_REPO_NAME`/`_TOKEN`) can set
its values in `config.env`, but they never reach the in-cluster backend pod because two separate
hand-curated allowlists in core code decide what gets forwarded. Any key not on those lists is
silently dropped, and the plugin's `pydantic_settings.BaseSettings` sees `None` for everything —
this is what caused the "GitHub ticket submission is not configured on this server" 503 despite
`config.env` being correctly filled in.

After this plan, adding a new plugin config var means editing `config.env` (and the plugin's own
`config.py`) only — zero changes anywhere in core deployment code, matching how the dev path
(`source config.env` in `backend/run.sh`/`dev/runall.sh`) already works today for free.

## Background — current state

(Confirmed by reading the implemented code, not just the docs.)

- **The dev path already does this for free.** `backend/run.sh`/`dev/runall.sh` both do
  `set -a; source config.env; set +a` before starting uvicorn directly on the host — every
  `config.env` key is in `os.environ`, so `pydantic_settings.BaseSettings` (which reads
  `os.environ` directly, `env_file` aside) sees everything. No change needed on this path.
- **The prod/minikube path (`prod/runall-production.sh`) goes through Kubernetes and re-derives
  the pod's environment twice, via two independent hand-curated lists, neither of which knows
  about plugin-specific keys:**
  1. **Step 6** (`prod/runall-production.sh` ~line 234-348) builds `nagelfluh-backend-secret` from
     an explicit `BACKEND_SECRET_ARGS` bash array of `--from-literal=KEY=value` entries, and a
     separate `nagelfluh-backend-config` ConfigMap from a literal heredoc. Some of these values are
     genuinely *computed*, not raw `config.env` values (`DATABASE_URL` has the real Postgres
     password inlined; `REGISTRY_AUTH` is base64'd; `REGISTRY_PROTOCOL`/`STORAGE_PROTOCOL`/
     `CLUSTER_TYPE` + their `*_CONFIG_JSON` are the *bootstrap-enriched* versions from Step 3,
     which can differ from whatever raw value is still sitting in `config.env`). Others
     (`JWT_SECRET_KEY`, `ADMIN_USERNAME`/`ADMIN_PASSWORD`) are plain conditional copies of a
     `config.env` value with no transformation at all.
  2. This Step 6 Secret/ConfigMap is only a **bootstrap seed** — per the existing comment at the
     top of that section, `backend/services/app_deployment.py`'s `apply_app_workloads()` (invoked
     from Step 9's `nagelfluh-deploy-app` Job) is "the authority for their final state," and it
     re-applies (create-or-patch) both objects from whatever `app_config`/`secrets` dicts
     `backend/bin/nagelfluh-deploy-app` built. That script builds them from **its own second,
     independent allowlist** — module-level `CONFIG_KEYS`/`SECRET_KEYS` lists — read via
     `_pick(keys)` off `os.environ` (its own pod env, itself populated by `envFrom`-ing Step 6's
     Secret/ConfigMap). A key missing from `CONFIG_KEYS`/`SECRET_KEYS` is stripped back out on
     every redeploy even if Step 6 happened to include it.
  - **Net effect: a plugin's `config.env` vars are dropped twice over** — first because Step 6's
    `BACKEND_SECRET_ARGS` doesn't mention them, and even if it did, `nagelfluh-deploy-app`'s
    `CONFIG_KEYS`/`SECRET_KEYS` would strip them back out on the very next redeploy.
- **`app_config` is a plain Python dict, not something that must correspond to a real K8s
  ConfigMap object.** Checked every consumer (`backend/services/cluster_providers/__init__.py`,
  `backend/services/cluster_providers/nodeport_app_deployment.py`,
  `backend/services/app_deployment.py`): it's only ever read via `.get()`/`.pop()` — including two
  non-string, Python-only entries (`_image_pull_credentials`, `_replicas`) that were never
  ConfigMap material to begin with, already popped out before `apply_app_workloads()` runs. No
  plugin-provided `ClusterProvider` exists yet in `plugins/` that implements `deploy_app()`/
  `expose_app()` (grepped — only core's `same-as-backend`/`minikube`, via
  `nodeport_app_deployment.py`, do), so nothing depends on the ConfigMap object's existence beyond
  core code itself.
- **Settled in discussion:** everything collapses into the single `nagelfluh-backend-secret`
  Secret (one K8s object, many keys in its `data` map — `envFrom` already flattens each key in a
  Secret to its own container env var, so this is one object, not one-Secret-per-key). The
  `nagelfluh-backend-config` ConfigMap is retired. Rationale (from discussion): the only real
  differences between a ConfigMap and a Secret in this deployment are that `kubectl get -o yaml`
  shows a ConfigMap's values in plaintext vs. base64 for a Secret, and that RBAC *could* grant
  broader read access to ConfigMaps than Secrets — Nagelfluh sets up no such split RBAC today, so
  keeping two objects buys nothing and forces the exact kind of "which list does this key belong
  on" classification the plugin-coupling problem is about.

## Design decisions (settled in discussion)

1. **All keys defined in `config.env` are forwarded generically** to every pod that needs app
   runtime config (migration Job, backend Deployment, frontend Deployment, and the
   `nagelfluh-deploy-app` Job itself) via the single `nagelfluh-backend-secret` Secret. Plugin
   authors need touch only `config.env` (and their own plugin's `config.py`) — never core
   deployment code.
2. **A small, fixed set of script-computed/derived values still wins over the generic layer**,
   applied as overrides after the generic passthrough: `DATABASE_URL`, `REGISTRY_AUTH`,
   `MC_HOST_minio`, `MINIO_ROOT_PASSWORD` (default-fallback), the bootstrap-enriched
   `REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON`/`STORAGE_PROTOCOL`/`STORAGE_CONFIG_JSON`/
   `CLUSTER_TYPE`/`CLUSTER_CONFIG_JSON` pairs, and `JWT_SECRET_KEY`'s existing generate-or-reuse
   logic (already correct and untouched — Design decision 5 of
   `docs/plans/done/app-deployment-hooks.md`). These are the only keys core code is still allowed
   to know by name; everything else is opaque, plugin-owned data core code never inspects or lists.
3. **Passthrough is scoped to "what's actually assigned in `config.env`," not "whatever's in the
   process's environment at that point"** — this must not leak host/container/K8s runtime noise
   (`PATH`, `HOME`, `KUBERNETES_SERVICE_HOST`, etc.) into the Secret:
   - In `prod/runall-production.sh` (Step 6): parse `config.env`'s own `KEY=VALUE` assignments
     directly, rather than dumping the shell's exported environment (which would also carry every
     inherited host var).
   - In `backend/bin/nagelfluh-deploy-app`: its pod's env is populated purely by `envFrom`-ing the
     Secret Step 6 just built, plus a short, fixed set of Kubernetes/container-runtime-injected
     vars (`PATH`, `HOME`, `HOSTNAME`, `PWD`, `SHLVL`, `TERM`, `LANG`, `PYTHONPATH`,
     `PYTHONUNBUFFERED`, `KUBERNETES_SERVICE_*`, `KUBERNETES_PORT*`) and this script's own
     deploy-time knobs (`APP_BACKEND_REPOSITORY`, `APP_FRONTEND_REPOSITORY`, `APP_IMAGE_TAG`,
     `APP_NAMESPACE`), none of which are app runtime config. Passthrough there = "`os.environ` minus
     that short, fixed, platform-level denylist" — a list about the *platform*, not about any
     plugin, so it never needs editing as plugins add config.
4. **Now-redundant special-case code is removed, not left dormant** (see the itemized list in this
   plan's Goal/discussion — the JWT/ADMIN literal blocks in Step 6, `CONFIG_KEYS`/`SECRET_KEYS` in
   `nagelfluh-deploy-app`, and the ConfigMap machinery in `app_deployment.py`).
5. **Ordering handles the "stale raw value vs. enriched value" case with no extra bookkeeping**:
   generic layer applied first, script-computed overrides applied second and win — same mechanism
   that already made e.g. `REGISTRY_PROTOCOL` correct today, just no longer requiring a bespoke
   `if [ -n ... ]` guard per key.

## Open items to confirm at implementation time

- **Exact denylist for `nagelfluh-deploy-app`'s env** — enumerate from an actual pod's `env`
  output (`kubectl exec` into a throwaway pod using the same image, or inspect the real
  `nagelfluh-deploy-app` Job pod before it exits) rather than guessing, so nothing plugin-relevant
  is accidentally excluded.
- **Parsing `config.env` safely in Step 6.** Values can contain characters that are awkward for a
  hand-rolled bash `KEY=VALUE` regex (base64 JSON blobs with `=` padding, tokens with special
  characters). Recommend a small Python helper (`python-dotenv`'s parser is already a transitive
  dependency via `pydantic-settings`) over hand-rolled bash parsing, since it already has to be
  correct for arbitrary values — confirm this at implementation time rather than assuming bash
  parsing is safe.
- **The three ConfigMap values that are pure script literals, not `config.env`-driven at all**
  (`ACCESS_TOKEN_EXPIRE_DAYS: "30"`, `PROCESS_COST: "0.10"`, `INITIAL_USER_BALANCE: "100.0"`,
  hardcoded in today's heredoc). Two options: (a) make them real `config.env` keys with these as
  defaults, consistent with everything else now flowing through `config.env`, or (b) keep them as
  script-hardcoded literals that get folded into the merged Secret alongside the generic
  passthrough, unchanged from today except for which K8s object they end up in. Leaning (a) for
  consistency, but confirm — it's a small scope increase (operators can now override them) that
  wasn't the original ask.
- Confirm no plugin-provided `ClusterProvider` added between now and implementation time assumes
  the retired `nagelfluh-backend-config` ConfigMap exists (checked now: none do).

## Phases

### Phase 1 — Core plumbing: single Secret, generic passthrough helper
- `backend/services/app_deployment.py`: drop `CONFIG_MAP_NAME`/`_apply_config_map`/the ConfigMap
  half of `_env_from()`. `apply_app_workloads()` merges `app_config` (after `_image_pull_credentials`/
  `_replicas` are popped, as today) together with `secrets` into the one Secret it applies.
- `backend/bin/nagelfluh-deploy-app`: replace the `CONFIG_KEYS`/`SECRET_KEYS` allowlists with the
  generic-minus-denylist mechanism (Design decision 3). `resolved_server_url`'s override of
  `SERVER_URL`/`BACKEND_BASE_URL`, and the `_image_pull_credentials`/`_replicas` special keys,
  keep working exactly as today — they're layered on top of the generic dict, not part of it.

### Phase 2 — `prod/runall-production.sh` Step 6 rework
- Replace `BACKEND_SECRET_ARGS`'s hand-curated `--from-literal` list and the ConfigMap heredoc with:
  generic `config.env` parsing (base layer) → apply the still-needed computed overrides
  (`DATABASE_URL`, `REGISTRY_AUTH`, `MC_HOST_minio`, `MINIO_ROOT_PASSWORD` default, the enriched
  `REGISTRY_*`/`STORAGE_*`/`CLUSTER_*` triples) → drop the now-redundant `JWT_SECRET_KEY`/
  `ADMIN_USERNAME` conditional blocks (generic passthrough already covers them).
- One `kubectl create secret generic nagelfluh-backend-secret` call from the merged map; the
  `nagelfluh-backend-config` ConfigMap heredoc is deleted.

### Phase 3 — Docs + config.env.example
- Update `config.env.example` and relevant docs (`docs/architecture/*`, this plugin's own
  `config.env.example` comment) to state that any plugin config var just needs to be added to
  `config.env` — no core script changes required to reach the backend pod. Remove/correct the
  `ymerflow-plugin-tickets-github` `config.env.example` note if it implies otherwise.

## Manual verification

- Fresh prod/minikube deploy reaches the same observable end state as today: app reachable at
  `SERVER_URL`, migrations applied, admin login works, Headlamp/pgAdmin reachable (parity check).
- `TICKETS_GITHUB_*` (the bug that surfaced this) reaches the running backend pod's environment
  and ticket submission no longer 503s, with zero changes to `prod/runall-production.sh` or
  `nagelfluh-deploy-app` beyond this cleanup itself — i.e. the fix is "add keys to `config.env`,"
  not "also patch a core allowlist."
- JWT key still persists across a `minikube delete && minikube start` recreate (regression check
  on the generate-or-reuse logic, now reached via the merged Secret path).
- Confirm no plugin-provided `ClusterProvider` in `plugins/` assumes the retired
  `nagelfluh-backend-config` ConfigMap exists.

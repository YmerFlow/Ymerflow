# Fix intermittent AKS 401 ("Queue unavailable: Unauthorized") — share one ApiClient per K8sClient

## Goal

Stop the recurring `Queue unavailable: (401) ... "reason":"Unauthorized"` that appears on the
cluster-queues view (and in the backend log) for the AKS cluster after the backend has been up
for roughly one token lifetime (~1h), and intermittently thereafter.

The 401 is **not** a bad credential and **not** a "token never refreshes" bug — a freshly minted
AAD token for the stored service principal is accepted by the AKS API server (verified live: a
fresh mint returns HTTP 200 with the correct audience/issuer/`oid`). The defect is that a single
long-lived `K8sClient` holds **two independent `kubernetes_asyncio` `Configuration` objects**, and
the rotating-token refresh hook keeps only one of them current. Fixing this needs a one-spot change
in the host repo's base `K8sClient`; **no plugin changes are required**, and it also closes the
identical latent bug in the GKE plugin.

## Root cause

- `K8sClient._ensure_initialized()` (`backend/services/k8s_client.py:235-236`) builds its two API
  handles with no explicit `api_client`:
  ```python
  self.batch_api = client.BatchV1Api()
  self.core_api  = client.CoreV1Api()
  ```
  Each bare `*Api()` constructs its own `ApiClient`, which calls `Configuration.get_default_copy()`
  — a **separate** `Configuration` instance with its own `api_key` dict. So one `K8sClient` has two
  independent copies of the bearer-token header. (`ApiClient.__init__` stores a *passed*
  configuration by reference and only copies when the argument is `None` — confirmed in the
  installed `kubernetes_asyncio` 36.1.0.)

- The AKS client (`plugins/ymerflow-azure/azure_plugin/cluster_provider.py:665-683`) rotates its
  token via a `refresh_api_key_hook`. The hook is gated on the **shared** `self._access_token` but
  writes the new token only into the **one** `configuration` whose request triggered it:
  ```python
  def _refresh_api_key_hook(configuration):
      now = time.time()
      if self._access_token is None or self._access_token.expires_on - now < 300:
          self._access_token = _mint_aks_token(...)              # shared gate
          configuration.api_key['authorization'] = f"Bearer {…}" # per-config write
  for api in (self.batch_api, self.core_api):                    # two separate configs
      ...
      configuration.refresh_api_key_hook = _refresh_api_key_hook
  ```
  Once any one config refreshes `self._access_token`, every *other* config's hook sees the shared
  token as fresh (`expires_on - now >= 300`) and does nothing — leaving its own header pinned to the
  now-expired token.

- `ProcessVersion.monitor_job` (`backend/models/process.py:578,721,789`) polls `get_job_status` →
  `batch_api.read_namespaced_job` every 5 s on the same cached client, so `batch_api` almost always
  "wins" the refresh race near expiry and writes the new token into **its** config. The
  cluster-queues endpoint (`backend/routers/utilities.py:124-128` → `list_workloads` / `list_pods` /
  `get_cluster_queue_limits`) goes exclusively through **`core_api`**, whose config is left stale →
  **401**. It is intermittent (166 events over 25 days, in bursts) because `core_api` recovers for a
  cycle only when one of its own requests happens to land inside the 5-minute refresh window before
  the batch poller does.

- Evidence (prod backend `backend-8777749cb-pcvnj`, pod up since 2026-09-17T19:29Z): first 401 at
  20:45Z (~1h16m uptime, i.e. after the first token-expiry cycle), never during the first hour; at
  20:54Z `batch_api.read_namespaced_job` returned **404** (authenticated — valid token) while
  `core_api` cluster-queues calls in the same window returned **401** — the two handles
  demonstrably held *different* tokens at the same instant, only possible with two configs.

- **GKE has the identical pattern** (`plugins/ymerflow-gcp/.../cluster_provider.py:651-672`:
  `super()._ensure_initialized()` then the same `for api in (self.batch_api, self.core_api)` hook
  loop). It would 401 the same way; it just isn't exercised yet.

## Change

### `backend/services/k8s_client.py`

In `_ensure_initialized()` (currently lines 235-236), build a single `ApiClient` after the
kubeconfig / in-cluster config has been loaded, and derive both API handles from it:

```python
self._api_client = client.ApiClient()          # uses the default config just loaded above
self.batch_api = client.BatchV1Api(self._api_client)
self.core_api  = client.CoreV1Api(self._api_client)
```

That is the entire fix. Both handles now share one `Configuration` (one `api_key` dict), so the
AKS/GKE hook's `self._access_token` gate and its `configuration.api_key['authorization']` write
operate on the same object — the refreshed token is seen by Jobs, Pods, and the Kueue
`CustomObjectsApi` (already built from `self.core_api.api_client`) alike.

### Why no plugin changes are needed

- Both plugins' hook loops (`for api in (self.batch_api, self.core_api)`) keep working unchanged:
  after this change the loop iterates the **same** configuration object twice and sets the identical
  hook/header on it twice — harmless, and it stops being buggy because there is now only one config.
- `list_workloads` / `get_cluster_queue_limits` already build `CustomObjectsApi(self.core_api.
  api_client)`, so they transitively pick up the shared config for free.
- Static-token cluster types (`same-as-backend`, `kubeconfig`, minikube) are unaffected — sharing
  one config for an immutable token is strictly fine.
- GKE is fixed transitively by this same host edit; **no change to the gcp plugin**.

### Explicitly out of scope (keep the diff minimal)

- Do **not** touch the `for api in (...)` loops in either plugin. They are now redundant (same
  object twice) but editing them is cosmetic and would mean plugin releases this fix deliberately
  avoids.
- Do **not** add `apps_api`, `K8sClient.close()`, a `K8sClientRegistry.close_all()`, or a
  `main.py` shutdown event here — those belong to the separate aiohttp-session-leak work (see
  overlap note).
- No DB migration, no API-shape change, no frontend change.

## Overlap with `docs/plans/fix-k8s-aiohttp-session-leaks.md` (MUST reconcile before implementing)

That plan's **change 5** proposes the *same* shared-`ApiClient` edit in the *same* method, for a
different reason (closing leaked aiohttp sessions), and additionally adds `self.apps_api`, a
`close()` method, `K8sClientRegistry.close_all()`, a `main.py` shutdown event, and an
`app_deployment.py` tweak. (Its line references — 55-71 — are stale; the file has since grown and
the method is now at ~221-237.)

Reconcile as follows:

- **If the aiohttp-leak plan is implemented first:** this 401 is fixed transitively by its change 5.
  This plan then needs no code — close it as "subsumed", keeping only the root-cause writeup for the
  record.
- **If this plan is implemented first:** do the two-line shared-`ApiClient` edit only. When the
  aiohttp-leak plan later lands, its change 5 overlaps the lines this plan touched — merge rather
  than duplicate (its version adds `apps_api` + `self._api_client` retention for `close()`), and the
  shared-`ApiClient` part is already done.

Do not implement both independently against the same lines.

## Verification

The bug only manifests after a token-expiry boundary, so verify at two levels.

1. **Shared-config assertion (fast, no waiting).** After a `K8sClient._ensure_initialized()`,
   confirm the two handles share one configuration and that a `CustomObjectsApi` built the way the
   code does picks up a mutation to it:
   ```python
   assert kc.batch_api.api_client is kc.core_api.api_client
   assert kc.batch_api.api_client.configuration is kc.core_api.api_client.configuration
   cfg = kc.core_api.api_client.configuration
   cfg.api_key['authorization'] = 'Bearer SENTINEL'
   assert client.CustomObjectsApi(kc.core_api.api_client).api_client.configuration.api_key['authorization'] == 'Bearer SENTINEL'
   ```
   (Can be a throwaway check or a small pytest against a `K8sClient` built with a dummy kubeconfig —
   no cluster needed.)

2. **Live confirmation across a token cycle (AKS).** After deploying the fixed backend, keep a
   process/job running on the AKS cluster (so `monitor_job` drives `batch_api` every 5 s) and leave
   the cluster-queues view polling. Watch the backend log for ≥ ~70 min (past one ~60-min token
   lifetime, ideally two):
   ```
   kubectl logs -n ymerflow <backend-pod> -f | grep -E "Could not read ClusterQueue|Could not list workloads"
   ```
   Expect **zero** new 401s across the expiry boundary (pre-fix, the first 401 appeared ~1h16m
   after pod start and recurred in bursts). A `ClientSecretCredential.get_token succeeded` line
   should still appear ~once per hour (the refresh is still happening) but must no longer be
   followed by a cluster-queues 401.

3. **Regression check for static clusters.** Confirm job submission/monitoring on the local
   minikube cluster still works unchanged (it uses the same base `_ensure_initialized`), and that
   `GET /utilities/cluster-queues` returns the minikube cluster's queue with no `queue_error`.

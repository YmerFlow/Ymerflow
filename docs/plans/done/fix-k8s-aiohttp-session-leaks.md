# Fix leaked aiohttp sessions and the hourly event-loop stall in K8s API calls

## Goal

Two related problems in how the backend and the minikube plugin talk to the Kubernetes API:

1. **Leaked `aiohttp` sessions.** Every `kubernetes_asyncio` API class (`CoreV1Api()`,
   `AppsV1Api()`, `BatchV1Api()`, ...) called with no explicit `api_client` argument builds its own
   throwaway `ApiClient`, which opens its own `aiohttp.ClientSession`/`TCPConnector`. None of these
   are ever closed, so garbage collection prints "Unclosed client session" / "Unclosed connector"
   warnings — most visibly during `yf-bootstrap-provision` (`prod/runall-minikube.sh` Step 3),
   where each `bootstrap()` call tears its event loop down (`asyncio.run()`) immediately after
   leaking several sessions. Fix this by sharing one `ApiClient` per logical unit of work and
   closing it explicitly, instead of leaving cleanup to the garbage collector.

2. **The hourly event-loop stall on cloud token refresh.** `GkeK8sClient` and `AksK8sClient`
   install a `kubernetes_asyncio` `refresh_api_key_hook` that is **synchronous** (the library calls
   it in the request path with no `await`). When the bearer token crosses its refresh margin (~once
   an hour), the hook mints a new token *inline* with a **blocking** network call —
   `google.auth.Credentials.refresh()` (GKE) / `ClientSecretCredential.get_token()` (AKS) — on the
   event loop thread. That blocking round-trip to Google/Azure AD freezes the entire backend event
   loop until it returns. (The in-code comments wave this away as "cheap/rare"; rare does not make
   it non-blocking.) Fix this by moving token refresh off the hot path into a background task that
   mints the new token in a worker thread (`asyncio.to_thread`) shortly *before* expiry and swaps
   the header in, so no request ever blocks the loop on a token mint.

These share a root cause (the `ApiClient`/`Configuration` lifecycle) and a fix site (`K8sClient`),
so they are done together: the background refresh task's lifecycle hangs off the same `close()`
method the session-leak fix adds.

## Current state

### Session leaks

- **`plugins/ymerflow-minikube/minikube_plugin/k8s_apply.py`** — `run_k8s(coro_fn)` (line 51-58)
  runs `coro_fn()` inside a fresh `asyncio.run(_wrapper())`. Every helper in this file does
  `client.CoreV1Api()` / `client.AppsV1Api()` with no `api_client` arg — a fresh session per call:
  - `ensure_namespace` (61), `apply_secret` (70), `apply_config_map` (85) → `CoreV1Api()`
  - `apply_deployment` (100) → `AppsV1Api()`
  - `apply_service` (111), `apply_persistent_volume` (129), `apply_persistent_volume_claim` (144)
    → `CoreV1Api()`
  - `delete_namespace` (155), `delete_persistent_volume` (168) → `CoreV1Api()` *(teardown helpers;
    the previous draft of this plan missed these — they leak too and keep the verification grep
    non-empty)*
  - `wait_deployment_available` (179) → `AppsV1Api()`

  `_create_or_patch` (42) and `_call_with_webhook_retry` (30) only take zero-arg callables and are
  unchanged.

  A single `bootstrap()` makes 8-9 such calls inside one `run_k8s()`, so one bootstrap axis alone
  leaks 8-9 sessions, all surfacing together right after `asyncio.run()` tears the loop down. This
  is the source of the reported log noise.

  **Every `run_k8s(...)` call site** (all must change once `run_k8s` passes an `api_client` into
  `coro_fn`):
  - `cluster_provider.py:112` — `run_k8s(lambda: ensure_namespace(_DEFAULT_JOBS_NAMESPACE))`
  - `cluster_provider.py:113` — `run_k8s(lambda: apply_persistent_volume(_load_postgres_pv()))`
  - `cluster_provider.py:134` — `run_k8s(lambda: delete_persistent_volume(_POSTGRES_PV_NAME))`
  - `registry_protocol.py:412` — `run_k8s(lambda: _bootstrap_async(user, password, direct_host))`
  - `registry_protocol.py:426` — `run_k8s(lambda: delete_namespace(REGISTRY_NAMESPACE))`
  - `storage_protocol.py:256` — `run_k8s(lambda: _bootstrap_async(root_user, root_password))`
  - `storage_protocol.py:278` — `run_k8s(_teardown_async)` (inline `_teardown_async`, lines 275-277)

- **`backend/services/app_deployment.py:410-417`** — `_apply_deployment()` does
  `apps_api = client.AppsV1Api()` standalone, unlike its siblings `_apply_config_map`/
  `_apply_secret`/etc. which correctly reuse `k8s_client.core_api`. Same bug, one call site. Lives
  in the long-running backend process rather than a short-lived `asyncio.run()`, so it doesn't
  produce the same burst of warnings, but it's a real per-deploy leak and an inconsistency with the
  rest of the file.

- **`backend/services/k8s_client.py`** — `K8sClient._ensure_initialized()` (line 221-246) already
  builds **one** shared `self._api_client = client.ApiClient()` and derives
  `batch_api`/`core_api` from it (lines 243-245).

  > **Already done (2026-10-12):** the shared-`ApiClient` part of this change was implemented by
  > `docs/plans/done/fix-aks-token-refresh-401-shared-apiclient.md` to fix the intermittent AKS
  > 401. Do **not** re-do the `batch_api`/`core_api` sharing. What is still missing: `self.apps_api`
  > (needed by `app_deployment.py`'s change below), a `close()` method, and
  > `K8sClientRegistry.close_all()`.

  `K8sClient` still has no `close()`, and `K8sClientRegistry` (`k8s_clients`, the module-level
  singleton every request goes through, lines 625-641) never closes any client it creates — the one
  shared session per client is leaked on process exit. `backend/main.py` currently has
  `@app.on_event("startup")` (line 44) but no shutdown event.

### Hourly event-loop stall (cloud token refresh)

- **`plugins/ymerflow-gcp/gcp_plugin/cluster_provider.py`** — `GkeK8sClient._ensure_initialized()`
  (line 651-672) installs `_refresh_api_key_hook` (658-666). The hook, when
  `not self._google_credentials.valid`, calls `self._google_credentials.refresh(Request())` — a
  **blocking** HTTP call — synchronously on the loop. The loop at line 668-672 sets the header on
  `batch_api` and `core_api` configs (now the *same* shared config after the AKS fix).

- **`plugins/ymerflow-azure/azure_plugin/cluster_provider.py`** —
  `AksK8sClient._ensure_initialized()` (line 662-683) installs `_refresh_api_key_hook` (669-677).
  The hook, when the token is `None` or within `_TOKEN_REFRESH_MARGIN_SECONDS` of
  `self._access_token.expires_on`, calls `_mint_aks_token(...)` (→ `ClientSecretCredential
  .get_token()`, a **blocking** HTTP call) synchronously on the loop. Same `for api in (batch_api,
  core_api)` header loop at 679-683.

Both already do the *initial* mint correctly off-thread via `asyncio.to_thread(...)` inside
`_ensure_initialized`; only the periodic in-hook refresh is on the loop. Both keep their own
`_TOKEN_REFRESH_MARGIN_SECONDS` constant (300s). The `materialize_kubeconfig` methods in both
plugins also mint tokens synchronously, but they run in short-lived `kubectl`/script contexts, not
on the live backend loop, so they are out of scope.

## Change

### 1. `plugins/ymerflow-minikube/minikube_plugin/k8s_apply.py`

- `run_k8s(coro_fn)`: create one `client.ApiClient()`, pass it into `coro_fn`, close it in a
  `finally`:
  ```python
  def run_k8s(coro_fn):
      async def _wrapper():
          await k8s_config.load_kube_config()
          api_client = client.ApiClient()
          try:
              return await coro_fn(api_client)
          finally:
              await api_client.close()
      return asyncio.run(_wrapper())
  ```
- Every helper gains a leading `api_client` parameter and passes it to its `*Api(...)` constructor
  instead of calling it bare:
  - `ensure_namespace(api_client, name)` → `client.CoreV1Api(api_client)`
  - `apply_secret(api_client, namespace, name, *, ...)` → `client.CoreV1Api(api_client)`
  - `apply_config_map(api_client, namespace, name, data)` → `client.CoreV1Api(api_client)`
  - `apply_deployment(api_client, namespace, deployment)` → `client.AppsV1Api(api_client)`
  - `apply_service(api_client, namespace, service)` → `client.CoreV1Api(api_client)`
  - `apply_persistent_volume(api_client, pv)` → `client.CoreV1Api(api_client)`
  - `apply_persistent_volume_claim(api_client, namespace, pvc)` → `client.CoreV1Api(api_client)`
  - `delete_namespace(api_client, name)` → `client.CoreV1Api(api_client)`
  - `delete_persistent_volume(api_client, name)` → `client.CoreV1Api(api_client)`
  - `wait_deployment_available(api_client, namespace, name, timeout_seconds=300)` →
    `client.AppsV1Api(api_client)`
- `_create_or_patch` / `_call_with_webhook_retry` are unchanged (they only take zero-arg callables).

### 2. `plugins/ymerflow-minikube/minikube_plugin/cluster_provider.py`

Thread `api_client` through all three `run_k8s` call sites:
- Line 112: `run_k8s(lambda api_client: ensure_namespace(api_client, _DEFAULT_JOBS_NAMESPACE))`
- Line 113: `run_k8s(lambda api_client: apply_persistent_volume(api_client, _load_postgres_pv()))`
- Line 134: `run_k8s(lambda api_client: delete_persistent_volume(api_client, _POSTGRES_PV_NAME))`

### 3. `plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py`

- `_bootstrap_async(user, password, direct_host)` (line 156) → add leading `api_client` param;
  thread it through its `ensure_namespace`/`apply_secret`/`apply_config_map`/`apply_deployment`/
  `apply_service`/`wait_deployment_available` calls (lines 166-235).
- Line 412: `run_k8s(lambda api_client: _bootstrap_async(api_client, user, password, direct_host))`.
- Line 426: `run_k8s(lambda api_client: delete_namespace(api_client, REGISTRY_NAMESPACE))`.

### 4. `plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`

- `_bootstrap_async(root_user, root_password)` (line 73) → add leading `api_client` param; thread it
  through its `ensure_namespace`/`apply_secret`/`apply_persistent_volume`/
  `apply_persistent_volume_claim`/`apply_deployment`/`apply_service`/`wait_deployment_available`
  calls (lines 81-181).
- Line 256: `run_k8s(lambda api_client: _bootstrap_async(api_client, root_user, root_password))`.
- Inline `_teardown_async` (line 275-277) → `async def _teardown_async(api_client):` and pass
  `api_client` to its `delete_namespace`/`delete_persistent_volume` calls; line 278 stays
  `run_k8s(_teardown_async)` (now receives `api_client`).

### 5. `backend/services/k8s_client.py`

- `K8sClient.__init__` (line 210-219): add `self._api_client = None`, `self._refresh_task = None`,
  `self._token_expires_on = 0.0` alongside the existing `self.batch_api = None` / `self.core_api =
  None` (`apps_api` too, see next).
- `_ensure_initialized()` (line 243-246): add `self.apps_api` from the already-shared `_api_client`:
  ```python
  self._api_client = client.ApiClient()
  self.batch_api = client.BatchV1Api(self._api_client)
  self.core_api = client.CoreV1Api(self._api_client)
  self.apps_api = client.AppsV1Api(self._api_client)   # new — used by app_deployment.py
  ```
  (Do not touch the existing shared-config comment / `batch_api`/`core_api` lines beyond adding
  `apps_api`.)
- Add a `close()` that cancels any background refresh task (change 8) and closes the shared client:
  ```python
  async def close(self):
      if not self._initialized:
          return
      if self._refresh_task is not None:
          self._refresh_task.cancel()
          try:
              await self._refresh_task
          except asyncio.CancelledError:
              pass
      await self._api_client.close()
  ```
- Add the generic background token-refresh loop used by the cloud subclasses (change 8). Add
  `import time` at the top of the module:
  ```python
  async def _run_token_refresh(self, mint, margin_seconds):
      """Keep the shared ApiClient's bearer token fresh WITHOUT ever blocking the event loop.

      `mint` is a *synchronous* callable returning (token_str, expires_on_unix); it is run in a
      worker thread (asyncio.to_thread) so the blocking Google/Azure-AD token call never stalls the
      loop — unlike the old synchronous refresh_api_key_hook, which did the mint inline on the loop
      once per hour. Refreshes `margin_seconds` before expiry and swaps the header in place on the
      one shared Configuration (which batch/core/apps all share)."""
      while True:
          delay = max(0.0, self._token_expires_on - time.time() - margin_seconds)
          await asyncio.sleep(delay)
          try:
              token, self._token_expires_on = await asyncio.to_thread(mint)
          except Exception:
              # A transient mint failure must not kill the task (that would let the token go stale
              # and every later request 401). Log and retry on a short backoff instead of giving up.
              logger.exception("Background token refresh failed; retrying shortly")
              self._token_expires_on = time.time() + margin_seconds  # retry in ~margin_seconds
              continue
          self._api_client.configuration.api_key['authorization'] = f"Bearer {token}"
  ```
- `K8sClientRegistry` (same file): add
  ```python
  async def close_all(self):
      for c in self._clients.values():
          await c.close()
  ```

### 6. `backend/main.py`

- Add a shutdown event next to the existing `startup_event` (line 44) that closes every registered
  K8s client:
  ```python
  @app.on_event("shutdown")
  async def shutdown_event():
      from backend.services.k8s_client import k8s_clients
      await k8s_clients.close_all()
  ```

### 7. `backend/services/app_deployment.py`

- `_apply_deployment(k8s_client, namespace, deployment, name)` (line 410-417): drop
  `apps_api = client.AppsV1Api()`, use `k8s_client.apps_api` (now available per change 5) instead,
  matching the pattern already used by `_apply_config_map`/`_apply_secret`.

### 8. `plugins/ymerflow-azure/azure_plugin/cluster_provider.py` — AKS refresh off the loop

Rewrite `AksK8sClient._ensure_initialized()` (line 662-683) to seed the token once and then hand
periodic refresh to the base-class background task instead of installing a sync hook:
```python
async def _ensure_initialized(self):
    if self._initialized:
        return
    tok = await asyncio.to_thread(_mint_aks_token, self._tenant_id, self._sp)
    self._token_expires_on = tok.expires_on
    self.kubeconfig = self._build_kubeconfig(tok.token)
    await super()._ensure_initialized()

    cfg = self._api_client.configuration
    cfg.api_key['authorization'] = f"Bearer {tok.token}"
    cfg.api_key_prefix['authorization'] = ""

    def _mint():
        t = _mint_aks_token(self._tenant_id, self._sp)
        return t.token, t.expires_on
    self._refresh_task = asyncio.create_task(
        self._run_token_refresh(_mint, _TOKEN_REFRESH_MARGIN_SECONDS))
```
- Delete `_refresh_api_key_hook` and the `for api in (self.batch_api, self.core_api):` loop — the
  header is now set once on the single shared `cfg` (covering batch/core/apps) and kept fresh by the
  background task.
- `self._access_token` is no longer needed (the live token lives in the header; expiry lives in
  `self._token_expires_on`); drop the attribute and its `__init__` initializer. `close()` needs no
  override — base `K8sClient.close()` already cancels `self._refresh_task`.

### 9. `plugins/ymerflow-gcp/gcp_plugin/cluster_provider.py` — GKE refresh off the loop

Same shape for `GkeK8sClient._ensure_initialized()` (line 651-672):
```python
async def _ensure_initialized(self):
    if self._initialized:
        return
    import google.auth.transport.requests
    await asyncio.to_thread(self._google_credentials.refresh,
                            google.auth.transport.requests.Request())
    self.kubeconfig = self._build_kubeconfig(self._google_credentials.token)
    self._token_expires_on = self._google_credentials.expiry.replace(
        tzinfo=timezone.utc).timestamp()
    await super()._ensure_initialized()

    cfg = self._api_client.configuration
    cfg.api_key['authorization'] = f"Bearer {self._google_credentials.token}"
    cfg.api_key_prefix['authorization'] = ""

    def _mint():
        import google.auth.transport.requests
        self._google_credentials.refresh(google.auth.transport.requests.Request())
        return (self._google_credentials.token,
                self._google_credentials.expiry.replace(tzinfo=timezone.utc).timestamp())
    self._refresh_task = asyncio.create_task(
        self._run_token_refresh(_mint, _TOKEN_REFRESH_MARGIN_SECONDS))
```
- `google.auth.Credentials.expiry` is a **naive UTC** datetime (google-auth convention), so stamp
  `tzinfo=timezone.utc` before `.timestamp()` to get a correct Unix expiry. Ensure `timezone` is
  imported (it is already imported in this module).
- Delete `_refresh_api_key_hook` and the `for api in (self.batch_api, self.core_api):` loop, same as
  AKS. No `close()` override needed.

## Verification

### Session leaks
- Run `backend/bin/yf-bootstrap-provision` directly (or `prod/runall-minikube.sh` end to end)
  against a fresh/existing Minikube and confirm stderr no longer contains "Unclosed client session"
  / "Unclosed connector" — registry and storage bootstrap should both still succeed (registry
  reachable, MinIO reachable, returned JSON on stdout unchanged).
- Exercise a teardown path (e.g. storage/registry `teardown()` or `cleanup-all.sh`) and confirm it
  still removes the namespace/PV and produces no unclosed-session warnings.
- Trigger an app redeploy (whatever currently calls `apply_app_workloads()`) and confirm the
  backend/frontend Deployments still apply correctly with `_apply_deployment` using
  `k8s_client.apps_api`.
- Restart the backend (`./backend/run.sh`) and confirm the new shutdown event runs without error
  (no exception logged) when the process stops.
- Grep to confirm no remaining bare `client.CoreV1Api()` / `client.AppsV1Api()` /
  `client.BatchV1Api()` (no-arg) calls in `k8s_apply.py` or `app_deployment.py`.

### Token refresh
- On a real AKS and a real GKE cluster, let the backend run across a token refresh boundary (token
  TTL is ~1h; `_TOKEN_REFRESH_MARGIN_SECONDS` is 300s, so the background task fires ~55 min in).
  Confirm (a) requests continue to succeed across the boundary (no 401), and (b) the loop is not
  stalled during the refresh — e.g. an unrelated endpoint served concurrently shows no latency
  spike at refresh time. (To exercise quickly without waiting an hour, temporarily lower the margin
  so the background task fires within a minute or two.)
- Confirm no `refresh_api_key_hook` remains on either client:
  `grep -rn refresh_api_key_hook plugins/` should return nothing.
- Stop the backend and confirm each cloud client's background refresh task is cancelled cleanly by
  `close()` (no "Task was destroyed but it is pending" warnings, no traceback).

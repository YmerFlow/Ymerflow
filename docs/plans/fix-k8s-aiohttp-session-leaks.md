# Fix leaked aiohttp sessions in K8s API calls

## Goal

Every `kubernetes_asyncio` API class (`CoreV1Api()`, `AppsV1Api()`, `BatchV1Api()`, ...) called
with no explicit `api_client` argument builds its own throwaway `ApiClient`, which opens its own
`aiohttp.ClientSession`/`TCPConnector`. None of these are ever closed, so garbage collection
prints "Unclosed client session" / "Unclosed connector" warnings — most visibly during
`yf-bootstrap-provision` (`prod/runall-minikube.sh` Step 3), where each `bootstrap()` call
tears its event loop down (`asyncio.run()`) immediately after leaking several sessions. Fix this by
sharing one `ApiClient` per logical unit of work and closing it explicitly, instead of leaving
cleanup to the garbage collector.

## Current state

- **`plugins/ymerflow-minikube/minikube_plugin/k8s_apply.py`** — `run_k8s(coro_fn)` (line 27-34)
  runs `coro_fn()` inside a fresh `asyncio.run(_wrapper())`. Every helper in this file
  (`ensure_namespace`, `apply_secret`, `apply_config_map`, `apply_deployment`, `apply_service`,
  `apply_persistent_volume`, `apply_persistent_volume_claim`, `wait_deployment_available`) does
  `client.CoreV1Api()` / `client.AppsV1Api()` with no `api_client` arg — a fresh session per call.
  A single `bootstrap()` (e.g. `DockerV2ProtocolHandler.bootstrap()` in `registry_protocol.py`, or
  `MinioProtocolHandler.bootstrap()` in `storage_protocol.py`) makes 8-9 such calls inside one
  `run_k8s()`, so one bootstrap axis alone leaks 8-9 sessions, all surfacing together right after
  `asyncio.run()` tears the loop down. This is the source of the reported log noise.
  - Callers, all via `run_k8s(lambda: ...)`:
    - `cluster_provider.py:92` — `run_k8s(lambda: ensure_namespace(_DEFAULT_JOBS_NAMESPACE))`
    - `registry_protocol.py:288` — `run_k8s(lambda: _bootstrap_async(user, password, host))`,
      where `_bootstrap_async` (line 137-214) calls `ensure_namespace` x2, `apply_secret` x2,
      `apply_config_map`, `apply_deployment`, `apply_service` x2, `wait_deployment_available`.
    - `storage_protocol.py:244` — `run_k8s(lambda: _bootstrap_async(root_user, root_password))`,
      where `_bootstrap_async` (line 83-191) calls `ensure_namespace` x2, `apply_secret`,
      `apply_persistent_volume`, `apply_persistent_volume_claim`, `apply_deployment`,
      `apply_service` x2, `wait_deployment_available`.

- **`backend/services/app_deployment.py:328-335`** — `_apply_deployment()` does
  `apps_api = client.AppsV1Api()` standalone, unlike its siblings `_apply_config_map`/
  `_apply_secret`/etc. which correctly reuse `k8s_client.core_api`. Same bug, one call site. Lives
  in the long-running backend process rather than a short-lived `asyncio.run()`, so it doesn't
  produce the same burst of warnings, but it's a real per-deploy leak and an inconsistency with the
  rest of the file.

- **`backend/services/k8s_client.py`** — `K8sClient._ensure_initialized()` (line 55-71) sets
  `self.batch_api = client.BatchV1Api()` and `self.core_api = client.CoreV1Api()` — two *separate*
  default `ApiClient`s (confirmed: `CoreV1Api.__init__`/`BatchV1Api.__init__` each do
  `if api_client is None: api_client = ApiClient()`), i.e. two sessions per `K8sClient`, for no
  reason — they could share one. `K8sClient` has no `close()`, and `K8sClientRegistry`
  (`k8s_clients`, the module-level singleton every request goes through) never closes any client it
  creates. Not the source of the reported warnings (one `K8sClient` lives for the process lifetime,
  so it isn't repeatedly leaked), but the same root pattern, and left dangling on process exit.
  `backend/main.py` currently has `@app.on_event("startup")` (line 41) but no shutdown event.

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
  - `apply_secret(api_client, namespace, name, ...)` → `client.CoreV1Api(api_client)`
  - `apply_config_map(api_client, namespace, name, data)` → `client.CoreV1Api(api_client)`
  - `apply_deployment(api_client, namespace, deployment)` → `client.AppsV1Api(api_client)`
  - `apply_service(api_client, namespace, service)` → `client.CoreV1Api(api_client)`
  - `apply_persistent_volume(api_client, pv)` → `client.CoreV1Api(api_client)`
  - `apply_persistent_volume_claim(api_client, namespace, pvc)` → `client.CoreV1Api(api_client)`
  - `wait_deployment_available(api_client, namespace, name, timeout_seconds=300)` →
    `client.AppsV1Api(api_client)`
- `_create_or_patch` itself is unchanged (it only takes zero-arg `create`/`patch` callables).

### 2. `plugins/ymerflow-minikube/minikube_plugin/cluster_provider.py`

- Line 92: `run_k8s(lambda: ensure_namespace(_DEFAULT_JOBS_NAMESPACE))` →
  `run_k8s(lambda api_client: ensure_namespace(api_client, _DEFAULT_JOBS_NAMESPACE))`.

### 3. `plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py`

- `_bootstrap_async(user, password, host)` → `_bootstrap_async(api_client, user, password, host)`;
  thread `api_client` through its `ensure_namespace`/`apply_secret`/`apply_config_map`/
  `apply_deployment`/`apply_service`/`wait_deployment_available` calls (line 145-214).
- Line 288: `run_k8s(lambda: _bootstrap_async(user, password, host))` →
  `run_k8s(lambda api_client: _bootstrap_async(api_client, user, password, host))`.

### 4. `plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`

- `_bootstrap_async(root_user, root_password)` → `_bootstrap_async(api_client, root_user, root_password)`;
  thread `api_client` through its `ensure_namespace`/`apply_secret`/`apply_persistent_volume`/
  `apply_persistent_volume_claim`/`apply_deployment`/`apply_service`/`wait_deployment_available`
  calls (line 91-191).
- Line 244: `run_k8s(lambda: _bootstrap_async(root_user, root_password))` →
  `run_k8s(lambda api_client: _bootstrap_async(api_client, root_user, root_password))`.

### 5. `backend/services/k8s_client.py`

- `_ensure_initialized()`: build one `ApiClient`, pass it to every `*Api` class:
  ```python
  self._api_client = client.ApiClient()
  self.batch_api = client.BatchV1Api(self._api_client)
  self.core_api = client.CoreV1Api(self._api_client)
  self.apps_api = client.AppsV1Api(self._api_client)
  ```
  (`apps_api` is new — needed by `app_deployment.py`'s change below.)
- Add:
  ```python
  async def close(self):
      if self._initialized:
          await self._api_client.close()
  ```
- `K8sClientRegistry` (same file): add a `async def close_all(self)` that awaits `close()` on every
  cached client:
  ```python
  async def close_all(self):
      for c in self._clients.values():
          await c.close()
  ```

### 6. `backend/main.py`

- Add a shutdown event next to the existing `startup_event` (line 41) that closes every registered
  K8s client:
  ```python
  @app.on_event("shutdown")
  async def shutdown_event():
      from backend.services.k8s_client import k8s_clients
      await k8s_clients.close_all()
  ```

### 7. `backend/services/app_deployment.py`

- `_apply_deployment(k8s_client, namespace, deployment, name)` (line 328-335): drop
  `apps_api = client.AppsV1Api()`, use `k8s_client.apps_api` (now available per change 5) instead,
  matching the pattern already used by `_apply_config_map`/`_apply_secret`.

## Verification

- Run `backend/bin/yf-bootstrap-provision` directly (or `prod/runall-minikube.sh` end to
  end) against a fresh/existing Minikube and confirm stderr no longer contains "Unclosed client
  session" / "Unclosed connector" — registry and storage bootstrap should both still succeed
  (registry reachable, MinIO reachable, returned JSON on stdout unchanged).
- Trigger an app redeploy (whatever currently calls `apply_app_workloads()`) and confirm the
  backend/frontend Deployments still apply correctly with `_apply_deployment` using
  `k8s_client.apps_api`.
- Restart the backend (`./backend/run.sh`) and confirm the new shutdown event runs without error
  (no exception logged) when the process stops.
- Grep to confirm no remaining bare `client.CoreV1Api()` / `client.AppsV1Api()` / `client.BatchV1Api()`
  calls (no-arg) in `k8s_apply.py` or `app_deployment.py`.

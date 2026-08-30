"""Registry of per-type cluster connection providers.

A `ClusterProvider` implements how to reach one value of `Cluster.cluster_type` (e.g.
'same-as-backend', 'kubeconfig'). `K8sClientRegistry.get()` (`backend/services/k8s_client.py`)
delegates to whichever provider `cluster.cluster_type` resolves to instead of branching on
cluster_type itself.

Providers are discovered through the `cluster_provider_handlers` fan-out hook, the same
`ymerflow.hooks` mechanism used for `storage_protocol_handlers`. Core registers its own built-in
providers (same-as-backend/kubeconfig) through this exact hook too — see `setup.py`'s
`ymerflow.hooks` entry point — so a plugin adding a new cluster type (e.g. GKE) uses the
identical channel core does, with no "core is special" path.
"""
import asyncio

from backend.hooks import hooks


class ClusterProvider:
    # Set True by a provider whose registration can't complete synchronously in
    # admin_create_cluster (e.g. "minikube": there's no provider_config yet, it's filled in later
    # by whatever runs on the target host). admin_create_cluster refuses to create such a provider's
    # Cluster row directly; instead POST /admin/clusters/register-callback creates it lazily, the
    # first time it sees a registration token (generated client-side, in the browser) it doesn't
    # already recognize — see backend/routers/admin.py and
    # docs/plans/minikube-cluster-registration-ux.md. Any future provider with the same "provision
    # out-of-band, report back later" shape (e.g. a GKE node-pool startup-script) gets this flow
    # for free just by setting this flag — no router changes.
    self_service_registration = False

    # Set True by a provider that can also *host the YmerFlow application itself* (backend +
    # frontend pods, their exposure, config/secrets) on its cluster — not just run process/
    # analysis Jobs on it. Gates whether deploy_app()/expose_app() below are ever called for a
    # given cluster_type, mirroring self_service_registration's role as a per-type capability flag
    # that changes control flow without touching any router (see
    # docs/plans/app-deployment-hooks.md, Design decision 2). A provider that leaves this False
    # (e.g. the generic 'kubeconfig' bring-your-own cluster type, which can't auto-know its own
    # Ingress class or how it should be exposed) is unaffected: the operator continues to deploy/
    # expose the app manually via k8s/*.yaml, exactly as before this hook existed.
    supports_app_deployment = False

    def connect(self, provider_config: dict, namespace: str) -> "K8sClient":
        """Return a K8sClient connected to this provider's cluster."""
        raise NotImplementedError

    def materialize_kubeconfig(self, provider_config: dict) -> dict:
        """Return a kubeconfig-shaped dict — the exact shape connect()'s own `kubeconfig` argument
        already accepts (K8sClient loads it via `config.load_kube_config_from_dict`) — for use by
        kubectl-based scripts (prod/runall-production.sh, docker/build.sh, backup.sh, restore.sh,
        debug-harness/run_debug.sh). MUST NOT shell out to a vendor CLI (gcloud, minikube) to build
        this — construct the credential directly via the provider's own Python SDK/HTTP calls (e.g.
        minting a short-lived bearer token from a stored GCP service-account key via `google-auth`,
        embedded straight into the returned dict's `users[].user.token`). No default implementation
        — every provider that wants to support kubectl-based scripts must implement this
        explicitly; a provider that doesn't (raises NotImplementedError) means those scripts can't
        target that cluster type yet, a loud and correct failure rather than a silent
        wrong-cluster one. See docs/plans/base-infrastructure-via-cluster-provider.md, Design
        decision 1."""
        raise NotImplementedError

    async def node_capacity(self, k8s_client, provider_config: dict) -> dict:
        """Return the largest single pod this cluster's jobs pool could ever admit, as
        `{"max_cpu_cores": float, "max_memory_gb": float}`.

        A Kubernetes pod is atomic — it must fit on **one** node — so this is deliberately
        one node's allocatable capacity, never a sum/aggregate across nodes. It is exactly the
        per-task ceiling the process editor's CPU/RAM sliders bind to and that submit-time
        validation enforces (`backend/models/process.py`); a task larger than this can never be
        scheduled and is rejected at submit rather than hanging unschedulable until its deadline.

        Default implementation reads live nodes (`list_node()`) and returns the **max** (never the
        sum) of their `status.allocatable`. This covers every always-on cluster type
        (`same-as-backend`/minikube, which always have ≥1 live node) with no per-provider work.

        A **scale-to-zero** provider (GKE/AKS node pool that may have zero nodes at query time)
        MUST override this to return the single-node allocatable derived from its machine type /
        VM SKU in `provider_config` — the same figure it uses to size its aggregate quota — since
        the default path finds no nodes to read. There is deliberately **no** fallback default: a
        provider that cannot answer **raises**, surfacing a real misconfiguration loudly rather
        than serving a guessed ceiling (CLAUDE.md rule 8). This method must never return `None`
        and never decline."""
        await k8s_client._ensure_initialized()
        from backend.services.k8s_client import (
            API_REQUEST_TIMEOUT_SECONDS, _parse_cpu_cores, _parse_memory_gb,
        )
        nodes = await k8s_client.core_api.list_node(_request_timeout=API_REQUEST_TIMEOUT_SECONDS)
        cpu_values = []
        memory_values = []
        for node in nodes.items:
            allocatable = node.status.allocatable or {}
            if "cpu" in allocatable:
                cpu_values.append(_parse_cpu_cores(allocatable["cpu"]))
            if "memory" in allocatable:
                memory_values.append(_parse_memory_gb(allocatable["memory"]))
        if not cpu_values or not memory_values:
            raise RuntimeError(
                f"{type(self).__name__}.node_capacity() found no nodes with readable allocatable "
                f"capacity (namespace={k8s_client.namespace!r}). An always-on cluster should have "
                f"≥1 live node; a scale-to-zero cluster type must override node_capacity() to report "
                f"its SKU/machine-type capacity from provider_config instead of reading live nodes."
            )
        return {"max_cpu_cores": max(cpu_values), "max_memory_gb": max(memory_values)}

    async def aggregate_capacity(self, k8s_client, provider_config: dict) -> dict | None:
        """Return the cluster-wide **autoscaled** quota ceiling used to size the Kueue
        `ClusterQueue` `nominalQuota`, shaped `{"cpu_cores": float, "memory_gb": float}` (the
        `quota_config` shape `ensure_cluster_job_ready()` consumes), or `None` to decline.

        This is the aggregate across the pool's full autoscaled node count (e.g.
        `node_capacity × max_count`), so many small tasks can queue and drive the autoscaler up —
        it is NOT a single-node figure. Returning `None` (the default) means "decline: fall
        through to node-sum aggregate sizing," which is correct for an always-on single-node
        cluster where the sum of present nodes already is the full ceiling.

        A **scale-to-zero** provider SHOULD override this to return its full autoscaled aggregate,
        otherwise its `ClusterQueue` collapses to the 1-core/1-GiB floor when zero nodes are
        present (nothing can be admitted → the autoscaler never triggers → deadlock).

        Unlike `node_capacity()`, `None` here is a legitimate, meaningful return (decline), not a
        failure; a provider that genuinely fails to compute an aggregate it intended to supply
        should **raise**, not return `None`."""
        return None

    async def test_connection(self, provider_config: dict) -> None:
        """Raise a clear exception if this config can't actually reach a cluster.
        Default: resolve a client via connect(), then a cheap, timeout-bounded
        list-namespaces call. Override for providers that can validate more cheaply/
        differently (e.g. before even attempting a network call)."""
        client = self.connect(provider_config, "default")
        await client._ensure_initialized()
        await asyncio.wait_for(
            client.core_api.list_namespace(limit=1, _request_timeout=10), timeout=15
        )

    def bootstrap(self, provider_config: dict) -> dict:
        """Given whatever config.env / seed-time provider_config was supplied for this
        cluster_type, return an enriched provider_config ready to persist onto the Cluster row —
        e.g. provisioning a fresh cluster or minting a first credential. Every core-provided
        provider implements this as a passthrough (`return provider_config`); live-provisioning
        bootstrap is entirely plugin territory (see Design decision 6 in
        docs/plans/registry-backend-hooks.md). Resolved and called by
        `backend/bin/yf-bootstrap-provision`; wiring its output into the dev/prod-minikube
        flows and the seed migrations is a later phase's concern (Phases 5/6)."""
        raise NotImplementedError

    def teardown(self, provider_config: dict) -> None:
        """Remove the k8s-level resources this provider's `bootstrap()` created (the jobs
        namespace, Kueue config, etc.). The teardown mirror of `bootstrap()`, resolved and called
        by `backend/bin/yf-bootstrap-teardown`
        (docs/plans/generic-deployment-orchestration.md, Phase 7). Default is a no-op passthrough,
        exactly like `bootstrap()`'s default for core-provided providers. Per Design decision 6,
        a provider that manages a local VM (e.g. minikube) must NOT stop/delete the VM itself here
        — only the k8s-level resources it applied — leaving VM destruction a manual, explicit
        operation. MUST be idempotent (safe to call when nothing is provisioned)."""
        return None

    async def resolve_app_hostname(self, provider_config: dict, app_config: dict) -> str | None:
        """Optional, cheap, idempotent. Called BEFORE the Secret is built, so its result can be
        baked into app_config["SERVER_URL"] first. Needed for a provider (e.g. GKE) whose
        externally-reachable hostname isn't known until a resource (a static IP) is reserved —
        that reservation normally only happens inside expose_app(), which runs after the Secret
        containing BACKEND_BASE_URL was already built and applied. Default: return
        app_config.get("SERVER_URL") unchanged — every provider whose hostname doesn't need a
        reservation step (same-as-backend/minikube) never needs to override this. See
        docs/plans/base-infrastructure-via-cluster-provider.md, Design decision 2."""
        return app_config.get("SERVER_URL")

    async def deploy_app(self, k8s_client, provider_config: dict, namespace: str, images: dict,
                         app_config: dict, secrets: dict) -> None:
        """Apply the YmerFlow application's own workload-level resources (backend + frontend
        Deployments/Service, the ymerflow-backend-secret Secret, the DB migration Job) onto this
        provider's cluster. Optional — only ever called when `supports_app_deployment` is True;
        the default raises so a provider that sets the flag but forgets to implement this fails
        loudly rather than silently no-op'ing.

        The workload-level work is identical for every provider, so implementations call the
        shared `backend.services.app_deployment.apply_app_workloads()` helper for it (Design
        decision 3) — this method's own job is only to resolve the provider-specific bits
        (e.g. how images are made pullable on this cluster) and delegate. See
        docs/plans/app-deployment-hooks.md.

        Args:
            k8s_client: a `K8sClient` for this cluster (typically `self.connect(...)`).
            provider_config: this Cluster row's `provider_config`.
            namespace: the app namespace to deploy into (e.g. "ymerflow") — distinct from
                `Cluster.namespace`, which is the *jobs* namespace.
            images: `{"backend": <resolved image ref>, "frontend": <resolved image ref>}`,
                already resolved through the registry axis (Design decision 4).
            app_config: flat data merged into the Secret alongside `secrets` (includes optional
                `APP_DOMAIN`, Design decision 6).
            secrets: flat data merged into the Secret alongside `app_config` — the combined map
                must include a resolved `DATABASE_URL`; JWT_SECRET_KEY handling per Design
                decision 5 happens inside apply_app_workloads().
        """
        raise NotImplementedError

    async def expose_app(self, k8s_client, provider_config: dict, namespace: str,
                         app_config: dict) -> dict:
        """Make the deployed app reachable from outside the cluster and return
        `{"url": str, ...}`. This is the genuinely provider-specific part (Design decision 2):
        `same-as-backend`/`minikube` implement it as a NodePort Service (parameterized, not
        today's hardcoded 30080/`hostname -I`); a plugin-provided cloud cluster type would
        implement it with whatever managed load balancer / certificate / Ingress mechanism that
        cloud offers, consuming `app_config["APP_DOMAIN"]` if it wants to. Optional — only ever
        called when `supports_app_deployment` is True. See docs/plans/app-deployment-hooks.md."""
        raise NotImplementedError


def cluster_provider_handlers():
    """Core's built-in cluster providers, registered under ymerflow.hooks in the root setup.py
    exactly like a plugin's would be — hence returned as (name, class) tuples, not stored in a
    private dict. Core has no special precedence over plugins.

    'minikube' moved out to plugins/ymerflow-minikube (see
    docs/plans/minikube-provisioning-plugin.md) — a stock install with that plugin not in
    BACKEND_PLUGINS has no self-hosted cluster option left, only 'same-as-backend'/'kubeconfig'
    (plus whatever other plugins are installed).

    Imports are local to break the import cycle: each provider module imports `ClusterProvider`
    from this module, so they can only be imported once this module has finished defining it."""
    from backend.services.cluster_providers.same_as_backend import SameAsBackendClusterProvider
    from backend.services.cluster_providers.kubeconfig import KubeconfigClusterProvider

    return [
        ("same-as-backend", SameAsBackendClusterProvider),
        ("kubeconfig", KubeconfigClusterProvider),
    ]


_registry = None


def get_cluster_provider(cluster_type: str) -> ClusterProvider:
    global _registry
    if _registry is None:
        registry = {}
        for name, cls in hooks.run.cluster_provider_handlers():
            if name in registry:
                raise ValueError(f"duplicate cluster_provider_handlers registration for {name!r}")
            registry[name] = cls
        _registry = registry
    if cluster_type not in _registry:
        raise ValueError(f"unknown cluster_type {cluster_type!r}")
    return _registry[cluster_type]()

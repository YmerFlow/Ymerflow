"""Generic, provider-agnostic cluster job-readiness provisioning.

Makes a `Cluster` actually ready to run Nagelfluh Jobs: creates the jobs namespace, installs the
Kueue operator (if not already present) and waits for it to become fully ready, sizes and applies
a Kueue `ResourceFlavor`/`ClusterQueue`/`LocalQueue` from real node allocatable capacity, and
applies the backend's `ymerflow-backend-jobs`/`ymerflow-backend-kueue-reader` RBAC.

This replaces two independent, duplicated shell implementations (the minikube-only
`plugins/ymerflow-minikube`'s provision-nagelfluh-jobs.sh and the GCP plugin's own GKE setup script) with one
provider-agnostic Python routine — see Design decision 8 in
`docs/plans/registry-backend-hooks.md`. None of this logic is actually specific to any given
`Cluster.cluster_type`: everything here operates purely through `kubernetes_asyncio` against
whatever `K8sClient` a `ClusterProvider.connect()` hands back, with **no shell/`kubectl`
subprocess calls anywhere in this module**.

Call sites (see Phase 7 of the plan): `POST /admin/clusters/register-callback` and
`admin_create_cluster` (`backend/routers/admin.py`), and the generic default-cluster seed
migration (`backend/alembic/versions/d1266f2f6e68_generic_seed_default_cluster.py`) — the only
places a `Cluster` row's config becomes active.

Additional API client classes constructed here (`AppsV1Api`, `ApiextensionsV1Api`,
`CustomObjectsApi`, `RbacAuthorizationV1Api`) are built with no explicit `ApiClient` argument,
exactly like `K8sClient._ensure_initialized()` builds `core_api`/`batch_api` — they pick up the
same globally-loaded `kubernetes_asyncio.client.Configuration` that
`config.load_incluster_config()`/`config.load_kube_config()` set up when `_ensure_initialized()`
ran. `kubernetes_asyncio.utils.create_from_dict()` is the one exception: it takes a raw
`ApiClient`, not a typed API wrapper, obtained via `k8s_client.core_api.api_client`.
"""
import asyncio
import logging
import math

import aiohttp
import yaml
from kubernetes_asyncio import client
from kubernetes_asyncio.client.exceptions import ApiException
from kubernetes_asyncio.utils import create_from_dict, FailToCreateError

from backend.services.k8s_client import API_REQUEST_TIMEOUT_SECONDS, _parse_cpu_cores, _parse_memory_gb

logger = logging.getLogger(__name__)

KUEUE_VERSION_TAG = "v0.16.4"
KUEUE_MANIFEST_URL = f"https://github.com/kubernetes-sigs/kueue/releases/download/{KUEUE_VERSION_TAG}/manifests.yaml"
KUEUE_NAMESPACE = "kueue-system"
KUEUE_DEPLOYMENT_NAME = "kueue-controller-manager"
KUEUE_WEBHOOK_SERVICE_NAME = "kueue-webhook-service"
KUEUE_CRD_NAME = "clusterqueues.kueue.x-k8s.io"

KUEUE_GROUP = "kueue.x-k8s.io"
KUEUE_API_VERSION_STR = "v1beta2"

RESOURCE_FLAVOR_NAME = "default-flavor"
CLUSTER_QUEUE_NAME = "nagelfluh-cluster-queue"
LOCAL_QUEUE_NAME = "nagelfluh-queue"
EPHEMERAL_STORAGE_QUOTA = "100Gi"  # not computed from node capacity, mirrors the shell exactly

# Headroom/floor mirror plugins/ymerflow-minikube's provision-nagelfluh-jobs.sh's `-1`/`-1` reservation and `<1 -> 1`
# floor, now applied to the *summed* allocatable capacity across every node (Design decision 8:
# "the more general of the two approaches ... works identically for minikube").
QUOTA_HEADROOM_CPU_CORES = 1.0
QUOTA_HEADROOM_MEMORY_GB = 1.0
QUOTA_MIN_CPU_CORES = 1.0
QUOTA_MIN_MEMORY_GB = 1.0

# Fetching the Kueue release manifest bundle is a large (multi-MB) one-shot download.
MANIFEST_FETCH_TIMEOUT = aiohttp.ClientTimeout(total=30)

# Poll budgets mirror the shell script's loops:
#   CRD registration:      `for i in {1..30}; sleep 2`  -> 30 * 2s  = 60s
#   controller availability: `kubectl wait --timeout=120s`          = 120s
#   webhook endpoints:      `for i in {1..80}; sleep 5`  -> 80 * 5s = 400s
KUEUE_CRD_POLL_TIMEOUT_SECONDS = 60
KUEUE_CRD_POLL_INTERVAL_SECONDS = 2
KUEUE_CONTROLLER_POLL_TIMEOUT_SECONDS = 120
KUEUE_CONTROLLER_POLL_INTERVAL_SECONDS = 2
KUEUE_WEBHOOK_POLL_TIMEOUT_SECONDS = 400
KUEUE_WEBHOOK_POLL_INTERVAL_SECONDS = 5

# The backend's own ServiceAccount namespace. Mirrors the shell's `NAGELFLUH_BACKEND_NAMESPACE`
# env var, which every real deployment leaves at its default ("nagelfluh") — this routine has no
# access to config.env-style env vars (it's called from the backend process itself, on-demand,
# not at shell-provisioning time), so a fixed literal is simpler than threading a new parameter
# through ensure_cluster_job_ready()'s signature for a value that's effectively always constant.
BACKEND_SERVICE_ACCOUNT_NAMESPACE = "nagelfluh"

RBAC_ROLE_NAME = "ymerflow-backend-jobs"
RBAC_CLUSTERROLE_NAME = "ymerflow-backend-kueue-reader"


async def ensure_cluster_job_ready(k8s_client, namespace: str, quota_config: dict | None = None) -> None:
    """Make `namespace` on whatever cluster `k8s_client` points at ready to run Nagelfluh Jobs.

    Idempotent — safe to call repeatedly against the same cluster (e.g. on every
    register-callback, or every time the seed migration runs against a fresh DB): namespace
    creation, Kueue install, and RBAC application all tolerate "already exists" (HTTP 409) and,
    for Kueue quotas/RBAC, fall back to patch/replace so a re-run picks up config changes (e.g.
    node capacity changing) instead of leaving stale values in place.

    Args:
        k8s_client: a `backend.services.k8s_client.K8sClient` (or subclass, e.g. a plugin's
            `GkeK8sClient`) already carrying whatever `provider_config` this cluster needs.
        namespace: the Nagelfluh jobs namespace to provision (`Cluster.namespace`).
        quota_config: optional explicit override of Kueue quota sizing, shaped
            `{"cpu_cores": float, "memory_gb": float}`. When omitted (the normal case), quota is
            computed from live `list_node()` allocatable capacity, summed across every node,
            minus a fixed headroom, floored at a 1-core/1-GiB minimum.

    Raises:
        RuntimeError: on any provisioning failure that isn't a harmless "already exists" — a
            failed/partial Kueue manifest apply, or a readiness poll timing out.
        ApiException: any other, unexpected Kubernetes API error (never swallowed silently, per
            CLAUDE.md's "never swallow errors" rule).
    """
    await k8s_client._ensure_initialized()

    await _ensure_namespace(k8s_client, namespace)
    await _ensure_kueue_installed_and_ready(k8s_client)
    cpu_cores, memory_gb = await _resolve_quota(k8s_client, quota_config)
    await _apply_kueue_quota(namespace, cpu_cores, memory_gb)
    await _apply_backend_rbac(namespace)


async def teardown_cluster_job_ready(k8s_client, namespace: str) -> None:
    """Teardown mirror of `ensure_cluster_job_ready()`: delete the jobs `namespace` and the
    cluster-scoped Kueue `ClusterQueue`/`ResourceFlavor` this module's `ensure_cluster_job_ready()`
    created. Provider-agnostic, exactly like its counterpart — any `ClusterProvider.teardown()` can
    call it, not just minikube's (docs/plans/generic-deployment-orchestration.md, Design decision
    7). Replaces the old `dev/cleanup-minikube.sh`, whose content was never actually
    minikube-specific.

    Does NOT uninstall the Kueue operator itself (the `kueue-system` namespace / CRDs): that's a
    cluster-wide component potentially shared with other tenants, and `ensure_cluster_job_ready()`
    only installs it when absent — so this leaves it in place, matching that install's
    "already present → leave alone" stance.

    Idempotent: every delete tolerates "not found" (HTTP 404), so a second run in a row is a clean
    no-op, matching `ensure_cluster_job_ready()`'s own idempotency."""
    await k8s_client._ensure_initialized()

    custom_api = client.CustomObjectsApi()
    for plural, name in (("clusterqueues", CLUSTER_QUEUE_NAME), ("resourceflavors", RESOURCE_FLAVOR_NAME)):
        try:
            await custom_api.delete_cluster_custom_object(
                group=KUEUE_GROUP, version=KUEUE_API_VERSION_STR, plural=plural, name=name,
                _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
            )
            logger.info("Deleted Kueue %s/%s", plural, name)
        except ApiException as e:
            if e.status != 404:
                raise
            logger.debug("Kueue %s/%s already absent", plural, name)

    try:
        await k8s_client.core_api.delete_namespace(
            namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS
        )
        logger.info("Deleted namespace %s", namespace)
    except ApiException as e:
        if e.status != 404:
            raise
        logger.debug("Namespace %s already absent", namespace)


# ── Namespace ────────────────────────────────────────────────────────────────────────────────


async def _ensure_namespace(k8s_client, namespace: str) -> None:
    try:
        await k8s_client.core_api.create_namespace(
            client.V1Namespace(
                api_version="v1", kind="Namespace",
                metadata=client.V1ObjectMeta(name=namespace),
            ),
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
        logger.info("Created namespace %s", namespace)
    except ApiException as e:
        if e.status != 409:
            raise
        logger.debug("Namespace %s already exists", namespace)


# ── Kueue operator install + readiness ──────────────────────────────────────────────────────


async def _kueue_controller_ready(apps_api) -> bool:
    try:
        deployment = await apps_api.read_namespaced_deployment(
            KUEUE_DEPLOYMENT_NAME, KUEUE_NAMESPACE, _request_timeout=API_REQUEST_TIMEOUT_SECONDS
        )
    except ApiException as e:
        if e.status == 404:
            return False
        raise
    ready_replicas = deployment.status.ready_replicas or 0
    return ready_replicas >= 1


async def _ensure_kueue_installed_and_ready(k8s_client) -> None:
    apps_api = client.AppsV1Api()

    if await _kueue_controller_ready(apps_api):
        logger.info("Kueue already installed and running")
    else:
        logger.info("Installing Kueue %s from %s", KUEUE_VERSION_TAG, KUEUE_MANIFEST_URL)
        await _apply_kueue_manifests(k8s_client.core_api.api_client)
        await _wait_for_kueue_crd()
        await _wait_for_kueue_controller(apps_api)

    # Mirrors the shell script: the webhook-readiness wait runs unconditionally, every time this
    # is called, whether Kueue was just installed or was already running — the TCP-reachability
    # probe used server-side ordering guarantees, not just "the Deployment says Ready".
    await _wait_for_kueue_webhook(k8s_client)


async def _apply_kueue_manifests(api_client) -> None:
    async with aiohttp.ClientSession(timeout=MANIFEST_FETCH_TIMEOUT) as session:
        async with session.get(KUEUE_MANIFEST_URL) as resp:
            resp.raise_for_status()
            manifest_text = await resp.text()

    for doc in yaml.safe_load_all(manifest_text):
        if not doc:
            continue  # blank `---`-separated sections parse as None
        try:
            await create_from_dict(api_client, doc, namespace=KUEUE_NAMESPACE)
        except FailToCreateError as failure:
            for exc in failure.api_exceptions:
                if getattr(exc, "status", None) == 409:
                    continue  # already exists (e.g. from a partial prior install) - fine
                kind = doc.get("kind", "<unknown kind>")
                name = (doc.get("metadata") or {}).get("name", "<unknown name>")
                raise RuntimeError(
                    f"Failed to apply Kueue manifest {kind}/{name}: "
                    f"{getattr(exc, 'status', '?')} {getattr(exc, 'reason', '')}: {getattr(exc, 'body', '')}"
                ) from failure


async def _wait_for_kueue_crd() -> None:
    ext_api = client.ApiextensionsV1Api()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + KUEUE_CRD_POLL_TIMEOUT_SECONDS
    while True:
        try:
            await ext_api.read_custom_resource_definition(
                KUEUE_CRD_NAME, _request_timeout=API_REQUEST_TIMEOUT_SECONDS
            )
            return
        except ApiException as e:
            if e.status != 404:
                raise
        if loop.time() >= deadline:
            raise RuntimeError(f"Timed out waiting for Kueue CRD {KUEUE_CRD_NAME} to register")
        await asyncio.sleep(KUEUE_CRD_POLL_INTERVAL_SECONDS)


async def _wait_for_kueue_controller(apps_api) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + KUEUE_CONTROLLER_POLL_TIMEOUT_SECONDS
    while True:
        if await _kueue_controller_ready(apps_api):
            return
        if loop.time() >= deadline:
            raise RuntimeError(
                f"Timed out waiting for {KUEUE_DEPLOYMENT_NAME} deployment in {KUEUE_NAMESPACE} to become ready"
            )
        await asyncio.sleep(KUEUE_CONTROLLER_POLL_INTERVAL_SECONDS)


async def _wait_for_kueue_webhook(k8s_client) -> None:
    """Replaces the shell's `minikube ssh -- nc` TCP reachability probe (which only works because
    that shell has host access to the node) with polling the webhook Service's Endpoints for a
    populated address list — doable purely via the K8s API, portable to any provider (Design
    decision 8). Deliberately does NOT attempt an actual TCP connection from this process to the
    pod/service IP: that's not reachable from wherever the backend runs for a remote cluster."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + KUEUE_WEBHOOK_POLL_TIMEOUT_SECONDS
    while True:
        try:
            endpoints = await k8s_client.core_api.read_namespaced_endpoints(
                KUEUE_WEBHOOK_SERVICE_NAME, KUEUE_NAMESPACE, _request_timeout=API_REQUEST_TIMEOUT_SECONDS
            )
            subsets = endpoints.subsets or []
            if subsets and subsets[0].addresses:
                logger.info("Kueue webhook service endpoints populated")
                return
        except ApiException as e:
            if e.status != 404:
                raise
        if loop.time() >= deadline:
            raise RuntimeError(
                f"Timed out waiting for {KUEUE_WEBHOOK_SERVICE_NAME} endpoints to be populated in {KUEUE_NAMESPACE}"
            )
        await asyncio.sleep(KUEUE_WEBHOOK_POLL_INTERVAL_SECONDS)


# ── Quota sizing ─────────────────────────────────────────────────────────────────────────────


async def _resolve_quota(k8s_client, quota_config: dict | None) -> tuple:
    """Returns (cpu_cores, memory_gb) as floats (whole numbers, floored - see module docstring
    on headroom/floor). `quota_config`, if given, must supply both `cpu_cores` and `memory_gb`
    explicitly and is used as-is, bypassing node-capacity computation entirely."""
    if quota_config and "cpu_cores" in quota_config and "memory_gb" in quota_config:
        return float(quota_config["cpu_cores"]), float(quota_config["memory_gb"])

    nodes = await k8s_client.core_api.list_node(_request_timeout=API_REQUEST_TIMEOUT_SECONDS)
    total_cpu_cores = 0.0
    total_memory_gb = 0.0
    for node in nodes.items:
        allocatable = node.status.allocatable or {}
        if "cpu" in allocatable:
            total_cpu_cores += _parse_cpu_cores(allocatable["cpu"])
        if "memory" in allocatable:
            total_memory_gb += _parse_memory_gb(allocatable["memory"])

    cpu_cores = max(QUOTA_MIN_CPU_CORES, math.floor(total_cpu_cores - QUOTA_HEADROOM_CPU_CORES))
    memory_gb = max(QUOTA_MIN_MEMORY_GB, math.floor(total_memory_gb - QUOTA_HEADROOM_MEMORY_GB))
    return float(cpu_cores), float(memory_gb)


def _format_cpu_quota(cpu_cores: float) -> str:
    return str(int(cpu_cores)) if cpu_cores == int(cpu_cores) else str(cpu_cores)


def _format_memory_quota(memory_gb: float) -> str:
    return f"{int(memory_gb)}Gi" if memory_gb == int(memory_gb) else f"{memory_gb}Gi"


# ── Kueue ResourceFlavor / ClusterQueue / LocalQueue ────────────────────────────────────────


async def _create_or_patch_cluster_object(custom_api, plural: str, body: dict) -> None:
    name = body["metadata"]["name"]
    try:
        await custom_api.create_cluster_custom_object(
            group=KUEUE_GROUP, version=KUEUE_API_VERSION_STR, plural=plural, body=body,
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
    except ApiException as e:
        if e.status != 409:
            raise
        # Use merge-patch semantics explicitly: with a plain dict body and PATCH,
        # kubernetes_asyncio's content-type auto-selection
        # (ApiClient.select_header_content_type) falls back to
        # 'application/json-patch+json' (a JSON-Patch *operations list*, which a full-object dict
        # body does not satisfy) since our body is a dict, not a list, and
        # 'application/strategic-merge-patch+json' isn't offered for CustomObjectsApi. Forcing
        # merge-patch here means the server merges our full desired object in, which for these
        # small, fully-specified bodies has the same effect as a replace.
        await custom_api.patch_cluster_custom_object(
            group=KUEUE_GROUP, version=KUEUE_API_VERSION_STR, plural=plural, name=name, body=body,
            _content_type="application/merge-patch+json",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )


async def _create_or_patch_namespaced_object(custom_api, plural: str, namespace: str, body: dict) -> None:
    name = body["metadata"]["name"]
    try:
        await custom_api.create_namespaced_custom_object(
            group=KUEUE_GROUP, version=KUEUE_API_VERSION_STR, namespace=namespace, plural=plural, body=body,
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
    except ApiException as e:
        if e.status != 409:
            raise
        # See _create_or_patch_cluster_object's comment on why _content_type is forced here.
        await custom_api.patch_namespaced_custom_object(
            group=KUEUE_GROUP, version=KUEUE_API_VERSION_STR, namespace=namespace, plural=plural, name=name, body=body,
            _content_type="application/merge-patch+json",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )


async def _apply_kueue_quota(namespace: str, cpu_cores: float, memory_gb: float) -> None:
    custom_api = client.CustomObjectsApi()
    api_version = f"{KUEUE_GROUP}/{KUEUE_API_VERSION_STR}"

    resource_flavor = {
        "apiVersion": api_version,
        "kind": "ResourceFlavor",
        "metadata": {"name": RESOURCE_FLAVOR_NAME},
    }
    cluster_queue = {
        "apiVersion": api_version,
        "kind": "ClusterQueue",
        "metadata": {"name": CLUSTER_QUEUE_NAME},
        "spec": {
            "namespaceSelector": {},
            "resourceGroups": [
                {
                    "coveredResources": ["cpu", "memory", "ephemeral-storage"],
                    "flavors": [
                        {
                            "name": RESOURCE_FLAVOR_NAME,
                            "resources": [
                                {"name": "cpu", "nominalQuota": _format_cpu_quota(cpu_cores)},
                                {"name": "memory", "nominalQuota": _format_memory_quota(memory_gb)},
                                {"name": "ephemeral-storage", "nominalQuota": EPHEMERAL_STORAGE_QUOTA},
                            ],
                        }
                    ],
                }
            ],
        },
    }
    local_queue = {
        "apiVersion": api_version,
        "kind": "LocalQueue",
        "metadata": {"name": LOCAL_QUEUE_NAME, "namespace": namespace},
        "spec": {"clusterQueue": CLUSTER_QUEUE_NAME},
    }

    logger.info(
        "Applying Kueue quotas: cpu=%s memory=%s (namespace=%s)",
        _format_cpu_quota(cpu_cores), _format_memory_quota(memory_gb), namespace,
    )
    await _create_or_patch_cluster_object(custom_api, "resourceflavors", resource_flavor)
    await _create_or_patch_cluster_object(custom_api, "clusterqueues", cluster_queue)
    await _create_or_patch_namespaced_object(custom_api, "localqueues", namespace, local_queue)


# ── Backend RBAC ─────────────────────────────────────────────────────────────────────────────


async def _create_or_patch(create, patch) -> None:
    """`create`/`patch` are zero-arg callables returning a fresh awaitable each time they're
    invoked (e.g. `lambda: api.create_x(...)`) - not already-created coroutine objects, since a
    coroutine can only be awaited once and this may need to call `create` then, on 409, `patch`.

    Uses PATCH rather than PUT/replace on an existing object deliberately: a PUT replace on these
    built-in RBAC types requires the request body to carry the object's current
    `metadata.resourceVersion` (Kubernetes' optimistic-concurrency contract for Update), which a
    freshly-constructed local object never has - PUTting one without it fails. PATCH has no such
    requirement. For these built-in RBAC kinds (unlike the Kueue CustomObjectsApi calls above,
    which are CRDs and must force `application/merge-patch+json` explicitly - CRDs don't support
    strategic-merge), `ApiClient.select_header_content_type` auto-selects
    `application/strategic-merge-patch+json` for a typed/dict PATCH body, so no explicit
    `_content_type` override is needed here."""
    try:
        await create()
    except ApiException as e:
        if e.status != 409:
            raise
        await patch()


async def _apply_backend_rbac(namespace: str) -> None:
    """Mirrors k8s/rbac/backend-jobs-rbac.yaml / the shell script's heredoc exactly. Applied
    unconditionally regardless of cluster_type, preserving the shell's "same least-privilege
    intent regardless of whether this cluster's identity model strictly needs it" policy (Design
    decision 8) - only actually load-bearing for "same-as-backend" clusters, where the backend's
    own in-cluster ServiceAccount token is the connecting identity."""
    rbac_api = client.RbacAuthorizationV1Api()

    role = client.V1Role(
        api_version="rbac.authorization.k8s.io/v1", kind="Role",
        metadata=client.V1ObjectMeta(name=RBAC_ROLE_NAME, namespace=namespace),
        rules=[
            client.V1PolicyRule(api_groups=["batch"], resources=["jobs"], verbs=["create", "get", "list", "watch", "delete"]),
            client.V1PolicyRule(api_groups=[""], resources=["pods"], verbs=["get", "list", "watch"]),
            client.V1PolicyRule(api_groups=[""], resources=["pods/log"], verbs=["get"]),
            client.V1PolicyRule(api_groups=[""], resources=["events"], verbs=["get", "list", "watch"]),
            client.V1PolicyRule(api_groups=[""], resources=["secrets"], verbs=["create", "get", "update"]),
        ],
    )
    await _create_or_patch(
        create=lambda: rbac_api.create_namespaced_role(namespace, role, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: rbac_api.patch_namespaced_role(RBAC_ROLE_NAME, namespace, role, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )

    role_binding = client.V1RoleBinding(
        api_version="rbac.authorization.k8s.io/v1", kind="RoleBinding",
        metadata=client.V1ObjectMeta(name=RBAC_ROLE_NAME, namespace=namespace),
        subjects=[client.RbacV1Subject(kind="ServiceAccount", name="default", namespace=BACKEND_SERVICE_ACCOUNT_NAMESPACE)],
        role_ref=client.V1RoleRef(kind="Role", name=RBAC_ROLE_NAME, api_group="rbac.authorization.k8s.io"),
    )
    await _create_or_patch(
        create=lambda: rbac_api.create_namespaced_role_binding(namespace, role_binding, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: rbac_api.patch_namespaced_role_binding(RBAC_ROLE_NAME, namespace, role_binding, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )

    cluster_role = client.V1ClusterRole(
        api_version="rbac.authorization.k8s.io/v1", kind="ClusterRole",
        metadata=client.V1ObjectMeta(name=RBAC_CLUSTERROLE_NAME),
        rules=[client.V1PolicyRule(api_groups=[KUEUE_GROUP], resources=["clusterqueues"], verbs=["get"])],
    )
    await _create_or_patch(
        create=lambda: rbac_api.create_cluster_role(cluster_role, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: rbac_api.patch_cluster_role(RBAC_CLUSTERROLE_NAME, cluster_role, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )

    cluster_role_binding = client.V1ClusterRoleBinding(
        api_version="rbac.authorization.k8s.io/v1", kind="ClusterRoleBinding",
        metadata=client.V1ObjectMeta(name=RBAC_CLUSTERROLE_NAME),
        subjects=[client.RbacV1Subject(kind="ServiceAccount", name="default", namespace=BACKEND_SERVICE_ACCOUNT_NAMESPACE)],
        role_ref=client.V1RoleRef(kind="ClusterRole", name=RBAC_CLUSTERROLE_NAME, api_group="rbac.authorization.k8s.io"),
    )
    await _create_or_patch(
        create=lambda: rbac_api.create_cluster_role_binding(cluster_role_binding, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: rbac_api.patch_cluster_role_binding(RBAC_CLUSTERROLE_NAME, cluster_role_binding, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )

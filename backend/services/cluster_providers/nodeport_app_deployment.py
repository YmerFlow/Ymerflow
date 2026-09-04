"""NodePort app-hosting reference implementation, shared by the two cluster types core ships that
support hosting the app itself: `same-as-backend` and `minikube`.

Both expose the app exactly the way `prod/runall-production.sh` does today — a NodePort Service on
the frontend, published on the host by minikube's docker driver — but parameterized (port and
public host resolved from `app_config`) instead of the hardcoded `30080`/`hostname -I` of the
shell script. This is the `expose_app()` half of Design decision 2 in
docs/plans/app-deployment-hooks.md; the workload half (`deploy_app()`) is entirely delegated to
the provider-agnostic `apply_app_workloads()` helper.

A cloud cluster type (a future plugin) would NOT reuse this mixin — it implements its own
`expose_app()` against a managed load balancer / Ingress / certificate mechanism, consuming
`app_config["APP_DOMAIN"]`. This mixin is the local/NodePort case only, which has no concept of a
domain (Design decision 6: `APP_DOMAIN` is meaningless here and simply ignored)."""
import logging

from kubernetes_asyncio import client
from kubernetes_asyncio.client.exceptions import ApiException

from backend.services.k8s_client import API_REQUEST_TIMEOUT_SECONDS
from backend.services import app_deployment

logger = logging.getLogger(__name__)

FRONTEND_SERVICE_NAME = "frontend"
DEFAULT_FRONTEND_NODE_PORT = 30080
DEFAULT_FRONTEND_TLS_NODE_PORT = 30443


class NodePortAppDeploymentMixin:
    """Mixed into a ClusterProvider to give it NodePort-based app hosting. Sets
    `supports_app_deployment = True`; provides `deploy_app()` (delegates to the shared helper) and
    `expose_app()` (a NodePort Service on the frontend)."""

    supports_app_deployment = True

    async def deploy_app(self, k8s_client, provider_config, namespace, images, app_config, secrets):
        # `image_pull_credentials`/`replicas` are threaded through app_config by the
        # yf-deploy-app entry point (it's the one place that resolves the registry axis and
        # any replica overrides); pulled back out here so apply_app_workloads() gets them as
        # first-class args rather than buried in the Secret data. Everything left in app_config
        # after popping these is real Secret material.
        app_config = dict(app_config)
        image_pull_credentials = app_config.pop("_image_pull_credentials", None)
        replicas = app_config.pop("_replicas", None)
        registry_reachable = app_config.pop("_registry_reachable", None)
        await app_deployment.apply_app_workloads(
            k8s_client, namespace, images, app_config, secrets,
            image_pull_credentials=image_pull_credentials, replicas=replicas,
            registry_reachable=registry_reachable,
        )

    async def expose_app(self, k8s_client, provider_config, namespace, app_config):
        await k8s_client._ensure_initialized()
        node_port = int(app_config.get("FRONTEND_NODE_PORT") or DEFAULT_FRONTEND_NODE_PORT)

        ports = [client.V1ServicePort(port=80, target_port=80, node_port=node_port, name="http")]
        # Public TLS on => also publish the frontend nginx's :443 TLS listener on its own NodePort,
        # so the host's :443 forward can reach it (mirrors the :80/http port above). Gated on the
        # same PUBLIC_TLS switch as the certbot sidecar/PVC in app_deployment.py — off => the
        # Service stays http-only, exactly as today.
        if app_config.get("PUBLIC_TLS") == "letsencrypt":
            tls_node_port = int(app_config.get("FRONTEND_TLS_NODE_PORT") or DEFAULT_FRONTEND_TLS_NODE_PORT)
            ports.append(client.V1ServicePort(port=443, target_port=443, node_port=tls_node_port, name="https"))

        service = client.V1Service(
            api_version="v1", kind="Service",
            metadata=client.V1ObjectMeta(name=FRONTEND_SERVICE_NAME, namespace=namespace),
            spec=client.V1ServiceSpec(
                type="NodePort",
                selector={"app": "frontend"},
                ports=ports,
            ),
        )
        try:
            await k8s_client.core_api.create_namespaced_service(
                namespace, service, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
        except ApiException as e:
            # A NodePort Service that already exists re-creates as a 422 "provided port is
            # already allocated" rather than the usual 409 "already exists" — the apiserver's
            # port allocator validates nodePort availability before the name-uniqueness check
            # ever runs, so it rejects a create attempt that collides with the Service's own
            # already-assigned port. Treat 422 as a conflict too, so a re-run against an
            # already-exposed app falls back to patch() instead of crashing every time (same fix
            # as minikube_plugin/k8s_apply.py's apply_service(), which hits the identical issue
            # for the registry's own NodePort Service).
            if e.status not in (409, 422):
                raise
            await k8s_client.core_api.patch_namespaced_service(
                FRONTEND_SERVICE_NAME, namespace, service, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)

        # SERVER_URL, if the operator set one, is authoritative for the returned URL — a NodePort
        # has no way to know the host's externally-reachable address itself (today's shell derives
        # it from `hostname -I`, which the caller does and passes in here). Fall back to just the
        # port when no public host is known.
        server_url = app_config.get("SERVER_URL")
        url = server_url or f":{node_port}"
        logger.info("Exposed app via NodePort %s (url=%s)", node_port, url)
        return {"url": url, "node_port": node_port}

"""Provider-agnostic K8s-API helper for hosting the YmerFlow application itself (backend +
frontend pods, their workload-level config/secrets, and the DB migration) on whatever cluster a
deployment's default `Cluster` row points at.

Mirrors the shape of `backend/services/cluster_job_provisioning.py`'s
`ensure_cluster_job_ready()`: a shared utility, not itself part of the `ClusterProvider` ABC,
called by every provider's own `deploy_app()` hook method — see
docs/plans/app-deployment-hooks.md, Design decision 3. Written against `kubernetes_asyncio` (the
same library `K8sClient`/`ensure_cluster_job_ready()` already use), not shell/`kubectl`.

What this module does NOT own — stays outside app-hosting scope: the jobs namespace, Postgres,
pgAdmin/Headlamp (applied identically for every cluster type via the existing `k8s/*.yaml`
manifests, against whatever cluster `yf-materialize-kubeconfig` resolves — see
docs/plans/base-infrastructure-via-cluster-provider.md), MinIO/the Docker registry (NOT static
manifests since the minikube-plugin migration — deployed per-protocol by each axis's own
`bootstrap()`, see docs/plans/done/generic-deployment-orchestration.md), and the backend's
job-running RBAC (`ensure_cluster_job_ready()`'s concern). This module owns only: the backend/frontend
Deployments, the backend's in-namespace ClusterIP Service (`backend-service` — also the target of
the separate, unrelated `ymerflow-jobs` ExternalName Service job pods use to reach the backend,
which stays a static k8s/ manifest), the single `ymerflow-backend-secret` Secret (the
`ymerflow-backend-config` ConfigMap was retired — see
docs/plans/generic-backend-config-passthrough.md — every app runtime config/secret value now rides
in one Secret, since `envFrom` already flattens each of its keys to its own container env var; a
second K8s object bought nothing but a "which list does this key belong on" classification
problem), and the one-shot DB migration Job. How external traffic actually reaches the frontend
(NodePort, LoadBalancer, Ingress, ...) is deliberately NOT this module's job — that's the
"genuinely provider-specific part" a `ClusterProvider.expose_app()` implementation owns (Design
decision 2).

`apply_app_workloads()` runs the migration Job to completion *before* applying the backend/
frontend Deployments, so — unlike today's `runall-production.sh`, which also runs a redundant
`migrate` initContainer on the backend Deployment itself as a second guarantee (see
docs/plans/done/registry-backend-hooks.md's Background section, which calls this out as a
pre-existing duplication) — neither Deployment needs its own wait-for-postgres/migrate
initContainer here: by the time either is applied, the migration Job has already proven Postgres
is reachable and the schema is current.
"""
import asyncio
import base64
import json
import logging
import secrets as secrets_module

from kubernetes_asyncio import client
from kubernetes_asyncio.client.exceptions import ApiException

from backend.services.k8s_client import API_REQUEST_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

SECRET_NAME = "ymerflow-backend-secret"
IMAGE_PULL_SECRET_NAME = "ymerflow-app-pull"
MIGRATION_JOB_NAME = "ymerflow-app-migrate"
MIGRATION_JOB_TIMEOUT_SECONDS = 300
MIGRATION_JOB_POLL_INTERVAL_SECONDS = 3
STALE_JOB_DELETE_TIMEOUT_SECONDS = 60

# Matches job_orchestrator.py's hardcoded BACKEND_URL ("http://backend-service:8000") and
# k8s/backend/service.yaml's ExternalName Service in the ymerflow-jobs namespace, which points
# at this exact name — job pods reach the backend through that ExternalName, which this module
# does not create or touch (it lives in a different namespace and is unrelated to app hosting).
BACKEND_SERVICE_NAME = "backend-service"
BACKEND_DEPLOYMENT_NAME = "backend"
FRONTEND_DEPLOYMENT_NAME = "frontend"

ADMIN_HTPASSWD_SECRET_NAME = "ymerflow-admin-secret"
HEADLAMP_TOKEN_SECRET_NAME = "headlamp-nginx-token"

# Public-TLS edge (optional, gated on app_config["PUBLIC_TLS"] == "letsencrypt"; see
# docs/plans/nginx-letsencrypt-public-tls.md). When on, the frontend pod gains a certbot sidecar
# and this PVC, which holds the Let's Encrypt account + certs at /etc/letsencrypt. The PVC is the
# crux of "don't re-issue on every redeploy": it survives pod restarts / app redeploys, so certbot
# finds a valid cert and no-ops. The env keys the nginx container's 40-tls.sh and the certbot
# sidecar read are set explicitly from app_config below (the frontend pod, unlike the backend, has
# no envFrom the backend Secret).
LETSENCRYPT_PVC_NAME = "ymerflow-letsencrypt"
CERTBOT_IMAGE = "certbot/certbot"
PUBLIC_TLS_HOST_KEYS = (
    "PUBLIC_TLS_APP_HOST", "PUBLIC_TLS_S3_HOST",
    "PUBLIC_TLS_CONSOLE_HOST", "PUBLIC_TLS_REGISTRY_HOST",
)


async def apply_app_workloads(k8s_client, namespace: str, images: dict, app_config: dict,
                               secrets: dict, image_pull_credentials: dict | None = None,
                               replicas: dict | None = None) -> None:
    """Apply every workload-level resource the YmerFlow app itself needs, in `namespace`, on
    whatever cluster `k8s_client` points at. Idempotent — safe to call repeatedly (e.g. on every
    redeploy): every object is created-or-patched, never assumed absent.

    Args:
        k8s_client: a `backend.services.k8s_client.K8sClient` (or subclass) already carrying
            whatever provider_config this cluster needs.
        namespace: the namespace to apply everything into (the app namespace, e.g. "ymerflow")
            — NOT necessarily `Cluster.namespace`, which is the *jobs* namespace; app hosting
            shares a `Cluster` row with job execution, not necessarily its namespace (Design
            decision 1 in docs/plans/app-deployment-hooks.md).
        images: `{"backend": <fully-resolved image ref>, "frontend": <fully-resolved image ref>}`
            — already-resolved `RegistryProtocolHandler.image_url()` strings (Design decision 4);
            this module never resolves a registry itself.
        app_config: flat str->str data merged into `ymerflow-backend-secret` alongside `secrets`
            (the two are only distinguished by caller convention — both end up in the same
            Secret, see module docstring).
        secrets: flat str->str data merged into `ymerflow-backend-secret` alongside `app_config`
            — the combined map must include "DATABASE_URL" (already fully resolved, e.g. with the
            Postgres password inlined; Postgres itself is outside this module's scope, see module
            docstring). May include "JWT_SECRET_KEY" as an explicit override (mirrors today's
            config.env JWT_SECRET_KEY precedence); if omitted, an existing Secret's
            JWT_SECRET_KEY is reused, and only a brand-new deployment generates one (Design
            decision 5).
        image_pull_credentials: optional `{"registry_server", "username", "password"}` — when
            given, a shared `kubernetes.io/dockerconfigjson` Secret is applied and attached to
            every pod here as imagePullSecrets. `None` means the cluster can pull `images`
            without credentials (e.g. a fully public registry).
        replicas: optional `{"backend": int, "frontend": int}` overrides; defaults to 1 each.
    """
    await k8s_client._ensure_initialized()
    replicas = replicas or {}

    # app_config and secrets merge into the one Secret — see module docstring and
    # docs/plans/generic-backend-config-passthrough.md. Merged before resolving JWT_SECRET_KEY so
    # an explicit override is found regardless of which of the two dicts the caller put it in.
    secret_data = {**app_config, **secrets}
    secret_data["JWT_SECRET_KEY"] = await _resolve_jwt_secret_key(k8s_client, namespace, secret_data)
    await _apply_secret(k8s_client, namespace, SECRET_NAME, secret_data)

    pull_secret_names = []
    if image_pull_credentials:
        await _apply_image_pull_secret(k8s_client, namespace, IMAGE_PULL_SECRET_NAME, image_pull_credentials)
        pull_secret_names.append(IMAGE_PULL_SECRET_NAME)

    await _run_migration_job(k8s_client, namespace, images["backend"], pull_secret_names)

    await _apply_backend(k8s_client, namespace, images["backend"], pull_secret_names, replicas.get("backend", 1))
    await _apply_frontend(k8s_client, namespace, images["frontend"], pull_secret_names,
                          replicas.get("frontend", 1), app_config)


# ── Create-or-patch helper ───────────────────────────────────────────────────────────────────


async def _create_or_patch_namespaced(create, patch) -> None:
    """`create`/`patch` are zero-arg callables returning a fresh awaitable each time they're
    invoked, exactly like `cluster_job_provisioning.py`'s `_create_or_patch` — a coroutine can
    only be awaited once and this may need to call `create` then, on 409, `patch`. Every object
    applied through this module is a built-in K8s kind (Deployment/Service/ConfigMap/Secret/Job),
    so `ApiClient.select_header_content_type` auto-selects strategic-merge-patch for the PATCH
    call with no explicit `_content_type` override needed (unlike the Kueue CRDs in
    cluster_job_provisioning.py)."""
    try:
        await create()
    except ApiException as e:
        if e.status != 409:
            raise
        await patch()


# ── Secret ───────────────────────────────────────────────────────────────────────────────────


async def _apply_secret(k8s_client, namespace, name, data) -> None:
    secret = client.V1Secret(
        api_version="v1", kind="Secret",
        metadata=client.V1ObjectMeta(name=name, namespace=namespace),
        string_data={k: str(v) for k, v in data.items()},
    )
    await _create_or_patch_namespaced(
        create=lambda: k8s_client.core_api.create_namespaced_secret(
            namespace, secret, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: k8s_client.core_api.patch_namespaced_secret(
            name, namespace, secret, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )


async def _apply_image_pull_secret(k8s_client, namespace, name, credentials) -> None:
    """A single shared pull Secret for the app's own long-lived Deployments/migration Job —
    deliberately simpler than the per-Job ephemeral pull Secret mechanism `job_orchestrator.py`
    uses for process Jobs (Design decision 4 in docs/plans/done/registry-backend-hooks.md): app
    pods are long-lived Deployments, not one-off Jobs, so there's no "as old as the Job itself"
    property to preserve. Re-applying (patching) this Secret on every `apply_app_workloads()`
    call keeps it fresh if credentials rotate."""
    server = credentials["registry_server"]
    username = credentials.get("username") or ""
    password = credentials.get("password") or ""
    dockerconfigjson = json.dumps({
        "auths": {
            server: {
                "username": username,
                "password": password,
                "auth": base64.b64encode(f"{username}:{password}".encode()).decode(),
            }
        }
    })
    secret = client.V1Secret(
        api_version="v1", kind="Secret",
        metadata=client.V1ObjectMeta(name=name, namespace=namespace),
        type="kubernetes.io/dockerconfigjson",
        data={".dockerconfigjson": base64.b64encode(dockerconfigjson.encode()).decode()},
    )
    await _create_or_patch_namespaced(
        create=lambda: k8s_client.core_api.create_namespaced_secret(
            namespace, secret, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: k8s_client.core_api.patch_namespaced_secret(
            name, namespace, secret, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )


async def _resolve_jwt_secret_key(k8s_client, namespace, config) -> str:
    """Design decision 5: check-before-generate against the K8s API, replacing the host-file
    (`YMERFLOW_DATA_DIR/jwt_secret_key`) persistence mechanism. Priority matches today's shell
    logic exactly: an explicit override in `config` (config.env's JWT_SECRET_KEY) wins, then an
    existing Secret's value is reused so existing tokens stay valid across a redeploy, and only a
    genuinely first-ever deployment generates a fresh one."""
    explicit = config.get("JWT_SECRET_KEY")
    if explicit:
        return explicit

    try:
        existing = await k8s_client.core_api.read_namespaced_secret(
            SECRET_NAME, namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
    except ApiException as e:
        if e.status != 404:
            raise
        existing = None

    if existing and existing.data and existing.data.get("JWT_SECRET_KEY"):
        logger.info("Reusing existing JWT_SECRET_KEY from %s/%s", namespace, SECRET_NAME)
        return base64.b64decode(existing.data["JWT_SECRET_KEY"]).decode()

    logger.info("No existing JWT_SECRET_KEY found in %s/%s — generating a new one", namespace, SECRET_NAME)
    return secrets_module.token_urlsafe(32)


# ── DB migration Job ─────────────────────────────────────────────────────────────────────────


def _env_from() -> list:
    return [client.V1EnvFromSource(secret_ref=client.V1SecretEnvSource(name=SECRET_NAME))]


def _image_pull_secrets(pull_secret_names) -> list | None:
    return [client.V1LocalObjectReference(name=n) for n in pull_secret_names] or None


async def _run_migration_job(k8s_client, namespace, backend_image, pull_secret_names) -> None:
    try:
        await k8s_client.batch_api.delete_namespaced_job(
            MIGRATION_JOB_NAME, namespace, propagation_policy="Foreground",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
        await _wait_for_job_gone(k8s_client, namespace)
    except ApiException as e:
        if e.status != 404:
            raise

    job = client.V1Job(
        api_version="batch/v1", kind="Job",
        metadata=client.V1ObjectMeta(name=MIGRATION_JOB_NAME, namespace=namespace),
        spec=client.V1JobSpec(
            backoff_limit=0,
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app": "ymerflow-app-migrate"}),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    image_pull_secrets=_image_pull_secrets(pull_secret_names),
                    containers=[client.V1Container(
                        name="migrate",
                        image=backend_image,
                        # backend_image is now a content-addressed tag (APP_IMAGE_VERSION, see
                        # docs/plans/versioned-app-image-tags.md) — never reused for different
                        # content — so IfNotPresent is correct and faster than an unconditional
                        # re-pull, same as job_orchestrator.py's existing IfNotPresent precedent.
                        image_pull_policy="IfNotPresent",
                        command=["python", "backend/bin/yf-migrate"],
                        env_from=_env_from(),
                    )],
                ),
            ),
        ),
    )
    await k8s_client.batch_api.create_namespaced_job(
        namespace, job, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
    await _wait_for_job_complete(k8s_client, namespace)


async def _wait_for_job_gone(k8s_client, namespace) -> None:
    """Foreground deletion is asynchronous (cascades to the Job's pods first) — poll until the
    Job object itself is actually gone before creating its replacement under the same name."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + STALE_JOB_DELETE_TIMEOUT_SECONDS
    while True:
        try:
            await k8s_client.batch_api.read_namespaced_job(
                MIGRATION_JOB_NAME, namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
        except ApiException as e:
            if e.status == 404:
                return
            raise
        if loop.time() >= deadline:
            raise RuntimeError(f"Timed out waiting for stale {MIGRATION_JOB_NAME} Job to finish deleting")
        await asyncio.sleep(2)


async def _wait_for_job_complete(k8s_client, namespace) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + MIGRATION_JOB_TIMEOUT_SECONDS
    while True:
        job = await k8s_client.batch_api.read_namespaced_job(
            MIGRATION_JOB_NAME, namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
        for condition in (job.status.conditions or []):
            if condition.type == "Complete" and condition.status == "True":
                logger.info("Migration Job %s completed", MIGRATION_JOB_NAME)
                return
            if condition.type == "Failed" and condition.status == "True":
                logs = await _fetch_job_pod_logs(k8s_client, namespace)
                raise RuntimeError(
                    f"Migration Job {MIGRATION_JOB_NAME} failed: {condition.reason} {condition.message}\n{logs}"
                )
        if loop.time() >= deadline:
            logs = await _fetch_job_pod_logs(k8s_client, namespace)
            raise RuntimeError(f"Timed out waiting for migration Job {MIGRATION_JOB_NAME} to complete\n{logs}")
        await asyncio.sleep(MIGRATION_JOB_POLL_INTERVAL_SECONDS)


async def _fetch_job_pod_logs(k8s_client, namespace) -> str:
    try:
        pods = await k8s_client.core_api.list_namespaced_pod(
            namespace, label_selector=f"job-name={MIGRATION_JOB_NAME}",
            _request_timeout=API_REQUEST_TIMEOUT_SECONDS,
        )
        if not pods.items:
            return "(no pod found for migration Job)"
        return await k8s_client.core_api.read_namespaced_pod_log(
            pods.items[0].metadata.name, namespace, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
    except ApiException as e:
        return f"(failed to fetch migration Job pod logs: {e})"


# ── Backend / frontend Deployments ──────────────────────────────────────────────────────────


async def _apply_deployment(k8s_client, namespace, deployment, name) -> None:
    apps_api = client.AppsV1Api()
    await _create_or_patch_namespaced(
        create=lambda: apps_api.create_namespaced_deployment(
            namespace, deployment, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: apps_api.patch_namespaced_deployment(
            name, namespace, deployment, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )


async def _apply_backend(k8s_client, namespace, image, pull_secret_names, replicas) -> None:
    container = client.V1Container(
        name="backend",
        image=image,
        # Same content-addressed-tag rationale as _run_migration_job's image_pull_policy above.
        image_pull_policy="IfNotPresent",
        ports=[client.V1ContainerPort(container_port=8000)],
        env_from=_env_from(),
        readiness_probe=client.V1Probe(
            http_get=client.V1HTTPGetAction(path="/", port=8000),
            initial_delay_seconds=10, period_seconds=5,
        ),
    )
    deployment = client.V1Deployment(
        api_version="apps/v1", kind="Deployment",
        metadata=client.V1ObjectMeta(name=BACKEND_DEPLOYMENT_NAME, namespace=namespace),
        spec=client.V1DeploymentSpec(
            replicas=replicas,
            selector=client.V1LabelSelector(match_labels={"app": "backend"}),
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app": "backend"}),
                spec=client.V1PodSpec(
                    containers=[container],
                    image_pull_secrets=_image_pull_secrets(pull_secret_names),
                ),
            ),
        ),
    )
    await _apply_deployment(k8s_client, namespace, deployment, BACKEND_DEPLOYMENT_NAME)

    # ClusterIP Service, needed internally regardless of provider (frontend nginx proxies /api to
    # it; the separate ymerflow-jobs ExternalName Service DNS-points at it too) — not
    # provider-specific exposure, so it lives here rather than in expose_app().
    service = client.V1Service(
        api_version="v1", kind="Service",
        metadata=client.V1ObjectMeta(name=BACKEND_SERVICE_NAME, namespace=namespace),
        spec=client.V1ServiceSpec(
            type="ClusterIP",
            selector={"app": "backend"},
            ports=[client.V1ServicePort(port=8000, target_port=8000, name="http")],
        ),
    )
    await _create_or_patch_namespaced(
        create=lambda: k8s_client.core_api.create_namespaced_service(
            namespace, service, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
        patch=lambda: k8s_client.core_api.patch_namespaced_service(
            BACKEND_SERVICE_NAME, namespace, service, _request_timeout=API_REQUEST_TIMEOUT_SECONDS),
    )


async def _apply_frontend(k8s_client, namespace, image, pull_secret_names, replicas,
                          app_config=None) -> None:
    app_config = app_config or {}
    # Public-TLS edge is entirely opt-in: only PUBLIC_TLS=letsencrypt injects the certbot sidecar,
    # the cert PVC, the ACME webroot, the :443 port, and the TLS env for 40-tls.sh. Empty/unset =>
    # none of the below runs and the frontend pod is byte-for-byte today's plain :80 Deployment.
    tls_enabled = app_config.get("PUBLIC_TLS") == "letsencrypt"

    ports = [client.V1ContainerPort(container_port=80)]
    volume_mounts = [
        client.V1VolumeMount(name="admin-htpasswd", mount_path="/etc/nginx/htpasswd", read_only=True),
        client.V1VolumeMount(name="headlamp-token", mount_path="/etc/nginx/headlamp-token", read_only=True),
    ]
    container_env = []
    volumes = [
        client.V1Volume(
            name="admin-htpasswd",
            secret=client.V1SecretVolumeSource(
                secret_name=ADMIN_HTPASSWD_SECRET_NAME,
                items=[client.V1KeyToPath(key="htpasswd", path="admin.htpasswd")],
            ),
        ),
        # optional=True: this Secret may not exist yet the first time deploy_app() runs before
        # Headlamp itself has come up and minted its token (mirrors today's k8s/frontend/
        # deployment.yaml, which the frontend pod tolerates missing — nginx just serves without
        # Headlamp auto-auth until it's populated and the pod is restarted).
        client.V1Volume(
            name="headlamp-token",
            secret=client.V1SecretVolumeSource(secret_name=HEADLAMP_TOKEN_SECRET_NAME, optional=True),
        ),
    ]
    extra_containers = []

    if tls_enabled:
        await _apply_letsencrypt_pvc(k8s_client, namespace)
        # 40-tls.sh reads the hostnames from env (the frontend pod has no envFrom the backend
        # Secret); pass PUBLIC_TLS + each configured host through as literal container env.
        tls_env = {"PUBLIC_TLS": "letsencrypt"}
        tls_env.update({k: app_config[k] for k in PUBLIC_TLS_HOST_KEYS if app_config.get(k)})
        container_env += [client.V1EnvVar(name=k, value=str(v)) for k, v in tls_env.items()]
        ports.append(client.V1ContainerPort(container_port=443))
        tls_mounts = [
            client.V1VolumeMount(name="letsencrypt", mount_path="/etc/letsencrypt"),
            client.V1VolumeMount(name="acme-webroot", mount_path="/var/www/acme"),
        ]
        volume_mounts += tls_mounts
        volumes += [
            client.V1Volume(
                name="letsencrypt",
                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                    claim_name=LETSENCRYPT_PVC_NAME),
            ),
            client.V1Volume(name="acme-webroot", empty_dir=client.V1EmptyDirVolumeSource()),
        ]
        extra_containers.append(_certbot_sidecar(app_config, tls_mounts))

    container = client.V1Container(
        name="frontend",
        image=image,
        # Same content-addressed-tag rationale as _run_migration_job's image_pull_policy above.
        image_pull_policy="IfNotPresent",
        ports=ports,
        env=container_env or None,
        volume_mounts=volume_mounts,
        readiness_probe=client.V1Probe(
            # Always probe :80 — it's up in every state (plain app, or app+ACME, or the
            # 301-redirect that still returns a 3xx k8s treats as ready) before any cert exists.
            http_get=client.V1HTTPGetAction(path="/", port=80),
            initial_delay_seconds=5, period_seconds=5,
        ),
    )
    deployment = client.V1Deployment(
        api_version="apps/v1", kind="Deployment",
        metadata=client.V1ObjectMeta(name=FRONTEND_DEPLOYMENT_NAME, namespace=namespace),
        spec=client.V1DeploymentSpec(
            replicas=replicas,
            selector=client.V1LabelSelector(match_labels={"app": "frontend"}),
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app": "frontend"}),
                spec=client.V1PodSpec(
                    containers=[container] + extra_containers,
                    volumes=volumes,
                    image_pull_secrets=_image_pull_secrets(pull_secret_names),
                ),
            ),
        ),
    )
    await _apply_deployment(k8s_client, namespace, deployment, FRONTEND_DEPLOYMENT_NAME)


# certbot renew re-checks every 12h; a fresh cert nginx picks up via 41-tls-watch.sh (no shared PID
# namespace needed — the watcher polls the shared PVC and reloads nginx itself). The initial
# issuance retries every 60s until it succeeds, because `certbot renew` is a no-op while no cert
# lineage exists yet — so a first-boot race where nginx's :80 isn't reachable when certbot starts
# must not be left to the renew loop.
_CERTBOT_SCRIPT = r"""
set -u
APP="$PUBLIC_TLS_APP_HOST"
DOMAINS="-d $APP"
[ -n "${PUBLIC_TLS_S3_HOST:-}" ]       && DOMAINS="$DOMAINS -d $PUBLIC_TLS_S3_HOST"
[ -n "${PUBLIC_TLS_CONSOLE_HOST:-}" ]  && DOMAINS="$DOMAINS -d $PUBLIC_TLS_CONSOLE_HOST"
[ -n "${PUBLIC_TLS_REGISTRY_HOST:-}" ] && DOMAINS="$DOMAINS -d $PUBLIC_TLS_REGISTRY_HOST"
STAGING=""
[ "${LETSENCRYPT_STAGING:-}" = "true" ] && STAGING="--staging"
while [ ! -f "/etc/letsencrypt/live/$APP/fullchain.pem" ]; do
    echo "certbot: requesting initial certificate for: $DOMAINS"
    certbot certonly --webroot -w /var/www/acme --non-interactive --agree-tos \
        --email "$LETSENCRYPT_EMAIL" --keep-until-expiring --expand $STAGING $DOMAINS \
        && break
    echo "certbot: issuance failed (is :80 reachable yet?); retrying in 60s"
    sleep 60
done
echo "certbot: certificate present; entering renew loop"
while true; do
    certbot renew --webroot -w /var/www/acme --non-interactive $STAGING || true
    sleep 43200
done
"""


def _certbot_sidecar(app_config, volume_mounts):
    """The certbot sidecar: obtains/renews the Let's Encrypt cert onto the shared PVC. It never
    touches nginx — 41-tls-watch.sh in the nginx container notices the cert on the PVC and reloads.
    Env comes straight from app_config (LETSENCRYPT_* + the PUBLIC_TLS_*_HOST names)."""
    env_keys = ("LETSENCRYPT_EMAIL", "LETSENCRYPT_STAGING") + PUBLIC_TLS_HOST_KEYS
    env = [client.V1EnvVar(name=k, value=str(app_config[k]))
           for k in env_keys if app_config.get(k) is not None]
    return client.V1Container(
        name="certbot",
        image=CERTBOT_IMAGE,
        command=["/bin/sh", "-c", _CERTBOT_SCRIPT],
        env=env,
        volume_mounts=volume_mounts,
    )


async def _apply_letsencrypt_pvc(k8s_client, namespace) -> None:
    """Create the cert PVC if absent; never patch it (a bound PVC's spec is largely immutable and
    re-applying must not disturb the stored certs). 128Mi is ample for the account + a handful of
    cert lineages."""
    pvc = client.V1PersistentVolumeClaim(
        api_version="v1", kind="PersistentVolumeClaim",
        metadata=client.V1ObjectMeta(name=LETSENCRYPT_PVC_NAME, namespace=namespace),
        spec=client.V1PersistentVolumeClaimSpec(
            access_modes=["ReadWriteOnce"],
            resources=client.V1ResourceRequirements(requests={"storage": "128Mi"}),
        ),
    )
    try:
        await k8s_client.core_api.create_namespaced_persistent_volume_claim(
            namespace, pvc, _request_timeout=API_REQUEST_TIMEOUT_SECONDS)
    except ApiException as e:
        if e.status != 409:
            raise  # already exists is fine; anything else is a real error (never swallowed)

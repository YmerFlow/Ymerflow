import hashlib
from dataclasses import dataclass
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Dict

from backend.config import settings
from backend.database import get_db
from backend.auth_deps import require_admin
from backend.models.cluster import Cluster
from backend.models.storage_backend import StorageBackend
from backend.models.tos import TosVersion
from backend.models.user import User
from backend.services.cluster_providers import get_cluster_provider
from backend.services.cluster_job_provisioning import ensure_cluster_job_ready
from backend.services.storage_protocols import get_protocol_handler
from backend.services.secret_masking import mask_config, resolve_config

router = APIRouter(tags=["Admin"])

# ── Self-service cluster registration (any provider with self_service_registration=True) ──────
# See docs/plans/minikube-cluster-registration-ux.md ("minikube" is the first and, so far, only
# such provider). The token is generated client-side by the admin's browser and never sent to the
# backend except as a bearer credential — only its SHA-256 hash is ever stored (same pattern as
# ApiKey.key_hash). No expiry: an unclaimed row is inert and harmless, see Cluster model comment.


def _hash_registration_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _cluster_admin_dict(cluster: Cluster) -> Dict:
    d = cluster.to_dict()
    d["cluster_type"] = cluster.cluster_type
    d["provider_config"] = mask_config(cluster.provider_config)
    return d


async def _test_and_apply_connection(cluster: Cluster, body: Dict) -> None:
    """Only touches cluster_type/provider_config if the caller actually sent them, and only
    re-tests the connection in that case — editing unrelated fields must not fail because the
    cluster is momentarily unreachable (see docs/plans/cluster-admin-ui.md Design decisions)."""
    if "cluster_type" in body or "provider_config" in body:
        cluster_type = body.get("cluster_type", cluster.cluster_type)
        submitted = body.get("provider_config") or {}
        stored = cluster.provider_config if cluster_type == cluster.cluster_type else {}
        try:
            provider_config = resolve_config(submitted, stored)
            provider = get_cluster_provider(cluster_type)
            await provider.test_connection(provider_config)
        except HTTPException:
            raise
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
        cluster.cluster_type = cluster_type
        cluster.provider_config = provider_config


def _apply_generic_fields(cluster: Cluster, body: Dict) -> None:
    """Only touches a column if its key is present in body — write-only-if-provided, same rule
    the rest of this route module follows for provider_config."""
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        cluster.name = name
    if "namespace" in body:
        cluster.namespace = body.get("namespace") or "nagelfluh-jobs"
    if "sort_order" in body:
        try:
            cluster.sort_order = int(body["sort_order"])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="sort_order must be an integer")
    if "active" in body:
        if not isinstance(body["active"], bool):
            raise HTTPException(status_code=400, detail="active must be a boolean")
        cluster.active = body["active"]
        if cluster.active and cluster.registration_token_hash:
            # Claiming a self-service-registered row (see
            # docs/plans/minikube-cluster-registration-ux.md Design decision 6) — the token has
            # done its job now that the admin has activated the row via Save.
            cluster.registration_token_hash = None
            if cluster.provisioning_status == "pending":
                cluster.provisioning_status = "active"
    if "max_runtime_seconds" in body:
        value = body["max_runtime_seconds"]
        if value is not None:
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise HTTPException(status_code=400, detail="max_runtime_seconds must be a positive integer or null")
        cluster.max_runtime_seconds = value


@router.get("/admin/clusters")
async def admin_list_clusters(auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Cluster).order_by(Cluster.sort_order))
    return [_cluster_admin_dict(c) for c in result.scalars().all()]


@router.get("/admin/clusters/by-registration-token")
async def admin_get_cluster_by_registration_token(
    token: str, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)
):
    """Polled by the still-open "Add Cluster" dialog after the admin runs the self-service setup
    command (see docs/plans/minikube-cluster-registration-ux.md) — looks up whichever Cluster row
    POST /admin/clusters/register-callback created/updated for this client-generated token, so the
    dialog can show "configuration received" and let the admin claim it via Save. 404 until the
    callback has landed."""
    token_hash = _hash_registration_token(token)
    result = await db.execute(select(Cluster).where(Cluster.registration_token_hash == token_hash))
    cluster = result.scalar_one_or_none()
    if cluster is None:
        raise HTTPException(status_code=404, detail="No cluster found for this registration token")
    return _cluster_admin_dict(cluster)


@router.post("/admin/clusters")
async def admin_create_cluster(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if not (body.get("name") or "").strip():
        raise HTTPException(status_code=400, detail="name is required")

    cluster_type = body.get("cluster_type", "kubeconfig")
    try:
        provider = get_cluster_provider(cluster_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if provider.self_service_registration:
        # Self-service cluster types (today just "minikube") are never created directly — the
        # Cluster row comes into being lazily, the first time
        # POST /admin/clusters/register-callback sees a client-generated token it doesn't
        # recognize yet. See docs/plans/minikube-cluster-registration-ux.md.
        raise HTTPException(
            status_code=400,
            detail=f"{cluster_type} clusters are created via self-service registration, not directly",
        )

    cluster = Cluster(name=body["name"].strip(), namespace=body.get("namespace") or "nagelfluh-jobs")
    await _test_and_apply_connection(cluster, body)
    _apply_generic_fields(cluster, body)
    if "cluster_type" in body or "provider_config" in body:
        # A connection was actually established above (same condition
        # _test_and_apply_connection itself uses to decide whether to test at all) - make the
        # cluster job-ready before persisting it, so a cluster that fails job-readiness
        # provisioning is never saved at all (clean rollback-by-never-having-saved; this
        # synchronous direct-creation path has no "pending row" concept to fall back to, unlike
        # cluster_register_callback's async polled flow - see
        # docs/plans/registry-backend-hooks.md Phase 7).
        try:
            provider = get_cluster_provider(cluster.cluster_type)
            k8s_client = provider.connect(cluster.provider_config, cluster.namespace)
            await ensure_cluster_job_ready(k8s_client, cluster.namespace)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Job-readiness provisioning failed: {e}")
    db.add(cluster)
    await db.commit()
    return _cluster_admin_dict(cluster)


@router.patch("/admin/clusters/{cluster_id}")
async def admin_update_cluster(cluster_id: str, body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    cluster = await db.get(Cluster, cluster_id)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    await _test_and_apply_connection(cluster, body)
    _apply_generic_fields(cluster, body)
    await db.commit()
    return _cluster_admin_dict(cluster)


@router.post("/admin/clusters/test-connection")
async def admin_test_cluster_connection(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Stateless test for the 'Test Connection' button — no cluster row required, so it works
    while filling out the create form before anything is saved. If cluster_id is provided and
    matches an existing cluster of the same cluster_type, masked fields resolve against its
    stored provider_config."""
    cluster_type = body.get("cluster_type")
    if not cluster_type:
        raise HTTPException(status_code=400, detail="cluster_type is required")
    stored = {}
    cluster_id = body.get("cluster_id")
    if cluster_id:
        existing = await db.get(Cluster, cluster_id)
        if existing is not None and existing.cluster_type == cluster_type:
            stored = existing.provider_config or {}
    try:
        provider_config = resolve_config(body.get("provider_config") or {}, stored)
        provider = get_cluster_provider(cluster_type)
        await provider.test_connection(provider_config)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
    return {"ok": True}


@router.post("/admin/clusters/register-callback")
async def cluster_register_callback(
    body: Dict,
    request: Request,
    cluster_type: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """Generic callback for any cluster_type whose provider has self_service_registration=True
    (today that's just "minikube", whose setup script the ymerflow-minikube plugin serves from
    minikube_plugin/routes.py — see docs/plans/minikube-cluster-registration-ux.md). Called by
    whatever ran out-of-band on the
    target host, not by an admin session — the only credential is the bearer token the admin's
    browser generated client-side when it showed the setup command, so this deliberately has no
    require_admin dependency. The token alone identifies which Cluster row this belongs to; there
    is no cluster id in the URL. If no row with this token hash exists yet, one is created here,
    lazily, in a pending/inactive state (see Design decision 2 in that plan) — a re-paste of the
    same command is idempotent and just updates that same row.

    `cluster_type` is a REQUIRED query param: the per-provider setup-script template renders it into
    the callback URL it posts back to (see docs/plans/generic-deployment-orchestration.md, Design
    decision 5), so core carries no default/hardcoded provider value at all. It's validated against
    the resolved provider's `self_service_registration` flag below, so an unregistered or
    non-self-service type can't be used to forge a pending row."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth_header[len("bearer "):].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token_hash = _hash_registration_token(token)

    # The POSTed body IS the provider_config, in whatever shape cluster.cluster_type's provider
    # expects (for "minikube"/"kubeconfig"-derived providers that's {"kubeconfig": "..."}) — the
    # callback itself doesn't need to know that shape, only the provider does.
    if not body:
        raise HTTPException(status_code=400, detail="request body (provider_config) is required")

    # Validate cluster_type resolves to a real provider that actually self-service-registers, so a
    # forged request can't create a pending row for an arbitrary/unregistered type. Only matters
    # when a row is being created lazily below; an existing row already carries its own type.
    try:
        provider = get_cluster_provider(cluster_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown cluster_type {cluster_type!r}")
    if not provider.self_service_registration:
        raise HTTPException(
            status_code=400,
            detail=f"cluster_type {cluster_type!r} does not support self-service registration",
        )

    result = await db.execute(
        select(Cluster).where(Cluster.registration_token_hash == token_hash)
    )
    cluster = result.scalar_one_or_none()
    if cluster is None:
        cluster = Cluster(
            cluster_type=cluster_type,
            name=f"{cluster_type}-{token[:8]}",
            active=False,
            provider_config={},
            provisioning_status="pending",
            registration_token_hash=token_hash,
        )
        db.add(cluster)

    provider_config = body
    try:
        provider = get_cluster_provider(cluster.cluster_type)
        await provider.test_connection(provider_config)
    except Exception as e:
        cluster.provisioning_status = "failed"
        # registration_token_hash stays set — the admin's still-open dialog can still find this
        # row by polling, and the same token can be re-pasted to retry.
        await db.commit()
        raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")

    # Connection works - now make the cluster actually ready to run YmerFlow Jobs (namespace,
    # Kueue, quotas/queues, RBAC - see docs/plans/registry-backend-hooks.md Phase 7). A separate
    # try/except from the connection test above so a failure here surfaces a distinguishable
    # message (an admin can tell "cluster unreachable" from "cluster reachable but couldn't be
    # made job-ready" at a glance), while handling the failure identically otherwise: mark the
    # row failed, commit, raise.
    try:
        k8s_client = provider.connect(provider_config, cluster.namespace)
        await ensure_cluster_job_ready(k8s_client, cluster.namespace)
    except Exception as e:
        cluster.provisioning_status = "failed"
        await db.commit()
        raise HTTPException(status_code=400, detail=f"Job-readiness provisioning failed: {e}")

    cluster.provider_config = provider_config
    # Config landed successfully, but the row stays pending/inactive — never dispatched to — until
    # the admin comes back to the still-open dialog and claims it via Save (admin_update_cluster,
    # which is also what clears registration_token_hash).
    cluster.provisioning_status = "pending"
    await db.commit()
    return {"ok": True, "cluster_id": cluster.id, "name": cluster.name}


# The remote self-service *setup script* endpoint (GET /static/assets/setup-minikube-remote.sh)
# used to live here, but it is wholly minikube-specific and now lives in the ymerflow-minikube
# plugin (minikube_plugin/routes.py, mounted via the register_routers nagelfluh.hook). Only the
# GENERIC callback below (cluster_register_callback, which dispatches through get_cluster_provider)
# stays in core. See docs/plans/done/generic-deployment-orchestration.md.


@dataclass
class _TestBackend:
    """Consistent .config shape for test_connection(backend), whether called against a real ORM
    row (update path) or a not-yet-created one (create/standalone-test-button path)."""
    config: Dict


def _storage_backend_admin_dict(backend: StorageBackend) -> Dict:
    d = backend.to_dict()
    handler = get_protocol_handler(backend.protocol)
    d["config"] = mask_config(backend.config, secret_keys=handler.SECRET_CONFIG_KEYS)
    return d


async def _test_and_apply_storage_connection(backend: StorageBackend, body: Dict) -> None:
    """Only touches protocol/config if the caller actually sent them, and only re-tests the
    connection in that case — editing unrelated fields (e.g. sort_order) must not fail because
    storage is momentarily unreachable (see docs/plans/storage-admin-ui.md Design decisions)."""
    if "protocol" in body or "config" in body:
        protocol = body.get("protocol", backend.protocol)
        submitted = body.get("config") or {}
        stored = backend.config if protocol == backend.protocol else {}
        try:
            config = resolve_config(submitted, stored)
            handler = get_protocol_handler(protocol)
            await handler.test_connection(_TestBackend(config))
        except HTTPException:
            raise
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
        backend.protocol = protocol
        backend.config = config


def _apply_storage_generic_fields(backend: StorageBackend, body: Dict) -> None:
    """Only touches a column if its key is present in body — write-only-if-provided, same rule
    _apply_generic_fields follows for clusters."""
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        backend.name = name
    if "bucket_prefix" in body:
        prefix = (body.get("bucket_prefix") or "").strip()
        if not prefix:
            raise HTTPException(status_code=400, detail="bucket_prefix is required")
        backend.bucket_prefix = prefix
    if "credential_strategy" in body:
        if body["credential_strategy"] not in ("static-key", "short-lived"):
            raise HTTPException(status_code=400, detail="invalid credential_strategy")
        backend.credential_strategy = body["credential_strategy"]
    if "sort_order" in body:
        try:
            backend.sort_order = int(body["sort_order"])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="sort_order must be an integer")
    if "active" in body:
        if not isinstance(body["active"], bool):
            raise HTTPException(status_code=400, detail="active must be a boolean")
        backend.active = body["active"]


@router.get("/admin/storage-backends")
async def admin_list_storage_backends(auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StorageBackend).order_by(StorageBackend.sort_order))
    return [_storage_backend_admin_dict(b) for b in result.scalars().all()]


@router.post("/admin/storage-backends")
async def admin_create_storage_backend(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if not (body.get("name") or "").strip():
        raise HTTPException(status_code=400, detail="name is required")
    if not (body.get("bucket_prefix") or "").strip():
        raise HTTPException(status_code=400, detail="bucket_prefix is required")
    backend = StorageBackend(
        name=body["name"].strip(), bucket_prefix=body["bucket_prefix"].strip(),
        protocol=body.get("protocol", "minio"),
        credential_strategy=body.get("credential_strategy", "static-key"),
    )
    _apply_storage_generic_fields(backend, body)
    await _test_and_apply_storage_connection(backend, body)
    db.add(backend)
    await db.commit()
    return _storage_backend_admin_dict(backend)


@router.patch("/admin/storage-backends/{backend_id}")
async def admin_update_storage_backend(backend_id: str, body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    backend = await db.get(StorageBackend, backend_id)
    if backend is None:
        raise HTTPException(status_code=404, detail="Storage backend not found")
    _apply_storage_generic_fields(backend, body)
    await _test_and_apply_storage_connection(backend, body)
    await db.commit()
    return _storage_backend_admin_dict(backend)


@router.post("/admin/storage-backends/test-connection")
async def admin_test_storage_backend_connection(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Stateless test for the 'Test Connection' button — no storage backend row required, so it
    works while filling out the create form before anything is saved. If backend_id is provided
    and matches an existing backend of the same protocol, masked fields resolve against its
    stored config."""
    protocol = body.get("protocol")
    if not protocol:
        raise HTTPException(status_code=400, detail="protocol is required")
    stored = {}
    backend_id = body.get("backend_id")
    if backend_id:
        existing = await db.get(StorageBackend, backend_id)
        if existing is not None and existing.protocol == protocol:
            stored = existing.config or {}
    try:
        config = resolve_config(body.get("config") or {}, stored)
        handler = get_protocol_handler(protocol)
        await handler.test_connection(_TestBackend(config))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Connection test failed: {e}")
    return {"ok": True}


# ── Terms of Service versions ────────────────────────────────────────────────────────────────

@router.get("/admin/tos-versions")
async def admin_list_tos_versions(auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    stmt = (
        select(TosVersion, User.username)
        .outerjoin(User, User.id == TosVersion.created_by)
        .order_by(TosVersion.version.desc())
    )
    result = await db.execute(stmt)
    return [
        {**tos_version.to_dict(), "created_by_username": username}
        for tos_version, username in result.all()
    ]


@router.post("/admin/tos-versions")
async def admin_create_tos_version(body: Dict, auth=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    body_text = (body.get("body") or "").strip()
    if not body_text:
        raise HTTPException(status_code=400, detail="body is required")

    max_version_stmt = select(func.max(TosVersion.version))
    max_version_result = await db.execute(max_version_stmt)
    next_version = (max_version_result.scalar_one_or_none() or 0) + 1

    tos_version = TosVersion(version=next_version, body=body_text, created_by=auth.user.id)
    db.add(tos_version)
    await db.commit()
    return {**tos_version.to_dict(), "created_by_username": auth.user.username}

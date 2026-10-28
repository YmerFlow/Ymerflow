"""Shared storage-credential provisioning.

Used by every call site that needs a project's storage ready before use: project creation,
manual re-setup (`POST /project/{id}/setup-storage`), and job launch (`ProcessVersion.run_task`).
`ensure_ready()` is protocol-agnostic — it resolves the project's `StorageBackend`, picks a
`CredentialStrategy` from `backend.credential_strategy`, and the strategy delegates to whichever
`StorageProtocolHandler` `backend.protocol` resolves to (`backend/services/storage_protocols/`).
Neither `ensure_ready()` nor the strategies branch on protocol themselves — that dispatch lives
entirely in the protocol-handler registry, once, so it is never duplicated at a call site.
"""
import asyncio
import logging

from sqlalchemy import select

from backend.models.storage_backend import StorageBackend
from backend.services.storage_protocols import get_protocol_handler

logger = logging.getLogger(__name__)


class CredentialStrategy:
    def provision(self, project, backend) -> dict:
        """Called once, at project creation. Returns credentials to persist on Project
        (or {} if this strategy never persists anything — e.g. always-minted strategies)."""
        raise NotImplementedError

    def mint(self, project, backend) -> dict:
        """Called at every job launch and on every refresh. Returns
        {credentials: {...}, expires_at: datetime | None}. expires_at=None means the
        credential never needs refreshing (e.g. static-key)."""
        raise NotImplementedError


class StaticKeyStrategy(CredentialStrategy):
    """Today's behavior, made explicit. provision() delegates to the resolved protocol
    handler's provision() — existing MinIO bucket/user/policy creation, or cloud SA + key
    creation — and persists the result on Project. mint() just returns those columns."""

    def provision(self, project, backend):
        return get_protocol_handler(backend.protocol).provision(project, backend)

    def mint(self, project, backend):
        return {
            "credentials": {
                "access_key": project.storage_access_key,
                "secret_key": project.storage_secret_key,
            },
            "expires_at": None,
        }


class ShortLivedStrategy(CredentialStrategy):
    """Lifetime pegged to the shortest common cap across backends actually in use (~1h) for
    uniform refresh cadence, even where a given backend (MinIO) could go longer — see Phase 4."""

    def provision(self, project, backend):
        return get_protocol_handler(backend.protocol).provision(project, backend)

    def mint(self, project, backend):
        return get_protocol_handler(backend.protocol).mint(project, backend)


_STRATEGIES = {
    "static-key": StaticKeyStrategy,
    "short-lived": ShortLivedStrategy,
}


def get_strategy(name: str) -> CredentialStrategy:
    try:
        return _STRATEGIES[name]()
    except KeyError:
        raise ValueError(f"unknown credential_strategy {name!r}")


async def ensure_ready(db, project, force: bool = False) -> dict:
    """Ensure a project's storage credentials exist.

    If credentials are already stored and force is False, this is a no-op returning them.
    Otherwise runs full provisioning via the project's StorageBackend's CredentialStrategy,
    which mints a new credential pair and commits it onto `project`.

    Credentials are no longer projected into a per-project K8s secret — the pod receives its
    (project-scoped) fsspec kwargs directly as an env var, built by the StorageProtocolHandler at
    launch time (see docs/plans/per-project-storage-routing.md decision 3). This removes the
    standing wrong-cluster bug where the secret was created on the backend's own cluster, not the
    job's target cluster.

    Returns the credentials dict ({"access_key", "secret_key"}), or {} if the project has no
    storage_backend_id (not yet backfilled/assigned).
    """
    if not project.storage_backend_id:
        return {}

    result = await db.execute(select(StorageBackend).where(StorageBackend.id == project.storage_backend_id))
    backend = result.scalar_one_or_none()
    if backend is None:
        raise RuntimeError(
            f"project {project.id} references missing storage_backend_id {project.storage_backend_id}"
        )

    strategy = get_strategy(backend.credential_strategy)

    # End the read transaction opened by the StorageBackend fetch above before either returning
    # (the fast path used to leak it to the caller) or blocking on provisioning. commit() (not
    # rollback()) keeps the passed-in `project` and the fetched `backend` readable afterwards under
    # expire_on_commit=False. See docs/plans/db-pool-commit-before-k8s-io.md.
    await db.commit()

    if not force and project.storage_access_key and project.storage_secret_key:
        return {"access_key": project.storage_access_key, "secret_key": project.storage_secret_key}

    logger.info("Running full storage setup for project %s", project.id)
    provision_result = await asyncio.to_thread(strategy.provision, project, backend)
    if provision_result.get("status") == "error":
        raise RuntimeError(f"Storage setup failed: {provision_result.get('error')}")

    creds = provision_result.get("credentials", {})
    project.storage_access_key = creds.get("access_key")
    project.storage_secret_key = creds.get("secret_key")
    project.storage_status = "ready"
    await db.commit()
    return creds

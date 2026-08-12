from sqlalchemy import Column, String, DateTime, JSON, Integer, Boolean, select
from datetime import datetime
import uuid

from backend.database import Base
from backend.hooks import hooks

DEFAULT_CLUSTER_ID = '3f976802-b810-4d20-942c-76da50c37510'


class Cluster(Base):
    __tablename__ = "clusters"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    # Discriminator for how this cluster's k8s API connection is established, dispatched to a
    # ClusterProvider (backend/services/cluster_providers/) exactly like StorageBackend.protocol
    # dispatches to a StorageProtocolHandler. provider_config is that provider's opaque config.
    cluster_type = Column(String(32), nullable=False, default="kubeconfig")
    provider_config = Column(JSON, nullable=False, default=dict)
    namespace = Column(String(255), nullable=False, default="nagelfluh-jobs")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)
    max_runtime_seconds = Column(Integer, nullable=True)  # NULL = unbounded

    # Self-service "minikube" cluster type (see docs/plans/minikube-cluster-registration-ux.md):
    # the admin's still-open "Add Cluster" dialog generates a registration token client-side (no
    # backend round trip) the moment "Minikube" is selected, and immediately shows a copy-paste
    # setup command with that token embedded. No Cluster row exists yet at that point — one is
    # created lazily by POST /admin/clusters/register-callback, the first time it sees this
    # token's hash, i.e. once the admin has actually run the command on the target host. That row
    # starts "pending"/active=False; the dialog polls GET /admin/clusters/by-registration-token to
    # discover it, then claims/activates it by clicking Save (PATCH .../{id} with active=true),
    # which is also what clears registration_token_hash and flips provisioning_status to "active".
    # A row that's created but never claimed just sits there, inert, forever — cheap and harmless,
    # so there's no token expiry to reason about. Every other cluster type goes straight to
    # "active" at creation.
    provisioning_status = Column(String(32), nullable=False, default="active")
    registration_token_hash = Column(String(64), nullable=True)  # SHA-256 hex

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "namespace": self.namespace,
            "created_at": self.created_at.isoformat(),
            "sort_order": self.sort_order,
            "active": self.active,
            "max_runtime_seconds": self.max_runtime_seconds,
            "provisioning_status": self.provisioning_status,
        }


async def get_allowed_clusters(db, user, project_id=None, resource_requests=None) -> list:
    """Resolve the set of clusters `user` is allowed to run on, sorted by sort_order.

    If no select_clusters plugins are registered, every active cluster is allowed. If
    plugins are registered, their union of allowed cluster ids is the allowed set — an
    empty union means no clusters are allowed, not a fallback to "all active".
    """
    if hooks.any_registered("select_clusters"):
        allowed_ids = set(await hooks.run_async.select_clusters(db, user, project_id, resource_requests))
        stmt = select(Cluster).where(Cluster.id.in_(allowed_ids), Cluster.active == True)
    else:
        stmt = select(Cluster).where(Cluster.active == True)
    stmt = stmt.order_by(Cluster.sort_order)
    result = await db.execute(stmt)
    return result.scalars().all()


async def get_cluster_for_process_version(db, process_version) -> "Cluster":
    """Resolve the Cluster a job ran/will run on. process_version.k8s_cluster_id is NULL on
    any row created before this column existed — those fall back to the bootstrap default
    cluster, which is exactly the single cluster they actually ran on."""
    from sqlalchemy import select

    cluster_id = process_version.k8s_cluster_id or DEFAULT_CLUSTER_ID
    stmt = select(Cluster).where(Cluster.id == cluster_id)
    result = await db.execute(stmt)
    cluster = result.scalar_one_or_none()
    if cluster is None:
        raise ValueError(f"Cluster not found: {cluster_id}")
    return cluster

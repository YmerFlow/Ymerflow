from sqlalchemy import Column, String, DateTime, JSON, Integer, Boolean, select
from datetime import datetime
import uuid

from backend.database import Base
from backend.hooks import hooks

DEFAULT_STORAGE_BACKEND_ID = 'f51f2357-277c-4128-806c-61d7dad491e7'


class StorageBackend(Base):
    __tablename__ = "storage_backends"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    protocol = Column(String(32), nullable=False)          # s3, gcs, az, file
    bucket_prefix = Column(String(255), nullable=False)
    credential_strategy = Column(String(32), nullable=False, default="static-key")
    # Strategy-specific connection config (e.g. MinIO admin alias, GCP SA email to
    # impersonate, AWS role ARN). Opaque to everything except the strategy implementation.
    config = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "protocol": self.protocol,
            "bucket_prefix": self.bucket_prefix,
            "credential_strategy": self.credential_strategy,
            "created_at": self.created_at.isoformat(),
            "sort_order": self.sort_order,
            "active": self.active,
        }


async def get_allowed_storage_backends(db, user) -> list["StorageBackend"]:
    """Resolve the set of StorageBackends `user` is allowed to create a project against, sorted
    by sort_order. Mirrors get_allowed_clusters() (backend/models/cluster.py).

    If no select_storage_backends plugins are registered, every active backend is allowed. If
    plugins are registered, their union of allowed backend ids is the allowed set — an empty
    union means no backends are allowed, not a fallback to "all active".
    """
    if hooks.any_registered("select_storage_backends"):
        allowed_ids = set(await hooks.run_async.select_storage_backends(db, user))
        stmt = select(StorageBackend).where(StorageBackend.id.in_(allowed_ids), StorageBackend.active == True)
    else:
        stmt = select(StorageBackend).where(StorageBackend.active == True)
    stmt = stmt.order_by(StorageBackend.sort_order)
    result = await db.execute(stmt)
    return result.scalars().all()

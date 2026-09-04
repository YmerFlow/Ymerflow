from sqlalchemy import Column, String, DateTime, ForeignKey, JSON, Integer
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from backend.database import Base


class Environment(Base):
    __tablename__ = "environments"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    docker_image = Column(String(255), nullable=False)
    process_id = Column(String(255), ForeignKey("processes.id", ondelete="CASCADE"), nullable=True, index=True)
    process_types = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    # Attribution for the admin stats dashboard (docs/plans/admin-stats-dashboard.md); nullable,
    # SET NULL — see Project.created_by. Inherited from the creating Process in _create_outputs.
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    # Relationships
    # Process versions that ran in this environment (via ProcessVersion.environment_id).
    # ondelete=RESTRICT on that FK means an environment in use cannot be deleted out from under
    # historical versions (see docs/plans/done/move-type-environment-to-processversion.md D5).
    process_versions = relationship("ProcessVersion", back_populates="environment", foreign_keys="ProcessVersion.environment_id")
    # The process that created this environment (via Environment.process_id)
    creating_process = relationship("Process", foreign_keys=[process_id], uselist=False)
    created_by_user = relationship("User", foreign_keys=[created_by])

    def to_dict(self, include_schemas=False, minimal=False):
        """Convert to API response format.

        process_types is the full JSON Schema for every process type in this
        environment. That's expensive to ship on every embedding of an environment
        (e.g. Process.to_dict()'s "environment" field), so by default it's trimmed
        to just the type names. Pass include_schemas=True (e.g. GET /environments)
        when the full schemas are actually needed.

        minimal=True drops docker_image, process_id, and process_types entirely,
        returning only id/name/created_at — for embeddings (e.g. Process.to_dict())
        where nothing beyond those three fields is ever read.
        """
        if minimal:
            return {
                "id": self.id,
                "name": self.name,
                "created_at": self.created_at.isoformat()
            }
        return {
            "id": self.id,
            "name": self.name,
            "docker_image": self.docker_image,
            "process_id": self.process_id,
            "process_types": self.process_types if include_schemas else list((self.process_types or {}).keys()),
            "created_at": self.created_at.isoformat()
        }

from sqlalchemy import Column, String, DateTime, Integer, ForeignKey, Table
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from backend.database import Base


# Many-to-many join: an API key grants access to a subset of its owner's projects.
# See docs/plans/done/mcp-api-key-many-to-many-projects.md.
api_key_projects = Table(
    "api_key_projects",
    Base.metadata,
    Column("api_key_id", String(255), ForeignKey("api_keys.id", ondelete="CASCADE"), primary_key=True),
    Column("project_id", String(255), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(255), nullable=False)
    key_hash = Column(String(255), unique=True, nullable=False)  # SHA-256 hex of raw key
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="api_keys")
    projects = relationship("Project", secondary=api_key_projects, back_populates="api_keys")

    def to_dict(self):
        return {
            "id": self.id,
            "label": self.label,
            "projects": [{"id": p.id, "name": p.name} for p in self.projects],
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "created_at": self.created_at.isoformat(),
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
        }

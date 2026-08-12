from sqlalchemy import Column, String, DateTime, JSON, Integer, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from backend.database import Base


class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String(255), nullable=False)
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    is_public = Column(Boolean, nullable=False, default=False, server_default="0")
    superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
    forked_from_workspace_id = Column(String(255), ForeignKey("workspaces.id", ondelete="SET NULL"),
                                       nullable=True)
    forked_from_version = Column(Integer, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", back_populates="workspaces")
    versions = relationship("WorkspaceVersion", back_populates="workspace",
                             cascade="all, delete-orphan", order_by="WorkspaceVersion.version",
                             foreign_keys="WorkspaceVersion.workspace_id")

    def to_dict(self, project_name=None):
        result = {
            "id": self.id,
            "title": self.title,
            "project_id": self.project_id,
            "is_public": self.is_public,
            "superpublic": self.superpublic,
            "forked_from_workspace_id": self.forked_from_workspace_id,
            "forked_from_version": self.forked_from_version,
            "created_at": self.created_at.isoformat(),
            "versions": [v.to_dict() for v in sorted(self.versions, key=lambda v: v.version)],
        }
        if project_name is not None:
            result["project_name"] = project_name
        return result


class WorkspaceVersion(Base):
    __tablename__ = "workspace_versions"
    __table_args__ = (UniqueConstraint("workspace_id", "version"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    workspace_id = Column(String(255), ForeignKey("workspaces.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    version = Column(Integer, nullable=False)
    layout = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    workspace = relationship("Workspace", back_populates="versions", foreign_keys=[workspace_id])

    def to_dict(self):
        return {
            "version": self.version,
            "layout": self.layout,
            "created_at": self.created_at.isoformat(),
        }

from sqlalchemy import Column, String, DateTime, JSON, Integer, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from backend.database import Base


# A reusable, named snapshot of the process editor's contents (process type, parameter form,
# resource settings, pinned environment, selected tags). Mirrors the Workspace versioning +
# visibility model exactly: parent row holds identity + sharing flags, a child *_version table
# holds the payload, append-only integer versions, visibility on the parent. See
# docs/plans/process-editor-defaults.md.
class ProcessDefault(Base):
    __tablename__ = "process_defaults"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String(255), nullable=False)
    description = Column(String(1024), nullable=True)
    # Home project. NULL only for superpublic systemwide rows (following the Environment/System
    # precedent — see docs/plans/process-editor-defaults.md Decision 9).
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                        nullable=True, index=True)
    is_public = Column(Boolean, nullable=False, default=False, server_default="0")
    superpublic = Column(Boolean, nullable=False, default=False, server_default="0")
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", foreign_keys=[project_id])
    versions = relationship("ProcessDefaultVersion", back_populates="process_default",
                            cascade="all, delete-orphan",
                            order_by="ProcessDefaultVersion.version",
                            foreign_keys="ProcessDefaultVersion.default_id")

    def to_dict(self, project_name=None):
        result = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "project_id": self.project_id,
            "is_public": self.is_public,
            "superpublic": self.superpublic,
            "created_at": self.created_at.isoformat(),
            "versions": [v.to_dict() for v in sorted(self.versions, key=lambda v: v.version)],
        }
        if project_name is not None:
            result["project_name"] = project_name
        return result


class ProcessDefaultVersion(Base):
    __tablename__ = "process_default_versions"
    __table_args__ = (UniqueConstraint("default_id", "version"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    default_id = Column(String(255), ForeignKey("process_defaults.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    version = Column(Integer, nullable=False)
    # Same typed-column layout as ProcessVersion (dropping runtime-only state/dependencies),
    # except tags: an association table is per-project and can't carry across projects for a
    # public/superpublic default, so tags are stored inline by name (Decision 8).
    type = Column(String(100), nullable=False)
    # Hard-pinned environment (Decision 1). RESTRICT matches ProcessVersion.environment_id.
    environment_id = Column(String(255), ForeignKey("environments.id", ondelete="RESTRICT"),
                            nullable=False, index=True)
    parameters = Column(JSON, nullable=False)
    resource_requests = Column(JSON, nullable=True)
    deadline_seconds = Column(Integer, nullable=True)
    k8s_cluster_id = Column(String(36), ForeignKey("clusters.id"), nullable=True)
    tag_names = Column(JSON, nullable=True)  # array of strings
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    process_default = relationship("ProcessDefault", back_populates="versions",
                                   foreign_keys=[default_id])

    def to_dict(self):
        return {
            "version": self.version,
            "type": self.type,
            "environment_id": self.environment_id,
            "parameters": self.parameters,
            "resource_requests": self.resource_requests,
            "deadline_seconds": self.deadline_seconds,
            "k8s_cluster_id": self.k8s_cluster_id,
            "tag_names": self.tag_names or [],
            "created_at": self.created_at.isoformat(),
        }

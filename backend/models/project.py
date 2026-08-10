from sqlalchemy import Column, String, Text, DateTime, Integer, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
import secrets

from backend.database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    storage_status = Column(String(32), nullable=True)  # None=unknown, "pending", "ready", "failed"
    storage_access_key = Column(String(255), nullable=True)
    storage_secret_key = Column(Text, nullable=True)
    storage_backend_id = Column(String(36), ForeignKey("storage_backends.id"), nullable=True)

    storage_backend = relationship("StorageBackend")
    processes = relationship("Process", back_populates="project", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="project", cascade="all, delete-orphan")
    workspaces = relationship("Workspace", back_populates="project", cascade="all, delete-orphan")
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    invites = relationship("ProjectInvite", back_populates="project", cascade="all, delete-orphan")
    api_keys = relationship("ApiKey", back_populates="project", cascade="all, delete-orphan")
    publications = relationship("Publication", back_populates="project", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "storage_status": self.storage_status,
        }


class ProjectMember(Base):
    __tablename__ = "project_members"

    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    joined_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", back_populates="members")
    user = relationship("User", back_populates="project_memberships")

    def to_dict(self):
        return {
            "project_id": self.project_id,
            "user_id": self.user_id,
            "username": self.user.username if self.user else None,
            "email": self.user.email if self.user else None,
            "joined_at": self.joined_at.isoformat()
        }


class ProjectInvite(Base):
    __tablename__ = "project_invites"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    email = Column(String(255), nullable=True)
    token = Column(String(255), unique=True, nullable=False, default=lambda: secrets.token_urlsafe(32))
    invited_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    accepted_at = Column(DateTime, nullable=True)

    project = relationship("Project", back_populates="invites")
    invited_by = relationship("User", foreign_keys=[invited_by_id])

    def to_dict(self, include_token=False):
        result = {
            "id": self.id,
            "project_id": self.project_id,
            "email": self.email,
            "invited_by": self.invited_by.username if self.invited_by else None,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "accepted_at": self.accepted_at.isoformat() if self.accepted_at else None,
        }
        if include_token:
            result["token"] = self.token
        return result


class Publication(Base):
    __tablename__ = "publications"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    findable = Column(Boolean, nullable=False, default=False)
    allow_anonymous = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    project = relationship("Project", back_populates="publications")
    created_by_user = relationship("User", foreign_keys=[created_by])

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "findable": self.findable,
            "allow_anonymous": self.allow_anonymous,
            "created_by": self.created_by_user.username if self.created_by_user else None,
            "created_at": self.created_at.isoformat(),
        }

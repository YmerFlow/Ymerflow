from sqlalchemy import Column, String, Text, DateTime, Integer, ForeignKey
from datetime import datetime
import uuid

from backend.database import Base


class ProjectExport(Base):
    __tablename__ = "project_exports"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    state = Column(String(32), nullable=False, default="queued")  # queued, running, done, failed
    error = Column(Text, nullable=True)
    file_url = Column(String(500), nullable=True)  # storage URL of the finished zip, once done
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    def to_dict(self):
        from backend.services.storage_service import storage_url_to_http_url
        return {
            "id": self.id,
            "project_id": self.project_id,
            "state": self.state,
            "error": self.error,
            "download_url": storage_url_to_http_url(self.file_url) if self.file_url else None,
            "created_at": self.created_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class ProjectImport(Base):
    __tablename__ = "project_imports"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    upload_id = Column(String(255), ForeignKey("uploads.id"), nullable=False)  # the submitted zip
    created_by_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    state = Column(String(32), nullable=False, default="queued")
    error = Column(Text, nullable=True)
    project_id = Column(String(255), ForeignKey("projects.id"), nullable=True)  # set once the new project exists
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "upload_id": self.upload_id,
            "state": self.state,
            "error": self.error,
            "project_id": self.project_id,
            "created_at": self.created_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }

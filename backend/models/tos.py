from sqlalchemy import Column, DateTime, Integer, Text, ForeignKey, UniqueConstraint
from datetime import datetime

from backend.database import Base


class TosVersion(Base):
    __tablename__ = "tos_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(Integer, nullable=False, unique=True, index=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    def to_dict(self):
        return {
            "version": self.version,
            "body": self.body,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
        }


class UserTosAcceptance(Base):
    __tablename__ = "user_tos_acceptances"
    __table_args__ = (UniqueConstraint("user_id", "tos_version_id"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    tos_version_id = Column(Integer, ForeignKey("tos_versions.id", ondelete="CASCADE"), nullable=False, index=True)
    accepted_at = Column(DateTime, default=datetime.utcnow, nullable=False)

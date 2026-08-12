from sqlalchemy import Column, String, DateTime, LargeBinary, Boolean, ForeignKey
from datetime import datetime
import uuid
import msgpack_numpy as m

from backend.database import Base

# Configure msgpack to handle numpy arrays
m.patch()


class System(Base):
    __tablename__ = "systems"

    id = Column(String(255), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    gex = Column(LargeBinary, nullable=False)  # Store msgpack bytes
    project_id = Column(String(255), ForeignKey("projects.id", ondelete="CASCADE"),
                         nullable=True, index=True)
    is_public = Column(Boolean, nullable=False, default=False, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

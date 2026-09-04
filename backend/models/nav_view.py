from sqlalchemy import Column, String, DateTime, Integer
from datetime import datetime

from backend.database import Base


class NavView(Base):
    """One row per dwelled navigation coordinate (GUI usage tracking).

    Aggregate usage only — deliberately stores **no user id and no session id**
    (docs/plans/done/gui-usage-nav-tracking.md, privacy stance). The six URL
    coordinates (+ workspace_version) are stored as raw ids/ints; names are
    resolved at read time by the admin stats pivot. No foreign keys / cascade:
    a view is a fact that must survive the resource it points at — a deleted
    resource simply renders as its raw id.
    """
    __tablename__ = "nav_views"

    id = Column(Integer, primary_key=True, autoincrement=True)  # high-volume → int PK, not UUID
    # Server-stamped; drives both the window filter and the t_day/t_week/t_month buckets.
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    workspace         = Column(String(255), nullable=True)  # workspace id
    workspace_version = Column(Integer,     nullable=True)
    project           = Column(String(255), nullable=True)  # project id
    process           = Column(String(255), nullable=True)  # process id
    version           = Column(Integer,     nullable=True)
    part              = Column(String(255), nullable=True)  # null == "all"
    sounding          = Column(Integer,     nullable=True)

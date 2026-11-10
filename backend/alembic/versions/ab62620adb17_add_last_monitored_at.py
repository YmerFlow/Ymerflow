"""add process_versions.last_monitored_at

Monitor liveness heartbeat for the orphan-monitor sweep
(docs/plans/db-monitor-resilience-retry-and-sweep.md). monitor_job refreshes this column on every
loop iteration; the periodic sweep re-attaches a monitor to any non-terminal version whose
heartbeat is NULL or stale. Nullable, no backfill — existing rows read as NULL (never monitored),
which the sweep treats as "needs a monitor", exactly the desired resume-on-upgrade behaviour.

Revision ID: ab62620adb17
Revises: 1332fe39b1da
Create Date: 2026-11-09
"""
from alembic import op
import sqlalchemy as sa

revision = 'ab62620adb17'
down_revision = '1332fe39b1da'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("process_versions", sa.Column("last_monitored_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("process_versions", "last_monitored_at")

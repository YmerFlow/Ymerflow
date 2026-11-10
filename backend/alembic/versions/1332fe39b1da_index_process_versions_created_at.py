"""index process_versions.created_at

Adds ix_process_versions_created_at to back the incremental process-list refetch
(docs/plans/incremental-process-list-refetch.md): list_processes now filters versions by
`created_at >= watermark`, so the window query needs an index on that column. Trivial at
current row counts, matters at scale.

Revision ID: 1332fe39b1da
Revises: 3da8f0553b5a
Create Date: 2026-11-08
"""
from alembic import op

revision = '1332fe39b1da'
down_revision = '3da8f0553b5a'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_process_versions_created_at", "process_versions", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_process_versions_created_at", table_name="process_versions")

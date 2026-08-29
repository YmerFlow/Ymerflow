"""add nav_views table

Creates nav_views — one row per dwelled navigation coordinate for aggregate GUI
usage tracking (docs/plans/done/gui-usage-nav-tracking.md). Deliberately no
user/session column, no foreign keys / cascade (a view is a fact that must
survive the resource it points at). Indexed created_at drives the stats-pivot
window filter and t_day/t_week/t_month temporal buckets.

Revision ID: 7549c70cb97b
Revises: 1c4fe144ca5f
Create Date: 2026-08-29
"""
from alembic import op
import sqlalchemy as sa

revision = '7549c70cb97b'
down_revision = '1c4fe144ca5f'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "nav_views",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("workspace", sa.String(length=255), nullable=True),
        sa.Column("workspace_version", sa.Integer(), nullable=True),
        sa.Column("project", sa.String(length=255), nullable=True),
        sa.Column("process", sa.String(length=255), nullable=True),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("part", sa.String(length=255), nullable=True),
        sa.Column("sounding", sa.Integer(), nullable=True),
    )
    op.create_index("ix_nav_views_created_at", "nav_views", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_nav_views_created_at", table_name="nav_views")
    op.drop_table("nav_views")

"""add process_defaults + process_default_versions tables

Reusable, named snapshots of the process editor's contents, with the same versioning +
visibility model as Workspace (see docs/plans/process-editor-defaults.md):

- process_defaults (parent): identity + sharing flags (is_public / superpublic). project_id is
  nullable (NULL only for superpublic systemwide rows, following the Environment/System precedent).
- process_default_versions (child): the editor payload, one append-only version per row,
  unique (default_id, version). Tags are stored inline as a JSON array of names, not an
  association table (per-project tag ids can't carry across projects for a public default).

Revision ID: 3da8f0553b5a
Revises: 2312aa5235d3
Create Date: 2026-10-23
"""
from alembic import op
import sqlalchemy as sa

revision = '3da8f0553b5a'
down_revision = '2312aa5235d3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "process_defaults",
        sa.Column("id", sa.String(255), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1024), nullable=True),
        sa.Column(
            "project_id",
            sa.String(255),
            sa.ForeignKey("projects.id", ondelete="CASCADE", name="fk_process_defaults_project_id_projects"),
            nullable=True,
        ),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("superpublic", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_process_defaults_created_by_users"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_process_defaults_project_id", "process_defaults", ["project_id"])

    op.create_table(
        "process_default_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "default_id",
            sa.String(255),
            sa.ForeignKey("process_defaults.id", ondelete="CASCADE", name="fk_process_default_versions_default_id"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(100), nullable=False),
        sa.Column(
            "environment_id",
            sa.String(255),
            sa.ForeignKey("environments.id", ondelete="RESTRICT", name="fk_process_default_versions_environment_id"),
            nullable=False,
        ),
        sa.Column("parameters", sa.JSON(), nullable=False),
        sa.Column("resource_requests", sa.JSON(), nullable=True),
        sa.Column("deadline_seconds", sa.Integer(), nullable=True),
        sa.Column(
            "k8s_cluster_id",
            sa.String(36),
            sa.ForeignKey("clusters.id", name="fk_process_default_versions_k8s_cluster_id"),
            nullable=True,
        ),
        sa.Column("tag_names", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_process_default_versions_created_by_users"),
            nullable=True,
        ),
        sa.UniqueConstraint("default_id", "version", name="uq_process_default_version"),
    )
    op.create_index("ix_process_default_versions_default_id", "process_default_versions", ["default_id"])
    op.create_index("ix_process_default_versions_environment_id", "process_default_versions", ["environment_id"])


def downgrade() -> None:
    op.drop_index("ix_process_default_versions_environment_id", "process_default_versions")
    op.drop_index("ix_process_default_versions_default_id", "process_default_versions")
    op.drop_table("process_default_versions")
    op.drop_index("ix_process_defaults_project_id", "process_defaults")
    op.drop_table("process_defaults")

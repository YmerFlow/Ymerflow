"""api key many-to-many projects

Replaces the 1:1 api_keys.project_id FK with a many-to-many join table
api_key_projects(api_key_id, project_id). Each existing key is backfilled to a
single-project many-to-many key (no access change), then project_id is dropped.

See docs/plans/done/mcp-api-key-many-to-many-projects.md.

Revision ID: 7c0f5632a011
Revises: 7bee60bd41a4
Create Date: 2026-08-31
"""
from alembic import op
import sqlalchemy as sa

revision = '7c0f5632a011'
down_revision = '7bee60bd41a4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_key_projects",
        sa.Column(
            "api_key_id",
            sa.String(length=255),
            sa.ForeignKey("api_keys.id", ondelete="CASCADE", name="fk_api_key_projects_api_key_id"),
            primary_key=True,
        ),
        sa.Column(
            "project_id",
            sa.String(length=255),
            sa.ForeignKey("projects.id", ondelete="CASCADE", name="fk_api_key_projects_project_id"),
            primary_key=True,
        ),
    )

    # Backfill: every existing 1:1 key becomes a 1-project many-to-many key.
    op.execute(
        """
        INSERT INTO api_key_projects (api_key_id, project_id)
        SELECT id, project_id FROM api_keys
        """
    )

    # Drop the old scalar FK. batch_alter_table so SQLite (dev) rebuilds the table.
    # Drop the index first: otherwise the batch rebuild reflects ix_api_keys_project_id
    # and tries to recreate it on a table that no longer has the column.
    with op.batch_alter_table("api_keys") as batch_op:
        batch_op.drop_index("ix_api_keys_project_id")
        batch_op.drop_column("project_id")


def downgrade() -> None:
    # Lossy: many-to-many -> 1:1 keeps only the first project per key.
    with op.batch_alter_table("api_keys") as batch_op:
        batch_op.add_column(
            sa.Column(
                "project_id",
                sa.String(length=255),
                sa.ForeignKey("projects.id", ondelete="CASCADE", name="fk_api_keys_project_id"),
                nullable=True,
            )
        )
        batch_op.create_index("ix_api_keys_project_id", ["project_id"])

    op.execute(
        """
        UPDATE api_keys SET project_id = (
            SELECT akp.project_id FROM api_key_projects akp
            WHERE akp.api_key_id = api_keys.id
            ORDER BY akp.project_id ASC
            LIMIT 1
        )
        """
    )

    op.drop_table("api_key_projects")

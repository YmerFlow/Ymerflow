"""add project_id/is_public/superpublic visibility columns to environments

Gives environments the same visibility model as Workspace/System (see
docs/plans/project-scoped-public-environments.md):

- project_id (nullable FK -> projects, CASCADE): the environment's home project.
  NULL for bootstrap/superpublic environments (docker/build.sh), which have no
  home project.
- is_public / superpublic: two orthogonal booleans (superpublic implies public).

Backfill preserves the pre-existing implicit model where the only distinction was
process_id:
- Bootstrap rows (process_id IS NULL, built by docker/build.sh) -> superpublic +
  is_public TRUE, project_id NULL.
- create_environment rows (process_id IS NOT NULL) -> private (both FALSE), with
  project_id copied from the creating process's project.

Revision ID: 2312aa5235d3
Revises: 2fccb9ea1497
Create Date: 2026-09-17
"""
from alembic import op
import sqlalchemy as sa

revision = '2312aa5235d3'
down_revision = '2fccb9ea1497'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # batch_alter_table so SQLite (dev) recreates the table to add the FK column;
    # on Postgres (prod) this is a plain ADD COLUMN.
    with op.batch_alter_table("environments") as batch_op:
        batch_op.add_column(
            sa.Column(
                "project_id",
                sa.String(255),
                sa.ForeignKey("projects.id", ondelete="CASCADE", name="fk_environments_project_id_projects"),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column("is_public", sa.Boolean(), nullable=False, server_default="0")
        )
        batch_op.add_column(
            sa.Column("superpublic", sa.Boolean(), nullable=False, server_default="0")
        )
        batch_op.create_index("ix_environments_project_id", ["project_id"])

    # Bootstrap rows (no creating process) -> superpublic + public.
    # TRUE/FALSE (not 1/0) so this runs on both Postgres and SQLite — Postgres will not
    # implicitly cast an integer to boolean in an assignment (see the sibling workspace
    # backfill af672e56b096, which uses `is_public = TRUE` for the same reason).
    op.execute(
        """
        UPDATE environments
        SET superpublic = TRUE, is_public = TRUE, project_id = NULL
        WHERE process_id IS NULL
        """
    )

    # create_environment rows -> private, inheriting the creating process's project.
    op.execute(
        """
        UPDATE environments
        SET is_public = FALSE, superpublic = FALSE,
            project_id = (SELECT p.project_id FROM processes p WHERE p.id = environments.process_id)
        WHERE process_id IS NOT NULL
        """
    )


def downgrade() -> None:
    with op.batch_alter_table("environments") as batch_op:
        batch_op.drop_index("ix_environments_project_id")
        batch_op.drop_column("superpublic")
        batch_op.drop_column("is_public")
        batch_op.drop_column("project_id")

"""add created_by attribution columns

Adds a nullable, indexed created_by FK -> users.id to projects, processes,
process_versions and environments (per-user attribution for the admin stats
dashboard, see docs/plans/admin-stats-dashboard.md Design decision 1).

ondelete="SET NULL" so deleting a user never cascades away their projects/
processes — the stats just re-bucket those rows into "(unknown)".

Best-effort backfill (pure-core only): projects.created_by <- the earliest
project_members.user_id per project (min joined_at), reconstructing the creator
since create_project inserts the creator as the first member. Processes,
versions and environments are left NULL for historical rows — their creator
isn't recoverable from pure-core data.

Revision ID: 1c4fe144ca5f
Revises: d1266f2f6e68
Create Date: 2026-08-28
"""
from alembic import op
import sqlalchemy as sa

revision = '1c4fe144ca5f'
down_revision = 'd1266f2f6e68'
branch_labels = None
depends_on = None

# (table, index name) for the four attributed tables. Same column shape everywhere.
_TABLES = [
    ("projects", "ix_projects_created_by"),
    ("processes", "ix_processes_created_by"),
    ("process_versions", "ix_process_versions_created_by"),
    ("environments", "ix_environments_created_by"),
]


def upgrade() -> None:
    for table, index_name in _TABLES:
        # batch_alter_table so SQLite (dev) recreates the table to add the FK column;
        # a no-op table rebuild on Postgres (prod) beyond the plain ADD COLUMN.
        with op.batch_alter_table(table) as batch_op:
            batch_op.add_column(
                sa.Column(
                    "created_by",
                    sa.Integer(),
                    # Named constraint: batch mode (SQLite table-rebuild) requires every
                    # constraint to carry a name.
                    sa.ForeignKey("users.id", ondelete="SET NULL", name=f"fk_{table}_created_by_users"),
                    nullable=True,
                )
            )
            batch_op.create_index(index_name, ["created_by"])

    # Backfill projects.created_by from the earliest member. Correlated subquery runs
    # identically on SQLite and Postgres. joined_at then user_id as a stable tiebreak.
    op.execute(
        """
        UPDATE projects SET created_by = (
            SELECT pm.user_id FROM project_members pm
            WHERE pm.project_id = projects.id
            ORDER BY pm.joined_at ASC, pm.user_id ASC
            LIMIT 1
        )
        """
    )


def downgrade() -> None:
    for table, index_name in reversed(_TABLES):
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_index(index_name)
            batch_op.drop_column("created_by")

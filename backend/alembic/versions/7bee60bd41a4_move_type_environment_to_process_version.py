"""move type and environment from process to process_version

Moves `type` and `environment_id` off `processes` and onto `process_versions`, so each
version records the process type and environment it actually ran under (history stays
truthful; an in-flight version keeps its own image even if a later version picks a
different environment). See docs/plans/done/move-type-environment-to-processversion.md.

Data migration (D3): every existing process_version inherits its parent process's current
type/environment_id (copy-down). The true per-version history was never recorded, so this is
the best achievable and is no worse than the prior behaviour.

The environment FK changes from CASCADE (on processes) to RESTRICT (on process_versions, D5):
an environment referenced by any historical version can no longer be deleted out from under it.

This migration also merges the two core-chain heads (469c547b1195, 7549c70cb97b) into one.

downgrade() is lossy: it re-adds the process columns and copies back the *latest* version's
type/environment_id (the only value the current model can report), dropping true per-version
history again.

Revision ID: 7bee60bd41a4
Revises: 469c547b1195, 7549c70cb97b
Create Date: 2026-08-30
"""
from alembic import op
import sqlalchemy as sa

revision = '7bee60bd41a4'
down_revision = ('469c547b1195', '7549c70cb97b')
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add type + environment_id to process_versions (nullable first, so existing rows can
    #    be backfilled before the NOT NULL constraint is applied). batch_alter_table so SQLite
    #    (dev) recreates the table; a plain ADD COLUMN on Postgres (prod).
    with op.batch_alter_table("process_versions") as batch_op:
        batch_op.add_column(sa.Column("type", sa.String(length=100), nullable=True))
        batch_op.add_column(
            sa.Column(
                "environment_id",
                sa.String(length=255),
                # Named constraint: batch mode (SQLite table-rebuild) requires a name.
                sa.ForeignKey(
                    "environments.id",
                    ondelete="RESTRICT",
                    name="fk_process_versions_environment_id_environments",
                ),
                nullable=True,
            )
        )
        batch_op.create_index("ix_process_versions_environment_id", ["environment_id"])

    # 2. Copy-down: each version inherits its parent process's current type/environment_id.
    #    Correlated subqueries run identically on SQLite and Postgres.
    op.execute(
        """
        UPDATE process_versions SET
            type = (SELECT p.type FROM processes p WHERE p.id = process_versions.process_id),
            environment_id = (SELECT p.environment_id FROM processes p WHERE p.id = process_versions.process_id)
        """
    )

    # 3. Now that every row has values, enforce NOT NULL.
    with op.batch_alter_table("process_versions") as batch_op:
        batch_op.alter_column("type", existing_type=sa.String(length=100), nullable=False)
        batch_op.alter_column("environment_id", existing_type=sa.String(length=255), nullable=False)

    # 4. Drop the now-unused process columns. Dropping the column drops its FK/index on both
    #    Postgres (auto) and SQLite (batch table-rebuild).
    with op.batch_alter_table("processes") as batch_op:
        batch_op.drop_index("ix_processes_environment_id")
        batch_op.drop_column("environment_id")
        batch_op.drop_column("type")


def downgrade() -> None:
    # 1. Re-add the process columns (nullable first). FK reverts to the original CASCADE.
    with op.batch_alter_table("processes") as batch_op:
        batch_op.add_column(sa.Column("type", sa.String(length=100), nullable=True))
        batch_op.add_column(
            sa.Column(
                "environment_id",
                sa.String(length=255),
                sa.ForeignKey(
                    "environments.id",
                    ondelete="CASCADE",
                    name="fk_processes_environment_id_environments",
                ),
                nullable=True,
            )
        )
        batch_op.create_index("ix_processes_environment_id", ["environment_id"])

    # 2. Lossy copy-back: take the latest version's type/environment_id for each process.
    op.execute(
        """
        UPDATE processes SET
            type = (
                SELECT pv.type FROM process_versions pv
                WHERE pv.process_id = processes.id
                ORDER BY pv.version DESC LIMIT 1
            ),
            environment_id = (
                SELECT pv.environment_id FROM process_versions pv
                WHERE pv.process_id = processes.id
                ORDER BY pv.version DESC LIMIT 1
            )
        """
    )

    # 3. Enforce NOT NULL to match the original schema.
    with op.batch_alter_table("processes") as batch_op:
        batch_op.alter_column("type", existing_type=sa.String(length=100), nullable=False)
        batch_op.alter_column("environment_id", existing_type=sa.String(length=255), nullable=False)

    # 4. Drop the per-version columns.
    with op.batch_alter_table("process_versions") as batch_op:
        batch_op.drop_index("ix_process_versions_environment_id")
        batch_op.drop_column("environment_id")
        batch_op.drop_column("type")

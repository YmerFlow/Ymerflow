"""Add STARTING value to the processstate enum

Adds a distinct STARTING lifecycle state (admitted, pod coming up / pulling image,
container not yet running) between QUEUED and RUNNING. See
docs/plans/done/cluster-queue-state-fixes.md.

Postgres: the enum is a native type (processstate) storing member NAMES; widen it with
ALTER TYPE ... ADD VALUE. ADD VALUE is allowed inside Alembic's transaction on PG 12+ as
long as the new value is not *used* in the same transaction (we only add it). No data
backfill — existing rows keep their states.

SQLite (dev): the enum is a VARCHAR + CHECK constraint; there is no cheap ALTER for it, so
this migration is a no-op there. A dev DB created before this migration keeps its old CHECK
and would reject 'STARTING'; recreate the dev DB (delete + re-migrate) to pick up the new
value.

Downgrade is a no-op: Postgres cannot drop an enum value without recreating the whole type,
which is not worth the risk for a purely-widened enum.

Revision ID: 469c547b1195
Revises: 15f28d0780e3
Create Date: 2026-08-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '469c547b1195'
down_revision: Union[str, Sequence[str], None] = '15f28d0780e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("ALTER TYPE processstate ADD VALUE IF NOT EXISTS 'STARTING'")
    # SQLite / others: enum enforced by a CHECK constraint; no-op (see module docstring).


def downgrade() -> None:
    # No-op: Postgres cannot drop an enum value without recreating the type; not worth the
    # risk for a widened enum. Existing rows are unaffected either way.
    pass

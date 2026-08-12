"""Add superpublic tier to workspaces and publications

Revision ID: 355d9314c125
Revises: b2e426fd2d56
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '355d9314c125'
down_revision: Union[str, Sequence[str], None] = 'b2e426fd2d56'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('workspaces', sa.Column('superpublic', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('publications', sa.Column('superpublic', sa.Boolean(), nullable=False, server_default=sa.false()))

    # Bootstrap 'default' workspace keeps its pre-existing effectively-universal visibility.
    # is_public=1 is already true for it today (af672e56b096), but setting it again here is
    # cheap insurance and keeps this migration self-consistent even if that's ever not the case.
    op.execute(sa.text("UPDATE workspaces SET superpublic = TRUE, is_public = TRUE WHERE id = 'default'"))


def downgrade() -> None:
    op.drop_column('publications', 'superpublic')
    op.drop_column('workspaces', 'superpublic')

"""project_scope_systems

Revision ID: 4ea58d5794c1
Revises: 355d9314c125
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4ea58d5794c1'
down_revision: Union[str, Sequence[str], None] = '355d9314c125'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('systems', schema=None) as batch_op:
        batch_op.add_column(sa.Column('project_id', sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column('is_public', sa.Boolean(), nullable=False, server_default='0'))
        batch_op.create_index('ix_systems_project_id', ['project_id'])
        batch_op.create_foreign_key(
            'fk_systems_project_id', 'projects', ['project_id'], ['id'], ondelete='CASCADE'
        )
    # Re-home pre-existing rows (today, only the seeded SkyTEM 304): keep them globally visible.
    op.execute("UPDATE systems SET is_public = true WHERE project_id IS NULL")


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('systems', schema=None) as batch_op:
        batch_op.drop_constraint('fk_systems_project_id', type_='foreignkey')
        batch_op.drop_index('ix_systems_project_id')
        batch_op.drop_column('is_public')
        batch_op.drop_column('project_id')

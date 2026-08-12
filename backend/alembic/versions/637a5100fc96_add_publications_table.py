"""Add publications table (read-only project publication links)

Revision ID: 637a5100fc96
Revises: af672e56b096
Create Date: 2026-08-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = '637a5100fc96'
down_revision: Union[str, Sequence[str], None] = 'af672e56b096'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(bind, table):
    return inspect(bind).has_table(table)


def upgrade() -> None:
    bind = op.get_bind()

    if not _table_exists(bind, 'publications'):
        op.create_table(
            'publications',
            sa.Column('id', sa.String(255), primary_key=True),
            sa.Column('project_id', sa.String(255),
                      sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
            sa.Column('findable', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('allow_anonymous', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('created_by', sa.Integer(),
                      sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False,
                      server_default=sa.text('CURRENT_TIMESTAMP')),
        )
        op.create_index('ix_publications_project_id', 'publications', ['project_id'])


def downgrade() -> None:
    op.drop_index('ix_publications_project_id', 'publications')
    op.drop_table('publications')

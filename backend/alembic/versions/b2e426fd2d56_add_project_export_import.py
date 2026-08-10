"""Add project_exports and project_imports tables

Revision ID: b2e426fd2d56
Revises: 637a5100fc96
Create Date: 2026-08-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2e426fd2d56'
down_revision: Union[str, Sequence[str], None] = '637a5100fc96'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'project_exports',
        sa.Column('id', sa.String(255), primary_key=True),
        sa.Column('project_id', sa.String(255),
                  sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('created_by_id', sa.Integer(),
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('state', sa.String(32), nullable=False, server_default='queued'),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('file_url', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False,
                  server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
    )
    op.create_index('ix_project_exports_project_id', 'project_exports', ['project_id'])

    op.create_table(
        'project_imports',
        sa.Column('id', sa.String(255), primary_key=True),
        sa.Column('upload_id', sa.String(255),
                  sa.ForeignKey('uploads.id'), nullable=False),
        sa.Column('created_by_id', sa.Integer(),
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('state', sa.String(32), nullable=False, server_default='queued'),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('project_id', sa.String(255),
                  sa.ForeignKey('projects.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False,
                  server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('project_imports')
    op.drop_index('ix_project_exports_project_id', 'project_exports')
    op.drop_table('project_exports')

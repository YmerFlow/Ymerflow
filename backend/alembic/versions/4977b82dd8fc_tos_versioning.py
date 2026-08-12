"""ToS versioning and re-agreement

Revision ID: 4977b82dd8fc
Revises: 4ea58d5794c1
Create Date: 2026-08-11 00:00:00.000000

"""
from typing import Sequence, Union
from datetime import datetime

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import table, column


# revision identifiers, used by Alembic.
revision: str = '4977b82dd8fc'
down_revision: Union[str, Sequence[str], None] = '4ea58d5794c1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SEED_TOS_BODY = """# Terms of Service

This is placeholder Terms of Service text shipped as a working example. Replace this text with
your own terms using the Admin → Terms of Service tab.

## 1. Acceptance of terms

By creating an account, you agree to be bound by these Terms of Service. If you do not agree,
do not create an account.

## 2. Use of the service

You agree to use this service only for lawful purposes and in a manner that does not infringe
the rights of, or restrict or inhibit the use and enjoyment of, this service by any third party.

## 3. Data and storage

Data you upload or generate through the service is stored on your behalf. You are responsible
for ensuring you have the right to upload and process any data you submit.

## 4. No warranty

This service is provided "as is", without warranty of any kind, express or implied, including
but not limited to the warranties of merchantability, fitness for a particular purpose, and
non-infringement.

## 5. Changes to these terms

These terms may be updated from time to time. Continued use of the service after changes take
effect constitutes acceptance of the revised terms.
"""


def upgrade() -> None:
    op.create_table(
        'tos_versions',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False,
                  server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('created_by', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.UniqueConstraint('version', name='uq_tos_versions_version'),
    )
    op.create_index('ix_tos_versions_version', 'tos_versions', ['version'])

    op.create_table(
        'user_tos_acceptances',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer(),
                  sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('tos_version_id', sa.Integer(),
                  sa.ForeignKey('tos_versions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('accepted_at', sa.DateTime(), nullable=False,
                  server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.UniqueConstraint('user_id', 'tos_version_id', name='uq_user_tos_acceptances_user_version'),
    )
    op.create_index('ix_user_tos_acceptances_user_id', 'user_tos_acceptances', ['user_id'])
    op.create_index('ix_user_tos_acceptances_tos_version_id', 'user_tos_acceptances', ['tos_version_id'])

    tos_versions = table(
        'tos_versions',
        column('version', sa.Integer),
        column('body', sa.Text),
        column('created_at', sa.DateTime),
        column('created_by', sa.Integer),
    )
    op.execute(
        tos_versions.insert().values(
            version=1,
            body=SEED_TOS_BODY,
            created_at=datetime.utcnow(),
            created_by=None,
        )
    )


def downgrade() -> None:
    op.drop_index('ix_user_tos_acceptances_tos_version_id', table_name='user_tos_acceptances')
    op.drop_index('ix_user_tos_acceptances_user_id', table_name='user_tos_acceptances')
    op.drop_table('user_tos_acceptances')

    op.drop_index('ix_tos_versions_version', table_name='tos_versions')
    op.drop_table('tos_versions')

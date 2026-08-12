"""widen_projects_storage_secret_key

Revision ID: cbd89ac575e8
Revises: d1266f2f6e68
Create Date: 2026-07-23 00:00:00.000000

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'cbd89ac575e8'
down_revision: Union[str, None] = 'd1266f2f6e68'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # storage_secret_key holds a plain string for MinIO/S3 backends but a full serialized GCS
    # service-account JSON key (2000+ chars) for the GCS backend — String(255) truncates it.
    with op.batch_alter_table('projects') as batch_op:
        batch_op.alter_column('storage_secret_key', type_=sa.Text(), existing_type=sa.String(255))


def downgrade() -> None:
    with op.batch_alter_table('projects') as batch_op:
        batch_op.alter_column('storage_secret_key', type_=sa.String(255), existing_type=sa.Text())

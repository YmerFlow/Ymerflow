"""move storage_backends.endpoint into config['endpoint'] (minio-only concept)

Revision ID: 1b1030f46ec9
Revises: cbd89ac575e8
Create Date: 2026-08-09
"""
from alembic import op
import sqlalchemy as sa
import json

revision = '1b1030f46ec9'
down_revision = 'cbd89ac575e8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, endpoint, config FROM storage_backends")).fetchall()
    for row in rows:
        if not row.endpoint:
            continue
        config = row.config if isinstance(row.config, dict) else json.loads(row.config or "{}")
        config["endpoint"] = row.endpoint
        conn.execute(
            sa.text("UPDATE storage_backends SET config = :config WHERE id = :id"),
            {"id": row.id, "config": json.dumps(config)},
        )
    with op.batch_alter_table("storage_backends") as batch_op:
        batch_op.drop_column("endpoint")


def downgrade() -> None:
    with op.batch_alter_table("storage_backends") as batch_op:
        batch_op.add_column(sa.Column("endpoint", sa.String(255), nullable=True))
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, config FROM storage_backends")).fetchall()
    for row in rows:
        config = row.config if isinstance(row.config, dict) else json.loads(row.config or "{}")
        endpoint = config.pop("endpoint", None)
        if endpoint is None:
            continue
        conn.execute(
            sa.text("UPDATE storage_backends SET endpoint = :endpoint, config = :config WHERE id = :id"),
            {"id": row.id, "endpoint": endpoint, "config": json.dumps(config)},
        )

"""seed default cluster from config.env

Revision ID: f6a7b8c9d0e1
Revises: d1e2f3a4b5c6
Create Date: 2026-07-07
"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime
import os

revision = 'f6a7b8c9d0e1'
down_revision = 'd1e2f3a4b5c6'
branch_labels = None
depends_on = None

DEFAULT_ID = '3f976802-b810-4d20-942c-76da50c37510'


def upgrade() -> None:
    from backend.config import settings
    conn = op.get_bind()

    exists = conn.execute(
        sa.text("SELECT COUNT(*) FROM clusters WHERE id = :id"), {"id": DEFAULT_ID}
    ).scalar()

    if not exists:
        conn.execute(sa.text("""
            INSERT INTO clusters
                (id, name, kubeconfig, registry_url, registry_auth, namespace, created_at)
            VALUES
                (:id, 'Default Cluster', NULL, :registry_url, :registry_auth, :namespace, :created_at)
        """), {
            "id": DEFAULT_ID,
            "registry_url": settings.registry_url,
            "registry_auth": settings.registry_auth,
            # K8S_NAMESPACE is a raw env var read directly in k8s_client.py, NOT a field
            # on backend.config.Settings — read it the same raw way here.
            "namespace": os.getenv("K8S_NAMESPACE", "ymerflow-jobs"),
            "created_at": datetime.utcnow().isoformat(),
        })


def downgrade() -> None:
    pass

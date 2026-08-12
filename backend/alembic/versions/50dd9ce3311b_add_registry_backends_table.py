"""Add registry_backends table and seed the default row

Revision ID: 50dd9ce3311b
Revises: 54ea11448613
Create Date: 2026-07-15
"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime
import base64
import json
import os

revision = '50dd9ce3311b'
down_revision = '54ea11448613'
branch_labels = None
depends_on = None

DEFAULT_ID = 'cb95ebc3-be84-444c-a431-d04efcdb1e2c'
# Today's fixed NodePort dev/setup-registry.sh publishes the self-hosted registry on (see
# docker/build.sh's REGISTRY_URL="${REGISTRY_PUBLIC_HOST}:30500").
DEFAULT_PORT = 30500


def _default_protocol_and_config():
    """Mirror a6b7c8d9e0f1_seed_default_storage_backend.py's fallback pattern: prefer the
    generic REGISTRY_PROTOCOL/REGISTRY_CONFIG_JSON env vars (the shape Phase 4 of
    docs/plans/registry-backend-hooks.md formalizes as Settings fields — not yet added there,
    since that's explicitly out of Phase 1's scope), falling back to today's
    REGISTRY_USER/REGISTRY_PASSWORD/REGISTRY_PUBLIC_HOST settings so the existing self-hosted
    docker-v2 registry keeps working unchanged with zero config.env changes."""
    protocol = os.getenv("REGISTRY_PROTOCOL")
    config_json = os.getenv("REGISTRY_CONFIG_JSON")
    if protocol and config_json:
        return protocol, json.loads(config_json)

    from backend.config import settings

    user, password = "ymerflow", "ymerflow"
    if settings.registry_auth:
        decoded = base64.b64decode(settings.registry_auth).decode()
        user, _, password = decoded.partition(":")

    return "docker-v2", {
        "user": user,
        "password": password,
        "host": settings.registry_public_host,
        "port": DEFAULT_PORT,
    }


def upgrade() -> None:
    op.create_table(
        'registry_backends',
        sa.Column('id', sa.String(36), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('protocol', sa.String(32), nullable=False),
        sa.Column('config', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )

    conn = op.get_bind()
    protocol, config = _default_protocol_and_config()
    conn.execute(sa.text("""
        INSERT INTO registry_backends
            (id, name, protocol, config, created_at, sort_order, active)
        VALUES
            (:id, 'Default Registry Backend', :protocol, :config, :created_at, :sort_order, :active)
    """), {
        "id": DEFAULT_ID,
        "protocol": protocol,
        "config": json.dumps(config),
        "created_at": datetime.utcnow().isoformat(),
        "sort_order": 0,
        "active": True,
    })


def downgrade() -> None:
    op.drop_table('registry_backends')

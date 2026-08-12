"""add_k8s_execution_fields

Revision ID: 08adf96a1437
Revises: 5g9h7d8f6c4b
Create Date: 2026-01-27 14:19:23.262500

"""
from typing import Sequence, Union
import os
import uuid

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '08adf96a1437'
down_revision: Union[str, Sequence[str], None] = '5g9h7d8f6c4b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add K8s execution fields to process_versions and create default environment."""

    # Get connection to check existing columns
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    existing_columns = [col['name'] for col in inspector.get_columns('process_versions')]

    # Add new columns to process_versions table
    # Note: SQLite doesn't support adding UNIQUE constraints via ALTER TABLE
    # We'll enforce uniqueness at the application level instead

    # Only add columns if they don't already exist
    if 'resource_requests' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('resource_requests', sa.JSON(), nullable=True))
    if 'deadline_seconds' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('deadline_seconds', sa.Integer(), nullable=True))
    if 'k8s_job_name' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('k8s_job_name', sa.String(255), nullable=True))
    if 'k8s_namespace' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('k8s_namespace', sa.String(255), nullable=True))
    if 'max_reserved_cost' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('max_reserved_cost', sa.Numeric(10, 4), nullable=True))
    if 'actual_cost' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('actual_cost', sa.Numeric(10, 4), nullable=True))
    if 'started_at' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('started_at', sa.DateTime(), nullable=True))
    if 'completed_at' not in existing_columns:
        op.add_column('process_versions',
            sa.Column('completed_at', sa.DateTime(), nullable=True))

    # Set default values for existing process_versions
    op.execute("""
        UPDATE process_versions
        SET
            resource_requests = '{"cpu": "1000m", "memory": "2Gi", "ephemeral-storage": "10Gi"}',
            deadline_seconds = 3600
        WHERE resource_requests IS NULL
    """)

    # Create default Bootstrap environment if it doesn't exist
    # Detect environment: use local image for dev, gcr.io for prod
    database_url = os.getenv('DATABASE_URL', '')
    is_prod = 'gcp' in database_url or 'cloud' in database_url

    if is_prod:
        gcp_project = os.getenv('GCP_PROJECT', 'ymerflow')
        docker_image = f'gcr.io/{gcp_project}/ymerflow-runner:latest'
    else:
        docker_image = 'ymerflow-runner:latest'  # Use minikube's docker daemon

    # Check if Bootstrap environment already exists
    connection = op.get_bind()
    result = connection.execute(sa.text("SELECT id FROM environments WHERE name = 'Bootstrap'"))
    bootstrap_exists = result.fetchone() is not None

    if not bootstrap_exists:
        bootstrap_id = str(uuid.uuid4())
        connection.execute(
            sa.text("""
                INSERT INTO environments (id, name, docker_image, process_id, created_at)
                VALUES (:id, :name, :docker_image, NULL, CURRENT_TIMESTAMP)
            """),
            {'id': bootstrap_id, 'name': 'Bootstrap', 'docker_image': docker_image}
        )


def downgrade() -> None:
    """Remove K8s execution fields from process_versions."""

    # Drop new columns
    op.drop_column('process_versions', 'completed_at')
    op.drop_column('process_versions', 'started_at')
    op.drop_column('process_versions', 'actual_cost')
    op.drop_column('process_versions', 'max_reserved_cost')
    op.drop_column('process_versions', 'k8s_namespace')
    op.drop_column('process_versions', 'k8s_job_name')
    op.drop_column('process_versions', 'deadline_seconds')
    op.drop_column('process_versions', 'resource_requests')

    # Note: We don't delete the Bootstrap environment in downgrade
    # to avoid data loss if it's been used

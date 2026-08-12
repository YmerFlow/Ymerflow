"""Workspace versioning, project scoping, and public sharing

Revision ID: af672e56b096
Revises: 1b1030f46ec9
Create Date: 2026-08-10 00:00:00.000000

"""
from typing import Sequence, Union
from datetime import datetime

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'af672e56b096'
down_revision: Union[str, Sequence[str], None] = '1b1030f46ec9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_PROJECT_ID = 'default-project-00000000-0000-0000-0000-000000000000'


def upgrade() -> None:
    bind = op.get_bind()

    # New parent-table columns (nullable at first — project_id is backfilled below, then
    # tightened to NOT NULL once every existing row has one).
    op.add_column('workspaces', sa.Column('project_id', sa.String(255), nullable=True))
    op.add_column('workspaces', sa.Column('is_public', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('workspaces', sa.Column('forked_from_workspace_id', sa.String(255), nullable=True))
    op.add_column('workspaces', sa.Column('forked_from_version', sa.Integer(), nullable=True))
    op.add_column('workspaces', sa.Column('created_by', sa.Integer(), nullable=True))

    op.create_table(
        'workspace_versions',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('workspace_id', sa.String(255),
                  sa.ForeignKey('workspaces.id', ondelete='CASCADE'), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('layout', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False,
                  server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('created_by', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.UniqueConstraint('workspace_id', 'version', name='uq_workspace_version'),
    )
    op.create_index('ix_workspace_versions_workspace_id', 'workspace_versions', ['workspace_id'])

    # Backfill every pre-existing (unscoped) workspace onto the seeded default project as
    # public, and copy its current `layout` column into a version-1 WorkspaceVersion row.
    now = datetime.utcnow().isoformat()
    op.execute(sa.text(
        "UPDATE workspaces SET project_id = :project_id, is_public = TRUE"
    ).bindparams(project_id=DEFAULT_PROJECT_ID))

    op.execute(sa.text(
        "INSERT INTO workspace_versions (workspace_id, version, layout, created_at) "
        "SELECT id, 1, layout, :now FROM workspaces"
    ).bindparams(now=now))

    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.alter_column('project_id', nullable=False)
        batch_op.create_foreign_key(
            'fk_workspaces_project_id', 'projects', ['project_id'], ['id'], ondelete='CASCADE'
        )
        batch_op.create_foreign_key(
            'fk_workspaces_forked_from_workspace_id', 'workspaces',
            ['forked_from_workspace_id'], ['id'], ondelete='SET NULL'
        )
        batch_op.create_foreign_key(
            'fk_workspaces_created_by', 'users', ['created_by'], ['id']
        )
        batch_op.drop_column('layout')
        batch_op.drop_column('updated_at')

    op.create_index('ix_workspaces_project_id', 'workspaces', ['project_id'])


def downgrade() -> None:
    op.add_column('workspaces', sa.Column('layout', sa.JSON(), nullable=True))
    op.add_column('workspaces', sa.Column('updated_at', sa.DateTime(), nullable=True))

    op.execute(sa.text(
        "UPDATE workspaces SET layout = ("
        "  SELECT wv.layout FROM workspace_versions wv "
        "  WHERE wv.workspace_id = workspaces.id "
        "  ORDER BY wv.version DESC LIMIT 1"
        ")"
    ))
    op.execute("UPDATE workspaces SET updated_at = created_at")

    op.drop_index('ix_workspaces_project_id', table_name='workspaces')

    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.alter_column('layout', nullable=False)
        batch_op.alter_column('updated_at', nullable=False)
        batch_op.drop_constraint('fk_workspaces_created_by', type_='foreignkey')
        batch_op.drop_constraint('fk_workspaces_forked_from_workspace_id', type_='foreignkey')
        batch_op.drop_constraint('fk_workspaces_project_id', type_='foreignkey')
        batch_op.drop_column('created_by')
        batch_op.drop_column('forked_from_version')
        batch_op.drop_column('forked_from_workspace_id')
        batch_op.drop_column('is_public')
        batch_op.drop_column('project_id')

    op.drop_index('ix_workspace_versions_workspace_id', table_name='workspace_versions')
    op.drop_table('workspace_versions')

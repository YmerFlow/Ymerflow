"""migrate flowview filter tag ids to names

Rename the FlowView layout field ``selectedFilterTagIds`` (a list of per-project tag
ids) to ``selectedFilterTagNames`` (a list of tag names). Tag ids are per-project, so a
filter persisted in a shared/public workspace is meaningless in any other project; the
tag *name* is the semantically stable key across projects. See
docs/plans/done/flowview-filter-by-tag-name.md.

Revision ID: 67694977ebed
Revises: 2fccb9ea1497
Create Date: 2026-09-27 00:00:00.000000

"""
from typing import Sequence, Union
import json

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '67694977ebed'
down_revision: Union[str, Sequence[str], None] = '2fccb9ea1497'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _walk(obj, transform):
    """Recursively walk a layout tree, applying ``transform`` to every dict in place."""
    if isinstance(obj, dict):
        transform(obj)
        for v in obj.values():
            _walk(v, transform)
    elif isinstance(obj, list):
        for item in obj:
            _walk(item, transform)


def upgrade() -> None:
    conn = op.get_bind()

    # Global id -> name lookup across every project (the migration can resolve ids from
    # any project; the client can't, which is exactly why the persisted-id design broke).
    id_to_name = {
        row[0]: row[1]
        for row in conn.execute(sa.text("SELECT id, name FROM process_tags"))
    }

    def transform(node):
        if "selectedFilterTagIds" not in node:
            return
        ids = node.pop("selectedFilterTagIds") or []
        # Resolve each id -> name; drop ids that no longer resolve (deleted tags).
        # De-dupe while preserving order.
        names, seen = [], set()
        for tid in ids:
            name = id_to_name.get(tid)
            if name is not None and name not in seen:
                seen.add(name)
                names.append(name)
        node["selectedFilterTagNames"] = names

    rows = conn.execute(sa.text("SELECT id, layout FROM workspace_versions")).fetchall()
    for row_id, layout in rows:
        if layout is None:
            continue
        data = layout if isinstance(layout, (dict, list)) else json.loads(layout)
        changed = {"v": False}

        def transform_and_flag(node, _t=transform):
            if "selectedFilterTagIds" in node:
                changed["v"] = True
            _t(node)

        _walk(data, transform_and_flag)
        if changed["v"]:
            conn.execute(
                sa.text("UPDATE workspace_versions SET layout = :layout WHERE id = :id"),
                {"layout": json.dumps(data), "id": row_id},
            )


def downgrade() -> None:
    conn = op.get_bind()

    # Best-effort reverse (lossy): resolve names back to ids using the tags of the
    # workspace's *current owner* project. A name with no matching tag in that project
    # is dropped.
    rows = conn.execute(sa.text("""
        SELECT wv.id, wv.layout, w.project_id
        FROM workspace_versions wv
        JOIN workspaces w ON w.id = wv.workspace_id
    """)).fetchall()

    for row_id, layout, project_id in rows:
        if layout is None:
            continue
        name_to_id = {
            r[0]: r[1]
            for r in conn.execute(
                sa.text("SELECT name, id FROM process_tags WHERE project_id = :pid"),
                {"pid": project_id},
            )
        }
        data = layout if isinstance(layout, (dict, list)) else json.loads(layout)
        changed = {"v": False}

        def transform(node):
            if "selectedFilterTagNames" not in node:
                return
            changed["v"] = True
            names = node.pop("selectedFilterTagNames") or []
            ids = [name_to_id[n] for n in names if n in name_to_id]
            node["selectedFilterTagIds"] = ids

        _walk(data, transform)
        if changed["v"]:
            conn.execute(
                sa.text("UPDATE workspace_versions SET layout = :layout WHERE id = :id"),
                {"layout": json.dumps(data), "id": row_id},
            )

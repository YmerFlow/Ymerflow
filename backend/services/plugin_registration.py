"""Auto-registration of built frontend plugins.

When a ``build_frontend_plugin`` Process finishes, ``ProcessVersion._create_outputs`` reads the
``plugin.json`` the build wrote into the project bucket and calls :func:`register_built_plugin`
here — mirroring how ``environment.json`` becomes an ``Environment``. There is no separate
registration API call; registration is a side effect of the build completing.
"""

import hashlib
import json
import logging
import os

import fsspec
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def compute_dataset_content_hash(db, project_id, process_id, process_version, dataset_id):
    """sha256 (16 hex) over the output dataset's ``path -> sha256`` manifest.

    This is the content-addressed token used as the ``/plugin-assets/{hash}/`` URL prefix and for
    per-version deduplication. Re-building identical bytes yields the same hash. Reads use the
    project backend's admin fsspec kwargs.
    """
    from backend.services.storage_service import get_storage_base_url, get_fsspec_storage_options

    storage_base = await get_storage_base_url(db, project_id)
    proto = storage_base.split("://")[0]
    fs = fsspec.filesystem(proto, **await get_fsspec_storage_options(db, project_id))
    base = (
        f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}"
    ).split("://", 1)[1]

    # End the read transaction (storage_base / fsspec kwargs resolution) before the storage
    # traversal below, so the pooled connection isn't parked across fs.find / fs.open. The caller
    # (register_built_plugin) re-opens a transaction for its upserts afterwards. See
    # docs/plans/db-pool-commit-before-k8s-io.md.
    await db.commit()

    manifest = {}
    for f in sorted(fs.find(base)):
        rel = os.path.relpath(f, base)
        with fs.open(f, "rb") as fh:
            manifest[rel] = hashlib.sha256(fh.read()).hexdigest()
    content = json.dumps(manifest, sort_keys=True).encode()
    return hashlib.sha256(content).hexdigest()[:16]


async def register_built_plugin(db: AsyncSession, process, process_version, plugin_info):
    """Upsert a Plugin + PluginVersion from a completed build's ``plugin.json``.

    Idempotent: re-registering identical bytes (same ``content_hash``) is a no-op via the
    ``(plugin_id, content_hash)`` unique constraint; the plugin identity is created once and its
    ``latest_version_id`` advances to the newest build. Does NOT enable the plugin for anyone —
    enabling is a separate, per-user action.
    """
    from backend.models.plugin import Plugin, PluginVersion

    remote_name = plugin_info.get("remote_name")
    output_dataset_id = plugin_info.get("output_dataset_id")
    if not remote_name or not output_dataset_id:
        logger.warning(
            "plugin.json missing remote_name/output_dataset_id; skipping plugin registration: %r",
            plugin_info,
        )
        return None

    npm_name = plugin_info.get("npm_name", remote_name)
    npm_version = plugin_info.get("npm_version", "0.0.0")
    built_against = plugin_info.get("built_against", {})
    display_name = plugin_info.get("display_name") or npm_name

    content_hash = await compute_dataset_content_hash(
        db, process.project_id, process.id, process_version.version, output_dataset_id
    )

    # Upsert the Plugin identity (stable, keyed by MF remote name).
    plugin = (
        await db.execute(select(Plugin).where(Plugin.name == remote_name))
    ).scalar_one_or_none()
    if plugin is None:
        plugin = Plugin(name=remote_name, display_name=display_name)
        db.add(plugin)
        await db.flush()

    # Idempotent PluginVersion on (plugin_id, content_hash).
    version = (
        await db.execute(
            select(PluginVersion).where(
                PluginVersion.plugin_id == plugin.id,
                PluginVersion.content_hash == content_hash,
            )
        )
    ).scalar_one_or_none()
    if version is None:
        version = PluginVersion(
            plugin_id=plugin.id,
            project_id=process.project_id,
            process_id=process.id,
            process_version=process_version.version,
            output_dataset_id=output_dataset_id,
            npm_name=npm_name,
            npm_version=npm_version,
            content_hash=content_hash,
            built_against=built_against,
        )
        db.add(version)
        await db.flush()

    plugin.latest_version_id = version.id
    await db.commit()
    logger.info(
        "✓ Plugin auto-registered: %s (version %s, content_hash %s)",
        remote_name, version.id, content_hash,
    )
    return version

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
import mimetypes
import os

from backend.database import get_db
from backend.routers.auth import get_current_user, AuthContext
from backend.models.user import User
from backend.models.plugin import Plugin, PluginVersion, UserPlugin

router = APIRouter(prefix="/plugins", tags=["plugins"])
assets_router = APIRouter(prefix="/plugin-assets", tags=["plugin-assets"])

# NOTE: There are intentionally no "build plugin" or "register plugin" endpoints. A frontend plugin
# is built by submitting a `build_frontend_plugin` Process through the generic
# POST /projects/{project_id}/process endpoint
# (its parameter schema drives the GUI form, exactly like create_environment). When the build
# completes, its output auto-registers as a Plugin/PluginVersion in ProcessVersion._create_outputs
# (via backend/services/plugin_registration.py), like create_environment -> environment.json ->
# Environment. Enabling for a user remains a separate action below.


def _backend_plugins(request: Request):
    return getattr(request.app.state, 'backend_frontend_plugins', [])


def _backend_plugins(request: Request):
    return getattr(request.app.state, 'backend_frontend_plugins', [])


@router.get("")
async def list_plugins(
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """List all installed plugins, merged with the current user's per-user state.

    This is the data source for the Plugin Manager UI, so each row carries everything the UI
    needs to render and act on:

      * ``id`` — the Plugin identity (enable/disable/upgrade mutations target it),
      * ``enabled`` — whether the current user has this plugin enabled,
      * ``upgrade_available`` — whether the user's pinned version differs from latest,
      * ``pinned_version_id`` — the user's currently-pinned PluginVersion (if enabled),
      * ``source`` — ``"remote"`` (DB-registered, user-toggleable) or ``"backend"``
        (admin-installed bundle, always enabled, not toggleable).

    Backend-bundled plugins (``app.state.backend_frontend_plugins``) are included so the manager
    shows the complete set of plugins a user actually loads, not just the DB-registered ones.
    """
    # Current user's per-user plugin state, keyed by plugin_id.
    stmt = select(UserPlugin).where(UserPlugin.user_id == auth.user.id)
    result = await db.execute(stmt)
    user_state = {up.plugin_id: up for up in result.scalars().all()}

    # All DB-registered (remote) plugins.
    stmt = select(Plugin).options(selectinload(Plugin.latest_version))
    result = await db.execute(stmt)
    plugins = result.scalars().all()

    rows = []
    for p in plugins:
        d = p.to_dict()
        up = user_state.get(p.id)
        enabled = bool(up and up.enabled)
        upgrade_available = bool(
            up and up.enabled and p.latest_version_id is not None
            and up.plugin_version_id != p.latest_version_id
        )
        d.update({
            "source": "remote",
            "enabled": enabled,
            "toggleable": True,
            "pinned_version_id": up.plugin_version_id if up else None,
            "upgrade_available": upgrade_available,
        })
        rows.append(d)

    # Backend-bundled plugins: always enabled, not toggleable, no DB identity.
    for b in _backend_plugins(request):
        rows.append({
            "id": None,
            "name": b["name"],
            "display_name": b.get("display_name", b["name"]),
            "description": None,
            "latest_version_id": None,
            "created_at": None,
            "source": "backend",
            "enabled": True,
            "toggleable": False,
            "pinned_version_id": None,
            "upgrade_available": False,
        })

    return rows


@router.get("/me")
async def get_my_plugins(
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """Return union of backend-bundled plugins and user-enabled remote plugins."""
    # Backend plugins — always on, not user-toggled
    backend = [
        {
            "name": b["name"],
            "display_name": b["display_name"],
            "base_url": b["base_url"],
            "source": "backend",
            "upgrade_available": False,
        }
        for b in _backend_plugins(request)
    ]

    # User-enabled remote plugins
    stmt = (
        select(UserPlugin)
        .options(
            selectinload(UserPlugin.plugin).selectinload(Plugin.latest_version),
            selectinload(UserPlugin.plugin_version),
        )
        .where(
            UserPlugin.user_id == auth.user.id,
            UserPlugin.enabled == True,  # noqa: E712
        )
    )
    result = await db.execute(stmt)
    user_plugins = result.scalars().all()

    remote = []
    for up in user_plugins:
        if not up.plugin or not up.plugin_version:
            continue
        latest = up.plugin.latest_version
        remote.append({
            "name": up.plugin.name,
            "display_name": up.plugin.display_name,
            "base_url": f"/plugin-assets/{up.plugin_version.content_hash}/",
            "source": "remote",
            "upgrade_available": (latest is not None and latest.id != up.plugin_version_id),
        })

    return backend + remote


@router.post("/{plugin_id}/enable")
async def enable_plugin(
    plugin_id: str,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """Enable a plugin for the current user, pinning to the current latest version."""
    stmt = select(Plugin).options(selectinload(Plugin.latest_version)).where(Plugin.id == plugin_id)
    result = await db.execute(stmt)
    plugin = result.scalar_one_or_none()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not plugin.latest_version:
        raise HTTPException(status_code=400, detail="Plugin has no built version yet")

    stmt = select(UserPlugin).where(
        UserPlugin.user_id == auth.user.id,
        UserPlugin.plugin_id == plugin_id,
    )
    result = await db.execute(stmt)
    up = result.scalar_one_or_none()

    if up:
        up.enabled = True
        up.plugin_version_id = plugin.latest_version_id
    else:
        up = UserPlugin(
            user_id=auth.user.id,
            plugin_id=plugin_id,
            plugin_version_id=plugin.latest_version_id,
            enabled=True,
        )
        db.add(up)

    await db.commit()
    return {"status": "enabled"}


@router.post("/{plugin_id}/disable")
async def disable_plugin(
    plugin_id: str,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """Disable a plugin for the current user."""
    stmt = select(UserPlugin).where(
        UserPlugin.user_id == auth.user.id,
        UserPlugin.plugin_id == plugin_id,
    )
    result = await db.execute(stmt)
    up = result.scalar_one_or_none()
    if up:
        up.enabled = False
        await db.commit()
    return {"status": "disabled"}


@router.post("/{plugin_id}/upgrade")
async def upgrade_plugin(
    plugin_id: str,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """Re-pin the user to the plugin's latest version."""
    stmt = select(Plugin).options(selectinload(Plugin.latest_version)).where(Plugin.id == plugin_id)
    result = await db.execute(stmt)
    plugin = result.scalar_one_or_none()
    if not plugin or not plugin.latest_version:
        raise HTTPException(status_code=404, detail="Plugin or latest version not found")

    stmt = select(UserPlugin).where(
        UserPlugin.user_id == auth.user.id,
        UserPlugin.plugin_id == plugin_id,
    )
    result = await db.execute(stmt)
    up = result.scalar_one_or_none()
    if not up:
        raise HTTPException(status_code=404, detail="Plugin not enabled for this user")

    up.plugin_version_id = plugin.latest_version_id
    await db.commit()
    return {"status": "upgraded"}


@router.delete("/{plugin_id}")
async def delete_plugin(
    plugin_id: str,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """Unregister a plugin. Admin or creator only."""
    stmt = select(Plugin).where(Plugin.id == plugin_id)
    result = await db.execute(stmt)
    plugin = result.scalar_one_or_none()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not auth.user.is_admin and plugin.created_by != auth.user.id:
        raise HTTPException(status_code=403, detail="Not authorized")

    await db.delete(plugin)
    await db.commit()
    return {"status": "deleted"}


@assets_router.get("/{content_hash}/{path:path}")
async def serve_plugin_asset(
    content_hash: str,
    path: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Stream a content-addressed plugin asset file.

    NOTE: This endpoint is intentionally unauthenticated. Module Federation loads remoteEntry.js
    and its chunks via <script> tags, which cannot carry an Authorization header — an auth-gated
    response would be a 401 JSON body that the browser's Opaque Response Blocking (ORB) rejects.
    The assets are immutable, content-addressed JavaScript bundles (not user data), and the
    {content_hash} acts as an unguessable capability token, so public serving is safe.
    """
    # Check backend-bundled plugins first
    for bp in _backend_plugins(request):
        bp_hash = bp["base_url"].strip("/").split("/")[-1]
        if bp_hash == content_hash:
            dist_dir = bp.get("dist_dir")
            if dist_dir:
                file_path = os.path.join(dist_dir, path)
                if os.path.exists(file_path):
                    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
                    return FileResponse(
                        file_path,
                        media_type=media_type,
                        headers={"Cache-Control": "public, max-age=31536000, immutable"},
                    )

    # Check database-registered plugin versions
    stmt = select(PluginVersion).where(PluginVersion.content_hash == content_hash)
    result = await db.execute(stmt)
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Plugin asset not found")

    from backend.services.storage_service import get_storage_base_url, get_fsspec_storage_options
    import fsspec

    storage_base = await get_storage_base_url(db, version.project_id)
    asset_path = (
        f"{storage_base}/processes/{version.process_id}/{version.process_version}"
        f"/datasets/{version.output_dataset_id}/{path}"
    )
    storage_options = await get_fsspec_storage_options(db, version.project_id)
    proto = storage_base.split("://")[0]
    fs = fsspec.filesystem(proto, **storage_options)
    file_path_str = asset_path.split("://", 1)[1]

    if not fs.exists(file_path_str):
        raise HTTPException(status_code=404, detail="Asset file not found in storage")

    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"

    def iterfile():
        with fs.open(file_path_str, "rb") as f:
            yield from f

    return StreamingResponse(
        iterfile(),
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )

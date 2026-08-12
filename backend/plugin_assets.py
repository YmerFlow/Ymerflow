import hashlib
import json
import os

from backend.hooks import hooks


def content_address_dir(dist_dir):
    """Compute a content hash over all files in dist_dir. Returns (content_hash, remote_name)."""
    manifest = {}
    for root, dirs, files in os.walk(dist_dir):
        dirs.sort()
        for fname in sorted(files):
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, dist_dir)
            with open(fpath, 'rb') as f:
                manifest[rel] = hashlib.sha256(f.read()).hexdigest()

    content = json.dumps(manifest, sort_keys=True).encode()
    content_hash = hashlib.sha256(content).hexdigest()[:16]

    pkg_path = os.path.join(dist_dir, 'package.json')
    remote_name = 'unknown'
    if os.path.exists(pkg_path):
        with open(pkg_path) as f:
            try:
                pkg = json.load(f)
                remote_name = pkg.get('ymerflow', {}).get('remoteName', 'unknown')
            except Exception:
                pass

    return content_hash, remote_name


def mount_plugin_assets(app):
    """Called at startup — discovers backend-bundled frontend plugins via hook."""
    import logging
    logger = logging.getLogger(__name__)

    descriptors = []
    try:
        bundles = hooks.run.frontend_bundles()
    except Exception as e:
        logger.warning(f"frontend_bundles hook failed: {e}")
        bundles = []

    for b in bundles:
        dist_dir = b.get('dist_dir', '')
        if not dist_dir or not os.path.isdir(dist_dir):
            continue
        try:
            ch, pkg_remote_name = content_address_dir(dist_dir)
            # Bundle can declare its own name; fall back to reading package.json
            remote_name = b.get('name', pkg_remote_name)
            descriptors.append({
                'name': remote_name,
                'display_name': b.get('display_name', remote_name),
                'base_url': f"/plugin-assets/{ch}/",
                'source': 'backend',
                'dist_dir': dist_dir,
            })
            logger.info(f"Mounted backend plugin {remote_name} at /plugin-assets/{ch}/")
        except Exception as e:
            logger.warning(f"Failed to content-address plugin bundle {b}: {e}")

    app.state.backend_frontend_plugins = descriptors

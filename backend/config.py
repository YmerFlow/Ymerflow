import os
import secrets
import logging
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import List, Optional

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    # Database
    database_url: str = "sqlite:///./nagelfluh.db"

    # Per-Project Bucket Storage.
    # NOTE: these four are seed-only — the bootstrap migrations (a6b7c8d9…, 182d880e84c7) copy them
    # into the default StorageBackend row at install time. Nothing reads them at runtime anymore;
    # runtime addressing resolves the project's own StorageBackend via its StorageProtocolHandler
    # (see docs/plans/done/per-project-storage-routing.md).
    storage_protocol: str = "s3"  # s3, gcs, az, or file
    storage_endpoint: str = "https://localhost:9000"  # MinIO URL; overridden by k8s ConfigMap in prod
    storage_bucket_prefix: str = "nagelfluh-project-"

    # MinIO Admin Credentials (for bucket/user management)
    minio_root_user: str = "minioadmin"
    minio_root_password: str = "minioadmin"

    # TLS verification for the storage endpoint. plugins/ymerflow-minikube's storage_protocol.py
    # always mints a self-signed cert (Level A: encrypt, skip server-identity verification — see
    # docs/plans/done/self-signed-tls-minio-registry.md), so this normally needs to be True
    # wherever storage_endpoint is https://. Defaults to False (verify) so a deployment fronted by
    # a real CA-issued cert doesn't silently skip verification.
    storage_tls_skip_verify: bool = False

    # Authentication
    jwt_secret_key: Optional[str] = None
    jwt_algorithm: str = "HS256"
    access_token_expire_days: int = 30

    # Application
    process_cost: float = 0.10
    initial_user_balance: float = 100.0

    # Markdown shown in the "Hosted version" box on the landing page (config.env
    # HOSTED_VERSION_TEXT). Served publicly via GET /public-config — no auth, since it's
    # rendered before sign-in. Unset => the box is left empty.
    hosted_version_text: Optional[str] = None

    # CORS
    cors_origins: List[str] = ["http://localhost:3000"]

    # Backend API base URL
    backend_base_url: str = "http://localhost:8000"

    # Frontend base URL (used for invite links)
    frontend_base_url: str = "http://localhost:3000"

    # Site admin bootstrap
    admin_username: Optional[str] = None   # ADMIN_USERNAME in config.env
    admin_password: Optional[str] = None   # ADMIN_PASSWORD in config.env

    # SMTP email settings (all optional; if smtp_host is unset, emails are logged instead)
    smtp_host: Optional[str] = None
    smtp_port: int = 587
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_from_email: str = "noreply@nagelfluh.example.com"

    # Container Registry Configuration
    registry_url: str = "registry:5000"  # in-cluster pull URL; overridden by k8s ConfigMap in prod
    registry_auth: Optional[str] = None  # Auth credentials (base64 username:password or empty for no auth)
    # Publicly-reachable registry host (config.env REGISTRY_PUBLIC_HOST, no port) — used only to
    # render the remote "minikube" cluster setup script (GET /static/assets/setup-minikube-remote.sh),
    # which needs to fetch the registry's live TLS cert and bake host:port into the script. See
    # docs/plans/done/remote-cluster-provisioning-and-registry.md.
    registry_public_host: Optional[str] = None

    # Plugin frontend build configuration
    # The build resolves a plugin's npm source from a server-local directory and/or the npm
    # registry, controlled by `plugin_npm_source_mode`:
    #   "auto"     (default): try the local source dir first, then the registry.
    #   "local":   local source dir ONLY — error if absent (offline / air-gapped / tests).
    #   "registry": npm registry ONLY — ignore the local dir.
    plugin_npm_source_mode: str = "auto"
    # Server-local directory the admin populates ahead of time with plugin npm packages
    # (`.tgz` tarballs from `npm pack`, or unpacked source dirs), consulted in "auto"/"local" mode.
    plugin_npm_source_dir: str = "/var/lib/nagelfluh/plugin-npm-source"
    # npm registry used to fetch the plugin source (in "registry"/"auto" mode) AND the build
    # toolchain / non-shared deps. Empty => the build routine's default (registry.npmjs.org); set
    # to a private mirror for locked-down deployments.
    plugin_npm_registry: Optional[str] = None
    # How the build pod mounts the server-local npm source dir into its filesystem. The build pod
    # needs the admin-populated source dir present at `plugin_npm_source_dir` to resolve the plugin.
    # One of: "" / "none" (no volume — local/dev only), "pvc" (PersistentVolumeClaim), or "hostpath".
    plugin_npm_source_volume_type: str = ""
    # PVC name (when volume_type == "pvc") or host path (when volume_type == "hostpath").
    plugin_npm_source_volume_source: Optional[str] = None

    class Config:
        env_file = "config.env"
        env_file_encoding = "utf-8"
        extra = "ignore"

    @field_validator('jwt_secret_key', mode='before')
    @classmethod
    def set_jwt_secret(cls, v):
        if v is None:
            logger.warning(
                "JWT_SECRET_KEY not set in environment. Using generated secret. "
                "Sessions will not persist across server restarts. "
                "Set JWT_SECRET_KEY in config.env for production."
            )
            return secrets.token_urlsafe(32)
        return v


settings = Settings()

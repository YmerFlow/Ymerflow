"""Registry of per-protocol storage handlers.

A `StorageProtocolHandler` implements the actual API calls for one value of
`StorageBackend.protocol` (e.g. 'minio', 'gcs', 's3'). `CredentialStrategy` implementations
(`backend/services/storage_credentials.py`) delegate to whichever handler `backend.protocol`
resolves to instead of branching on protocol themselves — that axis (strategy vs. protocol) stays
independently extensible.

Handlers are discovered through the `storage_protocol_handlers` fan-out hook, the same
`ymerflow.hooks` mechanism used for `job_pre_run` / `job_completed` / `user_created`. Core
registers its own built-in handlers (minio/gcs/s3) through this exact hook too — see
`setup.py`'s `ymerflow.hooks` entry point — so a plugin adding a new protocol (e.g. Azure) uses
the identical channel core does, with no "core is special" path.
"""
from backend.hooks import hooks


class StorageProtocolHandler:
    """Implements protocol-specific storage operations for one value of
    StorageBackend.protocol (e.g. 'minio', 'gcs', 's3'). CredentialStrategy
    implementations delegate to one of these instead of branching on
    `backend.protocol` themselves."""

    # Names of `config` keys that hold credential/secret material and must be masked as "****" in
    # admin API responses. None (the default) means "mask every key" — the conservative default
    # for any handler, including third-party plugins, that hasn't explicitly opted a key out.
    SECRET_CONFIG_KEYS = None

    def provision(self, project, backend) -> dict:
        """One-time setup at project creation: bucket/service-account/policy creation.
        Returns credentials to persist for static-key use, or {} if this protocol never
        persists a long-lived credential."""
        raise NotImplementedError

    def mint(self, project, backend) -> dict:
        """Mint a fresh credential. Returns {"credentials": {...}, "expires_at": datetime | None}."""
        raise NotImplementedError

    async def test_connection(self, backend) -> None:
        """Validate connectivity/credentials only — no side effects, safe to call
        repeatedly from the admin UI before any project exists to provision for.
        No default implementation: protocols are too different from each other for a
        shared check (unlike ClusterProvider, where one generic k8s-list-namespaces
        check covers every cluster type)."""
        raise NotImplementedError

    def storage_base_url(self, project, backend) -> str:
        """The `<scheme>://…` root a project's data lives under on this backend.

        One bucket per project, on every protocol, no exceptions — this IS the
        access-control boundary (see docs/plans/per-project-storage-routing.md decision 2):
        `<scheme>://<bucket_prefix><project_id>`. The bucket name embeds project_id so a
        bucket can be reverse-resolved back to its owning project (see
        `backend/services/storage_service.py:resolve_bucket`)."""
        raise NotImplementedError

    def fsspec_kwargs(self, backend, credentials, for_pod: bool = False) -> dict:
        """The fsspec kwargs to pass to `fsspec.open(url, **kwargs)`/`fsspec.filesystem(proto,
        **kwargs)` for the given credential set. Called with admin credentials
        (`admin_credentials(backend)`) for trusted backend-side I/O, and with project-scoped
        credentials for the untrusted pod/runner — the same code path serves both, with the
        caller choosing which creds to pass. No caller ever branches on protocol: this method is
        the only place fsspec kwarg *shape* (client_kwargs/key/secret vs. token, etc.) is
        decided.

        `for_pod=True` signals the kwargs are for a job pod (in-cluster), so a handler whose pod-
        facing endpoint differs from its backend-facing one (e.g. MinIO's dev localhost vs. the
        in-cluster service DNS) can translate; handlers where the endpoint is the same everywhere
        (GCS/S3) ignore it."""
        raise NotImplementedError

    def admin_credentials(self, backend) -> dict:
        """The backend's own admin credential set, in the same shape `provision()`/`mint()`
        return (i.e. what `fsspec_kwargs(backend, credentials)` expects) — used for backend-side/
        trusted I/O, which is allowed to read/write any project's bucket on this backend because
        the backend enforces its own access control."""
        raise NotImplementedError

    def bootstrap(self, config: dict) -> dict:
        """Given whatever config.env / seed-time config was supplied for this protocol, return
        an enriched config ready to persist onto the StorageBackend row — e.g. provisioning a
        service account or minting a first credential. Every core-provided handler implements
        this as a passthrough (`return config`); live-provisioning bootstrap is entirely plugin
        territory (see Design decision 6 in docs/plans/registry-backend-hooks.md). Resolved and
        called by `backend/bin/yf-bootstrap-provision`; wiring its output into the dev/
        prod-minikube flows and the seed migrations is a later phase's concern (Phases 5/6)."""
        raise NotImplementedError

    def teardown(self, config: dict) -> None:
        """Remove the k8s-level resources this protocol's `bootstrap()` created (namespaces,
        Deployments, Services, PV/PVC, etc.). The teardown mirror of `bootstrap()`, resolved and
        called by `backend/bin/yf-bootstrap-teardown`
        (docs/plans/generic-deployment-orchestration.md, Phase 7). Default is a no-op passthrough,
        exactly like `bootstrap()`'s default for core-provided handlers — a protocol that
        provisions nothing local (a managed object store) tears nothing down. MUST be idempotent
        (safe to call when nothing is provisioned)."""
        return None


def storage_protocol_handlers():
    """Core's built-in protocol handlers, registered under ymerflow.hooks in the root setup.py
    exactly like a plugin's would be — hence returned as (name, class) tuples, not stored in a
    private dict. Core has no special precedence over plugins.

    'minio' moved out to plugins/ymerflow-minikube (see
    docs/plans/minikube-provisioning-plugin.md) — a stock install with that plugin not in
    BACKEND_PLUGINS has no self-hosted storage option left, only 's3' (plus whatever other
    plugins are installed).

    Imports are local to break the import cycle: each handler module imports
    `StorageProtocolHandler` from this module, so they can only be imported once this module has
    finished defining it."""
    from backend.services.storage_protocols.s3 import S3ProtocolHandler

    return [
        ("s3", S3ProtocolHandler),
    ]


_registry = None


def get_protocol_handler(protocol):
    global _registry
    if _registry is None:
        registry = {}
        for name, handler_cls in hooks.run.storage_protocol_handlers():
            if name in registry:
                raise ValueError(
                    f"duplicate storage_protocol_handlers registration for protocol {name!r}"
                )
            registry[name] = handler_cls
        _registry = registry
    return _registry[protocol]()

"""Registry of per-protocol container-registry handlers.

A `RegistryProtocolHandler` implements the actual operations for one value of
`RegistryBackend.protocol` (e.g. 'docker-v2', 'gar'). This is the third pluggable-backend axis,
mirroring `StorageBackend`/`StorageProtocolHandler` (`backend/services/storage_protocols/`) and
`Cluster`/`ClusterProvider` (`backend/services/cluster_providers/`) exactly.

Handlers are discovered through the `registry_protocol_handlers` fan-out hook, the same
`ymerflow.hooks` mechanism used for `storage_protocol_handlers` / `cluster_provider_handlers`.
Core registers its own built-in handler (docker-v2) through this exact hook too — see
`setup.py`'s `ymerflow.hooks` entry point — so a plugin adding a new protocol (e.g. Google
Artifact Registry) uses the identical channel core does, with no "core is special" path.
"""
from backend.hooks import hooks


class RegistryProtocolHandler:
    """Implements protocol-specific container-registry operations for one value of
    RegistryBackend.protocol (e.g. 'docker-v2', 'gar')."""

    def image_url(self, config: dict, repository: str, tag: str) -> str:
        """The single place address *shape* is decided (mirrors
        StorageProtocolHandler.storage_base_url). `docker-v2` returns
        `host:port/repository:tag`. Every implementation is expected to return exactly
        `f"{self.image_prefix(config)}/{repository}:{tag}"` — image_prefix() is the part of
        that shape callers needing to construct their OWN sub-repository paths (e.g.
        `create_environment`'s per-environment images) must build on top of, instead of
        assuming any particular shape (a bare host:port, as with docker-v2, or a host plus
        fixed project/repository path segments, as with GAR)."""
        raise NotImplementedError

    def image_prefix(self, config: dict) -> str:
        """The part of image_url()'s address that comes before `/{repository}:{tag}` — i.e.
        `image_url(config, repository, tag) == f"{image_prefix(config)}/{repository}:{tag}"`
        for every implementation. `docker-v2` returns `host:port`; `gar` returns
        `location-docker.pkg.dev/project_id/repository` (GAR addresses under one fixed,
        bootstrapped repository — there is no bare host you can push arbitrary repository
        names under, unlike docker-v2's self-hosted registry). Callers that need to build a
        NEW image reference under a caller-chosen name (rather than calling image_url() with
        an already-known repository/tag) use this instead of assuming image_url()'s shape is
        just a host."""
        raise NotImplementedError

    async def pull_credentials(self, config: dict) -> dict:
        """Resolve a pod image-pull credential. Returns
        {"username": str, "password": str, "expires_at": datetime | None}.
        `docker-v2` returns the static user/password from its config, expires_at=None (i.e.
        "never refresh, reuse the pod-launch-time value" — see Design decision 4 in
        docs/plans/registry-backend-hooks.md)."""
        raise NotImplementedError

    def configure_push_auth(self, config: dict) -> None:
        """Perform whatever local docker login / credential-helper setup push-side tooling
        needs before a `docker push`. `docker-v2` does today's
        `docker login host:port -u ... -p ...` (see docker/build.sh)."""
        raise NotImplementedError

    async def test_connection(self, config: dict) -> None:
        """Raise a clear exception if this config can't actually reach/authenticate against a
        registry. No default implementation: protocols are too different from each other for a
        shared check (unlike ClusterProvider, where one generic k8s-list-namespaces check
        covers every cluster type)."""
        raise NotImplementedError

    def bootstrap(self, config: dict) -> dict:
        """Given whatever config.env / seed-time config was supplied for this protocol, return
        an enriched config ready to persist onto the RegistryBackend row — e.g. provisioning a
        service account or minting a first credential. Every core-provided handler implements
        this as a passthrough (`return config`); live-provisioning bootstrap is entirely plugin
        territory (see Design decision 6 in docs/plans/registry-backend-hooks.md). Not called
        anywhere yet in Phase 1 — the hook exists so Phase 4's generic
        `yf-bootstrap-provision` entry point has somewhere to call into."""
        raise NotImplementedError

    def teardown(self, config: dict) -> None:
        """Remove the k8s-level resources this protocol's `bootstrap()` created (namespaces,
        Deployments, Services, etc.). The teardown mirror of `bootstrap()`, resolved and called by
        `backend/bin/yf-bootstrap-teardown` (docs/plans/generic-deployment-orchestration.md,
        Phase 7). Default is a no-op passthrough, exactly like `bootstrap()`'s default for
        core-provided handlers — a protocol that provisions nothing local (a managed registry)
        tears nothing down. MUST be idempotent (safe to call when nothing is provisioned)."""
        return None

    def push_image(self, local_image_ref: str, config: dict, repository: str, tag: str) -> str:
        """Push a locally-built image (already present in the host's own Docker daemon, tagged
        `local_image_ref`) to this backend, resolving it under `repository:tag`. Returns the full
        pushed ref, mirroring `image_url()`'s return shape (in fact every implementation is
        expected to return exactly `self.image_url(config, repository, tag)`).

        This is the one place the actual push mechanics live, and it is self-contained: it owns
        whatever authentication and TLS handling the push needs, so the generic build-and-push
        entry point (`backend/bin/yf-build-and-push`) calls only this — never a separate
        `configure_push_auth()` step. `docker-v2` shells out to `docker save` + `crane push
        --insecure` with its own throwaway auth config (see
        docs/plans/generic-deployment-orchestration.md, Design decision 1), precisely so it does
        NOT depend on the host Docker daemon trusting its self-signed cert; a protocol backed by a
        real CA-issued cert (e.g. a future GAR handler) could instead implement this as a plain
        `docker push` (or supply `insecure=False` to a shared helper, if one is factored out) —
        this ABC makes no assumption either way."""
        raise NotImplementedError


def registry_protocol_handlers():
    """Core's built-in protocol handlers, registered under ymerflow.hooks in the root setup.py
    exactly like a plugin's would be — hence returned as (name, class) tuples, not stored in a
    private dict. Core has no special precedence over plugins.

    'docker-v2' moved out to plugins/ymerflow-minikube (see
    docs/plans/minikube-provisioning-plugin.md) — core registers no registry protocol of its own
    at all; a stock install needs that plugin (or another one) for any registry option.

    Imports are local to break the import cycle: each handler module imports
    `RegistryProtocolHandler` from this module, so they can only be imported once this module has
    finished defining it."""
    return []


_registry = None


def get_registry_protocol_handler(protocol):
    global _registry
    if _registry is None:
        registry = {}
        for name, handler_cls in hooks.run.registry_protocol_handlers():
            if name in registry:
                raise ValueError(
                    f"duplicate registry_protocol_handlers registration for protocol {name!r}"
                )
            registry[name] = handler_cls
        _registry = registry
    return _registry[protocol]()

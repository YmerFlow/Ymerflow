"""Shared helpers for write-only secret fields in the admin API (StorageBackend.config,
Cluster.provider_config). Secrets are never sent to the browser in
plaintext — GET/list responses substitute MASKED for each set field. On Save/Test Connection, any
field still equal to MASKED means "leave unchanged" and is resolved back to the stored value here,
rather than being persisted (or tested against) literally."""

MASKED = "****"


def mask_config(config, secret_keys=None):
    """secret_keys=None masks every key (default, conservative). A protocol handler that declares
    SECRET_CONFIG_KEYS restricts masking to just those keys — other keys (e.g. MinIO's endpoint)
    pass through in plaintext."""
    config = config or {}
    if secret_keys is None:
        return {k: MASKED for k in config}
    return {k: (MASKED if k in secret_keys else v) for k, v in config.items()}


def mask_secret(value):
    return MASKED if value else None


def resolve_config(submitted, stored):
    stored = stored or {}
    resolved = dict(submitted or {})
    for key, value in resolved.items():
        if value == MASKED:
            if key not in stored:
                raise ValueError(
                    f"cannot restore masked value for {key!r}: no existing value stored"
                )
            resolved[key] = stored[key]
    return resolved


def resolve_secret(submitted, stored):
    if submitted == MASKED:
        if not stored:
            raise ValueError("cannot restore masked value: no existing value stored")
        return stored
    return submitted

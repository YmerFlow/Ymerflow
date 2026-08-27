"""AWS S3 protocol handler — stub.

New code, not a refactor of anything existing (YmerFlow has no real-AWS storage support today —
the existing `minio_service.py` code talks to MinIO's S3-compatible API, handled by
`MinioProtocolHandler`, not this one). `provision()` will create an IAM role/policy + bucket for
`static-key` use; `mint()` will call STS `AssumeRole` for the `short-lived` strategy. Both are
Phase 4+ work.
"""
from backend.services.storage_protocols import StorageProtocolHandler


class S3ProtocolHandler(StorageProtocolHandler):
    def provision(self, project, backend) -> dict:
        raise NotImplementedError("AWS S3 storage provisioning is not implemented yet")

    def mint(self, project, backend) -> dict:
        raise NotImplementedError("AWS S3 short-lived credential minting is not implemented yet")

    async def test_connection(self, backend) -> None:
        raise NotImplementedError("AWS S3 storage support is not implemented yet")

    def storage_base_url(self, project, backend) -> str:
        # One bucket per project — <bucket_prefix><project_id> — same rule as every backend.
        return f"s3://{backend.bucket_prefix}{project.id}"

    def fsspec_kwargs(self, backend, credentials) -> dict:
        # Real AWS S3: no endpoint_url (boto talks to the AWS endpoint); a static key/secret pair
        # for the static-key strategy, or STS-minted creds for short-lived. Left as the same stub
        # shape MinIO uses minus the MinIO endpoint until AWS provisioning is implemented.
        return {
            "key": credentials.get("access_key"),
            "secret": credentials.get("secret_key"),
        }

    def admin_credentials(self, backend) -> dict:
        return {
            "access_key": backend.config.get("admin_access_key"),
            "secret_key": backend.config.get("admin_secret_key"),
        }

    def bootstrap(self, config: dict) -> dict:
        """Passthrough — unlike the rest of this stub handler's methods, `bootstrap` is a working
        implementation, not a NotImplementedError stub: every core-provided handler implements
        this as a passthrough regardless of how much else of the protocol is built out yet (see
        Design decision 6 in docs/plans/registry-backend-hooks.md)."""
        return config

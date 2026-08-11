# Storage Architecture

Nagelfluh uses a **per-project bucket** architecture with IAM-enforced security for dataset storage.

**Related documentation:**
- [Process Types](processes.md) - How process types use storage_context in their run() method
- [Environment](environment.md) - How storage credentials and configuration are injected into pods

## Storage Backends

### Development: MinIO
- S3-compatible object storage running in Minikube
- Automatic bucket/user/policy creation on project creation
- Credentials delivered per-job via the `STORAGE_KWARGS_JSON` env var (static or short-lived,
  per the backend's `credential_strategy` — see Credential Injection below), not a Kubernetes secret
- Port-forwarded to `localhost:9000` for backend access
- The `minio` `StorageBackend.protocol` (deploying the MinIO server itself into Minikube, TLS
  cert, bucket/user provisioning) is implemented by the `plugins/ymerflow-minikube` plugin's
  `MinioProtocolHandler` — core ships no storage protocol of its own. See
  [Registry Architecture](registry.md) (the sibling axis, documented in more depth) and
  `docs/plans/minikube-provisioning-plugin.md`.

### Production: Cloud Storage
- **Google Cloud Storage (GCS)**: Recommended for GCP deployments
  - Workload Identity for pod authentication
  - No explicit credentials needed
- **AWS S3**: Recommended for AWS deployments
  - IRSA (IAM Roles for Service Accounts) for pod authentication
  - No explicit credentials needed
- **Azure Blob Storage**: Supported via fsspec

## Bucket Structure

Each project gets its own isolated bucket:

```
s3://nagelfluh-project-{project-id}/
├── uploads/
│   └── {upload-id}/
│       ├── metadata.json
│       └── uploaded-file.xyz
└── processes/
    └── {process-id}/
        └── {version}/
            └── datasets/
                └── {dataset-id}/
                    ├── info.json        # Dataset metadata: dataset_name, mime_type,
                    │                    # and a files/parts map of relative path -> data file
                    ├── root.msgpack     # A data file referenced from info.json (name is
                    │                    # whatever the process chose, not fixed)
                    └── parts/
                        ├── chunk-0.msgpack
                        ├── chunk-1.msgpack
                        └── ...
```

### Path Breakdown

- **`uploads/{upload-id}/`**: User-uploaded files
  - Uploaded via backend API
  - Accessible by all processes in the project
  - Immutable after upload

- **`processes/{process-id}/{version}/datasets/{dataset-id}/`**: Process outputs
  - Written by process pods; scanned by the backend once the job completes
    (`ProcessVersion._create_outputs`, `backend/models/process.py`)
  - `info.json` is authoritative: the backend reads `dataset_name`/`mime_type` and the
    `files`/`parts` map from it to create the `Dataset` DB record — there is no fixed
    `root.msgpack` filename, the process chooses its own data file names and info.json points at
    them
  - Keyed by process **version**, not just process id, so re-running a process as a new version
    cannot collide with or overwrite a prior version's output
  - No overwrites possible (unique dataset IDs per execution)
  - Multiple files supported (root + parts)

## Security Model

### Per-Project Isolation

Each project has:
1. **Dedicated bucket**: `nagelfluh-project-{project-id}`
2. **Dedicated user/service account**: Scoped credentials
3. **IAM policy**: Path-based access control

### Process Pod Permissions

Process pods receive scoped credentials with:

- ✅ **READ access**: All files in the project bucket
  - All uploads: `uploads/*`
  - All process outputs: `processes/*/datasets/*`
- ✅ **WRITE access**: Only to own process directory
  - `processes/{PROCESS_ID}/datasets/*`
- ❌ **No access**: Other projects' buckets

### MinIO Policy Example

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::nagelfluh-project-abc123",
        "arn:aws:s3:::nagelfluh-project-abc123/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::nagelfluh-project-abc123/processes/process-xyz/*"
      ]
    }
  ]
}
```

### Credential Injection

Credentials are not a static, per-project secret synced into Kubernetes. Each `StorageBackend`
row has a `credential_strategy` (`backend/services/storage_credentials.py`) that decides how a
job's credentials are obtained and how long they last:

- **`static-key`** (`StaticKeyStrategy`) — the protocol handler's `provision()` runs once, at
  project creation, and the resulting access/secret key pair is persisted on the `Project` row.
  Every job launch reuses that same pair; `mint()` just returns it. It never expires on its own.
- **`short-lived`** (`ShortLivedStrategy`) — the protocol handler's `mint()` is called fresh at
  every job launch, and the runner refreshes it again mid-job (see below). Lifetime is pegged to
  the shortest common cap across backends actually in use (~1h) for a uniform refresh cadence.

Either strategy, the resulting credentials are delivered to the pod as a single
`STORAGE_KWARGS_JSON` environment variable — the exact kwargs
`StorageProtocolHandler.fsspec_kwargs()` built for that credential set, passed straight to
`fsspec.open(url, **kwargs)` — not a Kubernetes Secret:

```yaml
env:
  - name: STORAGE_BASE
    value: s3://nagelfluh-project-{project_id}
  - name: STORAGE_KWARGS_JSON
    value: '{"key": "...", "secret": "...", "client_kwargs": {"endpoint_url": "..."}}'
  - name: CREDENTIAL_STRATEGY
    value: static-key   # or short-lived
```

This is cluster-agnostic: nothing is mounted from a per-cluster Kubernetes secret, so a job
running on a remote/GKE cluster gets its credentials the same way a local Minikube job does. See
`docs/plans/done/per-project-storage-routing.md`.

#### Short-Lived Credential Refresh

For `credential_strategy=short-lived`, the pod also receives `STORAGE_REFRESH_TOKEN` (an opaque
per-job token, hash-compared server-side) and `STORAGE_CREDENTIALS_EXPIRES_AT`. `runner.py` forks
a separate refresher **OS process** (not a thread — process code is often CPU-bound numpy/scipy
that can hold the GIL, which would starve a same-process thread right up to expiry) that:

1. Sleeps until roughly half the remaining credential lifetime
2. Calls `POST /internal/process/{process_id}/versions/{version}/storage-credentials/refresh`
   (authenticated by the refresh token, re-running `strategy.mint()` server-side)
3. Writes the new `{credentials, expires_at}` to a local file via
   write-to-tempfile-then-atomic-rename
4. Repeats until the job exits

The main process's `storage_context['storage_kwargs']` is a `RefreshableStorageKwargs` object
(`docker/base-runner/storage_credentials_client.py`) that re-reads this file on every fsspec call
— env vars can't be updated on an already-running process, so the initial `STORAGE_KWARGS_JSON`
is only good for the first mint, not for a long-running job. See
`docs/plans/done/short-lived-storage-credentials-00-overview.md` for the full design.

## Dataset I/O with fsspec

All dataset access uses [fsspec](https://filesystem-spec.readthedocs.io/) for unified file operations across storage backends.

### Reading Datasets

```python
import fsspec
import os

# Get storage context from environment
storage_base = os.environ['STORAGE_BASE']  # e.g., s3://nagelfluh-project-abc123
storage_endpoint = os.environ.get('STORAGE_ENDPOINT')  # MinIO URL or None

# Build fsspec kwargs
storage_kwargs = {}
if storage_endpoint:
    storage_kwargs['client_kwargs'] = {'endpoint_url': storage_endpoint}

# Read a dataset
dataset_path = f"{storage_base}/processes/process-xyz/datasets/123/root.msgpack"
with fsspec.open(dataset_path, "rb", **storage_kwargs) as f:
    data = f.read()
```

### Writing Datasets

```python
import fsspec
import os
import uuid

def write_dataset(storage_context, data):
    """Write output dataset to storage.

    Args:
        storage_context: Dict with storage_base, process_id, storage_kwargs
        data: Binary data to write

    Returns:
        str: Full path to written dataset
    """
    # Generate unique dataset ID
    dataset_id = str(uuid.uuid4())

    # Construct output path
    output_path = (
        f"{storage_context['storage_base']}/"
        f"processes/{storage_context['process_id']}/"
        f"datasets/{dataset_id}/root.msgpack"
    )

    # Write data
    with fsspec.open(
        output_path,
        "wb",
        **storage_context['storage_kwargs']
    ) as f:
        f.write(data)

    return output_path
```

### Multi-Part Datasets

For large datasets, use chunked storage:

```python
def write_chunked_dataset(storage_context, chunks):
    """Write dataset in multiple parts.

    Args:
        storage_context: Storage configuration
        chunks: Iterable of binary chunks

    Returns:
        str: Base path to dataset
    """
    dataset_id = str(uuid.uuid4())
    base_path = (
        f"{storage_context['storage_base']}/"
        f"processes/{storage_context['process_id']}/"
        f"datasets/{dataset_id}"
    )

    # Write root metadata
    with fsspec.open(
        f"{base_path}/root.msgpack",
        "wb",
        **storage_context['storage_kwargs']
    ) as f:
        f.write(create_metadata(len(chunks)))

    # Write chunks
    for i, chunk in enumerate(chunks):
        with fsspec.open(
            f"{base_path}/parts/chunk-{i}.msgpack",
            "wb",
            **storage_context['storage_kwargs']
        ) as f:
            f.write(chunk)

    return base_path
```

### Listing Files

```python
import fsspec

# List all datasets for a process
fs = fsspec.filesystem(
    's3',
    key=os.environ['AWS_ACCESS_KEY_ID'],
    secret=os.environ['AWS_SECRET_ACCESS_KEY'],
    client_kwargs={'endpoint_url': os.environ.get('STORAGE_ENDPOINT')}
)

process_path = f"nagelfluh-project-abc123/processes/process-xyz/datasets"
datasets = fs.ls(process_path)
print(datasets)
```

## Dataset Structure

### Dataset Metadata

Each dataset has metadata stored in the backend database:

```python
{
    "id": "dataset-abc-123",
    "mime_type": "application/x-msgpack",
    "process_id": "process-xyz",
    "process_name": "Inversion Analysis",
    "process_version": 1,
    "dataset_name": "resistivity_model",
    "storage_path": "s3://nagelfluh-project-abc/processes/process-xyz/datasets/123/root.msgpack"
}
```

### Dataset Formats

Common formats:
- **MessagePack** (`.msgpack`): Binary format for AEM data (libaarhusxyz)
- **GeoJSON** (`.geojson`): Geographic vector data
- **GeoTIFF** (`.tif`): Raster/grid data
- **CSV** (`.csv`): Tabular data
- **NetCDF** (`.nc`): Multidimensional scientific data

## Storage Configuration

### Per-Project Storage Backends

Storage is not configured once, globally. Each project is bound to one row in the
`storage_backends` table (`backend/models/storage_backend.py`, `StorageBackend`), and every
read/write for that project resolves through it — never through global settings at request time.
A `StorageBackend` carries:

- `protocol` — `s3`, `gcs`, `az`, `file`, or a plugin-provided value (e.g. `minio`, from
  `plugins/ymerflow-minikube`)
- `bucket_prefix` — combined with the project id to form the bucket name
- `credential_strategy` — `static-key` or `short-lived` (see Credential Injection above)
- `config` — an opaque JSON blob meaningful only to that protocol's handler (MinIO admin alias,
  GCP service account to impersonate, AWS role ARN, etc.)

All addressing and fsspec-kwarg construction for a backend is delegated to a
`StorageProtocolHandler` (`backend/services/storage_protocols/__init__.py`), resolved from
`backend.protocol`:

- `provision(project, backend)` — one-time bucket/user/policy setup at project creation
- `mint(project, backend)` — mint a (possibly short-lived) credential
- `storage_base_url(project, backend)` — the `<scheme>://<bucket_prefix><project_id>` root for
  that project's data
- `fsspec_kwargs(backend, credentials, for_pod=False)` — the kwargs handed to
  `fsspec.open()`/`fsspec.filesystem()`
- `admin_credentials(backend)` — the backend's own trusted credentials, used for backend-side
  (trusted) I/O, which may read/write any project's bucket on that backend
- `bootstrap()`/`teardown()` — provision/tear down whatever infrastructure the protocol needs at
  install time (see [Registry Architecture](registry.md) for the sibling pattern)

Backend-side services (`backend/services/storage_service.py`: dataset scanning, the `/files/`
proxy, upload handling) and job-launch credential minting (`backend/services/job_orchestrator.py`)
all resolve the *project's own* `StorageBackend` this way. Core ships one built-in handler (`s3`);
MinIO's handler lives in `plugins/ymerflow-minikube` (see the Storage Backends section above).

### Install-Time Defaults

`backend/config.py`'s `storage_protocol` / `storage_endpoint` / `storage_bucket_prefix` settings
still exist, but only as seed values: the bootstrap migrations copy them into the default
`StorageBackend` row the first time the database is set up. After that, nothing reads them at
runtime — changing these env vars on an existing deployment has no effect. Reconfigure storage
through the admin storage-backends API instead (see "Choosing a Storage Backend" below).

```bash
# .env file — used once, at install time, to seed the default StorageBackend row
STORAGE_PROTOCOL=s3
STORAGE_ENDPOINT=http://localhost:9000      # MinIO, or empty for cloud S3/GCS
STORAGE_BUCKET_PREFIX=nagelfluh-project-
```

## Automatic Bucket Provisioning

When a new project is created:

1. **Backend generates**:
   - Unique project ID
   - Bucket name: `{backend.bucket_prefix}{project_id}` (the project's `StorageBackend` row)
   - Access credentials (MinIO) or service account (cloud), via the backend's `credential_strategy`

2. **MinIO setup** (development):
   - Create bucket via MinIO API
   - Create dedicated user
   - Create IAM policy with path-based permissions
   - Attach policy to user
   - Persist the credential pair on the `Project` row (`static-key`) or mint one fresh per job
     (`short-lived`) — see Credential Injection above; delivered to job pods as `STORAGE_KWARGS_JSON`,
     not a Kubernetes secret

3. **Cloud setup** (production):
   - Create GCS bucket with uniform access control
   - Create service account for project
   - Grant service account IAM roles on bucket
   - Configure Workload Identity binding

4. **Database record**:
   - Store project ID, bucket name, credential reference

## Choosing a Storage Backend

Which `StorageBackend` a project uses is a user-facing choice, not a fixed setting:

- `GET /utilities/available-storage-backends` returns the backends the current user is allowed to
  create a project against, resolved by `get_allowed_storage_backends()`
  (`backend/models/storage_backend.py`). If no `select_storage_backends` plugin hook is
  registered, every active backend is allowed; if one or more plugins register the hook (e.g. a
  billing plugin gating backends by plan), the allowed set is the union of what they return —
  mirrors how `select_clusters` already gates cluster choice.
- The create-project dialog (`frontend/src/ProjectModal.jsx`) shows that list and submits the
  chosen id as a required `storage_backend_id` on `POST /projects`; the backend re-validates it
  against the allowed set server-side rather than trusting the client. Unlike cluster selection,
  there is no server-side default — a request that omits `storage_backend_id` is rejected.
- Admins manage the backend catalog itself under `/admin/storage-backends`
  (`backend/routers/admin.py`) — list/create/update, plus a stateless "test connection" endpoint
  used before saving. `config` values the protocol handler flags as secret
  (`StorageProtocolHandler.SECRET_CONFIG_KEYS`) are masked in every admin API response.

## Best Practices

### Process Implementation

1. **Use storage_context**: Always accept and use the `storage_context` parameter
2. **Unique IDs**: Generate unique dataset IDs (UUIDs)
3. **Check existence**: Don't assume paths exist, handle errors
4. **Clean structure**: Organize outputs logically (root + parts)
5. **Document format**: Include format metadata in filenames and database

### Performance

1. **Stream large files**: Use streaming I/O for files >100MB
2. **Chunk appropriately**: Split large datasets into manageable chunks (10-50MB each)
3. **Parallel uploads**: Upload chunks in parallel when possible
4. **Compression**: Use compressed formats (msgpack supports compression)
5. **COG for rasters**: Use Cloud-Optimized GeoTIFF for map data

### Security

1. **Never hardcode credentials**: Always use environment variables
2. **Validate inputs**: Check dataset URLs before accessing
3. **Limit blast radius**: Write only to your process directory
4. **Clean up temp files**: Don't leak data to ephemeral storage
5. **Log safely**: Don't log credentials or sensitive data

### Error Handling

```python
import fsspec

try:
    with fsspec.open(path, "rb", **storage_kwargs) as f:
        data = f.read()
except FileNotFoundError:
    print(f"ERROR: Dataset not found: {path}")
    return {"status": "failed", "error": "Input dataset not found"}
except PermissionError:
    print(f"ERROR: Access denied: {path}")
    return {"status": "failed", "error": "Permission denied"}
except Exception as e:
    print(f"ERROR: Storage error: {e}")
    return {"status": "failed", "error": f"Storage error: {e}"}
```

## Troubleshooting

### Permission Denied

Credentials are not a Kubernetes secret to inspect — they arrive in the pod as the
`STORAGE_KWARGS_JSON` env var (see Credential Injection above). To debug:

```bash
# Confirm the pod actually received storage kwargs, and which credential_strategy it's using
kubectl exec -it {pod-name} -n nagelfluh-jobs -- printenv STORAGE_KWARGS_JSON CREDENTIAL_STRATEGY

# Test the credentials from inside the pod
kubectl exec -it {pod-name} -n nagelfluh-jobs -- python3 -c "
import fsspec, json, os
kwargs = json.loads(os.environ['STORAGE_KWARGS_JSON'])
fs = fsspec.filesystem(os.environ['STORAGE_BASE'].split('://')[0], **kwargs)
print(fs.ls('nagelfluh-project-{project_id}'))
"

# If credentials look wrong at the source, check the project's StorageBackend (as admin)
curl -H "Authorization: Bearer $TOKEN" https://localhost:8000/admin/storage-backends
```

### File Not Found

```bash
# List bucket contents (MinIO)
mc ls myminio/nagelfluh-project-{project_id}/

# Check if bucket exists
mc ls myminio/ | grep nagelfluh-project

# Verify path in logs
kubectl logs {pod-name} -n nagelfluh-jobs | grep "storage_base"
```

### Connection Errors

```bash
# MinIO is a NodePort (30900), published on the host by minikube's docker driver —
# check the mapping and that the pod is up
docker port minikube | grep 30900
kubectl get pods -n minio -l app=minio

# Test connection
curl -k https://localhost:9000/minio/health/live
```

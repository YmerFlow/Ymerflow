# Storage Architecture

YmerFlow uses a **per-project bucket** architecture with IAM-enforced security for dataset storage.

**Related documentation:**
- [Process Types](processes.md) - How process types use storage_context in their run() method
- [Environment](environment.md) - How storage credentials and configuration are injected into pods

## Storage Backends

### Development: MinIO
- S3-compatible object storage running in Minikube
- Automatic bucket/user/policy creation on project creation
- Credentials injected via Kubernetes secrets
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
        └── datasets/
            └── {dataset-id}/
                ├── root.msgpack        # Main dataset file
                ├── root.geojson        # Alternative format
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

- **`processes/{process-id}/datasets/{dataset-id}/`**: Process outputs
  - Written by process pods
  - Each process writes to its own directory
  - No overwrites possible (unique IDs per execution)
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

Credentials are injected into process pods via Kubernetes secrets:

```yaml
env:
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: project-{project_id}-storage
        key: access_key
  - name: AWS_SECRET_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: project-{project_id}-storage
        key: secret_key
  - name: STORAGE_BASE
    value: s3://nagelfluh-project-{project_id}
  - name: STORAGE_ENDPOINT
    value: http://minio.minio.svc.cluster.local:9000  # MinIO only
```

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

### Backend Configuration

Configure storage in `backend/config.py` or via environment variables:

```python
# config.py
STORAGE_PROTOCOL = os.getenv("STORAGE_PROTOCOL", "s3")  # s3, gcs, az, file
STORAGE_ENDPOINT = os.getenv("STORAGE_ENDPOINT", "")    # MinIO URL or empty
STORAGE_BUCKET_PREFIX = os.getenv("STORAGE_BUCKET_PREFIX", "nagelfluh-project-")
```

### Environment Variables

```bash
# .env file for development
STORAGE_PROTOCOL=s3
STORAGE_ENDPOINT=http://localhost:9000      # MinIO
STORAGE_BUCKET_PREFIX=nagelfluh-project-

# Production (GCS)
STORAGE_PROTOCOL=gcs
STORAGE_ENDPOINT=                            # Empty for cloud
STORAGE_BUCKET_PREFIX=nagelfluh-project-

# Production (S3)
STORAGE_PROTOCOL=s3
STORAGE_ENDPOINT=                            # Empty for AWS S3
STORAGE_BUCKET_PREFIX=nagelfluh-project-
```

## Automatic Bucket Provisioning

When a new project is created:

1. **Backend generates**:
   - Unique project ID
   - Bucket name: `{STORAGE_BUCKET_PREFIX}{project_id}`
   - Access credentials (MinIO) or service account (cloud)

2. **MinIO setup** (development):
   - Create bucket via MinIO API
   - Create dedicated user
   - Create IAM policy with path-based permissions
   - Attach policy to user
   - Store credentials in Kubernetes secret

3. **Cloud setup** (production):
   - Create GCS bucket with uniform access control
   - Create service account for project
   - Grant service account IAM roles on bucket
   - Configure Workload Identity binding

4. **Database record**:
   - Store project ID, bucket name, credential reference

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

```bash
# Check Kubernetes secret exists
kubectl get secret project-{project_id}-storage -n nagelfluh-jobs

# View secret contents
kubectl get secret project-{project_id}-storage -n nagelfluh-jobs -o yaml

# Test credentials from pod
kubectl exec -it {pod-name} -n nagelfluh-jobs -- python3 -c "
import fsspec, os
fs = fsspec.filesystem('s3',
    key=os.environ['AWS_ACCESS_KEY_ID'],
    secret=os.environ['AWS_SECRET_ACCESS_KEY'],
    client_kwargs={'endpoint_url': os.environ.get('STORAGE_ENDPOINT')})
print(fs.ls('nagelfluh-project-{project_id}'))
"
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

## Migration from Legacy Storage

Older YmerFlow versions used a shared `DATA_BASE_PATH`. To migrate:

1. **Identify datasets**: List all files under old `DATA_BASE_PATH`
2. **Group by project**: Determine which datasets belong to which projects
3. **Copy to new buckets**: Use `mc mirror` or `gsutil rsync`
4. **Update database**: Update `storage_path` in dataset records
5. **Verify access**: Test processes can read migrated datasets
6. **Remove old storage**: Clean up `DATA_BASE_PATH` after verification

See migration scripts in `backend/migrations/` for automated tools.

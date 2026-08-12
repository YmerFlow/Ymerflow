# Deployment Guide

This guide covers setting up YmerFlow for development and production environments.

## Prerequisites

- **Python**: 3.11 or higher
- **Node.js**: 16 or higher
- **Docker**: For building process runner images
- **Minikube**: For local Kubernetes development
- **kubectl**: Kubernetes command-line tool

## Deployment Modes

There are two ways to run YmerFlow, differing in where the backend, frontend, and database live:

| | Dev | Prod |
|---|---|---|
| Backend & frontend | Host machine | Kubernetes pods (inside Minikube) |
| Database | SQLite on host | PostgreSQL in Kubernetes |
| Process jobs | Kubernetes (Minikube) | Kubernetes (Minikube) |
| Storage | MinIO in Minikube | MinIO in Minikube |
| Start command | `./runall.sh` | `./runall.sh` |

## Ports

Ports published directly on the host — via minikube's docker driver
(`plugins/ymerflow-minikube`'s `minikube_vm.py`, `MINIKUBE_EXPOSE_PORTS`/`MINIKUBE_LISTEN_ADDRESS`)
unless noted otherwise — plus the host-process ports used only in dev mode. `docker port minikube`
shows the live mapping at any time.

| Host port | Service | Mode | Published via | Override | Notes |
|-----------|---------|------|----------------|----------|-------|
| 30080 | Frontend (nginx) | Prod only (Service exists only when `k8s/frontend/` is applied) | minikube NodePort → docker publish | `MINIKUBE_EXPOSE_PORTS` | Plain HTTP from nginx; proxies `/api`, `/pgadmin/`, `/headlamp/` |
| 30500 | Docker registry | Dev + Prod | minikube NodePort → docker publish | `MINIKUBE_EXPOSE_PORTS` | HTTPS (self-signed) + basic auth (`REGISTRY_USER`/`REGISTRY_PASSWORD`) |
| 9000 | MinIO API | Dev + Prod | minikube NodePort (30900) → docker publish, remapped to 9000 on the host | `MINIKUBE_EXPOSE_PORTS` | HTTPS (self-signed) + `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` |
| 9001 | MinIO console | Dev + Prod | minikube NodePort (30901) → docker publish, remapped to 9001 on the host | `MINIKUBE_EXPOSE_PORTS` | HTTPS (self-signed), same credentials as the API |
| 8443 | kube-apiserver | Dev + Prod | minikube's own docker publish (dynamic host port — check with `docker port minikube 8443`) | `MINIKUBE_APISERVER_IPS` adds the SAN needed for a remote kubeconfig to trust it | Not user-remappable via `MINIKUBE_EXPOSE_PORTS` |
| 8000 | Backend (FastAPI) | Dev only | host process (`./backend/run.sh`) | n/a | Not a Kubernetes port; direct `uvicorn --reload` |
| 3000 | Frontend dev server | Dev only | host process (`npm start`) | n/a | Not a Kubernetes port; CRA/webpack dev server |

`MINIKUBE_LISTEN_ADDRESS` (default `0.0.0.0`) controls which host interface(s) all
`MINIKUBE_EXPOSE_PORTS` entries — and, as a side effect, the apiserver — bind to. See
`config.env.example` for the full variable descriptions.

## Configuration

Before running for the first time, create `config.env` from the example:

```bash
cp config.env.example config.env
```

Key settings in `config.env`:

```bash
# development = backend/frontend on host, production = all services in-cluster (pods)
DEPLOYMENT=development

# Minikube resources
MINIKUBE_CPUS=4
MINIKUBE_MEMORY=8192

# Production only — public URL clients use to reach the app:
# SERVER_URL=http://192.168.1.100:30080

# Admin credentials for pgAdmin and the Kubernetes dashboard (production only).
# Used once on first run to create the nagelfluh-admin-secret K8s secret.
# ADMIN_USER=admin
# ADMIN_PASSWORD=password
```

`config.env` is gitignored and never committed.

### Pluggable backend bootstrap (registry / storage / cluster)

Three axes — the container registry, object storage, and the job-running cluster — are pluggable
backends (`RegistryBackend`/`StorageBackend`/`Cluster`, each dispatching to a protocol/provider
class). Their existing settings (`REGISTRY_USER`/`STORAGE_ENDPOINT`/etc., shown throughout this
guide) keep working unchanged and need no action — this section only applies if you want to
configure a **plugin-provided** protocol (e.g. Google Artifact Registry, GCS, GKE) from
`config.env` instead of the admin UI:

```bash
# REGISTRY_PROTOCOL=docker-v2
# REGISTRY_CONFIG_JSON={"user":"nagelfluh","password":"nagelfluh","host":"192.168.1.142","port":30500}

# STORAGE_PROTOCOL=s3
# STORAGE_CONFIG_JSON={...}

# CLUSTER_TYPE=kubeconfig
# CLUSTER_CONFIG_JSON={...}
```

If set, `backend/bin/yf-bootstrap-provision` runs before migrations (both `./runall.sh`
modes), resolves the named protocol/provider, and calls its `bootstrap(config)` hook — a no-op for
every core-shipped protocol, but a plugin's chance to do real provisioning (e.g. actually create a
cloud resource) before its enriched config gets seeded onto the default backend/cluster row. See
[Registry Architecture § Configuration](architecture/registry.md#configuration) for the full
mechanism and how it interacts with in-cluster migrations in production mode.

### Frontend-plugin build (npm source)

`build_frontend_plugin` Processes resolve a plugin's npm source from a **server-local directory
and/or the public npm registry**, chosen by `PLUGIN_NPM_SOURCE_MODE`. Relevant settings:

```bash
# Source resolution mode:
#   auto      (default) try the local source dir first, then the registry
#   local     local source dir ONLY — error if absent (offline / air-gapped / tests)
#   registry  npm registry ONLY — ignore the local dir
PLUGIN_NPM_SOURCE_MODE=auto

# Server-local directory the admin fills with plugin npm packages (used in auto/local mode): either
# packed tarballs from `npm pack` (`<scope-name>-<version>.tgz`) or unpacked source dirs.
# The build resolves name@version against this directory.
PLUGIN_NPM_SOURCE_DIR=/var/lib/nagelfluh/plugin-npm-source

# npm registry for the plugin source (registry/auto mode) AND the build toolchain / non-shared deps.
# Defaults to registry.npmjs.org; set to a private mirror for locked-down deployments.
# PLUGIN_NPM_REGISTRY=https://registry.npmjs.org/

# How the Kubernetes build pod mounts PLUGIN_NPM_SOURCE_DIR into its filesystem. The pod must see
# the admin-populated source dir at the same path or the build fails (PluginBuildError). One of:
#   ""/"none"  — no volume (local/dev only; the in-process/subprocess build path used by tests
#                reads the dir from the host filesystem directly, so no mount is needed)
#   "pvc"      — mount a PersistentVolumeClaim (set the claim name in ..._VOLUME_SOURCE)
#   "hostpath" — mount a host path (set the host path in ..._VOLUME_SOURCE)
# PLUGIN_NPM_SOURCE_VOLUME_TYPE=pvc
# PLUGIN_NPM_SOURCE_VOLUME_SOURCE=nagelfluh-plugin-npm-source
```

In a Kubernetes deployment, create a PVC (or host path) that holds the admin's plugin packages,
populate it, and point `PLUGIN_NPM_SOURCE_VOLUME_TYPE` / `PLUGIN_NPM_SOURCE_VOLUME_SOURCE` at it.
The orchestrator mounts it **read-only** at `PLUGIN_NPM_SOURCE_DIR` in every `build_frontend_plugin`
pod. For local/dev (and the `tests/test_plugin_install_flow.py` E2E test), leave the volume type
empty and run the build via `python -m ymerflow_plugin_build` (or the in-process path), which reads
`PLUGIN_NPM_SOURCE_DIR` from the local filesystem directly — no cluster required.

## Quick Start

### Dev Mode

Set `DEPLOYMENT=development` in `config.env` (the default), then:

```bash
./runall.sh
```

Open **http://localhost:3000**. The script starts Minikube, Kueue, MinIO, and the backend and frontend servers.

### Production-Minikube Mode

Set `DEPLOYMENT=production` in `config.env`, then:

```bash
./runall.sh
```

This is idempotent — safe to re-run after a reboot or upgrade. It handles Minikube, MinIO, PostgreSQL, image builds, and migrations automatically.

By default the app is exposed on port 30080 (the frontend NodePort, published directly on the
host by minikube's docker driver) of the host machine's primary IP (printed at the end of the
script). Clients on the network reach it at `http://<host-ip>:30080`.

| URL | Service |
|-----|---------|
| `http://<host-ip>:30080/` | Main application |
| `http://<host-ip>:30080/pgadmin/` | pgAdmin (PostgreSQL GUI) |
| `http://<host-ip>:30080/headlamp/` | Headlamp (Kubernetes / Kueue dashboard) |

#### After a reboot

```bash
./runall.sh   # re-run; it skips steps already done
```

## Manual Setup

If you prefer to set up components individually or troubleshoot issues:

### 1. Minikube, MinIO, and Docker Registry Setup

Minikube itself, MinIO, and the self-hosted docker-v2 registry are no longer stood up by
dedicated shell scripts — they're provisioned by `plugins/ymerflow-minikube`'s `bootstrap()` hooks
(`MinikubeClusterProvider`/`MinioProtocolHandler`/`DockerV2ProtocolHandler`), the same generic
mechanism a cloud plugin (e.g. `plugins/ymerflow-gcp`'s GKE/GCS/GAR) uses. See
`docs/plans/minikube-provisioning-plugin.md` and [Registry
Architecture](architecture/registry.md).

Prerequisites:
1. Clone the plugin's own repo into `plugins/ymerflow-minikube` (like every other backend
   plugin — `plugins/` is gitignored):
   ```bash
   mkdir -p plugins
   git clone <ymerflow-minikube repo URL> plugins/ymerflow-minikube
   ```
2. `config.env` needs `BACKEND_PLUGINS` to include it and `CLUSTER_TYPE=minikube`/
   `STORAGE_PROTOCOL=minio`/`REGISTRY_PROTOCOL=docker-v2` (with `*_CONFIG_JSON={}`) —
   `config.env.example` already defaults to this, so a plain `cp config.env.example config.env`
   is enough unless you're overriding it.

Then run bootstrap-provision directly (this is exactly what `dev/runall.sh`/
`prod/runall-production.sh` call as one of their own steps — see those scripts):

```bash
source env/bin/activate   # backend + BACKEND_PLUGINS must already be pip-installed
set -a; source config.env; set +a
PYTHONPATH=. python backend/bin/yf-bootstrap-provision
```

This:
- Starts Minikube with CPU/RAM/disk from `MINIKUBE_CPUS`/`MINIKUBE_MEMORY`/`MINIKUBE_DISK_SIZE` in
  `config.env` (defaults: 4 CPUs, 16 GB, 30 GB), publishes the required host ports, and mounts
  `NAGELFLUH_DATA_DIR` for persistent storage
- Creates the `nagelfluh-jobs` namespace
- Applies the cluster-scoped `nagelfluh-postgres` PersistentVolume (5Gi, hostPath-backed on
  Minikube; a zonal GCE persistent disk + CSI PV on GKE) that `k8s/postgres/statefulset.yaml`'s
  `data-postgres-0` PVC binds to — see
  [Postgres PV per cluster provider](plans/done/postgres-pv-per-cluster-provider.md)
- Deploys MinIO (namespace `minio`, self-signed TLS, 10Gi hostPath-backed PV) and the docker-v2
  registry (namespace `registry`, self-signed TLS, htpasswd auth)
- Is fully idempotent — safe to run multiple times; growing the disk size refuses rather than
  silently deleting the VM (set `MINIKUBE_ALLOW_RECREATE=1` to allow it — see Design decision 4 in
  the plan above)

Installing Kueue, applying its queue/quota configuration, and applying the backend's RBAC still
don't happen here — they're done by the backend itself, automatically, the first time a `Cluster`
row becomes active (for the local default cluster, that's during the database migration step
below). See [System Overview § Kueue Configuration](architecture/overview.md#kueue-configuration).
Run `env/bin/python backend/bin/yf-migrate` (step 4 below) after this to finish
provisioning Kueue for the local cluster.

**Verify installation:**

```bash
# Check Minikube status
minikube status

# Check Kueue installation
kubectl get crd | grep kueue

# Check namespace
kubectl get ns nagelfluh-jobs

# Check queues
kubectl get localqueue -n nagelfluh-jobs
kubectl get clusterqueue

# Check MinIO / registry pods
kubectl get pods -n minio
kubectl get pods -n registry
```

**If setup fails:**

```bash
# Clean up and start over
./dev/cleanup-all.sh
PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision
```

### 2. MinIO Storage

MinIO itself was deployed in step 1 above (`plugins/ymerflow-minikube`'s
`MinioProtocolHandler.bootstrap()`). `STORAGE_PROTOCOL`/`STORAGE_ENDPOINT` in `config.env` no
longer need to be set by hand for the local stack — the default `STORAGE_PROTOCOL=minio` plus
`STORAGE_CONFIG_JSON={}` (already the `config.env.example` default) is enough; the seed migration
picks up MinIO's actual root credentials from bootstrap-provision's output automatically.

**Verify MinIO:**

```bash
# Check MinIO pods
kubectl get pods -n minio

# mc alias set is no longer done for you by a setup script — do it once yourself
mc --insecure alias set myminio https://localhost:9000 "${MINIO_ROOT_USER:-minioadmin}" "${MINIO_ROOT_PASSWORD:-minioadmin}"

# Test connection
mc --insecure admin info myminio

# List buckets (should be empty initially)
mc --insecure ls myminio/
```

**Automatic Per-Project Storage:**

When you create a project in the UI, the backend automatically:

1. Creates MinIO bucket: `nagelfluh-project-{project-id}`
2. Creates MinIO user: `project-{project-id}` with generated password
3. Creates IAM policy with scoped permissions:
   - **READ**: `uploads/*` and `processes/*/datasets/*` (all data in project)
   - **WRITE**: `processes/*` (can write process outputs)
   - **LIST**: Bucket listing
4. Attaches policy to user
5. Creates Kubernetes secret: `project-{project-id}-storage` with credentials
6. Process pods automatically receive injected credentials

**No manual bucket or user creation needed!**

**Example IAM policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::nagelfluh-project-{id}/uploads/*",
        "arn:aws:s3:::nagelfluh-project-{id}/processes/*/datasets/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": ["arn:aws:s3:::nagelfluh-project-{id}/processes/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::nagelfluh-project-{id}"]
    }
  ]
}
```

### 3. Build Docker Images

Build the base runner image that executes processes:

```bash
./docker/build.sh
```

To build and register a **named environment** (after modifying process types in `docker/base-runner/`):

```bash
./docker/build.sh "My Environment Name"
```

`build.sh` reads `DEPLOYMENT` from `config.env` automatically. In prod mode the database update runs as a Kubernetes Job so `build.sh` never needs direct database access. The environment then appears in the UI's environment selector.

This builds the image directly in Minikube's Docker daemon:
- Based on Python 3.11 slim
- Includes process runner script
- Contains fake process implementations (fft, inversion, etc.)
- Includes process type schemas

**Verify build:**

```bash
# Switch to Minikube's Docker daemon
eval $(minikube docker-env)

# List images
docker images | grep nagelfluh

# You should see: nagelfluh-base-runner:latest
```

### 4. Backend Setup

Install Python dependencies and start the backend:

```bash
# Install the backend package, editable (from project root)
pip install -e .

# Download MinIO client for bucket management
wget https://dl.min.io/client/mc/release/linux-amd64/mc -O env/bin/minio-client
chmod +x env/bin/minio-client

# Run database migrations (creates tables and default environment)
env/bin/python backend/bin/yf-migrate

# Start backend server
./backend/run.sh
```

Backend runs on http://localhost:8000

**Verify backend:**

```bash
# Check health endpoint
curl http://localhost:8000/

# Check API docs
open http://localhost:8000/docs

# List process types
curl http://localhost:8000/process-types
```

### 5. Frontend Setup

Install Node.js dependencies and start development server:

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm start
```

Frontend runs on http://localhost:3000

**Verify frontend:**

Open browser to http://localhost:3000 and verify:
- UI loads without errors
- Can see "Select Environment" dropdown
- Console shows no errors

## After Minikube Restart

### Normal Restart (`minikube stop` → `minikube start`)

Everything persists — MinIO is reachable at `https://localhost:9000` again as soon as minikube is
back up (it's a NodePort published on the host by minikube's docker driver, not a port-forward).

### Full Reset (`minikube delete`)

VM-local data is lost (Postgres/MinIO/registry data itself survives via the `NAGELFLUH_DATA_DIR`
host bind-mount). Run full setup again — simplest is just `./dev/runall.sh`, or individually:

```bash
PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision
./docker/build.sh
env/bin/python backend/bin/yf-migrate
```

## Production Deployment

### Cloud Storage

#### Google Cloud Storage (GCS)

For production deployments on GCP, use per-project GCS buckets with Workload Identity.

**1. Create GCS bucket per project:**

```bash
PROJECT_ID="abc123"
BUCKET_NAME="nagelfluh-project-${PROJECT_ID}"
GCP_PROJECT="your-gcp-project"
REGION="us-central1"

# Create bucket
gsutil mb -p ${GCP_PROJECT} -l ${REGION} gs://${BUCKET_NAME}

# Enable versioning (optional, for audit trail)
gsutil versioning set on gs://${BUCKET_NAME}
```

**2. Create service account per process (or reuse per project):**

```bash
PROCESS_ID="process-xyz789"
SA_NAME="nagelfluh-process-${PROCESS_ID}"

gcloud iam service-accounts create ${SA_NAME} \
  --project=${GCP_PROJECT} \
  --display-name="YmerFlow Process ${PROCESS_ID}"
```

**3. Grant scoped IAM permissions:**

Read access to uploads and datasets:

```bash
gcloud storage buckets add-iam-policy-binding gs://${BUCKET_NAME} \
  --member="serviceAccount:${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer" \
  --condition='expression=resource.name.startsWith("projects/_/buckets/'${BUCKET_NAME}'/objects/uploads/") || resource.name.startsWith("projects/_/buckets/'${BUCKET_NAME}'/objects/processes/"),title=read-access'
```

Write access to process directory only:

```bash
gcloud storage buckets add-iam-policy-binding gs://${BUCKET_NAME} \
  --member="serviceAccount:${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator" \
  --condition='expression=resource.name.startsWith("projects/_/buckets/'${BUCKET_NAME}'/objects/processes/'${PROCESS_ID}'/"),title=write-access'
```

**4. Configure Workload Identity:**

```bash
K8S_SA_NAME="process-${PROCESS_ID}"
K8S_NAMESPACE="nagelfluh-jobs"

# Create k8s service account
kubectl create serviceaccount ${K8S_SA_NAME} -n ${K8S_NAMESPACE}

# Annotate k8s SA with GCP SA
kubectl annotate serviceaccount ${K8S_SA_NAME} \
  -n ${K8S_NAMESPACE} \
  iam.gke.io/gcp-service-account=${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com

# Allow k8s SA to impersonate GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  ${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:${GCP_PROJECT}.svc.id.goog[${K8S_NAMESPACE}/${K8S_SA_NAME}]"
```

**5. Update backend configuration:**

```bash
STORAGE_PROTOCOL=gcs
STORAGE_ENDPOINT=              # Empty for GCS
STORAGE_BUCKET_PREFIX=nagelfluh-project-
```

Pods will automatically use Workload Identity - no explicit credentials needed.

#### AWS S3

For production deployments on AWS, use per-project S3 buckets with IRSA (IAM Roles for Service Accounts).

**1. Create S3 bucket per project:**

```bash
PROJECT_ID="abc123"
BUCKET_NAME="nagelfluh-project-${PROJECT_ID}"
AWS_REGION="us-east-1"

# Create bucket
aws s3 mb s3://${BUCKET_NAME} --region ${AWS_REGION}

# Enable versioning (optional)
aws s3api put-bucket-versioning \
  --bucket ${BUCKET_NAME} \
  --versioning-configuration Status=Enabled
```

**2. Create IAM policy with scoped permissions:**

```bash
POLICY_NAME="nagelfluh-project-${PROJECT_ID}-policy"

cat > /tmp/policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}/uploads/*",
        "arn:aws:s3:::${BUCKET_NAME}/processes/*/datasets/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": ["arn:aws:s3:::${BUCKET_NAME}/processes/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET_NAME}"]
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name ${POLICY_NAME} \
  --policy-document file:///tmp/policy.json
```

**3. Create IAM role with IRSA:**

```bash
PROCESS_ID="process-xyz789"
CLUSTER_NAME="nagelfluh-cluster"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$(aws eks describe-cluster --name ${CLUSTER_NAME} \
  --query "cluster.identity.oidc.issuer" --output text | sed -e "s/^https:\/\///")

# Create trust policy
cat > /tmp/trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:nagelfluh-jobs:process-${PROCESS_ID}"
        }
      }
    }
  ]
}
EOF

# Create IAM role
aws iam create-role \
  --role-name nagelfluh-process-${PROCESS_ID} \
  --assume-role-policy-document file:///tmp/trust-policy.json

# Attach policy to role
aws iam attach-role-policy \
  --role-name nagelfluh-process-${PROCESS_ID} \
  --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${POLICY_NAME}
```

**4. Configure Kubernetes service account:**

```bash
kubectl create serviceaccount process-${PROCESS_ID} -n nagelfluh-jobs

kubectl annotate serviceaccount process-${PROCESS_ID} \
  -n nagelfluh-jobs \
  eks.amazonaws.com/role-arn=arn:aws:iam::${AWS_ACCOUNT_ID}:role/nagelfluh-process-${PROCESS_ID}
```

**5. Update backend configuration:**

```bash
STORAGE_PROTOCOL=s3
STORAGE_ENDPOINT=              # Empty for AWS S3
STORAGE_BUCKET_PREFIX=nagelfluh-project-
```

Pods will automatically use IRSA - no explicit credentials needed.

### Kubernetes Cluster

Once either cluster below exists and you register it with YmerFlow (Admin → Clusters → Add
Cluster, or the self-service registration flow for a supported `cluster_type`), the backend
installs Kueue (currently v0.16.4), sizes and applies its queue/quota configuration from the
cluster's real node capacity, and applies the required RBAC automatically — see [System Overview §
Kueue Configuration](architecture/overview.md#kueue-configuration). None of that needs to be done
manually; the steps below only create the raw Kubernetes cluster itself.

#### GKE (Google Kubernetes Engine)

```bash
# Create cluster
gcloud container clusters create nagelfluh \
  --region=$REGION \
  --num-nodes=3 \
  --machine-type=n1-standard-4 \
  --enable-autoscaling \
  --min-nodes=1 \
  --max-nodes=10 \
  --workload-pool=$GCP_PROJECT.svc.id.goog
```

#### EKS (Amazon Elastic Kubernetes Service)

```bash
# Create cluster
eksctl create cluster \
  --name nagelfluh \
  --region=$REGION \
  --nodegroup-name standard-workers \
  --node-type m5.xlarge \
  --nodes 3 \
  --nodes-min 1 \
  --nodes-max 10
```

Register the resulting cluster's kubeconfig with YmerFlow (Admin → Clusters); Kueue/RBAC
provisioning happens automatically once it connects successfully.
kubectl create namespace nagelfluh-jobs
kubectl apply -f k8s/kueue-config.yaml
```

### Database

#### PostgreSQL Setup

For production, use PostgreSQL instead of SQLite:

1. **Install PostgreSQL:**

```bash
# GKE using Cloud SQL
gcloud sql instances create nagelfluh-db \
  --tier=db-f1-micro \
  --region=$REGION

gcloud sql databases create nagelfluh \
  --instance=nagelfluh-db

# Create user
gcloud sql users create nagelfluh \
  --instance=nagelfluh-db \
  --password=<secure-password>
```

2. **Update backend configuration:**

```bash
DATABASE_URL=postgresql://nagelfluh:<password>@<db-host>:5432/nagelfluh
```

3. **Run migrations:**

```bash
env/bin/python backend/bin/yf-migrate
```

### Backend Deployment

#### Docker Image

```dockerfile
# backend/Dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Build and push:

```bash
docker build -t gcr.io/$GCP_PROJECT/ymerflow-backend:latest backend/
docker push gcr.io/$GCP_PROJECT/ymerflow-backend:latest
```

#### Kubernetes Deployment

```yaml
# k8s/backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ymerflow-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ymerflow-backend
  template:
    metadata:
      labels:
        app: ymerflow-backend
    spec:
      containers:
      - name: backend
        image: gcr.io/$GCP_PROJECT/ymerflow-backend:latest
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: nagelfluh-secrets
              key: database-url
        - name: STORAGE_PROTOCOL
          value: "gcs"
        - name: STORAGE_BUCKET_PREFIX
          value: "nagelfluh-project-"
```

Apply:

```bash
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml
```

### Frontend Deployment

#### Build Production Bundle

```bash
cd frontend
npm run build
```

#### Serve with Nginx

```dockerfile
# frontend/Dockerfile
FROM node:16 as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

Build and deploy:

```bash
docker build -t gcr.io/$GCP_PROJECT/nagelfluh-frontend:latest frontend/
docker push gcr.io/$GCP_PROJECT/nagelfluh-frontend:latest
kubectl apply -f k8s/frontend-deployment.yaml
```

## Admin Tools (production only)

In production mode, two web-based admin GUIs are deployed automatically and proxied by the nginx frontend pod.

### Architecture

```
Browser → nginx (frontend pod)
            /pgadmin/  → pgadmin pod (nagelfluh ns, port 80)
            /headlamp/ → headlamp pod (headlamp ns, port 4466)
```

Both paths are protected by nginx HTTP basic auth. The credentials are stored in the `nagelfluh-admin-secret` Kubernetes secret (key: `htpasswd`), which is mounted into the frontend pod at `/etc/nginx/htpasswd/admin.htpasswd`.

### pgAdmin

| | |
|---|---|
| URL | `<SERVER_URL>/pgadmin/` |
| Login | `<ADMIN_USER>@localhost` / `<ADMIN_PASSWORD>` |
| Image | `dpage/pgadmin4:latest` |
| Namespace | `nagelfluh` |

The YmerFlow PostgreSQL server (`postgres.nagelfluh.svc.cluster.local:5432`) is pre-configured via a mounted `servers.json` ConfigMap. On first connection you will be prompted for the database password (`nagelfluhpass`).

pgAdmin is configured with `SCRIPT_NAME=/pgadmin` so it generates correct URLs when sitting behind the nginx subpath proxy.

### Headlamp (Kubernetes / Kueue dashboard)

| | |
|---|---|
| URL | `<SERVER_URL>/headlamp/` |
| Login | nginx basic auth only — `<ADMIN_USER>` / `<ADMIN_PASSWORD>` |
| Image | `ghcr.io/headlamp-k8s/headlamp:latest` |
| Namespace | `headlamp` |

Headlamp runs in-cluster with a `cluster-admin` ClusterRoleBinding, so it can display all resources including Kueue `ClusterQueue`, `LocalQueue`, and `Workload` objects. It is started with `--base-url /headlamp` for subpath compatibility.

### Credentials

Credentials are read from `config.env` and written into a K8s secret once on first run:

```bash
# config.env
ADMIN_USER=admin        # default
ADMIN_PASSWORD=password # default — change this in production
```

To rotate credentials after the secret has been created:

```bash
kubectl delete secret nagelfluh-admin-secret -n nagelfluh
# Update ADMIN_USER / ADMIN_PASSWORD in config.env, then:
./runall.sh
```

### Kubernetes manifests

| File | Purpose |
|------|---------|
| `k8s/pgadmin/deployment.yaml` | pgAdmin pod |
| `k8s/pgadmin/service.yaml` | ClusterIP service |
| `k8s/pgadmin/servers-configmap.yaml` | Pre-configured PostgreSQL connection |
| `k8s/headlamp/rbac.yaml` | ServiceAccount + ClusterRoleBinding |
| `k8s/headlamp/deployment.yaml` | Headlamp pod |
| `k8s/headlamp/service.yaml` | ClusterIP service |

## Troubleshooting

### Minikube Issues

**Minikube won't start:**

```bash
# Delete and recreate
minikube delete
minikube start --cpus=4 --memory=8192
```

**Kueue installation fails ("metadata.annotations: Too long"):**

```bash
# Fixed using server-side apply
./dev/cleanup-all.sh
PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision
```

### MinIO Issues

**Not reachable on localhost:9000:**

MinIO is a NodePort (30900), published on the host by minikube's docker driver — not a
port-forward. Check the mapping:

```bash
docker port minikube | grep 30900
```

If it's missing, re-run bootstrap-provision — `MinikubeClusterProvider.bootstrap()`
(`plugins/ymerflow-minikube`) detects the missing publish and recreates minikube (data is
preserved via the `NAGELFLUH_DATA_DIR` host bind-mount):

```bash
PYTHONPATH=. env/bin/python backend/bin/yf-bootstrap-provision
```

**MinIO pods not running:**

```bash
# Check logs
kubectl logs -n minio -l app=minio

# Restart deployment
kubectl rollout restart deployment/minio -n minio
```

**Connection refused:**

```bash
# Verify MinIO service and NodePort
kubectl get svc -n minio
```

### Job Not Starting

**Check Kueue workload:**

```bash
kubectl get workloads -n nagelfluh-jobs
kubectl describe workload <workload-name> -n nagelfluh-jobs
```

**Check events:**

```bash
kubectl get events -n nagelfluh-jobs --sort-by='.lastTimestamp'
```

**Check job:**

```bash
kubectl describe job <job-name> -n nagelfluh-jobs
```

### Image Pull Errors

**Verify image exists:**

```bash
eval $(minikube docker-env)
docker images | grep nagelfluh
```

**Rebuild if missing:**

```bash
./docker/build.sh
```

### Backend Connection Issues

**Check Kubernetes connectivity:**

```bash
kubectl cluster-info
kubectl get nodes
```

**Verify kubeconfig:**

```bash
export KUBECONFIG=~/.kube/config
kubectl config current-context
```

### Storage Permission Errors

**Check Kubernetes secret:**

```bash
kubectl get secret project-<project-id>-storage -n nagelfluh-jobs -o yaml
```

**Test storage access:**

```bash
kubectl exec -it <pod-name> -n nagelfluh-jobs -- python3 -c "
import fsspec, os
fs = fsspec.filesystem('s3',
    key=os.environ['AWS_ACCESS_KEY_ID'],
    secret=os.environ['AWS_SECRET_ACCESS_KEY'],
    client_kwargs={'endpoint_url': os.environ.get('STORAGE_ENDPOINT')})
print(fs.ls('nagelfluh-project-<project-id>'))
"
```

**Verify MinIO user/policy:**

```bash
mc admin user info myminio project-<project-id>
mc admin policy entities myminio project-<project-id>-policy
```

### Database Migration Errors

**Check migration status:**

```bash
alembic -c backend/alembic.ini current
alembic -c backend/alembic.ini history
```

**Reset database (DANGER - loses all data):**

```bash
rm backend/nagelfluh.db
env/bin/python backend/bin/yf-migrate
```

**Rollback migration:**

```bash
alembic -c backend/alembic.ini downgrade -1
```

## Monitoring

### View Logs

**Backend logs:**

```bash
# If running with run.sh
tail -f backend/logs/uvicorn.log

# If in Kubernetes
kubectl logs -f deployment/ymerflow-backend
```

**Frontend logs:**

```bash
# Development server
# Logs appear in terminal where npm start was run

# Production (nginx)
kubectl logs -f deployment/nagelfluh-frontend
```

**Process pod logs:**

```bash
# Find pod
kubectl get pods -n nagelfluh-jobs

# Stream logs
kubectl logs -f <pod-name> -n nagelfluh-jobs
```

### Resource Usage

**Cluster resources:**

```bash
kubectl top nodes
kubectl top pods -n nagelfluh-jobs
```

**Storage usage:**

```bash
# MinIO
mc du myminio/

# GCS
gsutil du -s gs://nagelfluh-project-*
```

## Cleanup

### Stop All Services

```bash
./dev/stop-all.sh
```

### Clean Up Minikube

```bash
# Remove YmerFlow resources only
./dev/cleanup-all.sh

# Complete cluster deletion
minikube delete
```

### Clean Up Database

```bash
# Remove SQLite database
rm backend/nagelfluh.db

# Recreate tables
env/bin/python backend/bin/yf-migrate
```

# Container Registry Architecture

Nagelfluh pulls/pushes process-runner images through a **pluggable registry backend** — the same
pattern used for [object storage](storage.md) (`StorageBackend`/`StorageProtocolHandler`) and
multi-cluster job execution (`Cluster`/`ClusterProvider`). Unlike storage (one backend per
project), there is exactly **one active registry backend**, used app-wide: every cluster pulls
runner images from the same place `docker/build.sh` pushed them to.

**Related documentation:**
- [Storage Architecture](storage.md) — the sibling pluggable-backend axis; the registry axis
  mirrors its shape closely
- [Environment](environment.md) — how a Docker image becomes an Environment's `docker_image`
- Plugin SDK: [`RegistryProtocolHandler` reference](../plugin-sdk/overview.md) (full method
  signatures live in the SDK repo's `docs/backend-hooks.md`)

## Development: self-hosted Docker Registry v2

Core ships **no** registry protocol of its own. The self-hosted [Docker Registry
v2](https://docs.docker.com/registry/) stack (`docker-v2` protocol) lives entirely in the
`plugins/ymerflow-minikube` plugin, alongside the local Minikube cluster type and MinIO storage
protocol it also ships — see [Storage Architecture](storage.md#development-self-hosted-minio) and
`docs/plans/minikube-provisioning-plugin.md`. `DockerV2ProtocolHandler.bootstrap()`
(`minikube_plugin/registry_protocol.py`) deploys it into the local Minikube:
- Namespace `registry`, NodePort 30500, self-signed TLS, htpasswd basic auth
  (`REGISTRY_USER`/`REGISTRY_PASSWORD` in `config.env`, both default to `nagelfluh`)
- Reachable at `<REGISTRY_PUBLIC_HOST>:30500` from every cluster (local or remote) — there is no
  per-cluster registry address, matching the "one global registry" model above

`docker-v2` is a normal plugin-provided protocol like any other (e.g. Google Artifact Registry,
`gar`, from `plugins/ymerflow-gcp`) — a stock checkout with no backend plugins installed has no
registry option at all. `dev/runall.sh`/`prod/runall-production.sh` default `BACKEND_PLUGINS` to
include `plugins/ymerflow-minikube` and `REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON` to select
`docker-v2`, so a stock local deployment gets this registry automatically — but that plugin's own
repo must be cloned into `plugins/ymerflow-minikube` first (`plugins/` is gitignored, like every
other backend plugin).

## The `RegistryBackend` model

`backend/models/registry_backend.py`:

```python
class RegistryBackend(Base):
    id: str
    name: str
    protocol: str        # "docker-v2", or a plugin-provided value (e.g. "gar")
    config: dict          # JSON column, opaque — shape is entirely protocol-specific
    active: bool
    sort_order: int
```

`get_default_registry_backend_id(db)` resolves the app-wide registry: the first `active=True` row
ordered by `sort_order`. `docker-v2`'s `config` shape is `{"user", "password", "host", "port"}`.

## `RegistryProtocolHandler`

`backend/services/registry_protocols/` (`__init__.py` — the ABC + `registry_protocol_handlers`
hook only; core has no implementation of its own anymore) defines these methods. See
`plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py` (`docker-v2`) for a reference
implementation.

| Method | Sync/async | Purpose |
|---|---|---|
| `image_url(config, repository, tag)` | sync | The single place address *shape* is decided — `docker-v2` returns `host:port/repository:tag` |
| `pull_credentials(config)` | async | Resolve a pod image-pull credential: `{"username", "password", "expires_at"}` |
| `push_image(local_ref, config, repository, tag)` | sync | Push a locally-built image; owns its own auth/TLS; returns the full pushed ref |
| `configure_push_auth(config)` | sync | Optional local `docker login`/credential-helper setup a handler's own `push_image()` may use internally |
| `test_connection(config)` | async | Validate connectivity/credentials, no side effects |
| `bootstrap(config)` | sync | config.env-driven provisioning hook — see [Configuration](#configuration) below |
| `teardown(config)` | sync | Remove what `bootstrap()` created (default no-op) — see [Configuration](#configuration) below |

Handlers are discovered via the `registry_protocol_handlers` fan-out hook (the same
`nagelfluh.hooks` mechanism as `storage_protocol_handlers`/`cluster_provider_handlers`) — every
protocol, including `docker-v2`, is plugin-provided through this exact channel, with no "core is
special" path. See the plugin SDK's `docs/backend-hooks.md` for the full reference plugin authors
use to add a new protocol.

## Build + push flow

`docker/build.sh` no longer hardcodes any registry address or credentials, and never builds
against `minikube docker-env` — builds always run on the host's own Docker daemon. It shells out
to a single generic entry point, used identically for the backend, frontend, and process-runner
images:

```
backend/bin/yf-build-and-push <dockerfile> <build-context> <repository> <tag> [docker build args...]
```

which:
1. `docker build`s the image on the host daemon,
2. loads the active `RegistryBackend` row (or reads a pre-resolved one from
   `NAGELFLUH_RESOLVED_REGISTRY_JSON`, for the production split where Postgres is only reachable
   in-cluster),
3. resolves its `RegistryProtocolHandler`,
4. calls `handler.push_image(local_ref, config, repository, tag)` — which owns its own auth/TLS,
   pushes, and returns the full resolved image reference (`docker-v2` does a daemonless `crane
   push --insecure` to cope with its self-signed cert, so no host `docker login` is involved; a
   managed registry could just `docker push`),
5. prints only that resolved reference to stdout.

`build.sh` captures that output for the schema-extraction/DB-update step. Core only ever exercises
this with `docker-v2`; any other protocol's build/push mechanics are that plugin's concern.

## Pull flow: per-Job ephemeral credentials

Rather than a single long-lived registry pull Secret synced into every cluster's jobs namespace
(the old model), each process Job's pull credential is minted **fresh, at Job-creation time**:

1. `ProcessVersion.run_task()` (`backend/models/process.py`) resolves the active
   `RegistryBackend`, its handler, and calls `await handler.pull_credentials(config)`.
2. `job_orchestrator.create_job()` (`backend/services/job_orchestrator.py`) builds a per-Job
   `kubernetes.io/dockerconfigjson` Secret (named `<job-name>-registry-pull`) from that
   credential, keyed under the registry's `host:port` (matching what's actually embedded in the
   pod's image reference).
3. The Job is created first; the Secret is then created **owned by the Job**
   (`ownerReferences` pointing at the Job's UID), so Kubernetes garbage-collects it automatically
   whenever the Job itself is deleted (its own `ttl_seconds_after_finished` cleanup, or an
   explicit kill) — a Job's pull credential is never older than the Job.

This works uniformly for every protocol: `docker-v2`'s static credential just means
`expires_at=None` (never refresh, reuse the value minted at Job launch); a protocol with genuinely
short-lived pull tokens returns a real expiry, though nothing currently re-mints mid-Job on
expiry — `pull_credentials()` is only ever called once, at Job-creation time.

There is no longer a static, namespace-wide `nagelfluh-registry-pull` Secret provisioned by
`plugins/ymerflow-minikube`'s provision-nagelfluh-jobs.sh — that step was removed entirely.

## Configuration

### `config.env`

```bash
# Defaults are turnkey (nagelfluh/nagelfluh); change on any host exposed off a trusted LAN.
REGISTRY_USER=nagelfluh
REGISTRY_PASSWORD=nagelfluh
REGISTRY_PUBLIC_HOST=192.168.1.142   # required for remote-cluster registration; see below
```

These are consumed by a one-time Alembic seed migration
(`backend/alembic/versions/50dd9ce3311b_add_registry_backends_table.py`) that seeds the default
`RegistryBackend` row on first migrate — same "seed once, never re-touch on redeploy" model as
`StorageBackend`/`Cluster`.

### Opting a protocol into `bootstrap()`

All three pluggable axes share one more config.env-driven mechanism, for protocols/providers that
need **live provisioning** (not just persisting static config values) before their default row
is seeded — e.g. `plugins/ymerflow-minikube`'s `docker-v2`/`minio`/`minikube` deploying the local
self-hosted stack, or `plugins/ymerflow-gcp`'s `gar` registry protocol creating an Artifact
Registry repository. This is opt-in per axis, but a stock local deployment opts into all three by
default (see `config.env.example`):

```bash
REGISTRY_PROTOCOL=docker-v2
REGISTRY_CONFIG_JSON={}

STORAGE_PROTOCOL=minio
STORAGE_CONFIG_JSON={}

CLUSTER_TYPE=minikube
CLUSTER_CONFIG_JSON={}
```

`backend/bin/yf-bootstrap-provision` (run before migrations in both `dev/runall.sh` and
`prod/runall-production.sh`) resolves the matching handler/provider and calls `.bootstrap(config)`;
the enriched `{protocol, config}` result is what the generic seed migrations (`9623bab8493d` for
storage, `d1266f2f6e68` for cluster, `50dd9ce3311b` for registry) persist onto the default row.
Every one of `plugins/ymerflow-minikube`'s three `bootstrap()`s is idempotent (a no-op once
already provisioned) and internally makes sure the local Minikube VM is up first
(`minikube_plugin.minikube_vm.ensure_minikube_running()`), regardless of which axis happens to run
first. In `prod/runall-production.sh`, since `yf-bootstrap-provision` needs the full backend
Python environment plus control of the host's own Minikube/Docker, it's run host-side via a
one-off `docker run` against the freshly built backend image — with the host's Docker socket,
`~/.minikube`, `~/.kube`, and `NAGELFLUH_DATA_DIR` bind-mounted and `--network host` (see
`docs/plans/minikube-provisioning-plugin.md`, Design decision 2) — and its output is folded into
`nagelfluh-backend-secret`/`ymerflow-backend-config`, which the in-cluster `alembic-migrate` Job
also receives via `envFrom`.

See `docs/plans/done/registry-backend-hooks.md` for the full design history and rationale, and the
plugin SDK's `docs/backend-hooks.md` for how a plugin implements `bootstrap()` on its own
protocol/provider.

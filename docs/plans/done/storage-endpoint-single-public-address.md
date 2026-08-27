# Storage endpoint: one configured public address, used everywhere

## Goal

A project's MinIO `StorageBackend` must be addressed by **one configured, externally-reachable
endpoint** — the same URL from the backend host, from local-cluster job pods, and from
remote-cluster job pods. No endpoint rewriting, no per-cluster branching, no `for_pod` variant.

This is the operational requirement already stated in
[docs/plans/done/multi-cluster-execution.md](done/multi-cluster-execution.md) (lines 61–70):

> Storage stays exactly as decoupled as the dependency plan leaves it … **every cluster that can
> run a project's jobs must have network+DNS reachability to that project's storage endpoint.** For
> self-hosted MinIO … MinIO needs a stable externally-reachable endpoint.

That endpoint already exists in prod: `https://s3.ymerflow.earth` — the frontend nginx Let's Encrypt
edge (`frontend/40-tls.sh:119`) proxying to the in-cluster MinIO Service. It has a real cert and is
reachable from any cluster. We were simply not pointing storage at it.

## The bug this fixes

A job routed to the AKS cluster fails with `Name or service not known` for
`minio.minio.svc.cluster.local:9000` — an in-cluster DNS name that only resolves on the minikube
cluster where MinIO runs. Root cause: the default MinIO backend is addressed by its in-cluster
Service name, and the code even contains machinery (`_pod_endpoint`, `public_endpoint`, `for_pod`)
that assumes pods live in MinIO's own cluster. That assumption is exactly what breaks multi-cluster.

## What is split-brain and must be deleted (not added to)

- `plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`
  - `_pod_endpoint()` — the `localhost:9000 → *.svc.cluster.local:9000` rewrite. **Delete.**
  - `MinioProtocolHandler.fsspec_kwargs` — the `public_endpoint` / `for_pod` branch. Reduce to
    `endpoint = backend.config["endpoint"]`, unconditionally.
- `backend/services/storage_protocols/__init__.py` — remove the `for_pod` parameter from the
  `fsspec_kwargs` interface and its docstring. It exists only to support the rewrite above; once
  that's gone, GCP and Azure already ignore it (both say "`for_pod` makes no difference"), and the
  base/S3 stub ignore it too. Removing it is part of "no special casing," not a separate change.
- Update the two call sites that pass `for_pod=True`:
  `backend/models/process.py:897` and `backend/routers/internal.py:81`.
- Update the other handlers' signatures to drop the param:
  `backend/services/storage_protocols/s3.py`, `plugins/ymerflow-gcp/.../storage_protocol.py`,
  `plugins/ymerflow-azure/.../storage_protocol.py`.

## Configuration — point storage at the public name

- `prod/runall-production.sh`
  - `STORAGE_ENDPOINT` default (line ~366) → the configured public S3 host (`PUBLIC_TLS_S3_HOST`,
    e.g. `https://s3.ymerflow.earth`) instead of `https://minio.minio.svc.cluster.local:9000`.
  - `MC_HOST_minio` (line ~325) → same public host, so host-side `mc` admin uses the one address too.
- `config.env.example` — replace the guidance block (lines ~293–315) that currently says "leave
  `STORAGE_ENDPOINT` at the in-cluster MinIO Service." The new guidance: when `PUBLIC_TLS` is set,
  `STORAGE_ENDPOINT`/`STORAGE_CONFIG_JSON.endpoint` is the public S3 host, used from every cluster.
  With a real LE cert, `STORAGE_TLS_SKIP_VERIFY` can be `false`.

## Repointing existing backends is an admin/GUI action — NOT a migration, NOT from config.env

Storage backends are **database-owned, admin-managed data**. There can be several, and any of them
(including the default) may have had its endpoint set or edited through Admin → Storage
(`docs/plans/done/storage-backend-endpoint-field-scope.md` — the Endpoint field lives in
`config["endpoint"]`). `config.env` is only the *fresh-install seed* for the single default row
(written once by `9623bab8493d_generic_seed_default_storage_backend.py`, which `yf-migrate` skips on
every subsequent deploy). It is **not** authoritative for endpoints on a running system.

Therefore:

- **Do not add a re-seed migration** to repoint existing rows from `STORAGE_CONFIG_JSON`. It would
  touch only the one seeded default row (ignoring every GUI-created backend), and would clobber any
  endpoint an admin set by hand. Endpoint values are the admin's data, not the deploy's.
- **A redeploy does not, and should not, change existing backends' endpoints.**
- **Correcting an existing backend's endpoint is an admin action in Admin → Storage**: set the
  Endpoint to the publicly-reachable name (e.g. `https://s3.ymerflow.earth`), per backend. This is
  the correct owner of that data, and it is what unblocks the AKS job on the current prod system.

The `config.env`/seed change below only ensures **fresh installs** get a public endpoint from the
start; it never rewrites data on an existing deployment.

## Why storage has NO bootstrap special case (and the registry does)

The docker registry already implements this exact principle — one public address for everything
pulled *after* the system is live, with a **narrow bootstrap-only exception** for the images pulled
*before* the public nginx TLS edge exists. That is
[docs/plans/done/registry-public-vs-direct-address.md](done/registry-public-vs-direct-address.md),
already in prod and confirmed working (the AKS pod pulled `registry.ymerflow.earth:443/...`
successfully):

- `REGISTRY_PUBLIC_HOST` — post-live pulls: backend Deployment, runner / `Environment.docker_image`,
  per-Job pull Secret. Reachable from every cluster.
- `REGISTRY_DIRECT_HOST:REGISTRY_DIRECT_PORT` (node-IP:30500, self-signed) — **bootstrap-only**:
  the frontend/nginx image, the `yf-deploy-app` deployer Job, the migration Jobs, and host-side
  `crane`/`docker` pushes. These happen *before* the nginx edge they create exists.

**The registry needs no change** — it is the precedent this storage plan follows.

**Storage does not get a matching special case, and that is correct**, not an oversight:

- The registry needs a pre-edge address because *its own images build the nginx edge* — a
  chicken-and-egg the direct NodePort resolves.
- Storage has no such loop. Nothing pulls or reads storage to bring up nginx. Every storage access
  is post-live: `MinioProtocolHandler.bootstrap()` only applies k8s manifests (never touches the S3
  endpoint over the network); MinIO bucket/user/policy admin (`setup_project_storage` / `_run_mc`)
  runs at **project-provisioning time**, after the system is up, against `backend.config["endpoint"]`;
  job pods read/write only once running. So there is never a moment where storage must be reached
  before the public edge exists — one public address suffices everywhere, with zero exceptions.

`MC_HOST_minio` (prod script ~line 325) is exported but not actually invoked anywhere in the
bring-up; repoint it to the public host for consistency, but it is not load-bearing at bootstrap.

## Reachability note (ops, called out — not worked around in code)

Using one public address means local-cluster pods and the backend host reach `s3.ymerflow.earth`
via the router (NAT hairpin/loopback). This is the documented, intended topology; if hairpin is not
enabled on the edge router it is an ops fix on the router, **not** a reason to reintroduce an
in-cluster shortcut in code.

## Verification

- Existing default project on the **local** cluster: import/dataset read/write still works with the
  endpoint repointed to `s3.ymerflow.earth`.
- Same project, job routed to the **AKS** cluster: the import that previously failed with
  `Name or service not known` now reads/writes storage successfully.
- Backend-side I/O (upload, `/files/` proxy, post-job output scan) works against the public endpoint.

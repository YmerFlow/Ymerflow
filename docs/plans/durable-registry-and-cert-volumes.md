# Make the registry and Let's Encrypt volumes durable (hostPath PVs on the bind mount)

## Context

The post-mortem in `docs/bugs/minikube-recreate-destroys-non-bind-mount-volumes.md` found that two
of the three stores the design claims survive a `minikube delete` **do not**:

- **Registry blobs** live on an `emptyDir` (`registry_protocol.py:204`) — destroyed by any pod
  reschedule, not just a cluster recreate.
- **Let's Encrypt certs** live on a dynamic `standard` PVC (`app_deployment.py:609`, no
  `storageClassName`) — provisioned *inside* the minikube node, not on the
  `/mnt/ymerflow-data` host bind mount.

Only Postgres and MinIO are real `hostPath` PVs on the bind mount, which is why only they survived.

This plan makes the registry and cert volumes durable the same way Postgres/MinIO already are:
static `hostPath` PVs on the bind mount. The explicit requirement is that **a normal redeploy
applies the fix while preserving the current certs and images** — no second ACME rate-limit
lockout, no second registry wipe.

**Scope (per decisions below):** only the two volume defects + the cert data migration. Certbot
cold-start hardening, `ensure_minikube_running` mount-mismatch auto-recreate, and environment
build-recipe persistence (post-mortem fixes 4, 6, 1c) are **deferred to separate plans.**

### Decisions taken

- **Registry backing:** `hostPath` PV at `/mnt/ymerflow-data/registry`, mirroring
  `postgres-pv.yaml` and the MinIO PV. No `config.yml` change, no S3 driver.
- **Data preservation = operator dump/restore, not in-cluster automation.** The code change only
  swaps the *volume definitions*. Moving the existing bytes is a one-time runbook: copy out → apply
  → copy back in. No two-mount rolling copy, no in-minikube migration script.

## What changes (code)

### 1. Registry → hostPath PV — `plugins/ymerflow-minikube/minikube_plugin/registry_protocol.py`

In `_bootstrap_async` (around lines 156–214), mirror the MinIO pattern in
`storage_protocol.py:112-132`:

- Before the Deployment, apply a PV + PVC via the existing
  `apply_persistent_volume` / `apply_persistent_volume_claim` helpers (already imported from
  `k8s_apply`):
  - PV `ymerflow-registry`: `capacity 10Gi`, `ReadWriteOnce`, `persistentVolumeReclaimPolicy:
    Retain`, `storage_class_name=""`, `host_path=/mnt/ymerflow-data/registry`.
  - PVC `registry-storage` in `REGISTRY_NAMESPACE`: `storage_class_name=""`,
    `volume_name="ymerflow-registry"`, `requests.storage 10Gi`.
- Change the pod's `registry-storage` volume (line 204) from
  `empty_dir=client.V1EmptyDirVolumeSource()` to
  `persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name="registry-storage")`.
  The `volume_mounts` entry at line 198 (`/var/lib/registry`) is unchanged — the registry
  `config.yml` `rootdirectory` stays `/var/lib/registry`.

### 2. Let's Encrypt → hostPath PV

- **New file** `plugins/ymerflow-minikube/minikube_plugin/letsencrypt-pv.yaml`, a copy of
  `postgres-pv.yaml` with: `name: ymerflow-letsencrypt`, `capacity: 128Mi`,
  `claimRef: {namespace: ymerflow, name: ymerflow-letsencrypt}`,
  `hostPath: /mnt/ymerflow-data/letsencrypt`.
- **`cluster_provider.py`** `MinikubeClusterProvider.bootstrap()` (line 113): add a second
  `apply_persistent_volume(...)` call loading the new yaml, exactly alongside the existing
  `_load_postgres_pv()` line. Add `_LETSENCRYPT_PV_YAML` / `_load_letsencrypt_pv()` next to the
  existing `_POSTGRES_PV_*` helpers (lines 36–42).
- **`backend/services/app_deployment.py`** `_apply_letsencrypt_pvc` (lines 609–626): add
  `storage_class_name=""` and `volume_name="ymerflow-letsencrypt"` to the PVC spec so it binds to
  the new PV instead of dynamically provisioning. The create-if-absent / never-patch behavior and
  the 409 tolerance stay as-is.

### 3. Pre-create the bind-mount subdirs — `minikube_plugin/minikube_vm.py:237-239`

Add `registry` and `letsencrypt` to the `minikube ssh ... mkdir -p` list so the hostPath targets
exist before the PVs bind:

```
"/mnt/ymerflow-data/postgres", "/mnt/ymerflow-data/minio",
"/mnt/ymerflow-data/registry", "/mnt/ymerflow-data/letsencrypt",
```

## What changes (operator runbook — one-time, this deploy only)

Run on the prod host. `$DATA = $YMERFLOW_DATA_DIR` (the bind-mount source, default
`~/.ymerflow/data`). This is a single dump → redeploy → restore; idempotent stores (Postgres,
MinIO) are untouched.

1. **Dump certs and registry blobs out to the host** (before deploying the new code):
   ```bash
   kubectl cp ymerflow/$(kubectl get pod -n ymerflow -l app=frontend -o name | head -1 | cut -d/ -f2):/etc/letsencrypt ./letsencrypt-dump -c certbot
   kubectl cp registry/$(kubectl get pod -n registry -l app=registry -o name | head -1 | cut -d/ -f2):/var/lib/registry ./registry-dump
   ```
2. **Deploy the new code** (normal `./runall.sh`). This recreates the registry Deployment on the
   hostPath PVC (the old emptyDir is discarded) and the frontend on the hostPath-backed cert PVC.
   The cert PVC rebind requires the old dynamic PVC to be gone first:
   ```bash
   kubectl delete deploy frontend -n ymerflow           # release the RWO cert PVC
   kubectl delete pvc ymerflow-letsencrypt -n ymerflow  # drops the dynamic PV; data is in the dump
   ```
   then let the deploy recreate both (frontend PVC now binds to `ymerflow-letsencrypt` PV).
3. **Restore the bytes into the bind mount** (the dirs `mkdir`'d in change 3 map host-side to
   `$DATA/...`):
   ```bash
   rsync -a ./registry-dump/    $DATA/registry/
   rsync -a ./letsencrypt-dump/ $DATA/letsencrypt/
   ```
4. **Bounce the pods** so they re-read the now-populated volumes:
   ```bash
   kubectl rollout restart deploy/registry -n registry
   kubectl rollout restart deploy/frontend  -n ymerflow
   ```
   certbot finds `/etc/letsencrypt/live/<app>/fullchain.pem` present → skips issuance → **no ACME
   request.** The registry serves the restored manifests/blobs.

## Risks / notes

- **Non-minikube `PUBLIC_TLS=letsencrypt`:** hardcoding `storage_class_name=""` +
  `volume_name="ymerflow-letsencrypt"` in core `_apply_letsencrypt_pvc` assumes the
  `ymerflow-letsencrypt` hostPath PV exists — true on minikube (change 2), not on a cloud cluster
  with dynamic default storage. Let's Encrypt is currently only exercised on the minikube prod
  deployment, so this is acceptable for now; if GKE+letsencrypt becomes real, gate these two fields
  on an `app_config` flag. Noted, not built.
- **hostPath permissions:** the registry pod writes as its own uid; `_chown_to_host_owner()` chowns
  `$DATA`. Verify the registry can write `/var/lib/registry` after restore (step 4 covers a clean
  start on a populated dir).
- The registry/cert self-signed TLS certs under `$DATA/certs/...` already survive — unaffected.

## Verification (end to end)

1. **Durability of the volumes** — after the deploy:
   ```bash
   kubectl get pv ymerflow-registry ymerflow-letsencrypt -o wide   # Bound, hostPath on /mnt/ymerflow-data
   kubectl get pvc -A | grep -E 'registry-storage|ymerflow-letsencrypt'  # Bound, STORAGECLASS empty
   minikube ssh -- ls /mnt/ymerflow-data/registry /mnt/ymerflow-data/letsencrypt
   ```
   No PVC should be on `standard`; no volume should be `emptyDir` (re-check the registry pod spec).
2. **Certs preserved, no ACME hit** — `kubectl logs -n ymerflow deploy/frontend -c certbot` shows
   `certificate present; entering renew loop`, never `requesting initial certificate`. Site serves
   `:443` immediately.
3. **Registry images preserved** — `curl -sk -u <user>:<pass> https://<registry>/v2/_catalog`
   lists the pre-deploy repositories (backend, frontend, base-runner, any surviving env images).
4. **Survives a pod reschedule** (the real regression test for the emptyDir bug):
   ```bash
   kubectl rollout restart deploy/registry -n registry
   ```
   then re-hit `/v2/_catalog` — the catalog is still populated (previously this wiped it).
5. **Clean install** (optional, scratch dir): a fresh `./runall.sh` with an empty `$DATA` brings up
   both PVs `Bound` with no manual steps — proving the code path is self-sufficient when there is
   nothing to migrate.

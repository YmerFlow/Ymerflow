# Expose minikube services on the host IP / 0.0.0.0 (replace socat + kubectl port-forward)

## Goal

Make the cluster's host-facing services reachable on the **host's own interfaces** (`0.0.0.0` — the
LAN IP `192.0.2.142` and localhost) instead of only at the **minikube bridge IP** (`192.168.49.2`)
or via `socat` / `kubectl port-forward` hacks. This is the prerequisite for a second machine on the
LAN reaching this cluster (arch 2 in the multi-cluster discussion).

Scope (confirmed with the user): **the two existing NodePorts (frontend 30080, registry 30500),
MinIO (9000/9001), and the Kubernetes API server** (`:8443`). MinIO + apiserver are included because
the two-machine goal needs cross-machine data access (MinIO) *and* one backend dispatching Jobs to
the other machine's cluster (kube-apiserver). A single minikube recreate covers all of them.

## Prerequisite — credentials + TLS must land first

**`docs/plans/self-signed-tls-minio-registry.md` is a hard prerequisite of this plan** and must be
implemented and merged **before** any of the exposure work here. That plan gives MinIO and the
registry (a) **authentication** — username/password from `config.env` — and (b) **self-signed TLS
encryption**. Ordering it first is what makes publishing on `0.0.0.0` safe: by the time these
services become reachable from off-host, they are *never* anonymous and *never* cleartext. This
closes the interface-binding concern raised in earlier review — see decision 4.

## Decisions (confirmed with the user)

1. **Scope = NodePorts + MinIO + kube-apiserver** (fullest option).
2. **Recreate proceeds silently** — no CONFIRM prompt. Applying `--ports`/`--apiserver-ips` needs a
   `minikube delete` + recreate; PVC data (Postgres/MinIO) survives via the host bind-mount and
   `k8s/storage/` static PVs, and in-node docker images are rebuilt by the normal run flow, so the
   recreate is non-destructive to data and doesn't warrant a prompt.
3. **Frontend is published directly on 30080** (no friendly-port remap). `SERVER_URL` defaults to
   `http://<host-ip>:30080`; the `FRONTEND_PORT` variable and the entire socat step are removed.
4. **`MINIKUBE_LISTEN_ADDRESS` defaults to `0.0.0.0`** (all interfaces). This is safe *because* the
   credentials + TLS prerequisite is in place first — every exposed service requires auth over TLS,
   so binding a public interface (e.g. on the arch-1 machine) no longer leaks an anonymous/plaintext
   service. Residual: operators on a public-interface host should still change the default MinIO/
   registry credentials away from the shipped defaults (documented in `config.env.example`).

## Current state (confirmed by reading scripts + inspecting the running container)

| Port  | Service          | Type today   | Defined in                         | Host bridge today                                   |
|-------|------------------|--------------|------------------------------------|-----------------------------------------------------|
| 30080 | frontend / nginx | NodePort     | `k8s/frontend/service.yaml`        | prod `socat 0.0.0.0:${FRONTEND_PORT} → :30080`      |
| 30500 | registry         | NodePort     | `dev/setup-registry.sh`            | none (reached via `${MINIKUBE_IP}:30500`)           |
| 9000  | MinIO API        | ClusterIP    | `dev/setup-minio.sh`               | `kubectl port-forward … 9000:9000` → localhost only |
| 9001  | MinIO console    | ClusterIP    | `dev/setup-minio.sh`               | (console; localhost only)                           |
| 8443  | kube-apiserver   | (minikube)   | minikube                           | published to `127.0.0.1:32774` (random)             |

`docker port minikube` confirms 30080/30500/9000 are **not** published on the host; only
`22/2376/8443/32443/5000` are published to `127.0.0.1`.

## Mechanism

minikube's docker driver (v1.35.0, flags confirmed present):
- `--ports=<host>:<node>` (repeatable) — publishes a node container port on the host via docker's
  iptables DNAT. Host port may differ from node port, so a NodePort in the 30000–32767 range can be
  re-published on a friendly host port (e.g. host `9000` → node `30900`).
- `--listen-address=<ip>` — host IP the published ports bind to; `0.0.0.0` = all interfaces.
- `--apiserver-ips=<ip>` — adds an IP to the apiserver serving-cert SANs so TLS verification passes
  when a client connects via the LAN IP rather than the internal `192.168.49.2`.

Port publishing and the apiserver cert SAN are fixed at container-creation time, so applying them to
the existing container **requires `minikube delete` + recreate** (stop/start reuses the container).

## Phase 1 — `dev/setup-minikube.sh`: publish ports, apiserver SAN, silent recreate

The single shared `minikube start` (lines 79-87) is the one place all of this is configured.

1. Near the top, define (all overridable from `config.env`):
   ```bash
   # host<:node> specs published on the host. Bare NodePorts map identity; MinIO re-maps its
   # in-range NodePorts (30900/30901) back to the friendly 9000/9001 on the host.
   MINIKUBE_EXPOSE_PORTS="${MINIKUBE_EXPOSE_PORTS:-30080 30500 9000:30900 9001:30901}"
   MINIKUBE_LISTEN_ADDRESS="${MINIKUBE_LISTEN_ADDRESS:-0.0.0.0}"
   # LAN IP(s) to add to the apiserver cert SAN. Empty = don't expose the apiserver externally.
   MINIKUBE_APISERVER_IPS="${MINIKUBE_APISERVER_IPS:-}"
   ```
2. Build the flag arrays:
   ```bash
   START_FLAGS=(--listen-address="${MINIKUBE_LISTEN_ADDRESS}")
   for spec in $MINIKUBE_EXPOSE_PORTS; do
       case "$spec" in *:*) START_FLAGS+=(--ports="${spec}");; *) START_FLAGS+=(--ports="${spec}:${spec}");; esac
   done
   for ip in $MINIKUBE_APISERVER_IPS; do START_FLAGS+=(--apiserver-ips="${ip}"); done
   ```
   Add `"${START_FLAGS[@]}"` to the `minikube start` invocation.
3. **Silent recreate detection** — a new check alongside the insecure-registry / disk-size checks.
   When minikube is already running, force a recreate if any desired host port isn't published (or,
   for the apiserver, if the SAN check is impractical, key the recreate off the ports only and treat
   the apiserver SAN as applied-on-recreate):
   ```bash
   for spec in $MINIKUBE_EXPOSE_PORTS; do
       host_port="${spec%%:*}"
       if ! docker port minikube 2>/dev/null | grep -qE "0\.0\.0\.0:${host_port}(\b|$)"; then
           echo "Host port ${host_port} not published — recreating minikube (data preserved, images rebuild)"
           NEEDS_RECREATE=true
       fi
   done
   ```
   The recreate path does `minikube delete` then falls through to the existing start block — **no
   CONFIRM prompt** (decision 2). Reuse the disk-size branch's mechanics minus the `read CONFIRM`.

   > Verify at implementation: whether `--listen-address=0.0.0.0` actually moves the **apiserver**
   > publish off `127.0.0.1` (it governs published-port bind IP on the docker driver, but minikube
   > manages the 8443 mapping itself). If it does not, the fallback is documenting that the remote
   > kubeconfig uses the LAN IP with the apiserver host port from `docker port minikube 8443`, and
   > the SAN from `--apiserver-ips` is what makes that TLS-valid. Do **not** try to `--ports` 8443 —
   > it collides with minikube's own management of that port.

## Phase 2 — MinIO: NodePort instead of port-forward

### 2.1 `dev/setup-minio.sh`
- Change the `minio` Service (namespace `minio`) from `type: ClusterIP` to `type: NodePort` with
  `nodePort: 30900` (api/9000) and `nodePort: 30901` (console/9001). The `minio-nagelfluh`
  ExternalName service is unchanged (in-cluster jobs still use in-cluster DNS).
- **Delete the port-forward** (Step 3, lines ~113-135): the `pkill`, `kubectl port-forward … 9000`,
  and the readiness `nc` loop. MinIO is now reachable at `http://<host>:9000` via docker publish
  (which includes localhost, so the dev backend's `localhost:9000` keeps working).
- Update the closing echoes (localhost:9000/9001 statements stay valid).

### 2.2 Remove the now-redundant/ conflicting port-forward machinery
Publishing MinIO on `0.0.0.0:9000` would clash with any lingering `port-forward` on `localhost:9000`,
so remove them:
- `dev/restart-minio-portforward.sh` — delete the file (or gut to a message pointing at docker publish).
- `dev/monitor-services.sh` — drop the MinIO port-forward check/restart; keep backend/frontend checks.
- `dev/runall.sh` — remove the "ensure MinIO port-forward running" block (~127-132) and adjust the
  status echoes (~258, ~276).
- `dev/cleanup-all.sh` (~49-62) and `dev/stop-all.sh` (~17-21) — drop the MinIO port-forward kill
  logic / comments.

## Phase 3 — `prod/runall-minikube.sh`: drop socat, publish frontend directly

- `SERVER_URL` default becomes `http://$(hostname -I | awk '{print $1}'):30080` (was `:3000`).
- Remove the `FRONTEND_PORT` computation block (lines ~22, 291-304) — it existed only as socat's
  listen port.
- Before Step 1 calls `setup-minikube.sh`, export the LAN IP for the apiserver SAN:
  ```bash
  export MINIKUBE_APISERVER_IPS="${MINIKUBE_APISERVER_IPS:-$(hostname -I | awk '{print $1}')}"
  ```
  (`MINIKUBE_EXPOSE_PORTS`/`MINIKUBE_LISTEN_ADDRESS` use the Phase-1 defaults, which already include
  30080/30500/MinIO.)
- **Delete Step 12 entirely** (lines ~587-614): the `pkill …socat…`, the `<1024 → sudo setsid socat`
  / `else setsid socat` branch, and the `ss -tlnp` verification. Replace with a one-line note that
  minikube publishes the frontend on `:30080`.
- Update the final summary block: `App: ${SERVER_URL}` (now `:30080`); drop the "socat" wording.
  Registry `REGISTRY_URL: "${MINIKUBE_IP}:30500"` ConfigMap value is **unchanged** — pods still use
  the minikube IP internally; host-IP publish is additive.

## Phase 4 — config + docs

- `config.env.example`: document `MINIKUBE_LISTEN_ADDRESS` (default `0.0.0.0`), `MINIKUBE_EXPOSE_PORTS`
  (default `30080 30500 9000:30900 9001:30901`), and `MINIKUBE_APISERVER_IPS` (LAN IP for the
  apiserver SAN; empty = not externally exposed). Remove the `FRONTEND_PORT`/socat block; change the
  `SERVER_URL` example default to `:30080`.

## Credentials + TLS — in the prerequisite plan, not here

MinIO/registry authentication (username/password from `config.env`) and self-signed TLS are handled
by the prerequisite `docs/plans/self-signed-tls-minio-registry.md` (see Prerequisite above), which
lands first. This plan is purely port publishing + socat/port-forward removal; it assumes those
services already require auth over TLS by the time they're exposed.

## Manual verification

- Fresh `runall` (accepts the one-time silent recreate). `docker port minikube` then shows
  `0.0.0.0:30080`, `0.0.0.0:30500`, `0.0.0.0:9000`, `0.0.0.0:9001` bound; no `socat` process runs.
- From **another LAN machine** (`192.168.1.x`) — services are HTTPS + authenticated (prerequisite):
  - `curl http://192.0.2.142:30080/` reaches the app (and `/api` reaches the backend). The frontend
    stays plain HTTP from nginx (TLS, if any, terminated upstream — unchanged by this plan).
  - `curl -k -u "$REGISTRY_USER:$REGISTRY_PASSWORD" https://192.0.2.142:30500/v2/` returns `{}`;
    the same request **without** `-u` is rejected (auth is enforced).
  - `mc alias set r https://192.0.2.142:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --insecure &&
    mc ls r --insecure` works.
- kube-apiserver: from the other machine, a kubeconfig pointing at `https://192.0.2.142:<apiserver
  host port>` with this cluster's client cert connects **without** a TLS SAN error (proves
  `--apiserver-ips` took). Confirm the host port via `docker port minikube 8443`.
- Dev backend on the host still reaches MinIO at `https://localhost:9000` (docker publish covers
  localhost; skip-verify per the prerequisite plan).
- `docker/build.sh` still pushes to `${MINIKUBE_IP}:30500` (now via `docker login`) and pods still
  pull (ConfigMap unchanged).
- Second `runall` run does **not** recreate (ports already published).

## Follow-ups / notes

- The other machine's backend, to dispatch Jobs here, needs this cluster's **client credentials**
  (kubeconfig client cert) copied over — exposing the apiserver only solves reachability + TLS SAN,
  not authn. Out of scope for this script change; note it for the multi-cluster work.
- If a **stable** external apiserver port is required (rather than reading `docker port` each
  recreate), investigate at implementation whether `--apiserver-port` + `--listen-address` yields a
  fixed host mapping on the docker driver; capture the finding here.

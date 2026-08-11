# Short-Lived, Per-Project Storage Credentials — Phase 4: Runner-side refresh loop

Part of [short-lived-storage-credentials-00-overview.md](short-lived-storage-credentials-00-overview.md) — read that first for
goal, background, and architecture summary. This is Phase 4 of 4, the final phase.

**Depends on:** Phase 3 ([short-lived-storage-credentials-03-credential-strategies.md](short-lived-storage-credentials-03-credential-strategies.md))
— needs `ShortLivedStrategy` and the protocol handler registry in place.

Required for `ShortLivedStrategy` regardless of cluster count or topology (established: token
lifetime is a function of job duration vs. issuer cap, not of where the job runs).

This is the only phase that changes runtime behavior for real jobs, and only for `StorageBackend`
rows explicitly configured with `credential_strategy: short-lived` — the bootstrap row stays
`static-key` by default, so nothing changes for existing deployments until an admin opts a backend
in.

## 4.1 Per-job refresh token

At job launch (`job_orchestrator.create_job_manifest`), alongside the minted storage credential,
generate a random opaque `REFRESH_TOKEN` (e.g. `secrets.token_urlsafe(32)`), store its hash on
`ProcessVersion` (new column `refresh_token_hash`), and inject the plaintext as an env var
(`STORAGE_REFRESH_TOKEN`) into the pod — same delivery mechanism as every other env var already
injected today, no new distribution channel.

This sidesteps validating a Kubernetes ServiceAccount token across cluster boundaries (which would
require the backend to trust each cluster's own OIDC issuer — real complexity once
[multi-cluster-execution.md](multi-cluster-execution.md) lands) in favor of a credential-agnostic
opaque secret that works identically regardless of which cluster the pod is in.

## 4.2 New backend endpoint

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/internal/process/{process_id}/versions/{version}/storage-credentials/refresh` | `STORAGE_REFRESH_TOKEN` header, hash-compared | Re-mints and returns a fresh storage credential for this job |

Backend re-runs `strategy.mint(project, backend)` and returns the new credential + its
`expires_at`. Rate-limited/backed off gracefully — a transient failure here must not fail a 36h
job outright (§4.4).

## 4.3 Runner changes — refresher runs as a separate OS process, not a thread

`docker/base-runner/runner.py`'s `main()` today runs `process_class.run()` synchronously as the
only process in the container (confirmed: no threading/multiprocessing exists there yet). The
refresh loop must **not** be a background thread in that same process:

- Inversion/processing code is typically CPU-bound (numpy/scipy) and can hold the GIL for long
  stretches, or spawn its own worker processes/signal handlers that a same-process thread doesn't
  survive cleanly. A thread-based refresher can end up starved for exactly the window it's needed
  — right up to expiry — silently reintroducing the outage this phase exists to prevent.
- Instead, `runner.py` forks a **separate refresher OS process** (`multiprocessing.Process`, or a
  `subprocess.Popen` of a small dedicated script) right after the initial credential mint, before
  invoking `process_class.run()`. The refresher's only job: sleep until ~half the remaining
  lifetime, call the `/storage-credentials/refresh` endpoint, write the result, repeat.
- **IPC is a local file, not shared memory or a pipe.** The refresher process writes
  `{credentials, expires_at}` to a well-known container-local path (e.g.
  `/tmp/storage-credentials.json`, mode 0600) via write-to-tempfile-then-atomic-rename — no reader
  ever observes a partial write. The main process's storage_context wrapper re-reads this file
  (checking mtime) before constructing/rebuilding its fsspec filesystem instance. This is what
  makes storage_context need to become "mutable/rebuildable" rather than the plain dict it is
  today (a real code change to how `ymerflow_processes`/`aem_processes` obtain their filesystem
  object) — true regardless of thread vs. process, but the file-based handoff is what makes it
  safe across a process boundary.
- On exit (success or failure), the main process terminates the refresher subprocess
  (`Popen.terminate()` / `join(timeout=...)`) so the pod doesn't hang waiting on a lingering child.
- Retry with backoff on refresh failure inside the refresher process; only surface a failure (e.g.
  by writing an `{"error": ...}` sentinel instead of updating credentials) once the *current*
  credential is actually expired, not on the first transient error.

## 4.4 Failure modes to design for explicitly

- Backend restart mid-job: refresh calls should retry across a backend outage window, not fail
  immediately — a rolling backend restart must not kill a 36h inversion.
- Rate limiting: many long jobs refreshing on similar cadences could produce bursts of IAM/STS
  calls; unlikely to matter at current scale but worth a jittered refresh interval from the start
  rather than retrofitting it later.
- Refresher subprocess dies unexpectedly (OOM-killed, crashed): the main process must notice — poll
  `Popen.poll()` / check the credentials file's mtime against the current credential's `expires_at`
  before each storage operation — and attempt to respawn the refresher rather than running silently
  uncovered until the credential expires and every storage call starts failing.

## Next

This is the final phase. See
[short-lived-storage-credentials-00-overview.md](short-lived-storage-credentials-00-overview.md)'s
Open Questions section for unresolved design points that may need follow-up work.

"""Shared between runner.py and storage_credential_refresher.py.

For credential_strategy="short-lived" jobs, the pod's env vars are only a starting point — the
credential they carry expires mid-job, and env vars of an already-running process can't be
updated. So the refresher subprocess (storage_credential_refresher.py) re-mints periodically and
writes the result to a well-known local file; the main process reads that file on every storage
access instead of trusting its startup env vars. This is what makes storage_context's
`storage_kwargs` need to be "live" rather than a plain dict computed once at startup — see
docs/plans/done/short-lived-storage-credentials-04-runner-refresh-loop.md section 4.3.

For credential_strategy="static-key" (the default) none of this is used: runner.py's
get_storage_kwargs() keeps returning a plain dict exactly as before.
"""
import collections.abc
import json
import logging
import os
import subprocess
import sys
import tempfile
import time

logger = logging.getLogger(__name__)

CREDENTIALS_FILE = "/tmp/storage-credentials.json"

# Don't respawn more than once per this many seconds — a crash-looping refresher (e.g. backend
# unreachable at process startup) must not busy-loop forking subprocesses.
RESPAWN_COOLDOWN_SECONDS = 30


def write_credentials_atomic(data: dict, path: str = CREDENTIALS_FILE) -> None:
    """Write {kwargs, expires_at} (or {"error": ...}) so no reader ever observes a partial
    write: write to a tempfile in the same directory, then atomically rename over the target.
    `kwargs` is the protocol-general fsspec kwargs dict (s3: key/secret/client_kwargs; gcs: token;
    …), built by the backend's StorageProtocolHandler."""
    directory = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".storage-credentials-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def read_credentials(path: str = CREDENTIALS_FILE):
    """Returns the parsed dict, or None if the file doesn't exist yet or isn't valid JSON (e.g.
    read mid-write before the atomic rename lands — caller should just keep using the last-known-
    good value in that case, not crash)."""
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def spawn_refresher(env: dict) -> subprocess.Popen:
    """Fork the refresher as a separate OS process (not a thread) — inversion/processing code is
    typically CPU-bound and can hold the GIL for long stretches, so a same-process thread-based
    refresher can end up starved for exactly the window it's needed, right up to credential
    expiry. subprocess.Popen (not multiprocessing.Process) since the refresher is a standalone
    script with no need to share memory with the main process — the credentials file is the only
    IPC channel."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage_credential_refresher.py")
    return subprocess.Popen([sys.executable, "-u", script], env=env)


class RefreshableStorageKwargs(collections.abc.Mapping):
    """Drop-in replacement for the plain fsspec storage_kwargs dict, usable via `**storage_kwargs`
    (dict-unpacking only needs `.keys()` and `__getitem__`, both of which this implements) — so
    every existing process type (ymerflow_processes/aem_processes/mag_processes) that does
    `storage_kwargs = storage_context['storage_kwargs']; ...; fsspec.open(url, **storage_kwargs)`
    keeps working unmodified, transparently getting freshly-minted kwargs on every single call
    instead of the stale ones from job launch.

    Protocol-general: it holds whatever fsspec kwargs dict the backend's StorageProtocolHandler
    produced (s3: key/secret/client_kwargs; gcs: token; …) and hands it back verbatim — it does not
    reconstruct any protocol-specific shape itself. The refresher rewrites the same dict on refresh.

    Also doubles as the failure-mode watchdog from section 4.4: every access checks whether the
    refresher subprocess has died and, if so, respawns it (rate-limited) rather than silently
    running uncovered until the current credential expires.
    """

    def __init__(self, initial_kwargs, refresher_process, refresher_env,
                 credentials_path=CREDENTIALS_FILE):
        self._credentials_path = credentials_path
        self._refresher_process = refresher_process
        self._refresher_env = refresher_env
        self._last_respawn = time.monotonic()
        self._cached = dict(initial_kwargs)
        self._cached_error = None

    def _ensure_refresher_alive(self):
        if self._refresher_process.poll() is None:
            return  # still running
        now = time.monotonic()
        if now - self._last_respawn < RESPAWN_COOLDOWN_SECONDS:
            return
        logger.warning(
            "storage-credentials refresher subprocess died (exit code %s), respawning",
            self._refresher_process.returncode,
        )
        self._refresher_process = spawn_refresher(self._refresher_env)
        self._last_respawn = now

    def _reload(self):
        # Re-read on every access rather than caching by mtime: the file is a few dozen bytes, so
        # the cost is negligible, and mtime has only ~1s resolution on some filesystems — a cache
        # keyed on it can miss a write that lands within the same tick as the previous one.
        data = read_credentials(self._credentials_path)
        if not data:
            return  # no file yet, or a transient partial write mid-rename — keep last-known-good
        if "error" in data:
            # The refresher only ever writes this once the *current* credential's own expires_at
            # has actually passed (see storage_credential_refresher.py) — by construction there is
            # no valid last-known-good left to fall back to, so surface it loudly instead of
            # quietly making storage calls fail with a cryptic auth error.
            self._cached_error = data["error"]
            return
        self._cached = data["kwargs"]
        self._cached_error = None

    def _resolve(self):
        self._ensure_refresher_alive()
        self._reload()
        if self._cached_error is not None:
            raise RuntimeError(f"storage credential expired and could not be refreshed: {self._cached_error}")
        return self._cached

    def __getitem__(self, key):
        return self._resolve()[key]

    def __iter__(self):
        return iter(self._resolve())

    def __len__(self):
        return len(self._resolve())

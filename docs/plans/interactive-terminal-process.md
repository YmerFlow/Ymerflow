# Interactive Terminal Process

## Overview

A process type that gives the user an interactive IPython session with access to the project's storage context. Unlike regular processes, the "run" phase is a human-driven PTY session rather than an automated script. The initializer and finalizer are identical to all other process types — only the middle is different.

The session is exposed in the frontend as an xterm.js terminal widget connected over WebSocket.

## Design Decisions

- **Shell is Python (IPython)** — not bash. If the user wants to run other programs, they use `os.system()` or `subprocess`. This keeps storage context available as Python objects rather than requiring env var serialization.
- **No explicit output registration** — the user just writes files to `base` via fsspec. The finalizer scans storage and registers outputs automatically, exactly as it does for scripted process types.
- **PTY, not Jupyter kernel** — gives full terminal semantics: pdb works, readline works, any interactive program launched via `os.system()` works. No inline plots, but outputs appear in PlotView after the session ends.

## Architecture

### Process Runner (new process type)

A new process type `InteractiveProcess` in `docker/base-runner/ymerflow_processes/`:

```python
class InteractiveProcess:
    def schema(self):
        return {}  # no parameters needed

    def run(self, storage_context, parameters):
        import IPython
        IPython.start_ipython(argv=[], user_ns={
            "fs": storage_context.fs,
            "base": storage_context.base_path,
        })
```

The runner calls `initialize()`, then `run()` (which blocks on the IPython PTY until the user exits), then `finalize()`. No changes to the runner's init/finalize logic.

The pre-seeded namespace:

```python
fs    # fsspec AbstractFileSystem pointed at project storage
base  # str — base path for this process, e.g. "s3://nagelfluh-project-abc/processes/proc-id/"
```

Writing outputs is just normal fsspec usage:

```python
with fs.open(base + "result.xyz", "wb") as f:
    f.write(data)
# exit() → finalizer picks up result.xyz and registers it as an output dataset
```

### Backend (WebSocket PTY proxy)

New endpoint, e.g. `WS /ws/pty/{process_id}`, that:

1. Locates the running Kubernetes pod for the process
2. Opens a `kubectl exec` PTY connection to it (or equivalent API call)
3. Proxies raw bytes between the WebSocket client and the PTY

This is analogous to the existing `/ws/logs` endpoint but bidirectional.

The process stays in `"running"` state for the lifetime of the session. On PTY close, the runner finalizes and the process transitions to `"completed"` as normal.

### Frontend (xterm.js widget)

A new widget `TerminalView` in `frontend/src/widgets/TerminalView/`:

- Uses [xterm.js](https://xtermjs.org/) (`npm install --save xterm`)
- Connects to `WS /ws/pty/{process_id}` on mount
- Passes resize events to the backend (so the PTY SIGWINCH is correct)
- Standard xterm.js fit addon to fill the pane

Registered in `frontend/src/App.js` alongside the other widgets. Displayed when the active process is of type `interactive`.

## Implementation Steps

1. **Runner**: Add `InteractiveProcess` process type; ensure `start_ipython` receives correct `user_ns` and blocks until exit.
2. **Backend**: Add `WS /ws/pty/{process_id}` endpoint with kubectl exec PTY proxy.
3. **Frontend**: Add `TerminalView` widget with xterm.js, wired to the PTY WebSocket.
4. **Registration**: Verify finalizer correctly scans and registers files written under `base` — this should already work if other process types use the same finalizer.

## Non-goals

- Inline plot rendering (outputs appear in PlotView after session ends, not during)
- Jupyter notebook UI (intentionally avoided — PTY gives pdb, arbitrary interactive programs)
- Reproducible replay (session history is preserved as the process log for reference, but replay is not supported; outputs are therefore not usable as inputs in other processes)

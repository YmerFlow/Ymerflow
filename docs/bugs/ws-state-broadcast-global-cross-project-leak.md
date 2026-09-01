# Bug: `/ws/processes/updates` broadcasts every project's process state (and output ids/URLs) to every connected client, with no authentication

## Severity

**Medium–High** — a global, cross-tenant information-disclosure bug. Unlike
[`publication-link-leaks-real-project-id.md`](publication-link-leaks-real-project-id.md)
(which leaks *one* project's real id to a viewer who already had a link into *that* project),
this leaks activity metadata for **every project of every user** to **anyone** who opens a
WebSocket — including fully unauthenticated clients. It is a superset of, and the reason we
cannot cleanly fix, the publication-side WS leak noted in that report.

No dataset *contents* are exposed directly, but process ids, dataset ids, real project ids,
and `/files/` download URLs are — and `/files/` URLs are themselves auth-free capabilities
(see the companion bug), so leaking them is close to leaking the data.

## Symptoms

Open a WebSocket to `/ws/processes/updates` — no token, no cookie, no membership — and you
receive a live feed of **every process state transition happening anywhere in the system**:

```jsonc
// on every state change, for every process in every project:
{ "process_id": "...", "version": 3, "state": "running" }

// and, on completion (state -> "done"), the full outputs:
{
  "process_id": "...",
  "version": 3,
  "state": "done",
  "outputs": [
    {
      "id": "<dataset_id>",
      "project_id": "<REAL_PROJECT_ID>",       // ← another tenant's project id
      "process_id": "...",
      "process_name": "...",
      "dataset_name": "...",
      "url": "http://.../files/<bucket_prefix><REAL_PROJECT_ID>/.../root.msgpack",  // ← auth-free download URL
      "parts": { ... more /files/ URLs ... }
    }
  ]
}
```

So a passive listener learns, in real time and across the whole install: which projects
exist and are active, process/dataset names (which are often descriptive of the data),
job timing, and directly-fetchable file URLs for finished outputs.

## Why this matters

- **No authentication on the socket.** `process_state_websocket` calls
  `await websocket.accept()` and immediately joins the global broadcast set — there is no
  token parameter, no `Depends(...)`, no membership check
  (`backend/routers/processes.py:541-556`).
- **The broadcast is unscoped.** `broadcast_state` iterates *all* connected state sockets
  and sends every one the same message; connections are stored in a single flat list with no
  project/user key (`backend/services/websocket_service.py:45-71`).
- **The payload carries other tenants' ids and auth-free file URLs.** On `DONE`, the update
  embeds `dataset.to_dict()` for each output — real `project_id`, dataset id, and `/files/`
  URLs whose bucket is `<bucket_prefix><real_project_id>` and which the auth-free `/files/`
  proxy will serve to anyone (`backend/models/process.py:499-519`, and see the companion
  bug for the `/files/` capability model).

Combined: an unauthenticated client can sit on this socket and harvest download URLs for
every completed dataset in the entire system as jobs finish.

## Root cause

Two independent design gaps compound:

### 1. The state WebSocket is unauthenticated and un-scoped

```python
# backend/routers/processes.py:541-556
@router.websocket("/ws/processes/updates")
async def process_state_websocket(websocket: WebSocket):
    """WebSocket endpoint for streaming global process state updates"""
    await websocket.accept()                 # ← no auth, no project scope
    await ws_manager.connect_state(websocket)
    try:
        await websocket.send_json({"refetch": True})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await ws_manager.disconnect_state(websocket)
    ...
```

```python
# backend/services/websocket_service.py:45-71
async def connect_state(self, websocket: WebSocket):
    """Connect a websocket to global state updates"""
    self.state_connections.append(websocket)          # ← one flat global list

async def broadcast_state(self, message: dict):
    """Broadcast a state update to all connected websockets"""
    for ws in self.state_connections:                 # ← everyone gets everything
        await ws.send_json(message)
```

There is no per-connection notion of *which* project(s) a client is entitled to hear about,
so even if the socket were authenticated, the broadcast would still fan every project's
updates to every listener.

### 2. The broadcast payload includes full output dicts with real ids and file URLs

```python
# backend/models/process.py:499-519  (ProcessVersion.update_state)
if new_state == ProcessState.DONE and self.datasets:
    state_update["outputs"] = [dataset.to_dict() for dataset in self.datasets]
...
state_update = translate_urls_in_dict(state_update, to_storage=False)   # -> /files/ URLs
await ws_manager.broadcast_state(state_update)
```

`dataset.to_dict()` emits `project_id`, `id`, `url`, and `parts`
(`backend/models/dataset.py:44-70`); `translate_urls_in_dict(..., to_storage=False)` turns
storage URLs into auth-free `/files/<bucket_prefix><real_project_id>/…` URLs. All of it goes
out on the global channel.

## Affected code

- `backend/routers/processes.py:541-556` — unauthenticated `/ws/processes/updates` endpoint
- `backend/services/websocket_service.py:45-71` — flat global `state_connections`, unscoped `broadcast_state`
- `backend/models/process.py:492-519` — `ProcessVersion.update_state` broadcast payload (incl. `outputs`)
- `backend/models/process.py:319`, `967` — other `broadcast_state` call sites (process_id/version/state only, no `outputs`, but still global + unauthenticated)

## Reproduction

1. Without logging in, open a WebSocket to `ws(s)://<host>/ws/processes/updates`.
2. From an *unrelated* account, run any process to completion in some project `P`.
3. Observe the listener receive `P`'s `process_id`/`state` transitions and, on completion, a
   `done` message containing `P`'s real `project_id` and directly-fetchable `/files/` URLs.
4. `curl` one of those `/files/` URLs — it downloads without authentication.

## Relationship to the publication opacity work

This is why the WS path was left out of scope in
[`docs/plans/publication-link-id-opacity.md`](../plans/publication-link-id-opacity.md): that
plan redacts real ids at each **REST** response boundary using the per-request
`ProjectReadAccess`. The WS broadcast has **no per-connection publication (or even user)
context** to redact against, and the leak is far broader than publications — it's every
client, authenticated or not. Fixing it requires rescoping the channel, not a redaction
pass, so it belongs in its own change.

## Fix options (for discussion — not yet decided)

1. **Authenticate the socket + scope subscriptions per project.** Require auth on
   `/ws/processes/updates` (query-param token or cookie, resolved like the REST deps), have
   the client subscribe to specific project ids it can read (real membership *or* a
   publication id via `try_resolve_project_for_read`), and key `state_connections` by
   project so `broadcast_state(project_id, message)` only reaches entitled sockets. This also
   naturally lets publication viewers receive updates for just their project, with the same
   id-redaction the REST plan applies.
2. **Minimum-disclosure payload + authenticated fan-out.** Keep a single authenticated
   channel but strip `outputs`/ids/URLs from the broadcast — send only
   `{process_id, version, state}` as a change signal and let the client re-fetch through the
   access-checked REST endpoints (which already redact per the opacity plan). Removes the
   file-URL/id leak; still needs auth + at least per-user scoping so clients don't learn
   about processes in projects they can't see.
3. **Both:** authenticate, scope per project, *and* slim the payload to a refetch signal —
   defense in depth (the endpoint already sends a bare `{"refetch": true}` on connect, so the
   client is presumably able to refetch on demand already).

Recommendation leans toward **(1)+(3)**: authenticated, per-project-scoped channels carrying
only refetch signals, with any id-bearing detail coming back through the REST endpoints that
already enforce access and (per the opacity plan) redact real project ids.

## Notes

- The logs socket `/ws/logs/{process_id}` (`backend/routers/processes.py:513`) should be
  audited in the same pass — it is keyed by `process_id` (so not a *global* fan-out) but its
  authentication/authorization was not reviewed here and process ids are the only guard.
- No write path is involved; this is purely a read/subscribe disclosure.

# WebSocket state socket — per-project scoping (performance — fix later)

## Status

This is a **performance** follow-up to
[`ws-data-leak-fixes.md`](ws-data-leak-fixes.md), which closes the actual security holes. It
is **not** a data-leak fix and is not urgent.

After the payload strip, `/ws/processes/updates` is still one global, unauthenticated
firehose: it pushes a `{"refetch": true}` signal to **every** connected client on **every**
process/import/export state change **anywhere** in the system. The sole consumer
(`ProcessContext.jsx`, `handleWebSocketMessage`) responds by calling
`invalidateProject()` — so every logged-in browser refetches its current project whenever any
job transitions anywhere. That's N clients × M global events of wasted refetches.

**When to do this:** when the number of concurrent users × job throughput makes the global
refetch fan-out a real load problem. At current scale it is harmless (the refetches are
REST-auth-gated, so nothing leaks — they just cost requests).

**Minor security bonus:** scoping also closes the weak, no-attribution timing side-channel
that survives the strip (an anonymous listener otherwise learns "something, somewhere,
changed at time T"). This is a side benefit, not the reason to do the work.

**Operator scope decision:** anonymous / publication-link viewers get no live feed — a
read-only snapshot needs no push updates. The socket requires **real membership**.

---

## The change — authenticate + scope the state socket per project

Reuses the `authenticate_token` and `_is_project_member` helpers and the first-message-auth
transport introduced in [`ws-data-leak-fixes.md`](ws-data-leak-fixes.md) (do that plan
first).

1. **Registry** (`backend/services/websocket_service.py`): replace the flat global
   `state_connections: List[WebSocket]` with `Dict[str, Set[WebSocket]]` keyed by
   `project_id`; `connect_state(project_id, ws)` / `disconnect_state(project_id, ws)`;
   `broadcast_state(project_id, message)` sends only to that project's subscribers. Drop the
   per-message payload log (it would span projects); a count is fine.
2. **Endpoint** (`backend/routers/processes.py:541-556`): rewrite as
   `GET /ws/projects/{project_id}/updates` — `accept()`, first-message token, require real
   membership via `_is_project_member`, else `close(1008)`. Remove the old
   `/ws/processes/updates` path (the frontend is its sole caller and is updated here).
3. **Thread `project_id` through every `broadcast_state` call site** — all already have it
   in scope:
   - `backend/models/process.py:319, 967` — `process.project_id`.
   - `backend/models/process.py:499-519` (`update_state`) — already computes `project_id`
     (`:504-514`); pass it. (Payload is `{"refetch": true}` from the leak-fix plan.)
   - `backend/services/project_import_service.py:324, 346, 383` — `target_project_id`.
   - `backend/services/project_export_service.py:199, 238, 251` — `project_id`.
4. **Frontend** (`ProcessContext.jsx:427-432`): connect to
   `${WS_API}/ws/projects/${currentProject}/updates`, send the token from `onOpen`, and only
   enable for a real membership project — publication ids carry a `pub-` prefix
   (`backend/models/project.py:107`), so gate on `!currentProject.startsWith('pub-')` and a
   present `localStorage.auth_token`. `handleWebSocketMessage` is unchanged (still just
   `invalidateProject()`). The `useWebSocket.js:119` "no reconnect on `1008`" tweak from the
   leak-fix plan already applies.

**Known limitation:** membership is checked at connect time, so a user removed from a project
keeps their socket until it drops (matches JWT-until-expiry semantics). Add a periodic
re-check on the heartbeat `receive_text()` loop only if tighter revocation is needed.

---

## Test plan
- Connect with no token / a non-member token / a `pub-…` id → `close(1008)`, no messages.
- Member token, run a process in that project → `{"refetch": true}` on connect and on
  transitions; the UI refetches as before.
- Cross-project isolation: member of P1 subscribed to P1; run a process in P2 as another
  user → P1's socket receives nothing (the refetch fan-out is gone).
- Import/export: only members of the target project's socket are pinged.

## Affected files
- `backend/services/websocket_service.py` — per-project registry; `broadcast_state(project_id, …)`
- `backend/routers/processes.py:541-556` — authenticated per-project endpoint
- `backend/models/process.py:319, 499-519, 967` — pass `project_id`
- `backend/services/project_import_service.py:324, 346, 383` — pass `target_project_id`
- `backend/services/project_export_service.py:199, 238, 251` — pass `project_id`
- `frontend/src/ProcessContext.jsx:427-432` — per-project URL + token + real-project gate

(Depends on `authenticate_token` / `_is_project_member` from
[`ws-data-leak-fixes.md`](ws-data-leak-fixes.md).)

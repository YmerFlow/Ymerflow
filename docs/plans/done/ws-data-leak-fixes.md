# WebSocket data-leak fixes (security — fix now)

## Goal

Close the two **data-disclosure** holes in the WebSocket endpoints — both let someone read
data they have no access to. Neither is a performance concern; both should be fixed now.

Fixes [`docs/bugs/ws-state-broadcast-global-cross-project-leak.md`](../bugs/ws-state-broadcast-global-cross-project-leak.md)
(the state broadcast) and the companion logs-socket hole it flags in its Notes.

The remaining WebSocket issue — every client refetching on every global event — is a
**performance** problem, not a leak, and is deferred to
[`ws-state-socket-scoping.md`](ws-state-socket-scoping.md).

---

## Leak 1 — State broadcast leaks every project's process data to anyone

`/ws/processes/updates` is global and unauthenticated; on every state change it fans
`{process_id, version, state}` to every connected socket, and on `DONE` it attaches full
`outputs` — dataset ids, real cross-tenant `project_id`s, descriptive names, and **auth-free
`/files/` download URLs** (`backend/models/process.py:499-519`).

**Fix: strip every broadcast payload to a bare `{"refetch": true}` signal.** This works
because **the frontend never reads the message body** — the sole consumer
(`ProcessContext.jsx:421-432`, `handleWebSocketMessage`) ignores every field and just calls
`invalidateHelpers.invalidateProject()`. The socket is already only a "something changed —
refetch" doorbell, so with nothing on the wire there is nothing to leak, and the client
behaves identically.

Replace the payload at every `broadcast_state(...)` call site and delete the `outputs` block:

- **`backend/models/process.py:499-519` (`update_state`)** — the leak lives here. **Delete
  the `outputs` block (`:500-502`)** and the now-pointless `translate_urls_in_dict` call
  (`:516`); send `{"refetch": true}`.
- **`backend/models/process.py:319`** and **`:967`** — replace `{process_id, version,
  state}` with `{"refetch": true}`.
- **`backend/services/project_import_service.py:324, 346, 383`** — replace each
  `{type: "project_import", …}` with `{"refetch": true}`.
- **`backend/services/project_export_service.py:199, 238, 251`** — replace each
  `{type: "project_export", …}` with `{"refetch": true}`.

**No frontend change.** `handleWebSocketMessage` already ignores the body. Keeping the
explicit per-site calls (rather than hard-coding the signal inside `broadcast_state`) leaves
the later scoping work an easy diff — the sites all already have `project_id` in scope.

## Leak 2 — Logs socket is unauthenticated

`/ws/process/{process_id}/logs` (`backend/routers/processes.py:512-538`) `accept()`s with no
auth, then replays the full log history from the DB
(`SELECT … FROM process_logs WHERE process_id = :id`, `:521-530`) and streams new lines. The
**only** gate is *knowing the `process_id`* — an unguessable `uuid4`, but **not a secret**
(it appears in REST responses and URLs). Anyone who obtains one reads that process's entire
log output with no account. Unlike Leak 1, this cannot be stripped — the log lines *are* the
payload — so it needs real auth.

**Fix: authenticate the socket and require membership of the process's project.**

```python
@router.websocket("/ws/process/{process_id}/logs")
async def process_logs_websocket(websocket, process_id, version=None):
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)   # 1st msg = token
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await websocket.close(code=1008); return
    token = json.loads(raw).get("token")
    async with async_session_maker() as db:
        auth = token and await authenticate_token(token, db)
        pid = auth and (await db.execute(
            select(Process.project_id).where(Process.id == process_id))).scalar_one_or_none()
        if not auth or not pid or not await _is_project_member(db, pid, auth):
            await websocket.close(code=1008); return
    # ...existing replay + stream body, unchanged...
```

`Process.project_id` is one FK lookup (`backend/models/process.py:76`).

---

## Shared machinery (introduced here; reused by the scoping plan)

### Auth helpers (`backend/services/auth_service.py`)
- `authenticate_token(token, db) -> AuthContext | None` — factor the token→`AuthContext`
  body out of `get_current_user` (`:75-168`, currently coupled to `HTTPBearer(Request)` so it
  can't be injected on a `@router.websocket` handler). Reuses `decode_access_token` (`:66`)
  and the JWT / `apk_` / `upt_` logic. Never logs the raw token; returns `None` on invalid;
  lets unexpected errors propagate (CLAUDE.md rule 8).
- `_is_project_member(db, project_id, auth) -> bool` — the membership join
  (`select(Project).join(ProjectMember, …).where(Project.id == pid, ProjectMember.user_id ==
  auth.user.id)`, as in `require_project_member:200-204`) plus the API-key scope gate. **Real
  membership only** — must not fall back to the publication branch. (Operator decision:
  anonymous / publication viewers get no live logs feed.)

### Transport — first-message auth (not query param, not cookie)
Browsers cannot set an `Authorization` header on `new WebSocket(url)`
(`frontend/src/hooks/useWebSocket.js:82`). Options considered:
- **Cookie** — auto-sent on the handshake, zero client code, but this app uses a
  **localStorage Bearer token** (`api.js:29-41`), not a cookie; migrating REST auth to
  cookies (+ CSRF, cross-origin dev) is too big. Rejected.
- **Query param `?token=…`** — puts the token in URLs / proxy logs / history. Rejected.
- **First-message auth — chosen.** `accept()`, send nothing, read the first client message
  (the token), validate, then proceed or `close(1008)`. Token never hits a URL or log.

Cost: the first `receive_text()` **must** have an `asyncio.wait_for` timeout, or a client
that never sends a token holds the socket open forever.

### Frontend (logs socket only in this plan)
- `ProcessLog.jsx:100` and `ProcessProgress.jsx:153` keep their URL and send the token from
  the existing `onOpen` callback:
  `onOpen: () => send(JSON.stringify({ token: localStorage.getItem('auth_token') }))`.
- `useWebSocket.js:119` — do **not** reconnect on close code `1008` (add `&& event.code !==
  1008`), so a logged-out client doesn't hammer the endpoint.

(The state socket needs no frontend change in this plan — Leak 1 is payload-only.)

---

## Test plan

**Leak 1 (state payload):** open `/ws/processes/updates` unauthenticated, run a process to
completion → every message is exactly `{"refetch": true}`; no `outputs`, ids, names, or
`/files/` URLs ever appear. Frontend still live-refetches identically. Import/export still
refetches the UI.

**Leak 2 (logs auth):** against `/ws/process/<id>/logs` — no token / non-member token /
anonymous → `close(1008)`, no log lines. Member token → full replay + live stream as before.

## Affected files
- `backend/models/process.py:319, 499-519, 967` — strip state payloads; delete `outputs`
- `backend/services/project_import_service.py:324, 346, 383` — strip payloads
- `backend/services/project_export_service.py:199, 238, 251` — strip payloads
- `backend/services/auth_service.py` — add `authenticate_token`, `_is_project_member`
- `backend/routers/processes.py:512-538` — authenticate the logs socket
- `frontend/src/widgets/ProcessLog.jsx:100`, `frontend/src/widgets/ProcessProgress.jsx:153` — send token on `onOpen`
- `frontend/src/hooks/useWebSocket.js:119` — no reconnect on close code `1008`

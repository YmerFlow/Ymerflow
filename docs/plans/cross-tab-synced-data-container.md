# Cross-Tab Synced Data Container

## Goal

Let the user open a second browser tab/window that is **linked** to the first: both show the
same project / process / sounding selection, and both share client-side data that the user edits
but that is **not** persisted to the backend (manual edits, the AEM model-simulator "painted"
geology, etc.). Edits made in any linked tab appear in all the others.

This plan designs **one generic primitive** — a `SyncedStore` — plus the shared session
infrastructure it runs on (transport, leader election, ordering, persistence, loop-prevention).
It deliberately does **not** design the individual consumers' operation sets or their
state/diff serialization — those are left as open questions to be settled per consumer, when each
consumer is wrapped. The **final list of consumers** is likewise an open question; this plan only
builds the mechanism and wires up at most one proof-of-concept consumer.

### What is explicitly in scope

- The generic `SyncedStore` container (reducer-driven, op-based) and its subscribe/getState API.
- The per-origin **session** infrastructure shared by all stores: one `BroadcastChannel`,
  Web-Locks leader election with automatic failover, a per-store total-order sequencer, strict
  in-order apply, IndexedDB checkpoint + bootstrap, and the single loop-prevention rule.
- A generic **URL binding** adapter built on the same primitive, so selection
  (project/process/version/part/sounding) syncs across tabs and the URL stays a pure projection
  of synced state — without feedback loops when the user edits the URL in one tab.
- Opening a linked tab from the main tab, and the same-URL tab model that makes every tab a peer.

### What is explicitly out of scope (open questions, see end)

- The concrete op vocabulary and `serialize`/`deserialize` for each consumer.
- Which data objects become consumers (manual-edit diff, AEM model simulator, others).
- Any backend change. This is a purely client-side, same-origin feature.

---

## Background & Current State

### Selection is already a pure function of the URL

`frontend/src/ProcessContext.jsx` parses the pathname into
`{ workspace, workspaceVersion, project, process, version, part, sounding }`
(`parseUrlParams`, lines 24–66) and exposes each as derived state
(`selectedEnvironment`, `currentProject`, `activeProcess`, `currentPart`, `currentSounding`).
Every setter (`setCurrentProject`, `setActiveProcess`, `setCurrentPart`, `setCurrentSounding`, …)
just calls `navigate(buildUrlPath(...))`. There is no selection state outside the URL.

**Consequence for this feature:** selection sync *is* URL sync. The synced fields are
`project / process / version / part / sounding`. **`workspace` / `workspaceVersion` are NOT
synced** — the user wants each linked tab to show its own workspace (the `/w/:ws/wv/:v` segment is
per-tab). A tab reflecting a remote selection change must rewrite only the shared segments and
preserve its own `/w/.../wv/...`.

### Client-only editable data that is NOT in the URL or backend

- **Manual edits**: `inUseDiffState` via `inUseDiffReducer` in `ProcessContext.jsx` (line 146) —
  already an op/reducer shape (a natural fit for a `SyncedStore`).
- **AEM model simulator** (`frontend/src/widgets/AEMModelSimulator`): a paint-on-cross-section
  tool. Edits are parametric paint strokes applied to a diff that starts from an empty dataset;
  the base cross-section is itself parametric (layered earth). The accumulated grid can be large,
  but each stroke is tiny.

These are the data objects that today live only in the originating tab's memory — the thing this
feature exists to share. They are **candidate** consumers; the final list is an open question.

### Routing

react-router v7, mounted at the root. `/app/*` renders the main layout. Linked tabs will use the
**same** `/app/...` URL space as the main tab (see Decision 2) — no separate `/linked/<uuid>`
route.

---

## Design Decisions

### Decision 1: Reducer-driven, op-based container (chosen)

A `SyncedStore` is defined by a pure `reducer(state, op) → state` plus `serialize`/`deserialize`.
All mutation flows as **ops**. This is the generic primitive every consumer wraps; it knows
nothing about selection, paint, or diffs.

**Rejected:** syncing materialized state snapshots on every change (too big for the paint grid),
or a bespoke protocol per consumer (defeats the "one generic container" goal).

### Decision 2: Same-URL peer tabs + Web-Locks leader (chosen)

All linked tabs share one `/app/...` URL space and are **peers**. A leader is elected with the
Web Locks API using the never-resolving-lock pattern; when the leader's tab closes the browser
hands the lock to the next waiter automatically (**free failover**). The leader is only a
**sequencer** (assigns per-store `seq`); it is not a data owner.

Because every holder tab keeps the full materialized state of the stores it has open, and
IndexedDB holds a durable snapshot, closing any tab — leader included — never loses data.

**Rejected:** the `/linked/<uuid>` role-in-URL model where followers must die when the origin tab
closes. It is simpler to *start* but gives a worse UX (closing the origin kills the links), and the
transport/op layer is identical — so we build the peer model directly.

### Decision 3: The single loop-prevention rule (chosen)

There are exactly two entry points, kept strictly distinct:

- **`dispatch(op)`** = "a local intent happened here" → sent to the sequencer → stamped with
  `seq` → broadcast → applied. **This is the only path that ever broadcasts.**
- **`applySequenced(op)`** = "an already-ordered op arrived" → `reduce` + notify subscribers.
  **This path never broadcasts.**

Every projection of state — the React UI, the URL, the IndexedDB checkpoint — is a pure **output**
driven off `subscribe`. Inputs (UI actions, URL navigation) enter only via `dispatch`. Applying
never re-dispatches and outputs never feed back as inputs, so **no store can loop**, URL included.

### Decision 4: Small ops inline; big payloads via IndexedDB pointer (chosen)

`BroadcastChannel` structured-clones every message, so it must never carry a large payload.
Messages are therefore one of two kinds:

- `{ storeId, seq, origin, kind: 'inline', op }` — small ops ride inline.
- `{ storeId, seq, origin, kind: 'idb', key }` — a large payload is written to IndexedDB once by
  its producer, and only a small pointer is broadcast; each tab reads the blob from IDB once.

The size threshold / which kind a given op uses is a **consumer concern** (an open question), but
the mechanism is generic: the session provides "put this blob, get a key" and "read blob at key".

**Rejected:** SharedArrayBuffer (requires page-wide cross-origin isolation that can break existing
subresources; does not cleanly span independently-opened tabs; forces hand-rolled serialization +
`Atomics` for a capability this feature never needs). SharedWorker (correct but a large refactor —
the data model would have to move into the worker; revisit only if the peer model proves
insufficient).

### Decision 5: Single-leader total order, NOT a CRDT (chosen)

This is a single human user driving all tabs. Convergence is guaranteed by everyone applying the
**same leader-assigned `seq` order** (last-write-wins by order), with out-of-order messages
buffered until their `seq` is reached. CRDTs/vector clocks buy nothing here and add real
complexity. **State this explicitly so nobody "upgrades" it later.**

### Decision 6: Persistence is separate from sequencing (chosen)

Because workspaces are per-tab, no single tab (not even the leader) necessarily has every store
open. So "every tab holds full state" is true only *per store a tab has instantiated*. Therefore:

- **Leader** keeps only per-store `seq` counters (tiny) and rebroadcasts stamped ops. It does
  **not** need to materialize any store's data.
- **Each tab** materializes only the stores it has open, and **checkpoints those** to IndexedDB on
  a debounce.
- A tab opening a store (lazily, or on cold boot) **bootstraps from IndexedDB** (latest checkpoint
  + applies the tail of ops seen since), or from a warm peer/leader handoff if available.
- Ops for a store can only originate from a tab that has it open, so whenever a store receives ops
  some tab holds it and can persist it — no orphaned state.

---

## Component Design

### The primitive: `SyncedStore`

One instance per logical shared object. Created with a stable `id`, a `reducer`, and
`serialize`/`deserialize`. Public API (illustrative — exact names settled in implementation):

```js
const store = session.store({
  id: 'selection',                      // stable within the link session; also IDB key + bus tag
  reducer: (state, op) => nextState,    // pure, consumer-defined
  serialize:   (state) => bytes,        // for IDB checkpoint + bootstrap (default: structuredClone)
  deserialize: (bytes) => state,        // inverse of serialize
  initialState,
});

store.getState();                       // current materialized state
store.subscribe(fn);                    // called after every applySequenced; returns unsubscribe
store.dispatch(op);                     // LOCAL intent → sequencer → broadcast → apply
```

Internally the store holds: `state`, a per-store applied `seq` high-water mark, and a buffer for
out-of-order ops. `dispatch` → session sequencer; `applySequenced` → reduce + bump `seq` + notify
+ drain buffer. A wrapped data object becomes: *its mutators call `dispatch(op)` instead of
mutating; it rebuilds/notifies from `subscribe`.*

### The session: `SyncSession` (shared infrastructure)

One per browser tab, shared by all `SyncedStore`s in that tab. Responsibilities:

- **Transport**: owns a single `BroadcastChannel('ymerflow-sync-<sessionKey>')`. Routes inbound
  messages to the store named by `storeId`. (`sessionKey` — see Open Questions — scopes which tabs
  are linked; it is *not* the per-tab workspace.)
- **Leader election / sequencing**: `navigator.locks.request('ymerflow-sync-<sessionKey>-leader',
  { mode: 'exclusive' }, () => new Promise(() => {}))` — the holder is leader for its lifetime; the
  browser reassigns on close. The leader stamps each incoming `dispatch` with the next per-store
  `seq` and rebroadcasts the authoritative `{ storeId, seq, origin, kind, ... }`. Non-leaders send
  their dispatched op to the leader and apply only when the stamped op returns (uniform apply path;
  latency is an in-process `BroadcastChannel` round-trip — negligible on one machine).
- **Ordering**: per-store monotonic `seq`; receivers buffer gaps and apply strictly in order.
- **Blob store**: `putBlob(bytes) → key` / `getBlob(key) → bytes` over IndexedDB, for Decision 4's
  `kind: 'idb'` payloads.
- **Checkpoint / bootstrap**: `checkpoint(storeId, bytes, seq)` writes to IndexedDB on a debounce;
  `bootstrap(storeId) → { bytes, seq }` reads the latest checkpoint for a store opening cold.
- **Lifecycle signalling**: leader-changed / peer-joined events so a newly-opened store can request
  a warm snapshot instead of waiting for the next checkpoint.

### The generic URL binding: `UrlSyncBinding`

An adapter that binds the **selection** `SyncedStore` to the URL, built entirely on Decision 3:

- **state → URL (output):** subscribe to the store; on change, rebuild the path from the synced
  fields (`project/process/version/part/sounding`) **while preserving this tab's own
  `/w/<ws>/wv/<v>` segments**, and write it with `history.replaceState` (**not** react-router
  `navigate`/push). `replaceState` fires no `popstate` and performs no navigation, so reflecting
  state to the URL can never be read back as input — this is what stops the A→B→A URL ping-pong.
- **URL → state (input):** on load, parse the URL and `dispatch` the selection (genuine intent, so
  it propagates to peers). Back/forward fires `popstate` → parse → `dispatch`. An address-bar edit
  is a full navigation → handled as the next load's parse. All three re-enter through the single
  `dispatch` door.
- **Guard:** the output writer remembers the last URL string it wrote; the input side ignores a
  parsed selection equal to current state (belt-and-suspenders against redundant dispatch).

This replaces the direct `navigate(buildUrlPath(...))` calls in `ProcessContext.jsx`'s selection
setters with `selectionStore.dispatch(...)`, and makes `WorkspaceLayoutSync` / `AppBootstrap`
continue to work off the URL unchanged (workspace stays URL-driven and per-tab).

### Opening a linked tab

A menu/action in the main tab opens `window.open(currentSharedUrl, '_blank')` — same `/app/...`
URL (minus nothing; peers share the shared segments and each keeps its own workspace). The new tab
boots, joins the session (same `sessionKey`), elects/falls-in behind the leader, and bootstraps
each store it opens from IndexedDB or a warm peer. No `uuid` route segment is required; see Open
Questions for how `sessionKey` is chosen (per-origin single session vs. an explicit link id).

---

## Loosely-coupled consumer contract (what a consumer must provide)

To wrap an existing data object as a synced consumer, the consumer author supplies **only**:

1. A stable `storeId`.
2. A pure `reducer(state, op)`.
3. The **op vocabulary** (what ops exist, what they carry) — *open question, per consumer*.
4. `serialize`/`deserialize` for the state, and the choice of which ops (if any) are large enough
   to use the `kind: 'idb'` blob path — *open question, per consumer*.

Everything else (transport, ordering, election, persistence, loop-prevention, URL projection) is
provided by the session and is identical for all consumers.

---

## Implementation Steps

1. **`SyncSession`** (`frontend/src/sync/SyncSession.js`): BroadcastChannel transport, Web-Locks
   leader election + per-store sequencer, in-order apply with gap buffering, IndexedDB blob store +
   checkpoint/bootstrap, lifecycle events. No React.
2. **`SyncedStore`** (`frontend/src/sync/SyncedStore.js`): reducer/serialize container with
   `dispatch` / `applySequenced` / `subscribe` / `getState`, created via `session.store(...)`.
3. **React glue** (`frontend/src/sync/SyncProvider.jsx` + a `useSyncedStore` hook): provides the
   per-tab `SyncSession` in context and a hook to read/subscribe a store from components.
4. **`UrlSyncBinding`**: bind a selection store to the URL per the Component Design; repoint
   `ProcessContext.jsx` selection setters at `selectionStore.dispatch(...)`; keep workspace
   segments per-tab. Verify `WorkspaceLayoutSync` / `AppBootstrap` still behave.
5. **"Open linked window"** action (menu item) that `window.open`s the current shared URL.
6. **One proof-of-concept data consumer** (which one is an open question — likely the manual-edit
   diff, since `inUseDiffReducer` is already an op/reducer) to exercise the big-state /
   lazy-bootstrap / checkpoint paths end-to-end.
7. Manual verification (below).

---

## Verification

- Open a linked tab from the main tab: changing project/process/sounding in either tab is
  reflected in the other; each tab keeps its own workspace (`/w/.../wv/...`).
- Edit the URL's selection in one tab (address bar / back / forward): the change propagates to the
  other tab, and **no ping-pong** occurs (watch for runaway `replaceState`/history churn).
- Edit the proof-of-concept shared data in a follower tab: the change appears in the main tab and
  any other tab, in a consistent order.
- Open a third tab late: it bootstraps the current shared state (not an empty one) without
  replaying full history.
- Close the leader tab: the remaining tabs keep syncing (a new leader is elected) and lose no data;
  reload a tab and confirm it re-hydrates from IndexedDB.
- Confirm large payloads never cross `BroadcastChannel` (only `kind: 'idb'` pointers do).

---

## Open Questions

- [ ] **`sessionKey` / linkage scope.** Are *all* same-origin tabs one session (simplest — any two
      tabs you have open are linked), or is linkage explicit via a generated link id carried
      somewhere out-of-band (so you can have independent, unlinked tab groups)? The peer model
      supports either; pick the UX. Recommendation: start with a single per-origin session (no id),
      add explicit link groups later only if needed.
- [ ] **Per-consumer op vocabulary.** The concrete set of ops (and their payloads) for each
      consumer — selection, manual-edit diff, AEM model simulator, any others — is deferred to each
      consumer's own wrapping, not decided here.
- [ ] **Per-consumer `serialize`/`deserialize` and the inline-vs-IDB threshold.** How each
      consumer's state and ops are encoded, and which ops are large enough to use the IDB blob path,
      is a consumer concern. The session provides the mechanism; the policy is per consumer.
- [ ] **Final list of consumers.** Which data objects actually become `SyncedStore` consumers
      (beyond selection + the one proof-of-concept) is open. Candidates: manual-edit diff
      (`inUseDiffReducer`), AEM model simulator paint diff, others TBD.
- [ ] **Checkpoint cadence / snapshot vs. op-tail on bootstrap.** Debounce interval for IndexedDB
      checkpoints and whether cold boot replays a short op tail after the latest checkpoint or
      always waits for a fresh full checkpoint — tune during implementation against real grid sizes.
- [ ] **Leader hand-off of warm state.** Whether a newly-opened store requests a warm in-memory
      snapshot from a peer that already holds it (faster) or always goes through IndexedDB
      (simpler). Recommendation: IndexedDB first; add warm handoff only if join latency is a
      problem.
- [ ] **Interaction with react-router history.** `UrlSyncBinding` uses `history.replaceState`
      directly for the output side; confirm this coexists cleanly with react-router v7's history
      (it should, since we only replace, never push) and decide whether selection changes should
      ever create history entries at all.
```

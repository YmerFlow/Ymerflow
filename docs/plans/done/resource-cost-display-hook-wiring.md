# `resource_cost_display` hook wiring — pass account/plan data + detail level

## Goal

Fix two wiring gaps in how the host renders the `resource_cost_display` hook (currently the
billing plugin's `ResourceCostDisplay`) inside the Process Editor, so that a cost-display plugin
can (1) compute costs from the user's **actual plan rates** instead of a hardcoded fallback, and
(2) render a **compact summary** in the always-visible card footer but a **detailed per-resource
breakdown** in the resource modal.

Scope is the host side only: the `<CostDisplay>` call sites in
`frontend/src/widgets/ProcessEditor.jsx` and a short note documenting the extended hook contract.
It does **not** change any plugin, and it does **not** change what the hook *renders* — only what
data/props the host hands it.

## Background — the hook today

`ProcessEditor.jsx` resolves the hook once:

```js
// ProcessEditor.jsx:145
const CostDisplay = useMemo(() => hooks.run.resource_cost_display()[0]?.Component ?? null, []);
```

and renders the same component in **two** places, passing **identical** props both times:

- **Card footer** (`ProcessEditor.jsx:282-286`) — always visible in the editor.
- **Resource modal** (`ProcessEditor.jsx:335-339`) — the "Edit Resource Configuration" dialog.

```jsx
<CostDisplay cpuCores={cpuCores} memoryGb={memoryGb} deadlineMinutes={deadlineMinutes} />
```

Two consequences fall out of this:

1. **No plan data reaches the component.** The billing `ResourceCostDisplay` was written to read
   `accountData?.current_plan` for its rates, but the host never passes `accountData`. So the prop
   is always `undefined` and the component silently falls back to hardcoded
   `FALLBACK_CPU_RATE`/`FALLBACK_MEM_RATE` — it has **never** reflected the user's real plan rates.
   This is a pre-existing bug, not a design choice.

2. **The component can't tell the footer from the modal.** Both call sites are indistinguishable,
   so a plugin cannot render a compact line in one place and a full breakdown in the other.

The data the component needs already exists on the host's `user` object. The billing plugin's
server-side `user_to_dict` hook (`plugins/billing/billing/__init__.py:115-139`) already merges
`current_plan` (the full plan dict, including `cpu_rate_per_core_second` and
`memory_rate_per_gb_second`), `usage`, and `balance` into the user payload. That payload is what
`AuthContext` exposes as `user`. **The host already has the data — it just doesn't forward it.**

## Design decisions (confirmed with user)

1. **Extend the hook's prop contract, don't add an endpoint or a new context.** The host forwards
   the existing `user` object as `accountData`; no new fetch, no new backend surface.

2. **No core→plugin coupling.** `current_plan`/`usage`/`balance` are opaque fields the host merely
   forwards — the host does not know or care that they come from billing. When no billing (or
   cost-display) plugin is installed, `CostDisplay` is already `null` and nothing renders; when a
   plugin is installed but the user has no plan with rates, `accountData.current_plan` is `null`
   and the plugin decides what to show (the billing plugin will hide itself). The host does not
   branch on any of these fields.

3. **New props are additive and optional.** Any existing/third-party provider of the
   `resource_cost_display` hook that ignores the new props keeps working unchanged.

4. **`variant` is a plain label, interpreted by the plugin.** The host only says *where* it is
   rendering (`"summary"` in the footer, `"detailed"` in the modal). It does not decide what each
   level contains — that is the plugin's job.

5. **Accept mild staleness of `user`.** `AuthContext` hydrates `user` from the login response /
   localStorage and refreshes it on login; a plan-rate change mid-session may not be reflected
   until the next login. This is acceptable for a pre-run *estimate*. A general "refresh `user`
   from `/me`" mechanism is out of scope for this plan.

## Extended hook contract

```jsx
<CostDisplay
  cpuCores={number}
  memoryGb={number}
  deadlineMinutes={number}
  accountData={user}          // NEW: the AuthContext user object (has current_plan/usage/balance)
  variant={"summary" | "detailed"}  // NEW: which render context this is
/>
```

- `accountData` — forwarded verbatim from `AuthContext.user`. May be `null`/partial; the plugin
  handles that.
- `variant` — `"summary"` for the always-visible footer, `"detailed"` for the resource modal.

## Implementation

All changes in `frontend/src/widgets/ProcessEditor.jsx`.

1. **Import and read the auth context** (the component already imports several contexts via
   `useContext`; add `AuthContext`):

   ```js
   import { AuthContext } from '../AuthContext';
   // inside the component:
   const { user } = useContext(AuthContext);
   ```

2. **Footer call site** (`~282-286`) — pass `accountData` and `variant="summary"`:

   ```jsx
   <CostDisplay
     cpuCores={cpuCores} memoryGb={memoryGb} deadlineMinutes={deadlineMinutes}
     accountData={user} variant="summary"
   />
   ```

3. **Modal call site** (`~335-339`) — same `accountData`, `variant="detailed"`:

   ```jsx
   <CostDisplay
     cpuCores={cpuCores} memoryGb={memoryGb} deadlineMinutes={deadlineMinutes}
     accountData={user} variant="detailed"
   />
   ```

4. **Document the contract.** Add the two new props (`accountData`, `variant`) to the
   `resource_cost_display` hook description in the widget/hook docs
   (`docs/frontend/widgets.md` or wherever the hook is catalogued), noting they are optional and
   additive.

## Out of scope / follow-ups

- The billing plugin's own changes (reading `variant`, rendering the summary vs. the CPU/RAM
  breakdown, hiding when the plan has no rates, and the tokens-currency relabel) live in a
  **separate billing-plugin plan** and depend on this contract.
- Refreshing `user` from `/me` mid-session (staleness) — separate, if ever needed.

## Testing

- With a billing plan that has rates configured: footer shows the summary using the **real** plan
  rates (not the fallback); modal shows the detailed breakdown.
- With a plan that has no rates / no billing plugin: `CostDisplay` renders nothing (unchanged
  behavior), no console errors from `accountData` being absent.
- A hypothetical hook provider that ignores the new props still renders as before.

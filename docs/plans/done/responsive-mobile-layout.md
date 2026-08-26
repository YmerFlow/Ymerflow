# Responsive / Phone-Supporting Layout — Plan

## Context

Make the whole app usable on a phone-sized screen. On a small screen:

- The flexout **splits (vertical & horizontal) and grids stop tiling** and instead render
  their child widgets **stacked directly above each other**.
- **Tab sets stay tab sets** (already self-contained).
- **Widgets no longer get their own scrollbars** — the **entire page scrolls** instead.
- The **main menu collapses behind a small drag handle** centred at the top of the screen;
  **dragging or clicking the handle opens the menu**, which expands into a vertical **tree**:
  top-level entries stacked above each other, and opening a submenu expands it *inline* —
  indented one step below its parent, pushing the next top-level entry down.

### Decisions settled with the user (2026-08-26)

1. **Breakpoint: 576px (Bootstrap `sm`).** Mobile layout engages at `max-width: 575.98px`.
   True phones stack; anything tablet-sized keeps the desktop flexout layout.
2. **Mechanism: JS breakpoint conditioning**, *not* CSS `!important` overrides. A shared
   `useIsMobile()` hook (backed by `matchMedia` + its `change` event) drives conditional
   rendering. No `!important`, no touching inline styles from CSS.
3. **Each widget decides its own mobile height.** There is no host-imposed height rule.
   A widget that needs an intrinsic height sets one on mobile (all canvas/WebGL widgets do;
   the log widget also opts in, so it keeps a bounded height with its own internal scroll).
   Widgets that don't set a height grow to natural content height and let the page scroll.
   The height value is the widget's choice — no uniform default.
4. **Mobile menu is an inline accordion tree opened by a top-centre drag handle.** A small
   handle sits centred at the top of the screen; **drag it down or click it** to open the
   menu → vertical stack of top-level items; opening a dropdown expands its children inline
   (indented one step), pushing siblings down. No overlay pop-ups. Component entries are
   rendered inline in the same stack. The handle (and the open panel) is **sticky at the
   top** on mobile.

### The load-bearing invariant

**On any screen ≥ 576px the DOM tree and applied CSS must be byte-for-byte identical to
today.** Every change below is gated on `useIsMobile()` returning `true`; when it returns
`false` (desktop), each component renders exactly its current JSX with its current classes
and inline styles. No new class ever appears in the desktop DOM, and (because we add **no**
`@media` rules that could match ≥576px) no new CSS rule is ever *applied* on desktop.

This is why we chose JS conditioning over CSS `!important`: it makes the desktop path
provably unchanged (same code branch as today) instead of relying on a media query never
matching.

## Background — current state (confirmed by reading the code)

### The app shell is locked to viewport height — this is the root cause

`App.jsx:229-239` renders the authenticated shell as a full-viewport flex column:

```jsx
<div className="d-flex flex-column h-100">
  <MessageDisplay />
  <MenuBarWithComponents />
  <div className="flex-grow-1 overflow-hidden">   {/* App.jsx:233 */}
    <MainLayout />
  </div>
  ...
</div>
```

The flexout region is `overflow-hidden`, and every node below it is `h-100`, so the layout
tree is pinned to exactly the viewport height and **never grows the page**. Widgets scroll
internally instead. (Contrast `PageChrome` for `/account` and `/admin`, `App.jsx:155-165`,
which uses `flex-grow-1 overflow-auto` and *does* page-scroll.)

### Containers (all under `frontend/src/flexout/`)

- **`components/Split.jsx:58-64`** — flexbox. `.split-container` is `display:flex`;
  `split-vertical` → `row`, `split-horizontal` → `column` (`styling.scss:334-342`). Exactly
  2 children: first `style={{ flexBasis: size*100%, flexShrink:0 }}`, second `style={{ flex:1 }}`;
  a 5px `.split-divider` between them with a mouse-drag resize handler.
- **`components/Grid.jsx:152`** — CSS grid. Inline `gridTemplateColumns/Rows` built from
  `fr` fractions interleaved with literal `5px` divider tracks (`Grid.jsx:102-107`). Cells
  placed at `gridRow:2r+1, gridColumn:2c+1` (`Grid.jsx:116-123`); `rows*cols` children,
  `Empty`-padded. `.grid-container` is `display:grid; height:100%` (`styling.scss:326-331`).
- **`components/TabSet.jsx:240-276`** — Bootstrap `nav nav-tabs` strip; content area is
  `flex-grow-1 position-relative`; **every** tab body is `position-absolute top-0 start-0
  w-100 h-100` toggled `display:block/none`. All tabs stay mounted.
- **`components/Pane.jsx:217-274`** — universal wrapper for every node. Outer
  `d-flex flex-column h-100` (`:218`); widget body `flex-grow-1 overflow-auto` (`:270`).
  **This `overflow-auto` inside a height-constrained `h-100` chain is where per-widget
  scrollbars come from.**

### Menu (`frontend/src/flexout/`)

- **`MenuBar.jsx:102-111`** — `<nav className="navbar navbar-expand-lg navbar-dark">` with
  two `<ul className="navbar-nav">` (left = `position>=0`, right = `position<0`). **There is
  no `navbar-toggler` and no `.navbar-collapse`** — Bootstrap's built-in responsive collapse
  does not function today; on a narrow screen the items just wrap/overflow.
- Top-level entries are either a **registered component** (`BrandLogo`, `WorkspaceMenu`,
  `ProjectDropdown`, `ProcessSelector`, `UserMenu` — full react-bootstrap dropdowns) or a
  **data-driven dropdown** from the `menuTree` (`MenuContext.jsx`), rendered by
  `renderTopLevelItem`/`renderMenuItems` (`MenuBar.jsx:29-100`) using vanilla Bootstrap
  `data-bs-toggle="dropdown"` + recursive `<ul className="dropdown-menu">`.
- `MenuContext` distinguishes the two via `useRegisterMenu` (action/dropdown entries) vs
  `useRegisterMenuComponent` (component entries). No `unregister`.

### No responsive CSS exists

Repo-wide there are **zero `@media` rules** in `frontend/src`. The viewport meta tag *is*
present (`index.html:6`), so responsive rendering will take effect on real phones. Bootstrap
5 is fully imported (`styling.scss:66`) so its utilities are available.

### Widget height audit (confirmed by grep)

| Widget | File:line | Kind | Mobile treatment |
|---|---|---|---|
| FlowView | `widgets/FlowView/index.jsx:423` | react-flow canvas | **fixed mobile height** |
| PlotView | `widgets/PlotView/index.jsx:316` | gladly WebGL canvas | **fixed mobile height** |
| ProcessProgress | `widgets/ProcessProgress.jsx:228,250` | gladly canvas | **fixed mobile height** |
| AEMModelSimulator | `widgets/AEMModelSimulator/index.jsx:238` | 2D canvas | **fixed mobile height** |
| ProcessInfo | `widgets/ProcessInfo.jsx:97` | `p-3 h-100 overflow-auto` | grow naturally |
| ProcessLog | `widgets/ProcessLog.jsx:139,146` | `h-100` + `overflow-auto` | grow naturally |
| ClusterQueueView | `widgets/ClusterQueueView/index.jsx:20` | `height:100% overflow:auto` | grow naturally |
| EnvironmentView, Export, ProcessEditor, InUseEditor | — | natural flow | none |
| PluginManager | `widgets/PluginManager.jsx:19` | `h-100` only on the loading/centering wrapper | negligible; optional |

Plugin-provided widgets are out of scope for this plan but inherit the same convention (see
Non-goals).

## The shared primitive — `useIsMobile()`

New file `frontend/src/hooks/useIsMobile.js` (sibling of the existing `hooks/useWebSocket.js`):

```js
import { useState, useEffect } from 'react';

export const MOBILE_MEDIA_QUERY = '(max-width: 575.98px)';  // Bootstrap `sm` upper bound

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);           // resync in case it changed before listener attached
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}
```

This is the **resize-event guard** the constraint requires: state updates only when the
breakpoint is actually crossed (via the `matchMedia` `change` event), so a component that
branches on it re-renders correctly when the window is resized across 576px — not just at
mount.

## Frontend changes (all gated on `useIsMobile()`)

Each edit below is structured as: on desktop, unchanged code path; on mobile, the stacked path.

### 1. App shell — allow the page to scroll (`App.jsx:229-239`)

Swap `overflow-hidden` → `overflow-auto` on the flexout region only on mobile:

```jsx
const isMobile = useIsMobile();
...
<div className={`flex-grow-1 ${isMobile ? 'overflow-auto' : 'overflow-hidden'}`}>
  <MainLayout />
</div>
```

The outer `d-flex flex-column h-100` stays; the region beneath the menu bar becomes the
scroll container. On mobile the menu is collapsed behind a **sticky top-centre drag handle**
(see §7), so it stays reachable while the page scrolls.

### 2. Split — stack children (`components/Split.jsx`)

Add `const isMobile = useIsMobile();` and short-circuit before the desktop render:

```jsx
if (isMobile) {
  return (
    <div className="split-stack-mobile">
      <Pane parentUpdate={handleChildUpdate} {...node.children[0]} />
      <Pane parentUpdate={handleChildUpdate} {...node.children[1]} />
    </div>
  );
}
// ...existing desktop return unchanged (Split.jsx:58-64)
```

- `splitType` is ignored on mobile — vertical and horizontal both stack top-to-bottom.
- No inline `flexBasis`/`flex`, no `.split-divider` (drag-resize is meaningless when stacked),
  no forced height.
- `.split-stack-mobile` is a plain block container (`display:block`) — new CSS class that
  only ever exists in the mobile DOM.

### 3. Grid — single column (`components/Grid.jsx`)

```jsx
if (isMobile) {
  const realChildren = node.children.filter(c => c && c.widget !== 'Empty');
  return (
    <div className="grid-stack-mobile">
      {realChildren.map(child => (
        <Pane key={child.id} parentUpdate={handleChildUpdate} {...child} />
      ))}
    </div>
  );
}
// ...existing desktop return unchanged (Grid.jsx:152 + dividers)
```

- Children rendered in row-major order, `Empty` cells skipped (no blank gaps on a phone).
- No `gridTemplate*`, no `5px` divider tracks, no drag handles.

### 4. TabSet — stay tabs, but flow the body (`components/TabSet.jsx:240-276`)

Tabs remain tabs. The only problem is the body: today each body is `position-absolute h-100`,
which needs a height-constrained parent that no longer exists once the chain is broken. On
mobile, render bodies in **normal flow** so the active tab takes natural (or canvas) height,
while keeping all tabs mounted to preserve state:

```jsx
<div className={isMobile ? '' : 'p-0 flex-grow-1 position-relative'}>
  {node.children.map(tab => (
    <div
      className={isMobile ? '' : 'position-absolute top-0 start-0 w-100 h-100'}
      style={{ display: tab.id === activeTab ? 'block' : 'none' }}
    >
      <Pane ... {...tab} hideHeader />
    </div>
  ))}
</div>
```

The tab strip (`nav nav-tabs`) is unchanged.

### 5. Pane — natural height, no per-widget scrollbar (`components/Pane.jsx:217-274`)

On mobile, drop `h-100` from the outer wrapper and `flex-grow-1 overflow-auto` from the body,
so content flows at natural height and overflow becomes *page* scroll:

```jsx
const isMobile = useIsMobile();
...
<div className={`${hideHeader ? 'border-top ' : ''}d-flex flex-column ${isMobile ? '' : 'h-100'}`}>
  ...
  <div className={
    isMobile
      ? (hideHeader ? 'p-1' : 'pt-1')
      : `${hideHeader ? 'p-1' : 'pt-1'} flex-grow-1 overflow-auto`
  }>
    <WidgetErrorBoundary ...>
      <Widget parentUpdate={parentUpdate} {...node} />
    </WidgetErrorBoundary>
  </div>
</div>
```

The pane **header stays** on mobile — the chevron menu (switch widget / configure / remove)
is still useful. (Tab bodies keep `hideHeader` as today.)

### 6. Widgets — each decides its own mobile height

The host imposes no height. Once §5 stops `Pane` from constraining height on mobile, each
widget chooses: set an intrinsic mobile height (keeping its own internal scroll), or grow to
natural content height and let the page scroll. Import `useIsMobile` only in the widgets that
opt into a height.

**Widgets that set a mobile height** (they have no meaningful natural height, or deliberately
want a bounded scroll region). Each picks its **own** value — no shared default. Example,
PlotView (`widgets/PlotView/index.jsx:316`):

```jsx
<div className={isMobile ? 'd-flex flex-column' : 'h-100 d-flex flex-column'}
     style={isMobile ? { height: '70vh' } : undefined}>   {/* value is this widget's choice */}
```

- `PlotView/index.jsx:316`, `FlowView/index.jsx:423`, `ProcessProgress.jsx:228/250`,
  `AEMModelSimulator/index.jsx:238` — canvas/WebGL widgets; each sets the height that suits
  it. `AEMModelSimulator`'s `ModelCanvas` already sizes from
  `parentElement.getBoundingClientRect()` via a `ResizeObserver`, so a fixed-height parent is
  enough — no canvas-internal change.
- `ProcessLog.jsx:139,146` — **opts into a bounded height** on mobile (e.g. a `vh`-based
  height) and keeps its existing `flex-grow-1 overflow-auto` body, so a long log scrolls
  *inside* the widget instead of ballooning the page. This is the log widget exercising the
  same "widget decides" choice.

**Widgets that grow naturally** — remove the `h-100`/`overflow-auto` that would otherwise
collapse to 0 on mobile, and set no height:

- `ProcessInfo.jsx:97` — `p-3 h-100 overflow-auto` → `p-3` on mobile.
- `ClusterQueueView/index.jsx:20` — `height:100% overflow:auto` → drop both on mobile.

Already-natural widgets (`EnvironmentView`, `Export`, `ProcessEditor`, `InUseEditor`) need no
change. `PluginManager.jsx:19`'s `h-100` is only a loading-state centering wrapper — optional;
leaving it means the spinner is top-aligned on mobile, harmless.

### 7. MenuBar — drag-handle + accordion tree (`MenuBar.jsx`)

New sibling component `frontend/src/flexout/MobileMenu.jsx`. In `MenuBar.jsx`, branch at the
top:

```jsx
const isMobile = useIsMobile();
if (isMobile) return <MobileMenu leftItems={leftItems} rightItems={rightItems} />;
// ...existing desktop <nav navbar-expand-lg> return unchanged (MenuBar.jsx:102-111)
```

`MobileMenu`:

- Renders a **sticky top bar** (`position:sticky; top:0` with a z-index above the scrolling
  content) containing a small **drag handle centred horizontally** — a short pill/grip
  (e.g. a rounded bar, `.mobile-menu-handle`) rather than a hamburger square. A local
  `useState(open)` tracks whether the menu is expanded.
- **Opening:** the handle responds to both **a tap/click** (toggles `open`) and **a downward
  drag** (a pointer-drag past a small threshold sets `open`; dragging back up past the
  threshold closes it). Implemented with pointer events on the handle — `pointerdown` records
  the start Y, `pointermove` compares against a threshold, `pointerup` commits — no external
  gesture library. A tap that never crosses the threshold is treated as a click.
- When open, renders a **single vertical list** of all top-level items (left items then right
  items, preserving `sortMenuEntries` order) in the sticky panel, over the scrolling page.
- **Data-driven dropdown entries** (from `menuTree`): rendered by a new recursive
  `MobileMenuNode` that shows the label as a full-width row; tapping it toggles a local
  `expanded` state that renders its children **inline, indented one step** (e.g. a growing
  `padding-left` per depth), pushing subsequent rows down — the accordion tree the user
  asked for. Reuses the existing `menuTree` shape and `sortMenuEntries`; does **not** use
  Bootstrap `data-bs-toggle` (no overlay).
- **Component entries** (`BrandLogo`, `WorkspaceMenu`, `ProjectDropdown`, `ProcessSelector`,
  `UserMenu`): **rendered inline in the same vertical stack** — each component is placed as a
  full-width row, rendering its content in the flow rather than as an overlay pop-up. Where a
  component still relies on an overlay dropdown internally, that is acceptable for a first
  pass; touch-ups to make a given component render its options inline are done per component
  as they surface, not blocked on here.

New CSS (mobile-only classes, so never applied on desktop): `.mobile-menu-handle` (the
top-centre grip), `.mobile-menu-panel`, `.mobile-menu-node`, and an indent rule keyed on
depth. Added to `styling.scss`; because they
are applied only by `MobileMenu` (rendered only when `isMobile`), they never touch the
desktop DOM. (We may additionally wrap them in `@media (max-width: 575.98px)` as belt-and-
suspenders, but that is not required for correctness.)

## Desktop-identical guarantee — how we keep the promise

- Every edit is a conditional whose **`false` branch is the current code verbatim** (same
  classes, same inline styles, same element structure).
- `useIsMobile()` returns `false` for any viewport ≥ 576px, so on desktop every component
  takes the unchanged branch.
- We add **no `@media` rule that can match ≥576px**. The only new CSS classes
  (`.split-stack-mobile`, `.grid-stack-mobile`, `.mobile-menu-*`) are emitted **only** by
  mobile branches, so they never appear in the desktop DOM and their rules are never applied
  there.
- Verification includes a DOM/CSS diff at ≥576px (see Verification).

## Resolved design decisions (2026-08-26)

1. **Component menu entries** render inline in the vertical stack (§7) rather than as overlay
   pop-ups; per-component inline touch-ups happen as they surface, not blocked here.
2. **Widget height is the widget's own choice** (§6). The log widget opts into a bounded
   mobile height and keeps its internal scroll; it does not balloon the page.
3. **No shared canvas height default** — each widget picks its own mobile height value.
4. **Mobile menu opens from a small sticky drag handle** centred at the top — drag down or
   click to open, drag up or click to close (§7). No hamburger square.

## Implementation order

1. Add `hooks/useIsMobile.js`.
2. App shell scroll toggle (`App.jsx`) — verify the page scrolls on a narrow window.
3. `Pane.jsx` height/overflow toggle.
4. `Split.jsx` + `Grid.jsx` stacking.
5. `TabSet.jsx` body flow.
6. Widget heights (canvas fixed height; content widgets natural) — item 6 table.
7. `MobileMenu.jsx` + `MenuBar.jsx` branch + mobile menu CSS.
8. Full pass at 375px (iPhone) and 576/575px boundary.

## Verification

1. **Desktop-identical:** at ≥576px, diff the rendered DOM and computed styles of the app
   shell, a Split, a Grid, a TabSet, and the menu bar against `master`. Must be identical.
   Confirm `useIsMobile()` is `false` and no `.*-mobile`/`.mobile-menu-*` class is present.
2. **Breakpoint crossing:** resize the window across 576px repeatedly — layout flips both
   ways without reload (proves the resize-event guard works).
3. **Stacking:** on a 375px viewport, a nested vertical+horizontal split and a 3×3 grid each
   render their children in one scrolling column; no clipped/zero-height panes.
4. **Page scroll by default:** a widget that sets no mobile height (e.g. a tall table, an
   info dump) grows and scrolls the *page*, not itself. A widget that opts into a height
   (ProcessLog) scrolls *internally* within its bounded box while the rest of the page
   scrolls around it.
5. **Canvas widgets:** PlotView, FlowView, ProcessProgress, AEMModelSimulator each render at
   their mobile height (not 0px) and their canvas/WebGL content is visible and interactive.
6. **Tabs:** TabSet still shows a tab strip; switching tabs preserves state; the active tab
   body has correct height.
7. **Menu:** the top-centre drag handle opens the menu on **both** a click/tap and a
   downward drag, and closes on click or an upward drag; the handle stays sticky while the
   page scrolls; top-level items stack; tapping a data-driven dropdown expands its children
   inline/indented, pushing siblings down; component entries are reachable.

## Non-goals

- Internal responsive redesign of individual widget *content* (form field layout, table
  column hiding, etc.) beyond the height handling above.
- Touch-gesture affordances (swipe, pinch) beyond what widgets already implement.
- Popout/detached windows (not implemented in the codebase; `DetachedWindow.js` is unused).
- Auditing/retrofitting every plugin-provided widget. Plugins adopt the same convention
  (`useIsMobile` from the host; fixed mobile height for canvas widgets) as they are updated;
  this plan covers only the built-in widgets.
- Drag-to-resize / drag-to-rearrange on mobile (dividers and DnD are desktop-only by design
  here).
```
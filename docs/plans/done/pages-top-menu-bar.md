# Docs Site Top Menu Bar — Plan

## Goal

Add a full-width top menu bar to the GitHub Pages documentation site
(`ymerflow.org`), styled to match the YmerFlow web app's logged-out navbar (brand
gradient + wordmark). The bar contains:

- The **YmerFlow logo** (wordmark) on the left, linking to the docs home.
- A **Company / About** menu and submenu linking to `https://ymerflow.earth/page/about`
- A **"Try it!"** link on the right linking to `https://ymerflow.earth`

The existing left sidebar doc-nav stays as-is, below the new top bar
(layout: full-width top bar, then sidebar + content row underneath).

```
┌───────────────────────────────┐
│ [logo]         Try it!  About │  ← new gradient bar
├─────────┬─────────────────────┤
│ sidebar │  content            │
│  nav    │                     │
└─────────┴─────────────────────┘
```

## Background — how the docs site is built

Not Jekyll/MkDocs — a bespoke Python generator.

- **Workflow:** `.github/workflows/pages.yml` — on push to `master`:
  `pip install -r pages/requirements.txt` → `python pages/build.py` → upload
  `pages/_site/` → `actions/deploy-pages@v4`. Custom domain `CNAME` → `ymerflow.org`.
- **Generator:** `pages/build.py` (Python-Markdown + Jinja2 + Pygments). Renders
  `README.md` → `index.html` and each `docs/**/*.md` → matching `.html`, all
  wrapped in one Jinja2 template.
- **Template (chrome):** `pages/template.html`. Currently no top bar — chrome is a
  left `<aside id="sidebar">` with the logo (`frontend/public/YmerFlow.jpg` + text)
  and an auto-generated nav tree from the `docs/` directory.
- **Styling:** `pages/assets/style.css` — single file, its own `:root` variables
  (dark-slate `#1b2737` sidebar theme; *not* the app brand gradient). `body` is
  `display:flex` (sidebar + content as flex columns). Responsive: at
  `max-width:640px` the body switches to `flex-direction:column`.

## Background — the app's logged-out navbar style to match

(From `frontend/src/flexout/MenuBar.jsx`, `frontend/src/BrandLogo.jsx`,
`frontend/src/styling.scss`.)

- Markup: Bootstrap 5 `<nav class="navbar navbar-expand-lg navbar-dark bg-dark">`.
- `.navbar.bg-dark` is overridden to the **brand gradient**
  `linear-gradient(180deg, #050914, #091B2C)` (near-black → dark blue), light text.
- Logo: `frontend/src/assets/Logo-OnDark.svg` (horizontal wordmark, 234×75 viewBox),
  rendered at `height:28px`, inside `<a href="/">` with left/right margins.
- Font: **Sofia Sans**; brand link/secondary blue `#2269A7`, primary brown `#745E50`.

The docs `style.css` does not (and need not) pull in Bootstrap or Sofia Sans; we
replicate only the visual result (gradient bar + wordmark + light links) in plain
CSS so the docs site stays dependency-free.

## Design decisions (agreed)

- **Layout:** full-width top bar above the existing sidebar+content row. Keep the
  sidebar. (Chosen over "top bar replaces sidebar" and "links inside sidebar header".)
- **Logo asset:** use the app wordmark `Logo-OnDark.svg` for brand consistency, not
  the current `YmerFlow.jpg`.

## Open decision — how the logo SVG reaches the build

`Logo-OnDark.svg` lives in `frontend/src/assets/`, which `build.py` does **not**
copy (it only mirrors `frontend/public/*`). Two options:

- **Option A (recommended): extend `build.py`** to copy
  `frontend/src/assets/Logo-OnDark.svg` into `_site/assets/` (or a small brand
  dir). Keeps the SVG single-sourced from the app; no duplicate file to drift.
- **Option B: copy the SVG into `frontend/public/`** so the existing
  public-mirroring step picks it up. Simpler build change, but duplicates the asset
  and it can drift from the app's copy.

→ Proposed: **Option A**.

## Implementation steps

1. **`pages/build.py`** (Option A): after the `frontend/public` mirroring block
   (around lines 134–141), copy `frontend/src/assets/Logo-OnDark.svg` into
   `_site/assets/Logo-OnDark.svg` (guard with `.exists()`).

2. **`pages/template.html`**: add a `<header id="topbar">` as the **first** child of
   `<body>`, before `<aside id="sidebar">`. Contents:
   - `<a class="topbar-logo" href="{{ root_prefix }}index.html">` wrapping
     `<img src="{{ root_prefix }}assets/Logo-OnDark.svg" alt="YmerFlow">`.
   - A right-aligned nav with two `<a>`s:
     `Try it!` → `https://ymerflow.earth`,
     `Company / About` → `https://ymerflow.earth/page/about`
     (both `target="_blank" rel="noopener"` since they leave the docs site).
   - Because the top bar must span full width above the sidebar+content flex row,
     wrap the existing `#sidebar` + `#content` (+ optional `#toc-sidebar`) in a new
     `<div id="layout">` so the body becomes `topbar` (row 1) + `layout` (row 2).

3. **`pages/assets/style.css`**:
   - Change `body` from `display:flex` to `display:flex; flex-direction:column;`
     (stack top bar over the layout row).
   - Add `#layout { display:flex; flex:1; min-height:0; }` to hold sidebar+content
     as the horizontal row (moving the old body-level flex here).
   - `#sidebar` height: change `height:100vh` / `top:0` sticky so it's measured
     against the layout row, not the full viewport (e.g. sticky `top:0` still works
     but height should be `calc(100vh - <topbar-h>)`), so the sidebar doesn't push
     the page taller than the viewport. Verify scroll behavior.
   - Style `#topbar`: `background:linear-gradient(180deg,#050914,#091B2C)`,
     `display:flex; align-items:center; justify-content:space-between`,
     padding, `position:sticky; top:0; z-index:10`, light text.
   - `.topbar-logo img { height:28px; width:auto; }`.
   - Topbar links: light color, hover state, spacing matching the app feel
     (secondary blue `#2269A7` accent on hover is acceptable).
   - Responsive: at `max-width:640px`, ensure the top bar wraps/stacks sensibly and
     the existing sidebar-collapse rules still apply within `#layout`.

4. **Verify:** run `python pages/build.py` locally and open a couple of generated
   pages in `pages/_site/` (home + a nested `docs/**` page, to confirm
   `root_prefix` resolves the logo `../` correctly at depth). Check the top bar
   renders with gradient + wordmark, both external links work, and the sidebar +
   content + TOC still lay out correctly at wide and narrow widths.

## Files touched

- `pages/build.py` — copy the wordmark SVG into the site.
- `pages/template.html` — add `#topbar`, wrap body content in `#layout`.
- `pages/assets/style.css` — top bar styling + body/layout flex restructure.

## Out of scope

- No change to the app frontend, the sidebar nav generation (`build_nav`), or the
  `docs/` content.
- No new build dependencies (no Bootstrap/Sofia Sans on the docs site).

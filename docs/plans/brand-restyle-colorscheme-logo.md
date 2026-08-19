# Brand restyle: YmerFlow colorscheme, logo & typography

## Goal

Apply the YmerFlow style guide (`deps/StyleGuide/YmerFlow/`) to the frontend UI:

1. Re-theme Bootstrap 5.3.8 with the brand palette via Sass variable overrides.
2. Add the YmerFlow logo to the top toolbar (currently missing) and swap the
   landing-page raster for the real logo asset; update favicon/PWA icons.
3. Load **Sofia Sans** as the app font (Semibold headings, Bold small headings,
   Regular body).

This is a presentation-only change — no data model, API, or process logic is
touched.

## Design decisions (agreed with user)

- **Browns are for _primary_ only.** `$primary = #745E50`. Primary CTAs/buttons
  are brown (combined with other browns for hover/active depth as needed).
- **Blue accents are the normal UI chrome** — links, input focus rings, borders,
  hover/active outlines use the blue accent ramp (`#165096 / #2269A7 / #A1D2F0`).
- **Base colors carry the layout** — blackish `#050914` and whiteish `#F6F6F6`
  dominate; gray `#878787` is used sparingly.
- **Toolbar** uses the brand **gradient** (`#050914 → #091B2C`) with the
  `Logo-OnDark.svg` wordmark on the left; toolbar text/links are light.
- **Gradient** is used where it makes sense (toolbar; optionally the app/landing
  backdrop) — not everywhere.
- **Semantic colors** (success/danger/warning) are **desaturated to match the
  brown's saturation (~18% HSL)** so they sit in the same muted family rather
  than clashing with the earthy palette. ⚠️ See the note under §4 — at 18%
  saturation amber collides with the tan browns; final values need a
  distinguishability + contrast check.
- **Font:** Sofia Sans via `@fontsource/sofia-sans` (npm, self-hosted, no CDN).

## Brand palette reference (from the style guide)

```
Base
  #050914  blackish (base dark)          #F6F6F6  whiteish (base light)
  #878787  gray (sparingly)

Blue accents
  #091B2C  #003550  #165096  #2269A7  #4FB7D1  #A1D2F0  #BEDEF5

Brown accents (PRIMARY family only)
  #2E2418  #3F3222  #745E50  #8C7159  #B7A590  #C7C5C5

Background gradient
  linear-gradient(#050914 → #091B2C)
```

`#745E50` (the chosen primary) is HSL ≈ (23°, 18%, 38%) — hue ≈ 23, **saturation
≈ 18%**. That 18% is the saturation target for the muted semantic colors.

## Assets available

| Asset | Size / viewBox | Use |
|-------|----------------|-----|
| `Logo-OnDark.svg` | 234×75 (wordmark + icon) | Toolbar (dark bg) |
| `Logo-OnWhite.svg` | 234×75 (wordmark + icon) | Landing page (light bg) |
| `LogoIcon-500x500.png`, `LogoIcon-100x100.png` | square icon | favicon / PWA / apple-touch |
| `YmerIcon.svg`, `EarthIcon.svg` | icon-only | spare (not required) |

These live in `deps/StyleGuide/YmerFlow/` and must be **copied** into
`frontend/public/` and/or `frontend/src/` (a build cannot reference `deps/`
outside the frontend). Proposed destinations:

- `frontend/src/assets/Logo-OnDark.svg`
- `frontend/src/assets/Logo-OnWhite.svg`
- `frontend/public/favicon.ico` (regenerate from `LogoIcon`), `logo192.png`,
  `logo512.png`, and an `apple-touch-icon` from `LogoIcon-500x500.png`.

## Current state

- **`src/styling.scss`** — imports Bootstrap raw (`@import "bootstrap/scss/bootstrap"`),
  no variable overrides. Also contains ~30 hardcoded Bootstrap-gray hexes
  (`#6c757d`, `#dee2e6`, `#f8f9fa`, `#212529`, `#0d6efd`, …) in bespoke rules
  (`.tab-mini`, `.pane-menu-dropdown`, `.field-array`, `.card`, …).
- **`src/flexout/MenuBar.jsx`** — renders `<nav class="bg-dark navbar navbar-expand-lg navbar-dark">`;
  **no logo**. Left/right item groups come from the menu registry. ⚠️ `flexout/`
  is the generic layout engine — per CLAUDE.md we must **not** hardcode YmerFlow
  branding inside it.
- **`src/App.jsx`** — registers app-level menu components via
  `useRegisterMenuComponent([...], Component, position)` (e.g. ProjectDropdown at
  -2, ProcessSelector at -1, WorkspaceMenu at 2). Left group = position ≥ 0
  sorted ascending; **position 0 renders leftmost.**
- **`src/LandingPage.jsx`** — big logo top-left via `<img src="/YmerFlow.jpg">`;
  Sign-In / Pricing / Open-Source cards use Bootstrap `variant="primary"` /
  `"success"` / `"secondary"`.
- **Color usage across `src/`**: ~142 hardcoded hex literals in JSX/JS; Bootstrap
  `variant=` / `bg-*` / `text-*` classes throughout (primary/secondary/success/
  danger/warning/info/light/dark). Most inherit automatically once the theme is
  re-mapped; a handful of inline hexes need manual replacement.
- **No font** is currently loaded (default system stack).
- Bootstrap **5.3.8**, imported through Sass — variable overrides are supported
  by declaring them **before** the Bootstrap `@import`.

## Change

### 1. Dependencies

```bash
cd frontend
npm install --save @fontsource/sofia-sans
```

(Per CLAUDE.md rule 4: registry version, `--save`, ask before installing.)

### 2. Theme layer — `src/styling.scss`

Restructure the top of the file so brand variables and maps are declared
**before** Bootstrap is imported. Bootstrap's own functions must be imported
first so we can use `mix()`/`shade-color()` when deriving hover shades.

```scss
// Fonts (self-hosted Sofia Sans)
@import "@fontsource/sofia-sans/400.css";
@import "@fontsource/sofia-sans/600.css";
@import "@fontsource/sofia-sans/700.css";

// 1. Bootstrap functions (needed before variable overrides)
@import "bootstrap/scss/functions";

// 2. Brand palette
$brand-black:   #050914;
$brand-white:   #F6F6F6;
$brand-gray:    #878787;

$blue-900:      #091B2C;
$blue-800:      #003550;
$blue-600:      #165096;
$blue-500:      #2269A7;
$blue-400:      #4FB7D1;
$blue-300:      #A1D2F0;
$blue-200:      #BEDEF5;

$brown-900:     #2E2418;
$brown-800:     #3F3222;
$brown-600:     #745E50;   // PRIMARY
$brown-500:     #8C7159;
$brown-300:     #B7A590;
$brown-200:     #C7C5C5;

$brand-gradient: linear-gradient(180deg, #{$brand-black}, #{$blue-900});

// 3. Bootstrap variable overrides
$primary:        $brown-600;            // brown — primary CTAs
$secondary:      $blue-500;             // blue  — "normal stuff"
$body-color:     $brand-black;
$body-bg:        $brand-white;

// Chrome uses blue, not the brown primary:
$link-color:               $blue-500;
$link-hover-color:         $blue-600;
$border-color:             $blue-200;   // subtle blue borders
$input-border-color:       $blue-300;
$input-focus-border-color: $blue-500;
$focus-ring-color:         rgba($blue-500, .25);
$component-active-bg:      $blue-600;    // selected/active list items, etc.

// Semantic colors — muted to ~18% saturation (see §4)
$success: #4E6B54;   // provisional — verify
$danger:  #8A5A57;   // provisional — verify
$warning: #A99366;   // provisional — verify
$info:    $blue-400;

// Typography
$font-family-sans-serif: "Sofia Sans", system-ui, -apple-system, "Segoe UI",
                         Roboto, sans-serif;
$headings-font-weight:   600;   // Semibold headings

// 4. Bootstrap core
@import "bootstrap/scss/variables";
@import "bootstrap/scss/maps";
@import "bootstrap/scss/mixins";
@import "bootstrap/scss/bootstrap";

// 5. FontAwesome (unchanged)
@import "@fortawesome/fontawesome-free/scss/fontawesome";
@import "@fortawesome/fontawesome-free/scss/solid";
```

Then, **de-hardcode the bespoke rules** already in this file so they follow the
theme instead of literal Bootstrap grays:

- `.tab-mini.active` `#212529` → `$dark` / `$primary` as appropriate.
- `.pane-menu-toggle`, `.field-description-icon i` hover `#0d6efd` → `$link-color`.
- `.card .card-header`, `.field-array .array-item`, `.panel…` backgrounds
  `#f8f9fa` / borders `#dee2e6` → `$gray-100` / `$border-color`.
- `.split-pane` border `#999999` → `$border-color`.
- `.open-source-link` hover `#0d6efd` → `$link-color`.

(Keep the diff mechanical — swap literals for the matching Sass variable; no
layout changes.)

### 3. Toolbar gradient + logo

**Gradient (no `flexout/` edit):** style the app navbar from `styling.scss` so
the generic layout engine stays brand-free:

```scss
.navbar.bg-dark {
  background: $brand-gradient !important;   // overrides Bootstrap .bg-dark
}
```

`navbar-dark` already gives light text/links, which read correctly on the dark
gradient.

**Logo as a registered menu component (app-level, not `flexout/`):**

- New file `src/BrandLogo.jsx`:

  ```jsx
  import logo from './assets/Logo-OnDark.svg';
  export default function BrandLogo() {
    return (
      <a href="/" className="navbar-brand d-flex align-items-center py-0 me-3">
        <img src={logo} alt="YmerFlow" style={{ height: '28px', width: 'auto' }} />
      </a>
    );
  }
  ```

- In `App.jsx`, register it at the leftmost position (0 < WorkspaceMenu's 2):

  ```js
  useRegisterMenuComponent(["_brandLogo"], BrandLogo, 0);
  ```

  This puts the logo first in the left group with zero changes to
  `flexout/MenuBar.jsx`.

### 4. Semantic colors — muted to the brown's saturation

Target: HSL saturation ≈ **18%** (matching `#745E50`), keeping each hue's
identity and enough lightness for AA-contrast button text.

Provisional starting values (hue kept, S≈18%, L tuned for legibility):

| Role | Hue | Provisional hex | Note |
|------|-----|-----------------|------|
| success | ~140° green | `#4E6B54` | reads as muted green |
| danger  | ~5° red | `#8A5A57` | muddy at 18% — may need lower L / slightly higher S to read as "error" |
| warning | ~40° amber | `#A99366` | ⚠️ **collides with tan brown `#B7A590`** — likely needs a hue/lightness nudge to stay distinct from primary |

**Action during implementation:** compute exact values from HSL, then run a quick
check that (a) button text meets WCAG AA contrast, and (b) `warning` is visually
distinguishable from the brown primary/`$brown-300`. If 18% amber is
indistinguishable, nudge warning's lightness up or hue toward yellow and note the
deviation. Surface the final swatches to the user before locking them.

### 5. Landing page — `src/LandingPage.jsx`

- Replace `<img src="/YmerFlow.jpg" …>` with the vector on-white logo:
  `import logo from './assets/Logo-OnWhite.svg'` → `<img src={logo} …>`
  (keep the existing `maxWidth: 200px` sizing).
- Buttons already use semantic `variant`s and will pick up the new theme
  automatically — no per-button color edits needed.
- Optionally apply `$brand-gradient` as the page backdrop if it reads well
  behind the cards (decide visually; default = keep white body).

### 6. Favicon / PWA icons & metadata

- Regenerate `public/favicon.ico`, `public/logo192.png`, `public/logo512.png`
  from `LogoIcon-500x500.png`; add an `apple-touch-icon`.
- `public/index.html`: `<meta name="theme-color" content="#050914">` (brand
  black, currently `#000000`).
- `public/manifest.json`: fix stale CRA defaults — `"short_name": "YmerFlow"`,
  `"name": "YmerFlow"`, `"theme_color": "#050914"`,
  `"background_color": "#F6F6F6"`.

### 7. Sweep remaining hardcoded hex in JSX

~142 hex literals exist across `src/`. Most are functional (plot colors, status
indicators) and out of scope. In scope: **UI chrome** hexes that visibly clash
with the new theme — e.g. any inline `#007bff` / `#0d6efd` (old Bootstrap blue)
used for links/buttons/focus should become the blue accent or a `variant`/class.
Enumerate with:

```bash
grep -rniE "#0d6efd|#007bff|#6c757d|#212529" frontend/src --include=*.jsx --include=*.js
```

Fix chrome usages; leave data-viz / plot colors alone. Keep this pass
conservative and list anything ambiguous for the user rather than guessing.

## Files touched

| File | Change |
|------|--------|
| `frontend/package.json` | add `@fontsource/sofia-sans` |
| `frontend/src/styling.scss` | brand vars + Bootstrap overrides + font import + navbar gradient + de-hardcode bespoke rules |
| `frontend/src/BrandLogo.jsx` | **new** — toolbar logo component |
| `frontend/src/App.jsx` | register `BrandLogo` at position 0 |
| `frontend/src/LandingPage.jsx` | swap raster → `Logo-OnWhite.svg` |
| `frontend/src/assets/Logo-OnDark.svg`, `Logo-OnWhite.svg` | **new** — copied from StyleGuide |
| `frontend/public/{favicon.ico,logo192.png,logo512.png,apple-touch-icon.png}` | regenerated from LogoIcon |
| `frontend/public/index.html` | theme-color |
| `frontend/public/manifest.json` | name/short_name/theme/background |
| chrome hex sweep (a few JSX files) | old Bootstrap blue → accent |

**No `flexout/` files are modified** — the toolbar gradient is applied from
app-level `styling.scss` and the logo is injected via the existing menu
registry.

## Verification

1. `cd frontend && npm start` — app compiles, no Sass errors.
2. **Landing page (logged out):** on-white vector logo top-left; Sign-In primary
   button is brown; links/focus rings are blue; Sofia Sans renders.
3. **Toolbar (logged in):** dark gradient background; OnDark logo leftmost;
   existing menus/dropdowns unaffected and legible on the gradient.
4. **Buttons/badges:** primary = brown; secondary/info = blue; success/danger/
   warning = muted-but-distinguishable; all button text passes AA contrast.
5. Favicon and PWA install show the YmerFlow icon; browser tab theme-color is
   brand-black.
6. No obvious old-Bootstrap-blue (`#0d6efd`) chrome remains.
7. `npm run build` succeeds.

## Out of scope

- Plot / data-visualization color schemes (functional encodings).
- Backend, API, or any non-visual behavior.
- A full design-token / CSS-variable system beyond Bootstrap's Sass theming.

## Open items to confirm before/at implementation

1. Final muted semantic hexes (esp. warning vs. tan-brown distinguishability) —
   show swatches for sign-off (§4).
2. Whether to apply the brand gradient behind the landing-page cards or keep a
   white body (§5).

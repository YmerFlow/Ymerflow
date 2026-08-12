# Great Rename — Frontend-Internal Cosmetic Occurrences

## Goal

Rename the remaining `nagelfluh`/`Nagelfluh` occurrences that are **self-contained inside the
frontend package**, carry no persisted data, and aren't referenced by any other package in the
repo. These are the lowest-risk part of the wider rename (see the sibling `great-rename-*.md`
plans for everything else) — this plan is close to a mechanical find/replace.

> **Correction (post-investigation).** An earlier draft of this plan treated the
> `window.__nagelfluh_*` globals as frontend-internal. They are **not** — the plugin SDK
> (`deps/Ymerflow-plugin-sdk/js/index.js`) reads `window.__nagelfluh_registerHook`/`_hooks`, so
> they're part of the host↔plugin **bridge contract** and have moved to
> `great-rename-3-entrypoint-namespace.md` (which now owns the whole cross-repo bridge rename).
> This plan covers only the genuinely frontend-local, no-external-reader items below.

## Background — current state

Confirmed by reading each file (not just grepping):

- **`window.__nagelfluh_*` globals — MOVED OUT of this plan.** These (`AuthContext.jsx`,
  `MessageContext.jsx`, `App.jsx`, `plugins/hooks.jsx`, `scripts/export-widget-schemas.mjs`) are
  read by the plugin SDK and are part of the bridge contract — see
  `great-rename-3-entrypoint-namespace.md`. Not renamed here.

- **Module Federation host name** — `name: 'nagelfluh_host'`:
  - `frontend/vite.config.js:9` — the actual federation config
  - `frontend/src/plugins/loadPlugin.js:9` — a second literal that must match it (checked: no
    shared constant between the two today, they're just kept in sync by hand)
  - Confirmed via `grep -rln "nagelfluh_host" --include=*.js --include=*.jsx .` (excluding
    `node_modules`/`build`) that these are the **only two source occurrences** in the repo — no
    plugin package under `plugins/` or `tests/plugins/` hard-codes this host name.
  - `frontend/node_modules/.vite/deps/*.js` (8 files) contain `virtual:mf:__mfe_internal__
    nagelfluh_host__loadShare__...` strings — this is **Vite's dependency pre-bundling cache**,
    generated fresh from `vite.config.js`'s `name` field on every `vite dev`/`vite build`. Not
    source, not committed for its content to matter — out of scope for manual editing, see
    Implementation Steps.

- **IndexedDB cache database name** — `frontend/src/datamodel/dataset.js:38`:
  `const DB_NAME = "NagelfluhCache"`. Purely a client-side cache key; renaming it means existing
  users' browsers open a *new* empty IndexedDB store under the new name on next load (the old
  `NagelfluhCache` store is simply abandoned, not migrated) — functionally identical to a cache
  version bump, no data loss beyond a one-time cache-repopulation cost.

- **Image asset + license file**:
  - `frontend/public/Nagelfluh.jpg` (referenced by `frontend/src/LandingPage.jsx:14`,
    `src="/Nagelfluh.jpg"` — note the `alt` text next to it already reads `"YmerFlow"`, and the
    rest of `LandingPage.jsx` already says "YmerFlow" throughout; only the image filename/path
    lags behind) and its sidecar `frontend/public/Nagelfluh.jpg.LICENSE`.
  - `frontend/build/Nagelfluh.jpg.LICENSE` and the compiled references inside
    `frontend/build/static/js/main.ce52ac64.js`/`.js.map` are a **stale prior build** — confirmed
    by diffing against current `LandingPage.jsx` source, which no longer contains the old
    "Nagelfluh Geophysics" heading text or `github.com/SagebrushGeoTools/Nagelfluh` links that
    the stale build still has baked in. `frontend/build/` is `npm run build` output, not
    hand-maintained — out of scope for manual editing, see Implementation Steps.

- **MCP server example string** — `frontend/src/AccountPage.jsx:18,22,94,213`: the Account page
  shows users a copy-pasteable `claude mcp add --scope user --transport http nagelfluh ...`
  command and a matching `{"mcpServers": {"nagelfluh": {...}}}` JSON snippet, plus prose
  mentioning `.claude/settings.json`. This is **just example/display text** — the literal string
  `nagelfluh` here is the *suggested* local server name a user's own `claude mcp add` invocation
  would register under; it has no runtime tie to this repo's actual MCP endpoint (`MCP_URL`,
  built from the API base) or to how this session itself is configured. Renaming it to `ymerflow`
  is purely cosmetic and doesn't require any backend change — flagged in Open Questions only
  because it's user-facing copy, not because it's technically risky.

- **`frontend/.claude/settings.local.json:9`** — `"Bash(git -C
  /home/redhog/Projects/beta/Nagelfluh log --all --oneline --grep=outputs)"`. This is a
  **local filesystem path** (the actual clone directory name on this machine), not project
  source — it isn't part of the rename at all unless the working directory itself is renamed,
  which is outside the scope of a code change. Excluded.

## Design decisions

- **Rename the MF host name `nagelfluh_host` → `ymerflow_host`** in the two source files, then
  regenerate the Vite dep cache (delete `frontend/node_modules/.vite` and let the dev server
  rebuild it) rather than hand-editing the generated files.
- **Rename the image file** `Nagelfluh.jpg` → `YmerFlow.jpg` (and its `.LICENSE` sidecar),
  updating the one reference in `LandingPage.jsx`. The license file's *content* (attribution to
  the Wikimedia Commons source image) doesn't change — only the filename, to match the renamed
  asset it documents.
- **`frontend/build/` is excluded from this plan.** It's regenerated by `npm run build`, which
  should be re-run once the source-level renames in this plan (and any other in-scope frontend
  changes) land — not hand-edited.

## Implementation Steps

1. **MF host name**: update `vite.config.js:9` and `plugins/loadPlugin.js:9` to
   `'ymerflow_host'`. Delete `frontend/node_modules/.vite` so the next `npm start`/`vite build`
   regenerates the dependency cache under the new virtual module IDs — do not hand-edit the
   `.vite/deps/*.js` files.
3. **IndexedDB cache name**: change `DB_NAME` in `dataset.js:38` to `"YmerFlowCache"`.
4. **Image asset**: rename `frontend/public/Nagelfluh.jpg` → `frontend/public/YmerFlow.jpg` and
   `Nagelfluh.jpg.LICENSE` → `YmerFlow.jpg.LICENSE` (`git mv` to preserve history), update the
   `src="/Nagelfluh.jpg"` reference in `LandingPage.jsx:14`.
5. **AccountPage.jsx MCP example text**: change the four `nagelfluh` occurrences (CLI command ×2,
   JSON key, and confirm no other spot) to `ymerflow` (decided — see Resolved decisions).
6. **Rebuild**: run `npm run build` in `frontend/` so `frontend/build/` picks up every change
   above (including the now-current "YmerFlow" text that was already in source but stale in the
   committed build output) instead of hand-touching build artifacts.
7. Manual verification in the browser (per `CLAUDE.md`'s UI-change testing rule): app loads with
   no console errors referencing the old global names, landing page image renders from the new
   path, IndexedDB tab in devtools shows the new store name after a hard refresh, Account page
   shows the updated MCP snippet.

## Resolved decisions

- **AccountPage MCP example → rename to `ymerflow`** (settled 2026-08-12). Pure display text, no
  technical risk. Note this repo's *own* currently-configured MCP server (visible in-session as
  `mcp__nagelfluh__...`) is a separate local configuration this plan doesn't touch; updating it
  is a one-time manual `claude mcp remove nagelfluh` / `claude mcp add ... ymerflow` per machine,
  independent of this plan.

## Open Questions

- [ ] None outstanding.

# FlowView — filter by tag *name*, not tag id

**GitHub Issue:** #17 (supersedes the stub `stub-process-overview-empty.md`)
**State:** planning
**Labels:** bug, frontend

## Problem

The Process overview (FlowView) intermittently — and now, for at least one shared
workspace, permanently — renders empty even though the project has processes (the
process-selector dropdown still lists them all).

### Root cause (confirmed against production data)

The workspace layout persists the FlowView tag filter as a list of tag **ids**
(`selectedFilterTagIds`). Tags are **entirely per-project**: `process_tags` has a
NOT-NULL `project_id`, ids are per-project UUIDs, and a version→tag link only ever
references a tag owned by that version's project. There is no global tag namespace.

The "Default" workspace is **public** (owned by project `c919813b…`). When it is
viewed against a *different* project, it carries its persisted filter with it. In the
reported case the persisted filter is `["2063ff23…"]` = the tag **"Final"**, which is
owned by project `273c67c5…`. The viewed project (`2e02c2b4…`) has **zero** versions
carrying that id, so:

- `computeVisibleVersions` returns an empty visible-set → every node is `hidden`.
- `initialise` finds no visible sinks → `selectedVersions` is `{}` → the layout effect
  early-returns.

Both paths blank the canvas. Worse, the filter is **invisible and unclearable**:
`TagFilterBar` only renders chips for tags in the *current* project, so a foreign tag
id shows no chip and cannot be removed.

Verified by running the real `computeVisibleVersions`/`initialise` code against the
live graph (83 processes): `versions carrying 'Final' = 0`, `visible = 0`,
`hidden = 83/83`, `selectedVersions = {}`.

(The older, pre-tag-filtering "random, reload sometimes fixes it" variant of #17 was a
separate `processes.length !== selectedVersions.length` equality gate in the previous
layout effect; that gate no longer exists in the current rewrite, so this plan does not
address it.)

### The design defect

Storing tag **ids** is the mistake. An id only has meaning in its owning project, so a
filter persisted in a (shared) workspace is meaningless in any other project. The
semantically stable key across projects is the tag **name** (e.g. "show me the *Final*
results in whatever project I'm looking at"). Names are a clean de-facto key: there are
currently **zero** duplicate `(project_id, name)` rows in production (no DB constraint
enforces it, but the UI treats names as unique per project).

## Decisions

1. **Persist names, not ids.** Rename the FlowView node's layout field
   `selectedFilterTagIds` → `selectedFilterTagNames` (a list of strings). The rename
   makes the format change explicit and lets migration detect legacy layouts.
2. **Absent-name semantics = match-zero (strict).** A saved filter name with no
   matching tag in the current project matches **no** versions (the view is blank),
   *but the name always renders as a removable chip*. This preserves literal filter
   intent (a filter for "Final" must not silently show everything) while guaranteeing
   the user can always clear it. The clearable chip is the safety valve, not
   auto-ignoring.
3. **Match by name is available client-side.** Each version's `tags[]` already includes
   `{id, name, color}` (`ProcessTag.to_dict`), so no backend/API change is needed for
   matching.
4. **`TagInput.onRemove` hands back the tag object, not `tag.id`.** Today `onAdd`
   already passes a **name** (the typed string) while `onRemove` passes `tag.id` — an
   asymmetry. The two `TagInput` consumers need *different* keys: `TagSelector` must
   remove by real **id** (`removeVersionTag({ tagId })`), while the name-based filter
   wants the **name**. So change `TagInput` to call `onRemove(tag)` (the whole object);
   each consumer reads the field it needs — `TagSelector` reads `tag.id`, `TagFilterBar`
   reads `tag.name`. This avoids overloading `.id` to carry a name (an earlier draft's
   hack) and keeps `.name` meaning the name. (Rejected alternative: `onRemove(tag.name)`
   would force `TagSelector` to re-resolve name→id and would lean on per-project name
   uniqueness, which no DB constraint enforces.)
5. **Migrate existing layouts** so legitimate same-project filters survive the rename
   (see Migration).

## Implementation plan

### Step 1 — `computeVisibleVersions` seeds by name

File: `frontend/src/widgets/FlowView/index.jsx`.

- Rename the parameter `selectedFilterTagIds` → `selectedFilterTagNames` (a
  `Set<string>`).
- Change only the **seed** predicate: a version is seeded visible when its tags' names
  contain **all** filter names:
  ```js
  const vTagNames = new Set((v.tags || []).map(t => t.name));
  if ([...selectedFilterTagNames].every(name => vTagNames.has(name))) markVisible(...);
  ```
- The transitive BFS over `dependencies` (which reference `source_process_id` /
  `source_process_version` — both intra-project) is **unchanged**. The returned
  `Map<processId, Set<versionNumber>>` shape is unchanged, so `initialise`,
  `propagate`, node/edge building, and `ProcessNode`'s version `<select>` need no
  changes.

### Step 2 — FlowView state, prop, toggle handler

Same file:

- Prop: `selectedFilterTagNames: savedFilterTagNames = []` (was `selectedFilterTagIds`).
- `const selectedFilterTagNames = useMemo(() => new Set(savedFilterTagNames), [savedFilterTagNames]);`
- `filterKey` = `[...selectedFilterTagNames].sort().join(',')` (unchanged purpose).
- `handleToggleFilterTag(tagName)`: toggle the **name** in the set and persist:
  ```js
  parentUpdate?.('replace', nodeProps.id, { ...nodeProps, selectedFilterTagNames: [...next] });
  ```
- Update the `useMemo`/effect dep arrays that referenced `selectedFilterTagIds`.
- Pass `selectedTagNames={selectedFilterTagNames}` to `<TagFilterBar>`.

### Step 3 — `TagFilterBar` renders name chips (match-zero, always clearable)

File: `frontend/src/widgets/FlowView/TagFilterBar.jsx`.

- Props: `projectTags`, `selectedTagNames` (`Set<string>`), `onToggle` (by name).
- Build chips from **names**, using the real project tag object when present (so the
  chip keeps its color) and a synthesized placeholder for an absent (foreign) name.
  Removal reads `tag.name` (per Step 3b), so no `.id` overloading:
  ```js
  const byName = new Map((projectTags || []).map(t => [t.name, t]));
  const selectedTags = [...selectedTagNames].map(name => byName.get(name) || { name });
  const availableTags = (projectTags || []).filter(t => !selectedTagNames.has(t.name));
  if (selectedTags.length === 0 && availableTags.length === 0) return null;
  const handleAdd = async (name) => { if (byName.has(name)) onToggle(name); };
  const handleRemove = async (tag) => onToggle(tag.name);
  ```
- A placeholder `{ name }` has no `id`; `TagInput`'s `key` must fall back to the name
  (see Step 3b).
- This absorbs and replaces the interim clearable-chip patch already applied to this
  file (see "Interim change" below).

### Step 3b — `TagInput` removal by object; `TagSelector` reads the id

Files: `frontend/src/widgets/FlowView/TagInput.jsx`, `.../TagSelector.jsx`.

- `TagInput`: change the three `onRemove(tag.id)` call sites (backspace, delete, badge
  ×) to `onRemove(tag)`. Make the badge `key` tolerate id-less placeholders:
  `key={tag.id ?? tag.name}`. `onAdd` is unchanged (still passes the typed name).
- `TagSelector`: change `handleRemove(tagId)` → `handleRemove(tag)` and use `tag.id`
  internally (`removeVersionTag({ tagId: tag.id })`, `currentTags.filter(t => t.id !== tag.id)`).
  Behaviour is identical; only the parameter shape changes.

### Step 4 — Migration of existing workspace layouts

Existing `workspace_versions.layout` JSON stores `selectedFilterTagIds` on FlowView
nodes. Convert to `selectedFilterTagNames`.

**Recommended: one-time backend data migration** (alembic revision under
`backend/alembic/versions/`, generated id per CLAUDE.md rule #9):

- For each `workspace_versions` row, walk the layout JSON; on any object containing
  `selectedFilterTagIds`, resolve each id → `process_tags.name` (a global lookup — the
  migration can resolve ids from *any* project, which the client cannot), write
  `selectedFilterTagNames`, and delete `selectedFilterTagIds`. Drop ids that no longer
  resolve (deleted tags).
- Downgrade: reverse using the current-owner project's tags (best-effort; note lossy).

**Frontend fallback (belt-and-suspenders):** FlowView reads `selectedFilterTagNames`;
absent field ⇒ empty ⇒ no filter (safe default). So an unmigrated layout degrades to
"no filter / shows everything" rather than staying blank.

#### Behaviour when new code meets a legacy (id-based) layout

Concretely, with `selectedFilterTagIds` still in the node and no
`selectedFilterTagNames`:

- FlowView ignores the old field, `selectedFilterTagNames` defaults to `[]`,
  `computeVisibleVersions` returns `null` (all visible) → **the full graph renders. No
  blank, no crash.** The reported symptom is gone even before migration runs.
- **Cost:** any *intended* same-project filter is silently dropped (reverts to
  show-everything) until re-applied. Preserving those is the *only* reason the
  migration exists — it is not needed to fix the blank bug.
- The stale `selectedFilterTagIds` key survives in the layout JSON and is re-persisted
  via the `{ ...nodeProps }` spread on the next toggle, so the migration must **delete**
  it (not just add the new key).

**Rollout ordering is safe in both directions:** frontend-before-migration ⇒ filters
ignored (shows everything); migration-before-frontend ⇒ old frontend reads an id list
the migration already removed ⇒ also no filter. Neither order can produce a blank view;
the only transient cost is dropped *intended* filters during the window.

*Open decision for review:* is an alembic migration that mutates frontend-shaped layout
JSON acceptable here, or should conversion be done lazily on first workspace save from
the frontend? Recommend the alembic migration for a clean one-shot; flag the
backend↔layout-shape coupling.

### Step 5 — Manual verification

- Reproduce with the reported URL (`…/w/default/wv/2/p/2e02c2b4…`): after migration the
  "Final" chip shows (match-zero ⇒ still blank until removed); clicking × / backspace
  clears it and the full graph renders.
- Same public workspace against a project that *does* have a "Final" tag now filters
  correctly (cross-project win).
- No filter ⇒ all processes visible (unchanged).
- `TagSelector` (assigning tags to versions) still works (unchanged, id-based).

## Files touched

- `frontend/src/widgets/FlowView/index.jsx` — seed-by-name, prop/state/handler rename.
- `frontend/src/widgets/FlowView/TagFilterBar.jsx` — name chips, match-zero, always
  clearable; `onRemove` reads `tag.name`.
- `frontend/src/widgets/FlowView/TagInput.jsx` — `onRemove(tag)` instead of
  `onRemove(tag.id)`; `key={tag.id ?? tag.name}`.
- `frontend/src/widgets/FlowView/TagSelector.jsx` — `handleRemove(tag)` reads `tag.id`
  (behaviour unchanged).
- `backend/alembic/versions/<new>.py` — layout id→name migration (pending decision).
- `ProcessNode.jsx` — **no change** expected (verify during impl).

## Out of scope

- The historical `processes.length !== selectedVersions.length` race (already removed).
- Enforcing a DB unique constraint on `(project_id, name)` for tags (could be a
  follow-up; not required for this fix).

## Interim change already in the working tree

While diagnosing, a minimal stopgap was applied to `TagFilterBar.jsx` so *any* selected
tag id (including foreign ones) renders as a removable chip. Step 3 supersedes it. It
can be kept as an interim unblock or reverted before implementing this plan — reverting
is cleaner so implementation starts from `master`.

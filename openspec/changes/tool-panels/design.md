# Design

## Context

- `DockviewLayout` (outer) holds the left sidebar edge group, the center, the bottom terminal group and the browser group. Inside the center, `CenterDockview` (inner) splits the thread from the right tabs. The inner dockview exists only so that `ProjectHeader` can sit above both (a dockview top edge group was tried and dropped: `fromJSON` does not keep edge-group size constraints, so saved layouts let the header band be resized).
- The right pane content is chosen in `App.tsx` from `rightPaneTab` and the git context: the review sub-tabs (`REVIEW_TABS`) become dockview tabs, everything else is one header-less panel.
- Opening state is spread over `reviewPaneOpen`, `rightPaneTab`, `testRunnerOpen`, the per-project terminal visibility in `terminal-store`, and `browser-panel-store`. `?panel=` handles only `review`, `files` and `tests`.
- Tests (`testRunnerOpen`) is a full-screen view, not a pane.

## Goals / Non-Goals

**Goals:**

- One declaration per panel, read by the rail, the URL, shortcuts and the layout.
- The store is the source of truth; dockview only reflects it.
- Each phase merges on its own and leaves the app working.

**Non-Goals:**

- Letting users drag panels to new locations and remembering it (possible after phase 3, not part of this change).
- Several panels open side by side in one location.
- Mobile layout (`mobile-review`), which does not use dockview.
- Changing what any panel shows.

## Decisions

### Registry as plain data in `lib/tool-panels/registry.ts`

```ts
type ToolPanelLocation = 'right'; // 'bottom' joins in phase 3
interface ToolPanelDef {
  id: ToolPanelId;
  icon: LucideIcon;
  titleKey: string; // i18n
  shortcut?: string[];
  location: ToolPanelLocation;
  isAvailable: (ctx: ToolPanelContext) => boolean;
  Content: LazyExoticComponent<ComponentType>;
}
```

`ToolPanelContext` is built from the open thread (or grid selection) and project with the existing `thread-variant.ts` predicates (`canDoGitOps`, `canShowComments`, `isScratch`, …), so the scratch-predicate rule holds. The registry has no React state and no store import, so tests can read it. Alternative: let each panel module register itself at import time. Rejected: order and presence depend on import order and lazy loading.

### One `openPanels` field in `ui-store`

`openPanels: { right?: RightPanelId }` with `openPanel(id)`, `closeRightPanel()`, `togglePanel(id)`; a store subscription persists every change, so no action writes localStorage itself. Tests stays the full-screen view `testRunnerOpen` (mutually exclusive with the other full-screen views, unlike a panel); `?panel=tests` still opens it. Persisted with one localStorage key per location (`tool_panels.open.right`, value an id or `none`); the old `right_pane_open` / `right_pane_tab` keys are read once to seed it. `reviewSubTab` stays: it is state inside the review panel. Terminal visibility stays per project in `terminal-store` in phase 1 and moves to `openPanels.bottom` in phase 3, when terminal becomes an entry. Alternative: keep the booleans and derive. Rejected: they are what make the entry points disagree today.

Availability is applied at read time (`useOpenPanel(location)` returns `undefined` when the stored panel is not available), so moving to a scratch thread hides review without forgetting it for the next normal thread. The spec's "closes" is what the user sees.

### URL sync in one place

`use-thread-project-sync.ts` maps `?panel=<id>` through the registry instead of its `if` chain; the rail and shortcuts write the URL through one helper (`setPanelParam`) instead of `updatePanelParam` in `ThreadHeaderActions`. `?tab=` stays the review sub-tab.

### Rail outside dockview

`ToolRail` is a flex sibling of the dockview (`[dockview | rail]`), built with shadcn `Button` and `Tooltip`. Being outside the grid, it cannot be resized, dragged or lost by a saved layout, and it does not need an edge group (see Context). In the grid view it renders against the grid's selected thread through the same context the right pane already uses (`use-right-pane-target`).

### Header split

`ProjectHeader` moves from `App.tsx`'s center wrapper into the thread panel content. `ThreadHeaderActionsBase` loses the panel toggles (review, files, comments, tests, terminal, browser) and keeps startup commands, preview, open-in-editor and the ⋮ menu. The ⋮ menu items that toggle activity/comments call `togglePanel`.

### Phase 3: one dockview

With no header above the split, `CenterDockview` is removed: the thread panel (header and thread) is the outer layout's center panel, and the right panels are a group of that same dockview, which already placed them at full height beside the bottom group and to the right of the browser (`[left | center | browser | right]`). `DockviewLayout` took over the two behaviours only the inner dockview had: inactive review tabs stay mounted but `hidden`, and after a restore the right panels are reconciled with the open flag (removed when it says closed, added when it says open), with a save once the close animation ends, so a reload never shows a pane the flag says is closed. `STORAGE_KEY_LAYOUT` becomes `dockview.layout.v9`; on load the v8 layout and `center-dockview.layout.v1` are deleted, and the inner dockview's right-pane width moves to `dockview.right_width`, so the pane keeps the width the user dragged it to.

**Terminal and browser stay out of `openPanels`.** The terminal's visibility is per project (`terminal-store`) and the browser's belongs to the thread's browser session (`browser-panel-store`); one global `openPanels.bottom` would lose both. The rail toggles them through their stores, and the browser keeps opening beside the right panel, not instead of it. Making them registry entries waits until a location can hold per-scope state.

## Risks / Trade-offs

- [Every test or story that sets `reviewPaneOpen` / `rightPaneTab` breaks] → Phase 1 keeps thin selectors (`selectReviewPaneOpen(state)`) for one release so the call sites move in small commits; the selectors are removed in phase 3.
- [The `review.reset_gate` metric reads `reviewPaneOpen` to decide refreshes] → Keep the metric and its attributes; derive the flag from `openPanels.right === 'review'`.
- [Layout reset annoys users once] → Only in phase 3, one time, called out in the release notes.
- [e2e tests use `header-toggle-*`] → Phase 2 renames them to `tool-rail-<id>` in the same commit as the e2e updates.
- [Grid view hosts the right pane in a sibling slot (`grid-right-pane.ts`)] → Phase 3 keeps that slot logic in the sync hook; covered by the existing `grid-right-pane` tests.

## Migration Plan

Phase 1 → 2 → 3, each a separate PR, each rollbackable by revert. The localStorage seeding from the old keys stays until phase 3 lands.

# Proposal

## Why

The project header covers the thread and the right pane together, and its icons (review, files, tests, terminal, browser, comments) are wired one by one in `ThreadHeaderActions.tsx`, `ui-store.ts` (one boolean and one setter per pane, plus `rightPaneTab`), `use-thread-project-sync.ts` (`?panel=`) and `App.tsx`. Adding a panel means touching all of them, and the layout needs two nested dockviews only so that the header can span both columns. We want the thread in one panel and its tools in another, so that more panels can be added when needed.

## What Changes

- A **panel registry**: each tool panel (review, files, comments, activity, and later terminal and browser) is declared once with its id, icon, title, shortcut, location (`right`, `bottom`, or `view` for a full-screen view such as tests), availability for the open thread, and lazily loaded content. Adding a panel is adding an entry.
- **One open-panel state per location** in the UI store, replacing `reviewPaneOpen`, `filesPaneOpen`, `commentsPaneOpen`, `testRunnerOpen` and `rightPaneTab` with their setters. `?panel=<id>` reads and writes the same state for every registered panel.
- **The header splits.** The thread panel keeps its own header: breadcrumb, title, the thread menu (⋮), startup commands and preview. The tool icons leave it.
- **A tool rail**: a vertical column of icons at the right edge of the window, built from the registry, always visible. A click opens a panel, switches to it, or closes it when it is already open. A panel not available for the open thread (scratch threads, read-only shares without git) has no icon.
- **One dockview.** With the header inside the thread panel, `CenterDockview` is merged into `DockviewLayout`; terminal and browser become registry entries. Saved layouts are discarded once (layout key `v9`). **BREAKING** for saved layouts only: users get the default layout once.
- Delivered in three phases that merge separately: (1) registry and single state with no visible change, (2) split header and rail, (3) one dockview.

## Capabilities

### New Capabilities

- `tool-panels`: which tool panels exist, how they are opened, switched and closed from the rail, the URL and the keyboard, where they are placed, and what is remembered across reloads.

### Modified Capabilities

- `right-pane-tabs`: its requirements (a Review/Tests tab bar, a `rightPaneTab` store field, the `reviewPaneOpen` toggle) describe a layout that no longer exists and are replaced by `tool-panels`.

## Impact

- Client only: `stores/ui-store.ts`, `hooks/use-thread-project-sync.ts`, `App.tsx`, `components/thread/ProjectHeader.tsx` and `header/ThreadHeaderActions.tsx`, `components/CenterDockview.tsx`, `components/DockviewLayout.tsx` and `components/dockview/*`, `lib/dockview-right-panels.ts`, `lib/grid-right-pane.ts`, the grid view (`LiveColumnsView`), keyboard shortcuts, and the unit and e2e tests that use `header-toggle-*` test ids or the removed store fields.
- No server, runtime or API change.

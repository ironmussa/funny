# Tasks

## 1. Registry and single open-panel state (no visible change)

- [x] 1.1 Add `lib/tool-panels/registry.ts` with review, files, comments, activity (`right`) and tests (`view`), each with its availability rule built from `thread-variant.ts`; verify with a unit test that ids are unique and that availability matches the current header gating for normal, scratch and read-only-share threads
- [x] 1.2 Add `openPanels`, `openPanel`, `closePanel`, `togglePanel` to `ui-store.ts`, persisted under `tool_panels.open.right` and seeded once from `right_pane_open` / `right_pane_tab`; verify in `ui-store.test.ts` (toggle, switch, seed, availability at read time)
- [x] 1.3 Replace `reviewPaneOpen`, `rightPaneTab`, `testRunnerOpen` and the `setXPaneOpen` setters with the new actions at every call site, keeping read selectors where tests and stories need them; verify `bun run typecheck` and the client test suite pass
- [x] 1.4 Drive `?panel=` in `use-thread-project-sync.ts` from the registry and add `setPanelParam`; verify with tests for `?panel=files`, `?panel=review&tab=graph` and `?panel=review` on a scratch thread
- [x] 1.5 Keep `review.reset_gate` and `review.refresh_outcome` emitting with the same attributes; verify the existing `use-review-state` tests pass

## 2. Thread header and tool rail

- [x] 2.1 Add `ToolRail` (shadcn `Button` + `Tooltip`, `tool-rail-<id>` test ids, active state, i18n titles in en/es/pt) as a sibling of the dockview, rendered for the open thread, project, or grid selection; verify with a component test for open, switch, close and hidden-when-unavailable
- [x] 2.2 Move `ProjectHeader` into the thread panel and remove the panel toggles from `ThreadHeaderActionsBase`; route the ⋮ menu's activity/comments items through `togglePanel`; verify the header tests and the ToolRail component test
- [x] 2.3 Alt+key toggles and the rail's shortcut hints read the registry's `altKey`; verified by the shortcut tests and the ToolRail test
- [ ] 2.4 Update e2e tests from `header-toggle-*` to `tool-rail-*` (ids renamed; the Playwright run against a live app is still pending); verify the affected Playwright specs pass
- [x] 2.5 Update the root `CLAUDE.md` "Key components" list (openwiki has no client layout section) to describe the registry and rail

## 3. One dockview

- [x] 3.1 ~~Add terminal and browser registry entries in `openPanels`~~ Dropped: their visibility is per project / per browser session (see design, Phase 3); the rail toggles them through their own stores, covered by the ToolRail test
- [x] 3.2 Replace `CenterDockview` with the outer layout's center panel and right group; delete the inner dockview and its sync hooks; port its tab-hiding and restore reconcile to `DockviewLayout`; verified by `DockviewLayout.right-pane.test.tsx`, `DockviewLayout.integration.test.tsx` (real dockview) and the `grid-right-pane` tests
- [x] 3.3 Bump the layout key to `dockview.layout.v9`, drop the v8 and inner layouts on load and carry the right width over; verified by the "drops the layouts saved before tool panels" test
- [x] 3.4 No compatibility selectors were added in 1.3 (call sites moved directly); the one-time seeding from `right_pane_open` / `right_pane_tab` stays, it costs two reads; verified by `bun run lint` and `bun run typecheck`

## 4. Integration

- [ ] 4.1 Run `bun run lint`, `bun run typecheck` and the client tests, and check by hand in the browser: deep links, reload restore, scratch thread, grid view, terminal + right panel together

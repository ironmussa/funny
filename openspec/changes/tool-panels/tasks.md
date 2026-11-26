# Tasks

## 1. Registry and single open-panel state (no visible change)

- [x] 1.1 Add `lib/tool-panels/registry.ts` with review, files, comments, activity (`right`) and tests (`view`), each with its availability rule built from `thread-variant.ts`; verify with a unit test that ids are unique and that availability matches the current header gating for normal, scratch and read-only-share threads
- [x] 1.2 Add `openPanels`, `openPanel`, `closePanel`, `togglePanel` to `ui-store.ts`, persisted under `tool_panels.open.right` and seeded once from `right_pane_open` / `right_pane_tab`; verify in `ui-store.test.ts` (toggle, switch, seed, availability at read time)
- [x] 1.3 Replace `reviewPaneOpen`, `rightPaneTab`, `testRunnerOpen` and the `setXPaneOpen` setters with the new actions at every call site, keeping read selectors where tests and stories need them; verify `bun run typecheck` and the client test suite pass
- [x] 1.4 Drive `?panel=` in `use-thread-project-sync.ts` from the registry and add `setPanelParam`; verify with tests for `?panel=files`, `?panel=review&tab=graph` and `?panel=review` on a scratch thread
- [x] 1.5 Keep `review.reset_gate` and `review.refresh_outcome` emitting with the same attributes; verify the existing `use-review-state` tests pass

## 2. Thread header and tool rail

- [ ] 2.1 Add `ToolRail` (shadcn `Button` + `Tooltip`, `tool-rail-<id>` test ids, active state, i18n titles in en/es/pt) as a sibling of the dockview, rendered for the open thread, project, or grid selection; verify with a component test for open, switch, close and hidden-when-unavailable
- [ ] 2.2 Move `ProjectHeader` into the thread panel and remove the panel toggles from `ThreadHeaderActionsBase`; route the ⋮ menu's activity/comments items through `togglePanel`; verify the header tests and that the right pane reaches the top of the window in the Storybook layout story
- [ ] 2.3 (Alt+key toggles already read the registry since 1.3) Move the remaining keyboard shortcut hints (Alt+G and the others) to the registry's `shortcut`; verify with a shortcut test that rail and URL update
- [ ] 2.4 Update e2e tests from `header-toggle-*` to `tool-rail-*`; verify the affected Playwright specs pass
- [ ] 2.5 Update `openwiki` (client layout section) and the client `CLAUDE.md` "Key components" list to describe the registry and rail

## 3. One dockview

- [ ] 3.1 Add terminal (`bottom`) and browser (`right`) registry entries and move their visibility into `openPanels`; verify terminal and browser store tests
- [ ] 3.2 Replace `CenterDockview` with the outer layout's center panel and one `use-tool-panel-sync` hook; delete the inner dockview and its sync hooks; verify `DockviewLayout` tests, the `grid-right-pane` tests and the layout story
- [ ] 3.3 Bump the layout key to `dockview.layout.v9` and drop `center-dockview.layout.v1` on boot; verify with a test that an old stored layout is ignored
- [ ] 3.4 Remove the compatibility selectors from 1.3 and the old localStorage seeding; verify `bun run lint` and `bun run typecheck`

## 4. Integration

- [ ] 4.1 Run `bun run lint`, `bun run typecheck` and the client tests, and check by hand in the browser: deep links, reload restore, scratch thread, grid view, terminal + right panel together

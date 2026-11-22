# Tasks

## 1. Index, matcher and visibility

- [x] 1.1 Add `components/settings/settings-index.ts` with the entry type, the `SettingId` union and the page entries for both scopes. Typecheck passes (`bun check -p packages/client/tsconfig.json`).
- [x] 1.2 Extract Preferences gating into `buildPreferencesItems({ isAdmin })` and use it in `PreferencesPanel`. The existing `preferences-users-nav` test still passes, and a new unit test covers admin and non-admin results.
- [x] 1.3 Implement the pure `filterSettings` matcher (active language, English and keywords; case and accent insensitive; visible pages only; ranking by title first). Unit tests cover: an in-page match, a page-name-only match, no match, an English term in the `es` locale, an accent-free query, and admin-only pages excluded for non-admins.

## 2. Row and section primitives

- [x] 2.1 Add a required `settingId: SettingId | null` and `data-setting-id` to both `SettingRow` implementations, and add the `SettingsSection` and `SettingAnchor` primitives. Unit test: the rendered row carries `data-setting-id`.
- [x] 2.2 Add `stores/settings-filter-store.ts` (`query`, `focusId`; in memory only, cleared on leaving settings), and add the `useSettingDimmed(id)` hook that the primitives use to dim non-matching rows through `cn()`. Unit test: a row is dimmed when the filter does not match it and is not dimmed when the filter is empty.

## 3. Migrate pages to indexed rows and sections

- [x] 3.1 Migrate the Preferences pages: give every `SettingRow` an id, and convert hand-written rows and headers (`PreferencesContent.tsx`, `SystemSettings.tsx`, `TeamMembers.tsx`, …) to the primitives, with live counts kept outside the indexed title. Add the index entries. Typecheck passes.
- [x] 3.2 Migrate the Project Settings pages the same way (`GeneralSettings.tsx`, `general-settings-project/*`, `PipelineSettings.tsx`, `McpServerSettings.tsx`, …). Add the index entries. Typecheck passes.
- [x] 3.3 Add `scripts/fitness/check-settings-index.ts` with `--self-test` (every index id unique and rendered at least once; no `settings-section-header` class outside the primitive) and add it to `bun run lint`. `bun run lint` passes, and the self-test fails on a planted orphan id.

## 4. Filter UI

- [x] 4.1 Build `SettingsNavFilter` (input, pages with sub-items, empty state, keyboard ↑/↓/Enter/Esc, `data-testid`s) and render it in both `PreferencesPanel` and `SettingsPanel`. Component tests: an empty filter renders today's list, typing shows sub-items, and Escape clears the filter.
- [x] 4.2 Add the cross-surface hint, which uses the other scope's visible pages and is shown for Project Settings only when a project is selected. Selecting it opens the other surface with the same text. Component test covers the count and the no-project case.
- [x] 4.3 Implement deep link focus in the settings content container (scroll into view, temporary highlight class, `MutationObserver` with a timeout, then clear the focus id). Component test with a row that mounts late.
- [x] 4.4 Add i18n strings (placeholder, empty state, hint) to `en`, `es` and `pt`, and keywords for common synonyms. The locale key parity check, if one exists, passes.
- [x] 4.5 Add Storybook stories for `SettingsNavFilter` (empty, results, no results, hint). Stories render. (Checked by hand on master, 2026-11-22.)

## 5. Integration

- [x] 5.1 Playwright smoke test: filter "font" in Preferences, open the result, and check that the Appearance page shows the font size row highlighted. Filter a Preferences-only term from Project Settings and follow the hint. (`e2e/settings-filter.spec.ts` written; flow checked by hand on master, 2026-11-22.)
- [x] 5.2 Run `bun run lint`, `bun run typecheck` and the client tests. All pass.

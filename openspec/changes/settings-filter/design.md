# Design

## Context

- The two settings sidebars, `PreferencesPanel.tsx` (`PREFERENCES_NAV_ITEMS` and `ADMIN_ONLY_PREFERENCES`) and `SettingsPanel.tsx` (`buildSettingsItems` in `settings/items.ts`), have the same structure: a `SidebarHeader` above a `SidebarMenu`. Each one applies its own visibility rules inline.
- Pages are only mounted while they are open, so the filter cannot read their DOM. Matching has to run against a static description of each page.
- There are two `SettingRow` components with the same props (`title`, `description`, `children`): `settings/SettingRow.tsx` and `general-settings-project/setting-primitives.tsx`. Neither one has an id. Some pages write rows and headers by hand with `settings-row-title` and `settings-section-header` (for example `SystemSettings.tsx`, `PreferencesContent.tsx`, `TeamMembers.tsx`, `McpServerSettings.tsx`). Some of those headers include live counts, such as "Members (N)".
- `@funny/shared/lib/text-search` already provides `normalizeSearchText` and `findTextSearchMatches`, which are case and accent insensitive. The command palette uses them.
- i18n uses i18next with the locales `en`, `es` and `pt`.

## Goals / Non-Goals

**Goals:**

- One index and one matcher, shared by both sidebars and the cross-surface hint.
- An index that cannot silently drift from the rows that are actually rendered.
- Visibility decided by the same functions that build the sidebars.

**Non-Goals:**

- Changing the command palette. It can adopt the index later.
- The mobile settings list (`mobile/ProjectSettingsView.tsx`).
- Searching user data, or controls inside a row (select options, for example).
- Fuzzy or typo-tolerant matching. v1 matches substrings.

## Decisions

### 1. A static index declared in the client, typed by id

`components/settings/settings-index.ts` exports a readonly list of entries:

```ts
{ id: 'appearance.font-size', scope: 'preferences' | 'project', page: <page id>,
  kind: 'row' | 'section', title: <i18n key or literal>, description?: <i18n key or literal>,
  keywords?: string[] }
```

`SettingId` is the union of the `id`s. The `id` props on rows and sections are typed `SettingId`, so an id that is not in the index fails typecheck. Ids are namespaced by page so that they stay unique.

_Alternatives:_ generating the index at build time from JSX. This breaks on conditional rows, hand-written markup and computed titles, and it adds a build step. A registry that renders the rows (the index as the single source) would require rewriting every page. Not worth it for v1.

### 2. A fitness check for the other direction

Typecheck guarantees that every rendered id exists in the index. `scripts/fitness/check-settings-index.ts`, added to `bun run lint`, checks the other direction: every index id is used exactly once as an `id="…"` on a `SettingRow` or `SettingsSection` in `packages/client/src`. It also fails on any `settings-row-title` or `settings-section-header` class used outside the primitives, so hand-written rows cannot come back. It has a `--self-test` like the other fitness checks. This follows the repo pattern for source-shape guardrails.

_Alternative:_ a test that renders every page and compares DOM ids. Too much mocking (runners, tRPC, stores) for every page.

### 3. Required `id` on the row and section primitives

Both `SettingRow` implementations get a required `id: SettingId` and render `data-setting-id`. A new `SettingsSection` primitive (a header plus `data-setting-id`) replaces the hand-written `<h3 className="settings-section-header">`. Because the prop is required, typecheck lists every call site to migrate. Live counts ("Members (N)") are rendered next to the indexed title, so the indexed title itself stays static.

The two `SettingRow` implementations stay separate, since their styles differ. Both read their match state from one shared hook (decision 6).

### 4. Visibility through the existing builders

`buildSettingsItems` stays as it is. The inline Preferences gating becomes `buildPreferencesItems({ isAdmin })` next to `PREFERENCES_NAV_ITEMS`, and `PreferencesPanel` calls it. The filter receives the visible page ids from these two functions and drops every index entry whose page is not visible. There is no separate permission list.

### 5. A pure matcher

`filterSettings({ entries, visiblePages, query, t, tEn })` returns `{ page, pageMatched, elements[] }[]` in sidebar order. `tEn` is `i18n.getFixedT('en')`. For each entry it normalizes and checks the active-language text, the English text and the keywords. Inside a page, title matches rank before description and keyword matches. It is a plain function with no React, and it is unit-tested directly. The cross-surface hint calls it with the other scope's entries and visible pages.

### 6. Filter state in `ui-store`, shared by both surfaces

`ui-store` gets `settingsFilter: string` and `settingsFocusId: SettingId | null`. Both are in memory only and not persisted. Sharing one string is what lets the hint open the other surface with the same text, and lets the text survive navigation between pages. The text is cleared when the user leaves settings (the back button / `settingsReturnPath` path).

`useSettingMatch(id)` reads `settingsFilter`, runs the matcher for that single entry (memoized per query) and returns `dimmed`. The primitives apply `opacity-50` through `cn()`, and the row stays interactive.

_Alternative:_ keeping the filter in the URL (`?q=`). That would allow sharing a link, but it adds route-sync complexity (`use-view-route-sync.ts` is already delicate) for little benefit.

### 7. Deep link by focus id, not by URL hash

Selecting a sub-item sets `settingsFocusId` and navigates to the page route as it does today. The settings content container watches `settingsFocusId`. Once `[data-setting-id="<id>"]` exists it calls `scrollIntoView({ block: 'center' })`, adds a highlight class for about 1.5 s, and clears the focus id. Some rows render after their data loads, so the container waits with a `MutationObserver` that gives up after a short timeout (about 2 s). After that it shows the page without scrolling.

_Alternative:_ a URL hash. It interferes with route sync and with the browser's own scroll on navigation.

### 8. Shared sidebar component

`SettingsNavFilter` renders the input, the filtered list (pages and sub-items), the empty state and the hint. Both panels render it in place of their `SidebarMenu` map, passing their scope, their visible items and a `pagePath(id)` builder. Keyboard handling (↑/↓, Enter, Esc) lives there. Each element has a `data-testid`: `settings-filter-input`, `settings-filter-result-<id>`, `settings-filter-cross-hint`.

## Risks / Trade-offs

- [The index title differs from what the row renders] → Rows take their `title` from the same i18n key that the entry names. Where practical, the row can read the key from the index (`indexTitle(id)`). This is a convention, not enforced.
- [A conditional row is indexed but hidden by its own logic, for example a sandbox-only setting] → v1 accepts this. The page opens and nothing scrolls. If it becomes a problem, entries can get an optional `visible(ctx)` predicate.
- [An entry is indexed under the wrong page] → Not caught by the fitness check. Opening it fails to scroll. A Playwright smoke test that opens a sample of results per page catches the common cases.
- [Writing keywords by hand is tedious] → Keywords are optional. The English title and description already cover most searches. Add keywords for synonyms only ("smtp" → email).
- [Migration touches many files] → It is mechanical and typecheck-driven, and done one surface at a time.

## Implementation notes

These points were settled while implementing, and they replace the matching parts of the decisions above:

- **Prop name and `null`.** The prop is `settingId`, not `id` (no clash with the DOM `id`). It is required on `SettingRow` and `SettingsSection` and typed `SettingId | null`. `null` marks an element that is deliberately not indexed, for example the "Font size" header above the row of the same name, or the pipeline rows that are hidden until their section is switched on.
- **`SettingAnchor`.** Many settings are laid out by hand (project path, color, URLs, system prompt, tool permissions, the System rows, the key panels). They were not rewritten into `SettingRow`. Instead `SettingAnchor settingId=…` replaces their outer `div`, which adds the id, the dimming and the scroll target.
- **Fitness check scope (decision 2).** An id must be rendered at least once, not exactly once, because some rows have variant branches that render the same setting (Weave ×3, Sandbox ×2). Only the `settings-section-header` class is banned outside the primitive. Banning `settings-row-title` would have meant rewriting every hand-laid-out row for no benefit to the filter. The check also fails on duplicate ids in the index.
- **Store (decision 6).** The state lives in a small dedicated store, `stores/settings-filter-store.ts` (`query`, `focusId`, `reset`), not in `ui-store`. It is cleared by both back buttons. The dimming hook is `useSettingDimmed(id)`.
- **Translators.** `useSettingsTranslators()` wraps `t(key, { defaultValue })`. Index entries carry `titleDefault` / `descriptionDefault` for keys that are not in the locale files yet. The English translator (`getFixedT('en')`) is created on first use.
- **Highlight.** It is a CSS animation (`setting-focus-highlight` in `globals.css`), removed on `animationend`, so no timer outlives the effect.
- **Pages without static elements** (Providers, Runners, API tokens, …) are found through `SETTINGS_PAGE_KEYWORDS`, page-level search terms in the same file.
- **Preferences items** moved to `components/settings/preferences-items.ts`, so the two panels can each build the other surface's pages for the hint without importing each other. `PreferencesPanel.tsx` re-exports them.
- **Two row primitives, two names.** The project pages' row (`general-settings-project/setting-primitives.tsx`) is now `ProjectSettingRow`, so `SettingRow` is exported from one module only (fallow flags duplicate export names). Both take the same `settingId`.
- **Keyboard cursor.** While filtering, the highlighted sidebar row is the keyboard cursor (`isActive`), not the open page.

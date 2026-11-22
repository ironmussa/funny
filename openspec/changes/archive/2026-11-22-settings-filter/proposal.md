# Proposal

## Why

funny has two settings surfaces: Preferences, which applies to the whole instance (19 pages), and Project Settings (11 base pages plus 4 conditional ones). The only way to find a specific setting is to guess which surface and which page holds it. The command palette lists only the base project page names. It does not list any Preferences page or any setting inside a page. Users now have trouble finding settings they know exist.

## What Changes

- A filter input at the top of both settings sidebars (Preferences and Project Settings). Both use the same component.
- The filter matches page names and also the static UI elements inside pages: setting rows (title, description, keywords) and section headers. A page that has a matching element stays visible, and the elements that match are listed under it as sub-items.
- Selecting a sub-item opens that page, scrolls the element into view and highlights it briefly.
- On the page that is open, rows that do not match the filter are dimmed.
- When the other surface has matches, a hint shows how many and links to that surface with the same filter text, for example "2 results in Preferences →".
- Matching uses both the translated text and the English text, plus keywords. It ignores case and accents.
- The filter respects the existing visibility rules. It never shows a page or element that the user cannot open (instance admin pages, project-admin pages, owner-only pages).
- Setting rows get a stable id. Rows and section headers that are written by hand today move to the shared row and section primitives, so that each one can be indexed and scrolled to.
- Only static UI is in scope. User data (installed MCP servers, automations, runners, members) is not searched.

## Capabilities

### New Capabilities

- `settings-filter`: filtering the Preferences and Project Settings navigation by page name and by static in-page elements, with deep-linking to the element, dimming on the open page, a cross-surface hint and visibility gating.

### Modified Capabilities

None.

## Impact

- Client only (`packages/client`). No server, runtime or API changes.
- `components/PreferencesPanel.tsx`, `components/SettingsPanel.tsx` (sidebars), `components/settings/items.ts` (project page registry), and the Preferences nav items.
- `components/settings/SettingRow.tsx` and `components/general-settings-project/setting-primitives.tsx`: two `SettingRow` implementations that gain an `id` prop and `data-setting-id`.
- Pages with hand-written rows or headers: `settings/SystemSettings.tsx`, `general-settings/PreferencesContent.tsx`, `settings/TeamMembers.tsx`, `McpServerSettings.tsx`, and others that the index test finds.
- A new static settings index with i18n keys and keywords, plus a test that keeps it in sync with the rendered rows.
- New i18n strings for the filter placeholder, the empty state and the cross-surface hint (all locales).
- The mobile settings list (`mobile/ProjectSettingsView.tsx`) is out of scope for v1, but it can reuse the same index later.

# settings-filter Specification

## Purpose

Lets users find a specific setting in Preferences or Project Settings by typing part of its name, description or a related keyword. They no longer need to know which surface and page hold it.

## Requirements

### Requirement: Filter input in both settings surfaces

The Preferences sidebar and the Project Settings sidebar SHALL each show a filter input above the page list. The input SHALL behave the same on both surfaces.

#### Scenario: Input is present

- **WHEN** the user opens Preferences or Project Settings
- **THEN** a filter input is shown above the page navigation

#### Scenario: Empty filter shows the normal navigation

- **WHEN** the filter input is empty
- **THEN** the sidebar shows exactly the pages it shows today, in the same order, with no sub-items

### Requirement: Match pages and static in-page elements

The filter SHALL match page names and the static UI elements inside each page of the surface: setting rows (title, description and keywords) and section headers. A page SHALL stay visible when its name matches or when at least one of its elements matches. Each matching element SHALL be listed under its page. Elements built from user data (for example installed MCP server names, automation names, runner names, member names) SHALL NOT be matched.

#### Scenario: Match on a setting inside a page

- **WHEN** the user types "font" in Preferences
- **THEN** the Appearance page stays visible and the font size setting is listed under it, although "font" is not in the page name

#### Scenario: Match on a section header

- **WHEN** the user types a word from a section header of a page
- **THEN** that page stays visible and the section is listed under it

#### Scenario: Page name match without element matches

- **WHEN** the filter matches a page name but no element on that page
- **THEN** the page is shown with no sub-items

#### Scenario: No matches

- **WHEN** no page or element on the surface matches
- **THEN** the sidebar shows an empty-state message instead of the page list

#### Scenario: User data is not searched

- **WHEN** the user types the name of an installed MCP server
- **THEN** that server does not appear as a result

### Requirement: Language- and accent-insensitive matching

Matching SHALL ignore case and diacritics. It SHALL compare against the text in the active language and in English, and against the element's keywords.

#### Scenario: English term in a non-English locale

- **WHEN** the UI is in Spanish and the user types the English title of a setting
- **THEN** that setting is listed

#### Scenario: Accents ignored

- **WHEN** the user types "configuracion" without an accent
- **THEN** elements whose text contains "configuración" are listed

### Requirement: Deep link to a matched element

Selecting a matched element SHALL open its page, scroll the element into view and highlight it briefly. Selecting a page SHALL open that page as it does today.

#### Scenario: Open a matched setting

- **WHEN** the user selects the font size sub-item under Appearance
- **THEN** the Appearance page opens, the font size row is scrolled into view, and the row is highlighted for a short time

#### Scenario: Filter text survives navigation

- **WHEN** the user selects a result
- **THEN** the filter text and the result list stay as they were, so the user can open the next result

### Requirement: Dim non-matching rows on the open page

While the filter is not empty, the open page SHALL show the rows and sections that match at full emphasis and SHALL dim the indexed ones that do not match. Dimmed elements SHALL remain usable.

#### Scenario: Dimming on the current page

- **WHEN** the user is on a page and types a filter that matches one of its rows
- **THEN** that row is shown at full emphasis and the page's other indexed rows are dimmed

#### Scenario: Clearing restores the page

- **WHEN** the user clears the filter
- **THEN** no row on the open page is dimmed

### Requirement: Cross-surface hint

When the other settings surface has matches for the same text, the sidebar SHALL show how many and SHALL link to that surface with the same filter text applied. The count SHALL include only results the user is allowed to see. The Project Settings hint, and its count, SHALL be shown only when a project is selected.

#### Scenario: Matches in the other surface

- **WHEN** the user filters Project Settings with text that matches 2 elements in Preferences
- **THEN** a hint "2 results in Preferences" is shown, and selecting it opens Preferences with the same filter text

#### Scenario: No project selected

- **WHEN** the user filters Preferences and no project is selected
- **THEN** no Project Settings hint is shown

### Requirement: Respect visibility rules

The filter SHALL only list pages and elements that the user can open under the existing visibility rules: instance-admin-only Preferences pages, project-admin-only project pages, owner-only project pages, and pages shown only when a project is selected. These rules SHALL also apply to the cross-surface hint count.

#### Scenario: Non-admin does not find admin pages

- **WHEN** a non-admin user types "users" in Preferences
- **THEN** the Users page and its elements are not listed

#### Scenario: Collaborator does not find admin-only project pages

- **WHEN** a project collaborator who is not a project admin types the name of a setting that lives on the project's General page
- **THEN** that setting is not listed

### Requirement: Keyboard operation

The filter SHALL be operable from the keyboard. Arrow keys SHALL move through the results, Enter SHALL open the highlighted result, and Escape SHALL clear the filter.

#### Scenario: Open first result with Enter

- **WHEN** the user types a filter and presses Enter
- **THEN** the first result opens

#### Scenario: Escape clears

- **WHEN** the filter has text and the user presses Escape
- **THEN** the filter is cleared and the normal navigation is shown

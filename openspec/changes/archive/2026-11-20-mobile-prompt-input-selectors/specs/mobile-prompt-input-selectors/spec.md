## Purpose

Make prompt input options usable on narrow touch screens through accessible bottom selection panels while preserving existing desktop interactions and selection rules.

## ADDED Requirements

### Requirement: Prompt selectors adapt only on mobile

The system SHALL show prompt model/effort, mode, template, and branch choices in full-width bottom panels below 768 CSS pixels. At widths of 768 CSS pixels or greater, it SHALL preserve existing desktop selector presentation and behavior. Selectors outside the prompt input context SHALL retain their existing presentation.

#### Scenario: Mobile prompt selection

- **WHEN** a user opens any in-scope selector at 767 CSS pixels or less
- **THEN** its choices appear in a bottom panel rather than an anchored popup or lateral submenu

#### Scenario: Desktop boundary

- **WHEN** a user opens an in-scope selector at 768 CSS pixels or greater
- **THEN** the existing desktop selector appears

#### Scenario: Shared picker outside prompt

- **WHEN** a user opens a branch selector in settings on mobile
- **THEN** its existing presentation is preserved

### Requirement: Selection panels support touch and accessible dismissal

Each mobile panel SHALL provide a visible accessible title, current-selection indication, a close control, and scrollable options. Triggers, option rows, and navigation/dismissal controls SHALL provide touch targets at least 48 CSS pixels high. Panels SHALL fit the viewport, respect safe areas, and keep controls reachable with the software keyboard visible. Opening SHALL NOT automatically focus a search input. Dismissal by Close, outside tap, swipe, or Escape SHALL preserve uncommitted values and restore focus to the trigger when it remains mounted.

#### Scenario: Long list on a narrow screen

- **WHEN** the options exceed the available panel height
- **THEN** the user can scroll to and select the last option without horizontal page overflow and can reach the close control

#### Scenario: Cancel without a change

- **WHEN** a user dismisses the panel without completing a selection
- **THEN** the previous value remains selected and focus returns to its mounted trigger

#### Scenario: Search keyboard

- **WHEN** a branch panel opens and the user subsequently taps its search field
- **THEN** search receives focus only after that tap and the results and close control remain reachable with the keyboard visible

### Requirement: Simple selections retain existing behavior

Mode and template panels SHALL preserve existing choices, grouping, disabled states, and the no-template option. Selecting an enabled option SHALL invoke the existing selection behavior once and close the panel. Unavailable choices SHALL remain non-selectable.

#### Scenario: Choose a mode or template

- **WHEN** a user taps an enabled mode or template option
- **THEN** that value is committed once and the panel closes

#### Scenario: Clear template

- **WHEN** a user chooses the no-template option
- **THEN** the template selection is cleared using the existing behavior and the panel closes

### Requirement: Model and effort selection stays within one panel

The model panel SHALL preserve provider grouping, availability explanations, and permitted provider configuration actions. Models requiring an effort choice SHALL show that choice in the same panel with Back navigation. Model and effort SHALL remain uncommitted until the user completes the effort choice. Models without an effort step SHALL commit immediately. Disabled models SHALL NOT be selectable.

#### Scenario: Complete model and effort

- **WHEN** a user chooses an available model with effort options and then selects an effort
- **THEN** the model and effort are committed once through the existing behavior and the panel closes

#### Scenario: Back or cancel an effort choice

- **WHEN** a user enters the effort step and goes Back or dismisses the panel
- **THEN** the stored model and effort are unchanged
- **AND** Back returns to the model list in the same panel

#### Scenario: Model without an effort step

- **WHEN** a user selects an available model with no effort step
- **THEN** the existing model selection behavior runs once and the panel closes

#### Scenario: Unavailable provider

- **WHEN** an unavailable provider is displayed
- **THEN** its existing availability explanation and permitted setup action remain available and disabled models cannot be selected

### Requirement: Branch search retains existing semantics

The mobile branch panel SHALL retain existing filtering, branch availability, loading, empty/no-match states, special entries, and branch action semantics. Selecting an available branch SHALL invoke the existing selection behavior once and close the panel.

#### Scenario: Find and select a branch

- **WHEN** a user enters a query and chooses a matching available branch
- **THEN** that branch is selected once and the panel closes

#### Scenario: No matching branch

- **WHEN** no available branches match the query
- **THEN** a no-results message appears and existing permitted special actions remain available

### Requirement: Viewport changes do not commit pending choices

Crossing the mobile breakpoint with a selector open SHALL close the active presentation, discard pending choices, and leave the committed selection unchanged. Reopening SHALL use the new viewport's presentation.

#### Scenario: Resize during effort selection

- **WHEN** a user crosses to desktop width with a pending model effort choice
- **THEN** the panel closes without changing the model or effort
- **AND** reopening shows the desktop selector with the committed values

## ADDED Requirements

### Requirement: Right pane supports multiple tabs

The right-side pane SHALL support switching between multiple content views via tabs. Initial tabs: "Review" (existing ReviewPane) and "Tests" (new TestRunnerPane).

#### Scenario: Default tab is Review

- **WHEN** the right pane is opened without prior tab selection
- **THEN** the "Review" tab SHALL be active and ReviewPane SHALL be displayed

#### Scenario: Switch to Tests tab

- **WHEN** the user clicks the "Tests" tab
- **THEN** the TestRunnerPane SHALL be displayed and the "Review" tab content SHALL be hidden

#### Scenario: Switch back to Review tab

- **WHEN** the user clicks the "Review" tab while the "Tests" tab is active
- **THEN** the ReviewPane SHALL be displayed and the TestRunnerPane content SHALL be hidden

### Requirement: Tab state persisted in UI store

The `ui-store.ts` SHALL include a `rightPaneTab` field with type `'review' | 'tests'` that tracks the active right pane tab.

#### Scenario: Tab state in store

- **WHEN** the user switches tabs
- **THEN** the `rightPaneTab` value in `ui-store.ts` SHALL update to the selected tab identifier

### Requirement: Right pane toggle behavior preserved

The existing `reviewPaneOpen` toggle SHALL continue to open/close the right pane regardless of which tab is active. The selected tab SHALL be preserved across open/close cycles.

#### Scenario: Close and reopen pane

- **WHEN** the user has the "Tests" tab active, closes the right pane, then reopens it
- **THEN** the "Tests" tab SHALL still be active

### Requirement: Tab bar UI

The right pane SHALL display a tab bar at the top with clickable tab labels. The active tab SHALL be visually distinguished (e.g., underline or background highlight).

#### Scenario: Tab bar visible

- **WHEN** the right pane is open
- **THEN** a tab bar with "Review" and "Tests" labels SHALL be visible at the top of the pane

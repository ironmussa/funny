# arc-thread-ui Specification

## Purpose

TBD - created by archiving change native-arcs. Update Purpose after archive.

## Requirements

### Requirement: Purpose selector in NewThreadDialog

The NewThreadDialog SHALL display a purpose selector with options "Implement" (default) and "Explore". The selector SHALL use a shadcn/ui Select component with `data-testid="new-thread-purpose"`.

#### Scenario: User selects Explore purpose

- **WHEN** the user selects "Explore" from the purpose selector
- **THEN** the worktree toggle SHALL be hidden (explore defaults to local mode) and the arc picker SHALL be shown

#### Scenario: User selects Implement purpose

- **WHEN** the user selects "Implement" from the purpose selector
- **THEN** the worktree toggle, branch picker, and arc picker SHALL all be visible

### Requirement: Arc picker in NewThreadDialog

The NewThreadDialog SHALL display an arc picker dropdown when purpose is "Explore", or optionally when purpose is "Implement". The picker SHALL list existing arcs for the selected project plus a "+ New arc" option. The picker SHALL use a shadcn/ui Select component with `data-testid="new-thread-arc"`.

#### Scenario: User picks an existing arc

- **WHEN** the user selects "add-caching" from the arc picker
- **THEN** the thread creation request SHALL include `arcId` set to the selected arc's ID

#### Scenario: User picks "+ New arc"

- **WHEN** the user selects "+ New arc" from the arc picker
- **THEN** a text input SHALL appear for the arc name (kebab-case) and the system SHALL create the arc before creating the thread

#### Scenario: User picks no arc (implement purpose)

- **WHEN** the purpose is "Implement" and the user does not select an arc
- **THEN** the thread creation request SHALL omit `arcId` (normal thread behavior)

### Requirement: Arc badge on thread list items

Thread list items SHALL display the linked arc name as a subtle badge/subtitle when the thread has an `arcId`. Explore threads SHALL show a visual indicator distinguishing them from implement threads.

#### Scenario: Thread linked to arc

- **WHEN** a thread with arcId is displayed in the thread list
- **THEN** the arc name SHALL appear as a subtitle or badge on the thread item with `data-testid="thread-arc-badge"`

#### Scenario: Thread without arc

- **WHEN** a thread without arcId is displayed in the thread list
- **THEN** no arc badge SHALL be shown

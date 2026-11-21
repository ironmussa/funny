# grid-thread-actions Specification

## Purpose
TBD - created by archiving change grid-thread-actions. Update Purpose after archive.

## Requirements

### Requirement: The grid has a single selected thread

The grid view SHALL track exactly one selected thread at a time, stored as `gridSelectedThreadId`. The selection SHALL be persisted to `localStorage` and restored on reload. When the grid first renders (or its cells load) with no valid selection, the system SHALL auto-select the thread in the first occupied cell in row-major order. When the grid contains no threads, the selection SHALL be empty.

#### Scenario: Auto-select the first occupied cell

- **WHEN** the grid renders and no valid selection exists
- **THEN** the system SHALL select the thread in the first occupied cell (row-major)
- **AND** that cell SHALL be visually marked as selected

#### Scenario: A 1×1 grid always has its thread selected

- **WHEN** the grid is 1×1 and contains one thread
- **THEN** that thread SHALL be the selected thread
- **AND** the header action bar SHALL act on it

#### Scenario: Selection persists across reload

- **WHEN** a thread is selected and the page is reloaded
- **THEN** the previously selected thread SHALL be restored as selected, provided it is still placed in the grid
- **AND** if it is no longer placed, the system SHALL fall back to auto-selecting the first occupied cell

### Requirement: Clicking a cell selects its thread

Clicking a grid cell that holds a thread SHALL make that thread the selected thread and update the highlighted-border indicator. Clicking SHALL NOT navigate away from the grid view.

#### Scenario: Click changes the selection

- **WHEN** the user clicks a cell holding thread B while thread A is selected
- **THEN** thread B SHALL become the selected thread
- **AND** thread B's cell SHALL show the selected border and thread A's SHALL not
- **AND** the grid view SHALL remain open (no route change)

### Requirement: Removing or reshuffling the selected cell clears the selection

When the selected thread is removed from the grid, or a column collapse / reshuffle leaves it no longer placed in any cell, the selection SHALL be cleared.

#### Scenario: Removing the selected thread clears selection

- **WHEN** the user removes the currently selected thread from the grid
- **THEN** the selection SHALL be cleared
- **AND** the header action bar SHALL reflect having no selected thread

### Requirement: Thread action icons live in the grid view header

The grid view header SHALL render a single consolidated thread action bar — the same set as the main thread header (startup commands, preview, terminal, review, project files, tests, comments, share, more-actions) — next to the grid-size picker, bound to the selected thread. The per-column headers SHALL NOT render these action icons; a column header SHALL retain only its drag handle, status icon, title, and per-cell remove control. Project-scoped actions (startup commands, terminal) SHALL target the selected thread's project, and the terminal panel SHALL be allowed to open in the grid.

#### Scenario: Header actions operate on the selected thread

- **WHEN** thread B is selected and the user clicks the review icon in the grid header
- **THEN** the action SHALL apply to thread B (its project / worktree)

#### Scenario: Column headers no longer carry action icons

- **WHEN** the grid renders columns
- **THEN** no column header SHALL show the review / files / tests / comments / share / more-actions icons
- **AND** each column header SHALL still show its drag handle, status, title, and remove control

#### Scenario: No selected thread disables the header actions

- **WHEN** the grid has no selected thread (empty grid)
- **THEN** the header action bar SHALL be disabled or hidden

### Requirement: Header actions open the global right pane scoped to the selected thread

While the grid is open and a thread is selected, the thread action icons SHALL open the same global right pane used by the main thread view (Changes/History/Stash/PRs/Issues, Project Files, Comments, Activity), scoped to the selected thread's project and worktree. The right pane SHALL render alongside the grid rather than being suppressed.

#### Scenario: Review opens the real right pane in grid

- **WHEN** a thread is selected in the grid and the user toggles the review icon
- **THEN** the global right pane SHALL open showing that thread's changes
- **AND** it SHALL render beside the grid without covering it

#### Scenario: Switching selection re-scopes the open pane

- **WHEN** the right pane is open for thread A and the user selects thread B
- **THEN** the right pane SHALL re-scope to thread B's project / worktree

#### Scenario: Scratch thread inherits git gating

- **WHEN** the selected thread is a scratch thread with no git
- **THEN** the review and project-files actions SHALL be disabled
- **AND** comments and more-actions SHALL remain available, matching the main view

### Requirement: The selection override does not leak into the non-grid view

The grid selection SHALL drive the app-level thread context and right-pane visibility ONLY while the grid view is open. When the grid is not open, the app SHALL continue to use the URL-derived active thread.

#### Scenario: Main view is unaffected

- **WHEN** the grid view is closed
- **THEN** the app-level thread context and right pane SHALL resolve to the URL-derived active thread
- **AND** the grid selection SHALL have no effect on them

### Requirement: A new-thread cell inherits nothing from the selected thread

The grid's new-thread (compose) cell SHALL NOT inherit the selected thread's context. Its context usage, queued-message count, and other per-thread affordances SHALL reflect an empty new thread regardless of which thread is selected.

#### Scenario: Compose cell stays empty while switching selection

- **WHEN** a new-thread cell is on screen and the user selects an existing thread with a queued message and non-zero context
- **THEN** the new-thread cell SHALL NOT show that thread's queued count or context usage

### Requirement: Grid columns render the conversation identically to the main view

A grid column SHALL render the thread conversation using the same message-stream wiring as the main thread view — including the per-session changed-files summary card and the per-message fork / rewind / permission / tool affordances — by reusing the same (thread-scoped) handlers, so behavior matches exactly.

#### Scenario: Session-changes summary appears in a grid column

- **WHEN** a git-capable thread in a grid column has a completed session with a changed-files summary
- **THEN** the column SHALL render that session-changes summary card, same as the main view

#### Scenario: Card affordances match the main view

- **WHEN** a thread is shown in a grid column
- **THEN** its message cards SHALL expose the same fork / rewind / permission-approval / tool-respond affordances as the main thread view
- **AND** acting on one column SHALL NOT affect another column's thread

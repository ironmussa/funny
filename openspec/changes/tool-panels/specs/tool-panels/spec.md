# Spec Delta

## Purpose

Lets the user open the tools that act on a thread (review, files, comments, activity, tests, terminal, browser) in panels beside the thread, and lets developers add a new tool panel in one place.

## ADDED Requirements

### Requirement: Tool panels are declared in one registry

Every panel that opens in the right location SHALL be declared once, with an id, an icon, a title, an optional keyboard shortcut, its location, and a rule saying whether it is available for the open thread or project. The terminal, the browser and the test runner are toggled from the rail but keep their own visibility: per project for the terminal, per browser session for the browser, and a full-screen view for the test runner. The rail, the URL handling, the shortcuts and the layout SHALL all read that declaration; none of them SHALL list panels on their own.

#### Scenario: A new panel needs one entry

- **WHEN** a developer adds a registry entry for a new panel
- **THEN** the panel gets a rail icon, opens from `?panel=<id>` and from its shortcut, and renders in its location, with no other file listing it

#### Scenario: Ids are unique

- **WHEN** two registry entries share an id
- **THEN** the registry test fails

### Requirement: The thread panel has its own header

The thread panel SHALL show a header with the breadcrumb, the thread title, the thread menu, the startup commands and the preview action. That header SHALL span only the thread panel and SHALL NOT contain the icons that open tool panels.

#### Scenario: Header width

- **WHEN** the right tool panel is open
- **THEN** the thread header ends where the thread panel ends, and the tool panel starts at the top of the window below the window chrome

### Requirement: A tool rail opens and closes panels

A vertical rail of icons SHALL be shown at the right edge of the window, except under a view that takes the whole window, with one icon per registered panel, in registry order. The rail SHALL show the same icons for every thread and view, so it does not change shape when the user switches. Clicking the icon of a closed panel SHALL open it in its location and close any other panel open there; clicking the icon of the panel open in its location SHALL close it. The icon of an open panel SHALL be shown as active. Each icon SHALL show the panel title and shortcut in a tooltip and carry the test id `tool-rail-<id>`.

#### Scenario: Open a panel

- **WHEN** no right panel is open and the user clicks the review icon
- **THEN** the review panel opens on the right and its icon is shown as active

#### Scenario: Switch panels

- **WHEN** the review panel is open and the user clicks the files icon
- **THEN** the files panel replaces review on the right

#### Scenario: Close a panel

- **WHEN** the review panel is open and the user clicks the review icon
- **THEN** the right panel closes and the thread takes its width

#### Scenario: Panels in different locations stay open together

- **WHEN** the review panel is open on the right and the user opens the terminal
- **THEN** the terminal opens at the bottom and review stays open

### Requirement: Unavailable panels are disabled

A panel whose availability rule fails for the open thread or project SHALL keep its rail icon, disabled, SHALL NOT open from the URL or its shortcut, and SHALL close if it was open when the user moves to such a thread.

#### Scenario: Scratch thread

- **WHEN** the user opens a scratch thread
- **THEN** the review, files and terminal icons are disabled, and an open review panel closes

#### Scenario: URL asks for an unavailable panel

- **WHEN** the user opens a scratch thread with `?panel=review`
- **THEN** no panel opens and the thread is shown

### Requirement: One open panel per location, shared by every entry point

The client SHALL keep at most one open panel per location. The rail, `?panel=<id>`, the keyboard shortcuts and the thread menu SHALL read and change that same state, so they never disagree. Opening a panel from any of them SHALL update `?panel=` to the panel open on the right (or remove it when none is).

#### Scenario: Deep link

- **WHEN** the user opens a thread URL with `?panel=files`
- **THEN** the files panel is open on the right and the files rail icon is active

#### Scenario: Shortcut and rail agree

- **WHEN** the user presses the review shortcut (Alt+G) while review is closed
- **THEN** review opens, its rail icon is active, and the URL carries `?panel=review`

#### Scenario: Review sub-tab link keeps working

- **WHEN** the user opens a URL with `?panel=review&tab=graph`
- **THEN** the review panel opens on its History tab

### Requirement: Open panels survive a reload

The open panel of each location and the size of each location SHALL be remembered on the device and restored on reload, unless the URL names a panel. A stored layout from before this change SHALL be discarded once and the default layout used.

#### Scenario: Reload

- **WHEN** the user has files open on the right, resizes it, and reloads
- **THEN** files is open on the right at the same width

#### Scenario: Old layout

- **WHEN** the browser holds a layout saved by the previous version
- **THEN** it is ignored and the default layout is shown

### Requirement: Panels act on the grid's selected thread

While the grid view is open, the rail and the right panel SHALL act on the thread selected in the grid, and the rail's tools SHALL be disabled when no grid thread is selected and no project is selected.

#### Scenario: Grid selection

- **WHEN** the grid view is open with a thread selected and the user clicks the review icon
- **THEN** the review panel shows that thread's changes

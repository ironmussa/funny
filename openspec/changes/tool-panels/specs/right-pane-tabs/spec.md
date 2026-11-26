# Spec Delta

## REMOVED Requirements

### Requirement: Right pane supports multiple tabs

**Reason**: The right pane is no longer a fixed Review/Tests tab bar; any registered tool panel can open there, and tests is a full-screen view.
**Migration**: See `tool-panels` — "Tool panels are declared in one registry" and "A tool rail opens and closes panels".

### Requirement: Tab state persisted in UI store

**Reason**: The `rightPaneTab` field is replaced by one open-panel state per location.
**Migration**: See `tool-panels` — "One open panel per location, shared by every entry point".

### Requirement: Right pane toggle behavior preserved

**Reason**: There is no separate `reviewPaneOpen` toggle; opening, switching and closing go through the rail, the URL and shortcuts.
**Migration**: See `tool-panels` — "A tool rail opens and closes panels" and "Open panels survive a reload".

### Requirement: Tab bar UI

**Reason**: The rail replaces the header icons; panel tabs come from the layout.
**Migration**: See `tool-panels` — "A tool rail opens and closes panels".

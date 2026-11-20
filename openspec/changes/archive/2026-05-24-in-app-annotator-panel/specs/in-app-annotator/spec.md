## ADDED Requirements

### Requirement: Globe icon toggles the browser panel from the sidebar header

The system SHALL render a globe icon button in `SidebarTopBar` alongside the existing Search / Kanban / Grid / Analytics icons. Clicking the icon SHALL toggle the visibility of a side panel called the Browser Panel. The icon MUST carry `data-testid="sidebar-browser-panel"`.

#### Scenario: First open

- **WHEN** the user clicks the globe icon while the panel is closed
- **THEN** the Browser Panel SHALL open as a sibling column to the main content with a default width of 480px
- **AND** a `browser_panel.opened` counter metric SHALL be recorded

#### Scenario: Toggle closed

- **WHEN** the user clicks the globe icon while the panel is open
- **THEN** the panel SHALL close
- **AND** all in-memory annotations and the typed URL SHALL be cleared

#### Scenario: Icon hidden when sidebar is collapsed

- **WHEN** the sidebar is in the collapsed state
- **THEN** the globe icon SHALL NOT be rendered in the collapsed strip
- **AND** the panel SHALL remain reachable by expanding the sidebar first

### Requirement: URL bar loads any user-pasted URL into the iframe

The system SHALL render a URL input at the top of the panel with `data-testid="browser-panel-url-input"` and a Go button with `data-testid="browser-panel-url-go"`. Submitting the form (Enter or Go) SHALL set the iframe's `src` to the entered URL.

#### Scenario: Valid URL

- **WHEN** the user enters `http://localhost:5173` and presses Enter
- **THEN** the iframe's `src` SHALL be set to that URL
- **AND** a `browser_panel.url_loaded` counter SHALL be recorded with attribute `protocol="http"`

#### Scenario: URL without protocol

- **WHEN** the user enters `localhost:5173` (no scheme)
- **THEN** the system SHALL prefix `http://` before assignment
- **AND** the iframe SHALL load `http://localhost:5173`

#### Scenario: Site refuses to be embedded

- **WHEN** the loaded URL responds with `X-Frame-Options: DENY` or a CSP that blocks framing
- **THEN** the panel SHALL display the message "This site refuses to be embedded. Try a local dev server URL."
- **AND** the Send action SHALL remain disabled until a different URL loads successfully

### Requirement: Tool selector switches between Browse, Pin, Region, and Draw

The system SHALL render a tool selector inside the panel exposing exactly four tools: Browse (mouse pointer), Pin, Region, and Draw. Exactly one tool SHALL be active at a time. The default active tool on panel open SHALL be Browse.

Each tool button MUST carry `data-testid="browser-panel-tool-<name>"` where `<name>` is one of `browse`, `pin`, `region`, `draw`.

#### Scenario: Browse mode passes input through

- **WHEN** the active tool is Browse
- **THEN** the iframe SHALL have `pointer-events: auto`
- **AND** the overlay SHALL have `pointer-events: none`
- **AND** clicks SHALL be delivered to the embedded page

#### Scenario: Annotation mode captures input on the overlay

- **WHEN** the active tool is Pin, Region, or Draw
- **THEN** the iframe SHALL have `pointer-events: none`
- **AND** the overlay SHALL have `pointer-events: auto`
- **AND** clicks SHALL NOT reach the embedded page

### Requirement: Pin tool drops a numbered marker with a note

When the Pin tool is active, a single click on the overlay SHALL create a new annotation of kind `pin` with the click's overlay-relative `(x, y)` coordinates. The system SHALL render the pin as a numbered circle at those coordinates and open a popover with a `<textarea>` for the user's note.

#### Scenario: Add a pin

- **WHEN** the user clicks at overlay coords (123, 456) with Pin active
- **THEN** a new annotation `{ kind: 'pin', x: 123, y: 456, note: '' }` SHALL be appended to the annotation list
- **AND** a popover SHALL open anchored at (123, 456) with focus in the textarea
- **AND** a `browser_panel.annotation_added` counter SHALL be recorded with attribute `kind="pin"`

#### Scenario: Save a pin note

- **WHEN** the user types text and clicks Save (or presses Cmd/Ctrl+Enter) in the popover
- **THEN** the typed text SHALL be persisted to the annotation's `note` field
- **AND** the popover SHALL close

### Requirement: Region tool draws a rectangle with a note

When the Region tool is active, pressing and dragging on the overlay SHALL draw a live rectangle. On mouseup the system SHALL create a new annotation of kind `region` with `(x, y, w, h)` in overlay-relative pixels (normalized so width and height are positive) and open the note popover.

#### Scenario: Draw a region

- **WHEN** the user drags from (10, 10) to (110, 60) with Region active
- **THEN** a new annotation `{ kind: 'region', x: 10, y: 10, w: 100, h: 50, note: '' }` SHALL be appended
- **AND** the rectangle SHALL remain visible on the overlay until cleared

#### Scenario: Drag in reverse direction

- **WHEN** the user drags from (200, 200) to (100, 100)
- **THEN** the annotation SHALL be `{ x: 100, y: 100, w: 100, h: 100 }` (positive width/height)

### Requirement: Draw tool produces a free-hand canvas overlay

When the Draw tool is active, the system SHALL render a canvas sized to the overlay that captures pointer input as free-hand strokes. The user SHALL be able to choose one of five colors (red `#ef4444`, amber `#f59e0b`, green `#22c55e`, blue `#3b82f6`, white `#ffffff`) via swatches.

The Draw tool SHALL contribute at most one annotation of kind `draw` per send. Multiple stroke sessions accumulate onto the same canvas. The note for the draw annotation SHALL be entered in a single textarea visible below the color swatches.

#### Scenario: Make a stroke

- **WHEN** the user presses, moves, and releases the mouse with Draw active and red selected
- **THEN** a red stroke SHALL be drawn on the canvas
- **AND** the draw annotation SHALL exist in the store with the current canvas serialized lazily on send

#### Scenario: Clear drawing

- **WHEN** the user clicks the Clear button in the Draw tool's submenu
- **THEN** the canvas SHALL be cleared
- **AND** any pending draw annotation SHALL be removed from the store

### Requirement: Annotation list shows and allows removal of all annotations

The system SHALL render an Annotation List below or beside the iframe that displays each annotation with its number, kind, summary (coords or "drawing"), and a snippet of its note. Each row SHALL include a remove button with `data-testid="browser-panel-annotation-remove-<id>"`.

#### Scenario: Remove an annotation

- **WHEN** the user clicks the remove button for annotation 2
- **THEN** annotation 2 SHALL be deleted from the store
- **AND** the corresponding overlay marker SHALL disappear
- **AND** subsequent annotations SHALL renumber to maintain a 1-based contiguous sequence

### Requirement: Send creates a new thread with structured annotation context

The system SHALL render a Send button with `data-testid="browser-panel-send"` that is enabled when (a) the URL has been loaded successfully AND (b) at least one annotation exists. Clicking Send SHALL open a confirmation dialog with project, mode, and model selectors, defaulting to the user's last-used project (or the first project if none), `mode = 'local'`, and `model = 'sonnet'`.

Confirming the dialog SHALL call `threadsApi.createThread` with:

- `title = "Annotated: <url>"` truncated to 80 characters
- `prompt = ` the structured markdown produced by `lib/browser-panel-markdown.ts`
- `images = ` one image attachment per non-empty draw annotation (PNG `dataUrl` from the canvas)
- `projectId`, `mode`, `model` from the dialog's selections

On success the system SHALL navigate to the new thread, close the panel, and clear the in-memory annotations and URL.

#### Scenario: Send with mixed annotations

- **WHEN** the user clicks Send with one pin, one region, and one non-empty draw annotation, then confirms the dialog
- **THEN** `threadsApi.createThread` SHALL be called with one image attachment and a prompt containing three annotation sections
- **AND** a `browser_panel.sent` counter SHALL be recorded with attribute `annotation_count="3"`
- **AND** the panel SHALL close and the user SHALL be navigated to the new thread route

#### Scenario: Send with no project selected and no projects exist

- **WHEN** the user has zero projects and tries to Send
- **THEN** the Send dialog SHALL display "Create a project first" and the Confirm button SHALL be disabled

#### Scenario: Send fails

- **WHEN** `threadsApi.createThread` rejects
- **THEN** an `error`-level log SHALL be emitted in namespace `browser-panel`
- **AND** the panel SHALL remain open with annotations intact
- **AND** the dialog SHALL show a toast with the error message

### Requirement: Annotation state is ephemeral

The system SHALL hold the panel's URL, tool selection, draw color, and annotation list in a Zustand store (`useBrowserPanelStore`). This state SHALL NOT be persisted to the database, to localStorage, or to any backend. The state SHALL be cleared whenever the panel transitions from open to closed and whenever a Send call resolves successfully.

#### Scenario: Reload clears annotations

- **WHEN** the user creates two annotations and reloads the page
- **THEN** the panel SHALL open empty (no annotations, no URL prefilled) on next icon click

#### Scenario: Close clears annotations

- **WHEN** the user creates one annotation and closes the panel
- **THEN** reopening the panel SHALL show no annotations and an empty URL field

### Requirement: Panel uses shadcn/ui components and respects font-size settings

All interactive elements in the panel SHALL be built from `@/components/ui/*` (Button, Input, Popover, Dialog, ScrollArea, Tooltip, Select). The panel MUST NOT introduce raw HTML buttons, inputs, or third-party UI libraries. Text inside the panel SHALL respect the global font-size setting via the existing `PROSE_FONT_SIZE_PX` / `MONO_FONT_SIZE_PX` helpers from `@/stores/settings-store`, and colors SHALL use theme CSS variables (no hardcoded hex outside the documented `DRAW_COLORS` palette).

#### Scenario: Font-size change

- **WHEN** the user changes the global font size in Settings while the panel is open
- **THEN** the panel's text (URL bar, annotation list, popovers) SHALL re-render at the new size without requiring a panel close

#### Scenario: Theme change

- **WHEN** the user switches between light and dark themes
- **THEN** the panel's surface, border, and text colors SHALL update via theme variables (no flash of hardcoded color)

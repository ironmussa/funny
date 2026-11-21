# thread-scroll-navigation Specification

## Purpose

TBD - created by archiving change frozen-thread-viewer. Update Purpose after archive.

## Requirements

### Requirement: Rows render in normal document flow with native scroll

Message rows SHALL be laid out in normal document flow inside the scroller (no
`position: absolute`, no transform positioning, no scroll-margin bookkeeping).
Reading-position stability during content changes above the viewport MUST rely
on native browser scroll anchoring (`overflow-anchor`), not manual anchor
capture/restore. The frozen viewer path MUST NOT require a thread-switch
settle window.

#### Scenario: Prepending history does not move the viewport

- **WHEN** an older page of messages is prepended while the user reads
  mid-thread
- **THEN** the content under the user's viewport does not visibly shift

### Requirement: Bidirectional infinite scroll

History SHALL load automatically in both directions using sentinel elements
observed by IntersectionObserver: nearing the top loads older pages while
`hasMore` is true; nearing the bottom loads newer pages while `hasMoreAfter` is
true (possible when positioned mid-thread). Loads MUST NOT duplicate (no
re-trigger while a load is in flight) and MUST reuse the existing windowed
pagination (`windowStart`, `total`).

#### Scenario: Scrolling up loads older messages

- **WHEN** the user scrolls near the top and `hasMore` is true
- **THEN** the previous page loads and renders above, with no scroll jump

#### Scenario: Scrolling down from a deep link loads newer messages

- **WHEN** the user is positioned mid-thread (window not at the end) and
  scrolls near the bottom
- **THEN** the next page loads and renders below

#### Scenario: No duplicate loads

- **WHEN** the top sentinel stays visible while a page load is in flight
- **THEN** no additional load starts until the current one settles

### Requirement: Per-thread scroll position persists across switches

On leaving a thread, the viewer SHALL persist the reading position as an anchor
message id plus pixel offset (or an explicit bottom-pinned marker). On
returning, it SHALL load the message window around that anchor and restore the
position deterministically — including when the anchor is far from the latest
message.

#### Scenario: Switch away and back mid-thread

- **WHEN** the user scrolls to the middle of a long thread, opens another
  thread, and returns
- **THEN** the viewport shows the same anchor message at the same offset

#### Scenario: Bottom-pinned thread restores to bottom

- **WHEN** the user leaves a thread while pinned to the bottom and returns
  after new messages arrived
- **THEN** the viewport is pinned to the new bottom

### Requirement: Any message is directly reachable

The viewer SHALL support navigating to an arbitrary message id
(`expandToItem`-equivalent, used by deep links, search results, and event
cards): if the message is outside the loaded window, the window around it loads
first, then the row scrolls into view.

#### Scenario: Jump to an unloaded message

- **WHEN** navigation requests a message id older than the loaded window
- **THEN** the window containing it loads and the viewport scrolls to that
  message

### Requirement: Sticky bottom during streaming

While the user is at (or near) the bottom, incoming streamed content SHALL keep
the viewport pinned to the bottom. Once the user scrolls up past a threshold,
auto-scroll MUST stop until they return to the bottom.

#### Scenario: Pinned viewer follows the stream

- **WHEN** content streams in while the user is at the bottom
- **THEN** the viewport stays pinned to the latest content

#### Scenario: Reading up is never hijacked

- **WHEN** the user scrolls up while content streams in
- **THEN** the viewport position is not auto-scrolled

### Requirement: Find-in-page covers all loaded history

Browser find-in-page (Ctrl+F) SHALL find text in any loaded message, including
off-screen frozen rows, and finding a match SHALL scroll to and render it.

#### Scenario: Match far above the viewport

- **WHEN** the user searches for text that only appears in a frozen message
  hundreds of rows above
- **THEN** the browser finds it, scrolls to it, and the row renders correctly

### Requirement: Sticky user-message context is preserved

The frozen viewer SHALL keep the current sticky user-message context behavior:
while scrolling through an assistant response, the owning user message stays
visible as sticky context with the existing dock/undock behavior.

#### Scenario: Long response keeps its question visible

- **WHEN** the user scrolls through a long assistant response whose user
  message scrolled out of view
- **THEN** the user message shows as sticky context until the next exchange
  begins

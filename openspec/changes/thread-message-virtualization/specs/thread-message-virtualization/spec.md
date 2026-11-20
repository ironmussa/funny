## ADDED Requirements

### Requirement: Thread message streams render with bounded DOM virtualization

The thread message stream SHALL render loaded messages with true virtualization,
mounting only the rows needed for the current viewport plus overscan. Scrolling
or search navigation SHALL move the mounted range instead of permanently
expanding it from the bottom.

#### Scenario: Initial long-thread entry mounts only the viewport neighborhood

- **WHEN** a user opens a thread with many loaded grouped render items
- **THEN** the client SHALL mount only a bounded number of message/tool/event rows
- **AND** it SHALL NOT mount every loaded row

#### Scenario: Deep scroll does not permanently grow DOM

- **WHEN** the user scrolls far upward in a long loaded thread and then returns
  to the bottom
- **THEN** rows far outside the viewport SHALL be unmounted
- **AND** the mounted row count SHALL remain bounded by viewport plus overscan

### Requirement: Thread entry remains lazy

Opening a thread SHALL continue to load only the newest page of messages unless
the user scrolls or navigates to older content. The virtualization change SHALL
NOT require loading the full thread into the client on entry.

#### Scenario: Opening a long thread requests the newest page

- **WHEN** a user opens a long thread
- **THEN** the first thread data request SHALL use the configured message limit
- **AND** older pages SHALL remain unloaded while the user stays near the bottom

### Requirement: Full-history search navigation works with virtualized rows

Thread search SHALL continue to run against the full server-side thread history.
Navigating to a result SHALL load older pages only when the target message is not
already present in the client store, then scroll the virtualized list to the
target row and apply the in-message highlight.

#### Scenario: Search jump to a loaded old message mounts only the target area

- **WHEN** a search result points to an old message that is already loaded
- **THEN** the list SHALL scroll to that message
- **AND** the matching text SHALL be highlighted
- **AND** intermediate rows between the previous viewport and the target SHALL
  NOT remain mounted

#### Scenario: Search jump to an unloaded old message loads pages lazily

- **WHEN** a search result points to a message outside the loaded page
- **THEN** the client SHALL call the existing older-message loading flow until
  the target message is loaded
- **AND** the list SHALL scroll to the target after it becomes available
- **AND** the client SHALL NOT load unrelated newer or older pages beyond what is
  needed to reach the target

### Requirement: Pagination and scroll anchoring are preserved

The thread message stream SHALL preserve the reader's visual position when older
messages are prepended to the loaded range. The unloaded-history spacer SHALL
continue to represent server-side messages that have not been loaded yet, unless
replaced by an equivalent tested mechanism.

#### Scenario: Scrolling to the top loads older messages without jump

- **WHEN** the user reaches the top of the currently loaded virtualized range and
  older messages exist
- **THEN** the client SHALL request the next older page
- **AND** after the page is inserted, the same visible content SHALL remain at
  the same visual position

### Requirement: Scroll restoration uses stable content anchors

The thread message stream SHALL restore non-bottom scroll positions by stable
render item identity plus viewport offset. Pixel offsets and proportional scroll
progress MAY be retained as fallback state, but SHALL NOT be the primary
restoration mechanism for long virtualized threads.

#### Scenario: Returning to a long thread restores the same visible item

- **WHEN** a user leaves a long thread while reading an item away from the bottom
- **AND** the user later returns to the same thread
- **THEN** the stream SHALL restore the same render item to the saved viewport
  offset when that item is loaded
- **AND** it SHALL tolerate changed total scroll height without restoring to an
  unrelated proportional position

#### Scenario: Saved anchor is unavailable

- **WHEN** a saved anchor item is no longer loaded or no longer exists
- **THEN** the stream SHALL use a safe fallback such as bottom restoration or
  proportional restoration
- **AND** it SHALL replace the fallback state with a fresh stable anchor after
  the next successful measurement

### Requirement: Dynamic row heights are measured and invalidated safely

The virtualized message stream SHALL estimate row sizes before measurement,
measure actual mounted row sizes, and update virtual geometry when row heights
change. Height estimates and cached measurements SHALL account for layout inputs
that materially affect rendered height.

#### Scenario: Streamed content changes a mounted row height

- **WHEN** assistant text, tool output, or media content changes the height of a
  mounted row
- **THEN** the virtualizer SHALL remeasure that row
- **AND** the scroll policy SHALL preserve either bottom pinning or the user's
  current reading anchor according to the current pinned state

#### Scenario: Layout input invalidates cached measurements

- **WHEN** the user changes font size, switches compact mode, or resizes the
  thread viewport
- **THEN** cached row measurements from the previous layout SHALL NOT be treated
  as authoritative
- **AND** the list SHALL remeasure mounted rows without jumping the current
  visible anchor

### Requirement: Streaming sticky-bottom behavior is preserved

The message stream SHALL continue to stay pinned to the bottom while the user is
at the bottom and new content streams in. If the user has intentionally scrolled
away from the bottom, streaming content SHALL NOT steal their scroll position.

#### Scenario: Streaming while pinned stays at bottom

- **WHEN** the user is at the bottom of a running thread
- **AND** assistant text or tool output increases row height
- **THEN** the viewport SHALL remain pinned to the bottom

#### Scenario: Streaming after manual scroll-up does not steal position

- **WHEN** the user scrolls away from the bottom of a running thread
- **AND** assistant text or tool output streams in
- **THEN** the viewport SHALL preserve the user's reading position
- **AND** the scroll-to-bottom affordance SHALL remain available

### Requirement: Timeline and section context work with virtualization

Visible-message tracking and sticky section context SHALL continue to work when
the user scrolls through virtualized rows, including when the user-message row
that owns the current section is outside the mounted range.

#### Scenario: Visible user message updates while scrolling

- **WHEN** the user scrolls through a non-compact thread view
- **THEN** `onVisibleMessageChange` SHALL receive the user-message id for the
  section currently in view

#### Scenario: Section context is shown when owner row is unmounted

- **WHEN** the first visible virtual row belongs to a section whose user message
  is above the mounted range
- **THEN** the list SHALL still render the appropriate section context/header

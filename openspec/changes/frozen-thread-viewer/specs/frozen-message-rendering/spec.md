# frozen-message-rendering

Lifecycle of "freezing" settled messages to static sanitized HTML so long
threads keep a bounded React footprint, while recent/streaming messages stay
fully live.

## ADDED Requirements

### Requirement: Settled messages outside the live tail freeze to static HTML

A message row SHALL render as frozen static HTML (single
`dangerouslySetInnerHTML` subtree, no per-node React components) when its
message is complete (not streaming) AND it falls outside the live tail. Frozen
HTML MUST come from the shared `renderMarkdownToSafeHtml` cache.

#### Scenario: Old message is frozen

- **WHEN** a thread with 200 messages loads and message 10 is complete
- **THEN** message 10 renders as a frozen HTML row with no live markdown
  component instance mounted for it

#### Scenario: Freezing is not a re-parse

- **WHEN** a live message leaves the tail and freezes
- **THEN** its HTML is taken from the cache without recompiling

### Requirement: Live tail stays fully React

The most recent N messages (default 30) and any actively streaming message
SHALL render through the live React path with full interactivity, regardless of
freeze criteria.

#### Scenario: Streaming message is never frozen

- **WHEN** a message is receiving streaming deltas
- **THEN** it renders live, updating at most once per animation frame

#### Scenario: Tail boundary moves with new messages

- **WHEN** new messages arrive and an older message exits the last-N window
- **THEN** that message transitions to frozen rendering without visible layout
  shift

### Requirement: The entire loaded history stays mounted

All loaded messages SHALL remain mounted in the DOM (no mount cap, no
virtualized unmounting). Frozen rows MUST use `content-visibility: auto` with
`contain-intrinsic-size` fed by cached measured heights so off-screen rows cost
no layout or paint.

#### Scenario: Off-screen rows skip rendering work

- **WHEN** 500 messages are loaded and the viewport shows the bottom of the
  thread
- **THEN** rows far above the viewport are present in the DOM but skipped for
  layout/paint, and scrollbar geometry remains stable

### Requirement: Frozen rows are interactive via event delegation

Interactivity inside frozen HTML SHALL be implemented with delegated listeners
on the frozen region (not per-row or per-node listeners): local-file links open
in the editor, code-block copy buttons copy to clipboard, and images open the
lightbox.

#### Scenario: File link on a frozen row

- **WHEN** the user clicks a local-path link inside a frozen message
- **THEN** the file opens in the editor exactly as it does on a live message

#### Scenario: One listener regardless of thread size

- **WHEN** 500 frozen messages are mounted
- **THEN** the frozen region registers a constant number of listeners (does not
  scale with message count)

### Requirement: Rich content renders as React islands inside frozen rows

Content that requires live React (visualizer fences such as mermaid/dbml,
nested markdown blocks, `MarkdownImageCard` images) SHALL render as isolated
React islands embedded in the frozen row, while the surrounding prose stays
static HTML.

#### Scenario: Mermaid block in an old message

- **WHEN** a frozen message contains a mermaid fence
- **THEN** the diagram renders via the existing visualizer component and the
  rest of the message remains frozen HTML

### Requirement: Frozen rows unfreeze on demand

When the user invokes a per-message interaction that needs live React (fork,
rewind, message controls), the row SHALL swap back to live rendering before the
interaction proceeds, and MAY re-freeze afterwards.

#### Scenario: Rewind from an old message

- **WHEN** the user opens rewind controls on a frozen message
- **THEN** the row renders live and the controls behave identically to a live
  message

### Requirement: Tool cards in the frozen region defer their output

Tool call rows are NOT frozen to HTML (they remain React cards), but while
collapsed inside the frozen region they MUST NOT mount their full output DOM —
only a bounded preview. Full output mounts on expand.

#### Scenario: Long Bash output stays unmounted

- **WHEN** a collapsed Bash tool card with a 5000-line output sits in the
  frozen region
- **THEN** the DOM contains only the card header/preview until the user expands
  it

### Requirement: React footprint is bounded by tail size, not thread length

The number of live React fiber trees for message content SHALL be bounded by
the live tail size plus open islands/unfrozen rows — independent of how many
messages are loaded.

#### Scenario: Long thread memory bound

- **WHEN** 500 messages are loaded with a tail of 30
- **THEN** live markdown component instances number ~30 (plus islands), not 500

### Requirement: Viewer flag with the virtualizer as fallback

Viewer selection SHALL be controlled by a `threadViewer` setting
(`'virtual' | 'frozen'`, default `virtual` until rollout). The `virtual` path
(current `MemoizedMessageList`) MUST remain functional and unchanged while the
flag exists.

#### Scenario: Flag off uses the current viewer

- **WHEN** `threadViewer` is `virtual`
- **THEN** threads render through the existing virtualized list with no
  behavior change

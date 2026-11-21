# safe-markdown-rendering Specification

## Purpose
TBD - created by archiving change frozen-thread-viewer. Update Purpose after archive.

## Requirements

### Requirement: Markdown compiles to sanitized HTML

The client SHALL provide a `renderMarkdownToSafeHtml(content)` function that
compiles markdown with Sätteri and passes the result through an allow-list
sanitizer before it can reach the DOM. Raw Sätteri output MUST NOT be assigned
to `innerHTML` / `dangerouslySetInnerHTML` anywhere. The effective sanitization
policy MUST be at least as strict as the current `rehype-sanitize` schema:
no `<script>`, `<iframe>`, `<object>`, inline event handlers (`on*`
attributes), or `javascript:` URLs survive.

#### Scenario: Executable HTML is stripped

- **WHEN** a message contains `<img src=x onerror="alert(1)">` or a
  `<script>` block
- **THEN** the rendered HTML contains no `onerror` attribute and no script
  element, and nothing executes

#### Scenario: javascript URL is neutralized

- **WHEN** a message contains `[click](javascript:alert(1))`
- **THEN** the rendered anchor has no `javascript:` href

#### Scenario: Benign GitHub-style HTML renders

- **WHEN** a message contains `<details><summary>…</summary></details>` or
  `<br>`
- **THEN** those elements render as HTML, matching current `rehype-raw` +
  `rehype-sanitize` behavior

### Requirement: Sätteri markdown feature surface

The Sätteri engine SHALL render the markdown feature set users need:
GFM tables, task lists, strikethrough, autolinks, fenced code blocks with a
`language-*` class, inline code, blockquotes, headings, and images.

#### Scenario: GFM table renders

- **WHEN** a message contains a GFM table
- **THEN** it renders as a `<table>` with horizontal overflow handling

#### Scenario: Task list renders

- **WHEN** a message contains `- [x] done` / `- [ ] pending`
- **THEN** checkboxes render checked/unchecked and are not interactive

#### Scenario: Code block carries its language

- **WHEN** a message contains a fenced block tagged `ts`
- **THEN** the output `<code>` element carries the language so highlighting and
  the copy button can attach

### Requirement: Compiled HTML is cached by content hash

Compiled HTML SHALL be cached in an LRU keyed by a hash of the message content.
The cache MUST be capped by total stored bytes (not entry count) and MUST be
shared by live rendering and frozen rows so freezing a message never re-parses
it.

#### Scenario: Repeated render hits the cache

- **WHEN** the same message content is rendered twice (e.g., a row unmounts and
  remounts)
- **THEN** Sätteri compiles it only once and the second render reuses the
  cached HTML

#### Scenario: Cache stays bounded

- **WHEN** many large messages are compiled
- **THEN** total cached bytes never exceed the configured cap and least
  recently used entries are evicted first

### Requirement: Streaming recompiles are budgeted

While a message is streaming, recompilation SHALL be throttled to at most one
compile per animation frame, always ending with a final compile of the complete
content.

#### Scenario: Burst of deltas

- **WHEN** multiple streaming deltas arrive within one frame
- **THEN** the message is compiled at most once that frame and the final
  rendered HTML reflects the latest content

### Requirement: Sätteri is the sole thread engine

Thread messages SHALL always render through Sätteri. There SHALL be no
per-user engine setting or alternate markdown renderer in the thread path.
When the Sätteri path throws or its WASM binding fails to load, the renderer
MUST preserve the original message as safe plain text and emit a
`markdown.satteri_error` metric.

#### Scenario: Engine crash preserves source text

- **WHEN** compilation throws for a message
- **THEN** that message shows its original text in a safe error state and a
  `markdown.satteri_error` metric is recorded

#### Scenario: WASM asset missing in a packaged build

- **WHEN** the Sätteri WASM asset cannot be loaded at runtime
- **THEN** the client preserves every message as safe plain text rather than
  showing broken or missing content

### Requirement: WASM asset ships with every build target

The Sätteri WASM binding SHALL be bundled and resolvable in dev (Vite), in the
production client build, and in the packaged Tauri app.

#### Scenario: Packaged app renders markdown

- **WHEN** the Tauri-packaged app opens a thread
- **THEN** markdown renders via Sätteri (no `markdown.satteri_error` metric is
  emitted for asset load failure)

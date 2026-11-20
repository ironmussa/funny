# Spec Delta

## Purpose

Lets agents answer with interactive, catalog-bounded UI in chat messages by emitting a fenced `json-render` spec, without changing how the thread itself is rendered.

## ADDED Requirements

### Requirement: Render json-render fenced blocks as UI

The chat SHALL render a fenced code block whose language is `json-render` as UI built from the spec it contains, instead of as code. Other fenced languages SHALL keep their current rendering.

#### Scenario: Valid spec renders as components

- **WHEN** an assistant message contains a ` ```json-render ` block holding a valid spec that uses only catalog components
- **THEN** the message shows those components in place of the code block

#### Scenario: Other fences are unaffected

- **WHEN** an assistant message contains a ` ```json ` or ` ```mermaid ` block
- **THEN** it renders exactly as it did before this change

### Requirement: Catalog-bounded vocabulary

The renderer SHALL only render component types and props defined in funny's generative-UI catalog. Each component SHALL follow the active theme (light/dark) and the user's font-size setting.

#### Scenario: Unknown component type

- **WHEN** a spec references a component type that is not in the catalog
- **THEN** that element is not rendered, the rest of the spec still renders, and a visible notice names the unknown type

#### Scenario: Invalid props

- **WHEN** an element's props fail the catalog schema for its type
- **THEN** that element shows an inline error instead of rendering with the invalid props

#### Scenario: Theme and font size

- **WHEN** the user switches theme or changes the font size in Settings > Appearance
- **THEN** rendered generative-UI components update to match without reloading the message

### Requirement: Malformed specs fail safely

A block that cannot be parsed as a spec SHALL NOT break the message or the thread view. It SHALL show an error notice together with the raw block source.

#### Scenario: Invalid JSON after the message completes

- **WHEN** a completed assistant message contains a ` ```json-render ` block whose content is not a valid spec
- **THEN** the block shows an error notice and the raw source as code, and the surrounding message renders normally

### Requirement: Progressive rendering while streaming

While the assistant message is still streaming, the renderer SHALL show the elements parsed so far and SHALL NOT show a parse error for an incomplete spec.

#### Scenario: Partial spec mid-stream

- **WHEN** a ` ```json-render ` block is still being received
- **THEN** completed elements are shown, and no malformed-spec error appears until the message has finished

### Requirement: Closed, user-initiated actions

Generative-UI components SHALL only trigger actions from a fixed set: a local state update scoped to the rendered block, and sending a follow-up prompt in the same thread. A follow-up SHALL only be sent after an explicit user click, SHALL go through the same route and authorization as a follow-up typed by the user, and SHALL be disabled when the user cannot send follow-ups to that thread.

#### Scenario: Button sends a follow-up

- **WHEN** the user clicks a generative-UI button bound to `followUp` with a prompt
- **THEN** that prompt is sent as a user follow-up message in the same thread, exactly as if the user had typed it

#### Scenario: No action on render

- **WHEN** a spec is rendered, re-rendered, or scrolled into view
- **THEN** no follow-up or other side effect is triggered without a user click

#### Scenario: Unknown action

- **WHEN** a spec binds an element to an action name outside the fixed set
- **THEN** the element renders inert and the action is never executed

#### Scenario: Read-only viewer

- **WHEN** the viewer cannot send follow-ups to the thread (for example a view-only share, or a frozen/archived thread)
- **THEN** follow-up buttons render disabled

### Requirement: No raw markup execution

Spec content SHALL be rendered as text and component props only. It SHALL NOT be rendered as HTML, and it SHALL NOT be able to load scripts, iframes, or remote resources.

#### Scenario: HTML in a text prop

- **WHEN** a text prop contains `<script>` or other HTML markup
- **THEN** the markup is displayed as literal text

### Requirement: Agent is told about the fence and catalog

The instructions funny gives agents SHALL describe the ` ```json-render ` fence, the available components with their props, and the available actions. The description SHALL be generated from the same catalog definition the renderer uses.

#### Scenario: Catalog change reaches the agent

- **WHEN** a component is added to or removed from the catalog
- **THEN** the agent-facing instructions list exactly the catalog's current components and actions, with no separate manual edit

## Purpose

Defines the visual and interaction-state contract that keeps the supported Funny thread experience recognizably equivalent across the React DOM and native GPUIX renderers.

## ADDED Requirements

### Requirement: Renderer-neutral visual semantics

The supported React and GPUIX thread clients SHALL derive their parity surfaces from the same named semantic visual contract, including canvas, sidebar, surface, input, border, text, status, spacing, typography, radius, control-size, and content-width roles.

#### Scenario: Render the same named theme

- **WHEN** both renderers present the same parity fixture with the same named theme and density
- **THEN** corresponding surfaces SHALL use the contract's matching semantic roles rather than renderer-local approximations

#### Scenario: Renderer requires a native representation

- **WHEN** a contract value requires different CSS and native GPUIX representations
- **THEN** each renderer SHALL translate that value without changing its semantic role or component state

### Requirement: Equivalent thread layout hierarchy

The supported clients SHALL present the thread experience with the same ordered hierarchy of navigation, compact thread header, centered conversation viewport, and composer for an equivalent viewport class.

#### Scenario: Desktop thread layout

- **WHEN** an authenticated user opens a thread at a desktop viewport covered by the parity fixtures
- **THEN** both renderers SHALL show the navigation beside the thread pane and SHALL align the conversation and composer to the same bounded content column

#### Scenario: Compact thread layout

- **WHEN** the viewport crosses the shared compact-layout threshold
- **THEN** both renderers SHALL hide or reveal navigation through an equivalent compact control while preserving the selected thread and conversation content

#### Scenario: Unsupported web-only panel

- **WHEN** the React layout contains a panel outside the native thread scope
- **THEN** the GPUIX client SHALL retain the canonical thread hierarchy without presenting an empty imitation of that panel

### Requirement: Equivalent conversation presentation

The supported clients SHALL distinguish user messages, assistant content, tool activity, and unsupported content through matching component roles, width constraints, density, and state treatment while preserving canonical message ordering and virtualization behavior.

#### Scenario: Present a user and assistant exchange

- **WHEN** a fixture contains a user prompt followed by an assistant Markdown response
- **THEN** both renderers SHALL present the user prompt as a bounded inverse-surface card and the assistant response as readable content on the conversation canvas without full-width role bands

#### Scenario: Present rich assistant content

- **WHEN** an assistant response contains headings, lists, code, tables, or diffs supported by both renderers
- **THEN** both renderers SHALL preserve the same content hierarchy and SHALL use the shared typography and spacing roles for the supported elements

#### Scenario: Present unsupported content

- **WHEN** one renderer cannot safely display a message feature
- **THEN** it SHALL show an explicit stable fallback within the corresponding conversation position without changing the styling of unrelated messages

### Requirement: Equivalent prompt composer

The supported clients SHALL present prompt entry as one bounded composer surface containing the editor, available context controls, lifecycle action, and accessible state feedback.

#### Scenario: Idle composer

- **WHEN** a writable idle thread is open
- **THEN** both renderers SHALL show a centered bordered composer aligned with the conversation column, with the current model or mode context and a send action

#### Scenario: Active run composer

- **WHEN** an agent run is active
- **THEN** both renderers SHALL replace or supplement the send action with the available stop, interrupt, or queue behavior and SHALL visibly distinguish disabled and pending states

#### Scenario: Read-only composer

- **WHEN** the selected shared thread cannot be steered by the current user
- **THEN** both renderers SHALL present the composer as read-only and SHALL NOT expose an enabled send action

### Requirement: Equivalent project and thread navigation

The supported clients SHALL use matching visual roles for sidebar sections, project groups, selected rows, activity state, thread metadata, and overflow actions without changing access-control or navigation semantics.

#### Scenario: Render grouped navigation

- **WHEN** the user has activity, scratch threads, projects, and project threads
- **THEN** both renderers SHALL preserve the same group ordering and SHALL visually distinguish section headings, project rows, thread rows, and the selected thread

#### Scenario: Render thread metadata

- **WHEN** a thread has activity status, relative time, branch information, or change counts available to both clients
- **THEN** both renderers SHALL present the available metadata using equivalent status pins and compact metadata chips without allowing absent metadata to leave empty placeholders

#### Scenario: Activate a navigation row with the keyboard

- **WHEN** a keyboard user focuses and activates a project or thread navigation control
- **THEN** both renderers SHALL expose a visible focus state and perform the same supported selection or expansion action

### Requirement: Equivalent status and activity surfaces

The supported clients SHALL present tool calls, todos, permission requests, connection state, loading, empty, and recoverable errors through reusable semantic surfaces with equivalent severity and action hierarchy.

#### Scenario: Present tool and todo activity

- **WHEN** a thread contains tool output or a todo list
- **THEN** both renderers SHALL use bounded activity cards that expose the item title, current status, primary content, and supported expansion state

#### Scenario: Present a permission request

- **WHEN** an active permission request requires a decision
- **THEN** both renderers SHALL emphasize the risk-relevant context and SHALL distinguish the primary decision, secondary decision, pending state, and resolved state

#### Scenario: Present a recoverable connection error

- **WHEN** realtime connectivity is interrupted while durable thread content remains available
- **THEN** both renderers SHALL preserve the conversation and show a non-destructive connection status surface separate from message content

### Requirement: Product and diagnostic surface separation

Renderer diagnostics, benchmark counters, host warnings, and experimental rendering switches SHALL NOT occupy the normal product hierarchy used for parity evaluation.

#### Scenario: Normal product mode

- **WHEN** a supported thread is displayed without diagnostic mode enabled
- **THEN** neither renderer SHALL show renderer counters, package warnings, rendering-mode toggles, or session controls as conversation content or primary header actions

#### Scenario: Diagnostic mode

- **WHEN** diagnostic mode is explicitly enabled
- **THEN** diagnostic controls SHALL remain identifiable as development tooling and SHALL NOT alter the dimensions of the parity fixture's product surfaces

### Requirement: Paired parity evidence

Every component state claimed as supported by both renderers SHALL have a shared semantic fixture and renderer-specific automated evidence; presentation evidence unavailable on a host SHALL be reported as unsupported rather than inferred.

#### Scenario: Validate a supported component state

- **WHEN** a component state is added to the shared parity inventory
- **THEN** the React and GPUIX implementations SHALL both render the same semantic fixture and SHALL pass structural assertions for roles, content, state, and key layout tokens

#### Scenario: Capture visual evidence on a supported host

- **WHEN** both renderers can produce deterministic image output for a parity fixture
- **THEN** the acceptance run SHALL retain paired images and SHALL evaluate documented geometry, color, and spacing tolerances

#### Scenario: Native image capture is unavailable

- **WHEN** the GPUIX host cannot provide deterministic image output
- **THEN** structural parity checks SHALL still run and visual acceptance SHALL remain explicitly inconclusive for that host

#### Scenario: No supported native host is available

- **WHEN** the project has no macOS or Windows host available for an interactive native acceptance run
- **THEN** acceptance SHALL use the GPUIX production build, authenticated workflow integration suites, shared structural fixtures, and recorded host-capability evidence
- **AND** the result SHALL explicitly state that interactive native rendering and image parity remain unverified rather than treating their absence as a product failure

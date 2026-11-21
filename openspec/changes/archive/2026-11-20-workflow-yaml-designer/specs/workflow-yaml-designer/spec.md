## ADDED Requirements

### Requirement: Versioned workflow YAML source

The system SHALL treat workflow YAML files as versioned project artifacts under
`<repo>/.funny/workflows/*.yaml`.

#### Scenario: Project workflow discovery

- **WHEN** a project contains `.funny/workflows/deploy.yaml`
- **THEN** the workflow catalog SHALL include a user workflow named `deploy`

#### Scenario: Built-in workflow discovery

- **WHEN** the system starts with built-in workflow YAML files in `packages/workflows/defaults`
- **THEN** the workflow catalog SHALL include those built-in workflows

#### Scenario: User workflow overrides built-in workflow

- **WHEN** a project workflow has the same `name` as a built-in workflow
- **THEN** the project workflow SHALL replace the built-in workflow in the effective catalog

#### Scenario: Legacy pipeline path is ignored

- **WHEN** a project contains `.funny/pipelines/deploy.yaml`
- **THEN** the workflow catalog SHALL NOT read, load, migrate, or warn as if that file is a workflow

### Requirement: Decoupled workflow package

The workflow YAML schema, parser, serializer, graph conversion, and built-in workflow
catalog SHALL live in a workspace package separate from runtime execution.

#### Scenario: Client imports workflow graph utilities

- **WHEN** the client needs to render a workflow graph
- **THEN** it SHALL import graph conversion utilities from `@funny/workflows` or shared
  workflow DTOs, not from `@ironmussa/funny-runtime`

#### Scenario: Runtime compiles workflows for execution

- **WHEN** the runtime executes a workflow
- **THEN** it SHALL compile the parsed workflow to the generic `@funny/pipelines`
  execution engine using runtime-owned action providers

#### Scenario: Pipeline engine remains generic

- **WHEN** workflow YAML action schemas are moved
- **THEN** `@funny/pipelines` SHALL continue to expose generic pipeline execution
  primitives without owning Funny-specific workflow YAML actions

### Requirement: Workflow graph visualization

The client SHALL render workflow YAML as an interactive React Flow graph.

#### Scenario: Dependencies render as edges

- **WHEN** a workflow node declares `depends_on: [build, test]`
- **THEN** the graph SHALL render edges from `build` to the node and from `test` to the node

#### Scenario: Root nodes render without inbound dependency edges

- **WHEN** a workflow node declares no dependencies
- **THEN** the graph SHALL render it as a root node

#### Scenario: Loop renders as loop edge

- **WHEN** a workflow node declares `loop.back_to: review`
- **THEN** the graph SHALL render a loop edge from that node to `review`

#### Scenario: Conditional and retry metadata are visible

- **WHEN** a workflow node declares `when`, `on_error`, `retry`, or `approval`
- **THEN** the graph or node inspector SHALL expose that metadata without requiring
  source-only inspection

### Requirement: Workflow visual editing

The client SHALL allow users to edit common workflow structure and node configuration
through the designer while preserving YAML as the saved source.

#### Scenario: Node dependency edit

- **WHEN** a user connects node `a` to node `b` in the designer
- **THEN** the saved YAML SHALL include `b.depends_on` containing `a`

#### Scenario: Node action edit

- **WHEN** a user changes a node action configuration in the inspector
- **THEN** the parsed workflow model SHALL update and serialize to valid workflow YAML

#### Scenario: Invalid edit blocks save

- **WHEN** a designer edit creates invalid workflow YAML
- **THEN** the UI SHALL show validation diagnostics and SHALL NOT save the workflow

#### Scenario: Built-in edit creates project override

- **WHEN** a user edits a built-in workflow
- **THEN** the save flow SHALL write a project override to `.funny/workflows/<name>.yaml`
  instead of modifying the built-in package file

### Requirement: Workflow source editing

The client SHALL provide a source YAML view for advanced edits and synchronize it with
the graph after validation.

#### Scenario: Valid source refreshes graph

- **WHEN** a user edits source YAML and validation succeeds
- **THEN** the graph SHALL refresh to match the parsed YAML

#### Scenario: Invalid source keeps previous graph

- **WHEN** a user edits source YAML and validation fails
- **THEN** the UI SHALL show diagnostics and keep the last valid graph available

### Requirement: Workflow execution from designer

The client SHALL allow users to run a workflow by name from the designer using the
runtime dispatcher.

#### Scenario: Run workflow with thread

- **WHEN** a user starts workflow `fusion` for an existing thread with required inputs
- **THEN** the runtime SHALL dispatch that workflow for the thread and return a run id

#### Scenario: Missing required inputs

- **WHEN** a workflow declares required inputs and the user attempts to run without them
- **THEN** the UI or API SHALL reject the run with validation diagnostics

#### Scenario: Cancel active run

- **WHEN** a workflow run is active
- **THEN** the user SHALL be able to request cancellation by run id

### Requirement: Live workflow node state

The designer SHALL show live per-node run state for an active workflow run.

#### Scenario: Running node highlight

- **WHEN** the runtime emits a node state update with status `running`
- **THEN** the designer SHALL highlight the matching workflow node as running

#### Scenario: Terminal node states

- **WHEN** the runtime emits `completed`, `skipped`, or `failed` for a node id
- **THEN** the designer SHALL render the matching terminal state on that node

#### Scenario: Approval wait state

- **WHEN** a workflow node is waiting on an approval gate
- **THEN** the designer SHALL render the matching node with `waiting_approval` state

#### Scenario: Unknown node update

- **WHEN** the client receives a node state update for a node id not present in the
  currently displayed graph
- **THEN** the designer SHALL ignore the update without crashing

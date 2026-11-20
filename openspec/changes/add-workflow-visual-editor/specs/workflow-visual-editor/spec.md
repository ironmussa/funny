## ADDED Requirements

### Requirement: Workflow inventory lists visible YAML pipelines

The system SHALL expose a workflow inventory for the selected project that lists built-in Funny pipelines and user overrides from `.funny/pipelines/*.yaml`.

#### Scenario: Built-in and user workflows are listed

- **WHEN** a project has no user workflow overrides
- **THEN** the inventory includes built-in runtime pipelines
- **AND** each entry identifies its source as `built-in`

#### Scenario: User override wins

- **WHEN** `.funny/pipelines/code-review.yaml` exists and declares `name: code-review`
- **THEN** the inventory shows `code-review` as source `user`
- **AND** the user workflow is the version opened and dispatched by default

### Requirement: Workflow graph represents YAML structure

The system SHALL convert a valid Funny YAML pipeline into a graph where each YAML node is represented by one visual node and dependency relationships are represented by edges.

#### Scenario: Dependency edges are rendered

- **WHEN** a pipeline node declares `depends_on: [review, tests]`
- **THEN** the graph includes dependency edges from `review` to that node and from `tests` to that node

#### Scenario: Loop edge is rendered

- **WHEN** a node declares `loop.back_to`
- **THEN** the graph includes a visually distinct loop edge from that node to the referenced node

#### Scenario: Pipeline reference is visible

- **WHEN** a node uses `pipeline: { name: commit }`
- **THEN** the visual node labels the action as a pipeline reference
- **AND** displays the referenced pipeline name

### Requirement: Workflow editor saves valid YAML overrides

The system SHALL allow users to edit workflow graphs and save the result as YAML under `.funny/pipelines/*.yaml` after validation succeeds.

#### Scenario: Connect nodes updates dependencies

- **WHEN** the user connects node `a` to node `b`
- **THEN** the draft YAML for node `b` includes `depends_on: [a]`

#### Scenario: Built-in edit creates override

- **WHEN** the user edits a built-in pipeline and saves
- **THEN** the runtime writes the YAML to `.funny/pipelines/<pipeline-name>.yaml`
- **AND** does not modify the shipped built-in YAML file

#### Scenario: Invalid draft is not saved

- **WHEN** the draft contains duplicate node IDs or an unknown dependency
- **THEN** the save action is blocked
- **AND** validation issues are shown to the user

### Requirement: Workflow editor supports YAML escape hatch

The system SHALL provide a YAML text view for the current workflow draft and validate changes made directly in YAML.

#### Scenario: YAML edit updates graph

- **WHEN** the user edits YAML text and the YAML validates successfully
- **THEN** the graph updates to match the parsed pipeline structure

#### Scenario: YAML parse error preserves draft

- **WHEN** the user enters malformed YAML
- **THEN** the graph remains on the last valid draft
- **AND** the YAML panel displays the parse error

### Requirement: Workflow execution uses the existing dispatcher

The system SHALL execute workflows through the existing runtime scheduler pipeline dispatcher rather than a browser-side or duplicate execution engine.

#### Scenario: Dispatch selected workflow

- **WHEN** the user submits required inputs and runs a workflow
- **THEN** the runtime loads and compiles the selected YAML pipeline
- **AND** dispatches it through `SchedulerPipelineDispatcher`
- **AND** returns a pipeline run id

#### Scenario: Missing required input blocks dispatch

- **WHEN** the selected workflow declares a required input and the user leaves it empty
- **THEN** the run action is disabled or rejected with a validation error
- **AND** no pipeline run is started

### Requirement: Workflow graph displays run progress

The system SHALL display active run progress on the workflow graph.

#### Scenario: Node status updates

- **WHEN** a workflow node starts, completes, fails, is skipped, or waits for approval
- **THEN** the corresponding graph node updates its visual status

#### Scenario: Failed run remains inspectable

- **WHEN** a workflow run fails
- **THEN** the graph keeps the last known per-node statuses visible
- **AND** the user can inspect the failed node and error summary

### Requirement: Workflow file writes are contained to the project override directory

The runtime SHALL only write workflow YAML overrides inside the selected project's `.funny/pipelines/` directory.

#### Scenario: Path traversal is rejected

- **WHEN** a save request attempts to target a path outside `.funny/pipelines/`
- **THEN** the runtime rejects the request
- **AND** no file outside the override directory is created or modified

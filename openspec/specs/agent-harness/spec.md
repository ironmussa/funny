# agent-harness Specification

## Purpose
TBD - created by archiving change public-agent-harness. Update Purpose after archive.

## Requirements

### Requirement: Public harness package exports stable authoring APIs

The system SHALL provide a workspace package named `@funny/harness` that exports
stable TypeScript APIs for authoring agents, sessions, tools, workflows, and
sandbox intent without requiring consumers to import the funny server or runtime
application packages.

#### Scenario: Consumer imports the harness API

- **WHEN** TypeScript code imports `createAgent`, `createSession`, `defineTool`, `defineWorkflow`, `runWorkflow`, and `sandbox` from `@funny/harness`
- **THEN** the package resolves those exports from its public entry point

#### Scenario: Harness package avoids server dependency

- **WHEN** the harness package dependency graph is inspected
- **THEN** it does not depend on `packages/server` or `@ironmussa/funny-runtime`

### Requirement: Agents are declarative and session-executed

The system SHALL allow callers to define an agent declaratively and execute it
through a session bound to a runtime, working directory, and optional persisted
provider session id.

#### Scenario: Create an agent definition

- **WHEN** a caller invokes `createAgent` with provider, model, instructions, permission mode, tool policy, and sandbox intent
- **THEN** the system returns an immutable agent definition containing those options in a normalized form

#### Scenario: Prompt an agent session

- **WHEN** a caller creates a session for an agent and calls `session.prompt("review this change")`
- **THEN** the session delegates execution to its configured `HarnessRuntime` and resolves with a normalized agent result

#### Scenario: Continue an existing provider session

- **WHEN** a caller creates a session with a persisted provider session id and sends a prompt
- **THEN** the runtime receives that session id so providers that support continuation can resume the prior context

#### Scenario: Stream session events

- **WHEN** an agent session runs and the underlying process emits messages, tool calls, errors, or completion
- **THEN** the harness emits normalized session events while preserving raw provider details in metadata when available

### Requirement: Harness runtime adapter contract

The system SHALL define a minimal `HarnessRuntime` contract that can execute
agent requests, optionally run commands, request approvals, emit notifications,
and resolve sandbox execution requests.

#### Scenario: Local runtime executes through core

- **WHEN** a caller uses the local harness runtime to prompt an agent
- **THEN** the runtime creates an agent process using `@funny/core` primitives and returns normalized results to the harness session

#### Scenario: Product runtime bridges existing actions

- **WHEN** product runtime code runs a harness workflow
- **THEN** it can provide an adapter that bridges harness requests to the existing runtime `ActionProvider` without changing the pipeline engine

#### Scenario: Unsupported runtime capability fails before execution

- **WHEN** a workflow or session requires a runtime capability the configured runtime does not provide
- **THEN** the harness fails with a stable unsupported-capability error before starting the agent or workflow step

### Requirement: Tools are typed, validated, and registered

The system SHALL allow callers to define tools with a stable name, description,
input schema, and handler, and register them for use by workflows and agent
sessions.

#### Scenario: Tool input is validated

- **WHEN** a registered tool is invoked with input that does not match its schema
- **THEN** the harness rejects the invocation with a `tool_validation_failed` error and does not call the handler

#### Scenario: Workflow invokes a registered tool

- **WHEN** a workflow step invokes a registered tool with valid input
- **THEN** the harness calls the tool handler and makes its result available to the workflow context

#### Scenario: Duplicate tool names are rejected

- **WHEN** two tools with the same name are registered in one harness registry
- **THEN** the harness rejects the second registration with a stable duplicate-tool error

#### Scenario: Agent tool exposure requires runtime support

- **WHEN** an agent session includes custom tools and the runtime cannot expose those tools to the selected provider
- **THEN** the session fails before agent start with an unsupported-tool-exposure error

### Requirement: Workflows execute over the existing pipeline engine

The system SHALL allow callers to define and run harness workflows while using
`@funny/pipelines` as the execution engine and preserving cancellation,
progress reporting, and failure semantics.

#### Scenario: Define and run a workflow

- **WHEN** a caller defines a workflow with harness steps and invokes `runWorkflow`
- **THEN** the harness executes the workflow through `@funny/pipelines` and returns a normalized workflow result

#### Scenario: Workflow receives harness context

- **WHEN** a harness workflow step runs
- **THEN** the step receives context containing cwd, runtime, progress reporter, tool registry, and a session factory

#### Scenario: Workflow progress is reported

- **WHEN** workflow steps start, complete, skip, retry, or fail
- **THEN** the harness forwards progress through the configured progress reporter using stable step identifiers

#### Scenario: Workflow cancellation propagates

- **WHEN** a caller aborts a running harness workflow
- **THEN** the abort signal is propagated to the pipeline engine and any active runtime operation that supports cancellation

### Requirement: Sandbox intent distinguishes local, process, and runner execution

The system SHALL expose sandbox intent constructors that distinguish local
execution, process-level agent sandboxing, and whole-runner sandboxing.

#### Scenario: Local sandbox intent

- **WHEN** a caller configures an agent or workflow with `sandbox.local()`
- **THEN** the harness requests execution on the current runtime without adding a sandbox boundary

#### Scenario: Process sandbox intent

- **WHEN** a caller configures an agent session with process-level sandbox intent
- **THEN** a runtime that supports process sandboxing maps that intent to the agent subprocess spawn hook used by `SandboxManager`

#### Scenario: Runner sandbox intent

- **WHEN** a caller configures runner-level sandbox intent
- **THEN** the harness sends a sandbox execution request to its runtime adapter and does not instantiate a cloud provider SDK itself

#### Scenario: Unsupported sandbox backend

- **WHEN** a caller requests process-level or runner-level sandboxing from a runtime that does not support that backend
- **THEN** the harness fails with an `unsupported_sandbox_backend` error before starting work

### Requirement: Runner sandbox integration delegates to cloud provisioner lifecycle

The system SHALL integrate runner-level sandbox intent with the
`provision-railway-runners` provisioner seam when that runtime capability is
available, while leaving provider selection, provider credentials, pause/resume,
snapshot, restore, and idle lifecycle outside the harness package.

#### Scenario: Runner sandbox uses provisioner capability

- **WHEN** a server/runtime adapter receives runner-level sandbox intent for a thread-backed harness session
- **THEN** it delegates sandbox resolution to the cloud runner provisioner rather than calling infrastructure provider APIs from the harness

#### Scenario: Provider lifecycle remains outside harness

- **WHEN** a runner-level sandbox is paused, resumed, snapshotted, restored, killed, or terminated for idleness
- **THEN** those operations are performed by the `provision-railway-runners` provider/provisioner layer, not by `@funny/harness`

#### Scenario: Harness preserves provider-agnostic intent

- **WHEN** the project's runner infrastructure provider changes (e.g. Railway to another provider)
- **THEN** harness-authored code using runner sandbox intent does not need to change

### Requirement: Harness examples cover the supported authoring flows

The system SHALL include examples or README snippets for direct agent prompting,
custom tool registration, workflow execution, and sandbox backend selection.

#### Scenario: Direct prompt example works

- **WHEN** a developer follows the direct agent prompt example
- **THEN** the example creates an agent, opens a session, sends a prompt, and prints a normalized result

#### Scenario: Workflow example works

- **WHEN** a developer follows the workflow example
- **THEN** the example defines at least one tool-backed workflow step and runs it through the harness

#### Scenario: Sandbox example documents altitude

- **WHEN** a developer reads the sandbox example
- **THEN** it explains the behavioral difference between local, process-level, and runner-level sandbox intent

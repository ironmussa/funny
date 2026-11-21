# agent-definition Specification

## Purpose

TBD - created by archiving change agent-definitions. Update Purpose after archive.

## Requirements

### Requirement: AgentDefinition interface

The system SHALL define an `AgentDefinition` interface in `packages/shared/src/types.ts` with the following fields: `name` (string), `label` (string), `systemPrompt` (string or function returning string), `model` (AgentModel), `provider` (AgentProvider), and `permissionMode` (PermissionMode).

#### Scenario: AgentDefinition type is importable

- **WHEN** a module imports `AgentDefinition` from `@funny/shared`
- **THEN** it has access to a typed interface with all six fields (name, label, systemPrompt, model, provider, permissionMode)

#### Scenario: systemPrompt as static string

- **WHEN** an `AgentDefinition` has `systemPrompt` set to a plain string
- **THEN** that string is used directly as the system prompt

#### Scenario: systemPrompt as function

- **WHEN** an `AgentDefinition` has `systemPrompt` set to a function
- **THEN** the function is called with a context object (e.g. `{ arcName, commitSha }`) and the return value is used as the system prompt

### Requirement: Built-in agent registry

The system SHALL provide a registry of built-in agent definitions at `packages/runtime/src/services/agent-registry.ts` containing entries for all existing agent roles: `reviewer`, `corrector`, `precommitFixer`, `testFixer`, `arcExplore`, `arcPlan`, and `arcImplement`.

#### Scenario: Registry exports all built-in agents

- **WHEN** a module imports `BUILTIN_AGENTS` from the agent registry
- **THEN** it has access to named entries for `reviewer`, `corrector`, `precommitFixer`, `testFixer`, `arcExplore`, `arcPlan`, and `arcImplement`

#### Scenario: Each built-in agent has complete defaults

- **WHEN** any entry in `BUILTIN_AGENTS` is accessed
- **THEN** it has non-empty values for all `AgentDefinition` fields (name, label, systemPrompt, model, provider, permissionMode)

### Requirement: resolveAgent merges overrides

The system SHALL provide a `resolveAgent()` function that takes a base `AgentDefinition` and optional partial overrides, returning a complete `AgentDefinition` with overrides applied on top of defaults.

#### Scenario: Override model only

- **WHEN** `resolveAgent(BUILTIN_AGENTS.reviewer, { model: 'haiku' })` is called
- **THEN** the returned `AgentDefinition` has `model: 'haiku'` and all other fields from the reviewer default

#### Scenario: No overrides

- **WHEN** `resolveAgent(BUILTIN_AGENTS.reviewer)` is called with no overrides
- **THEN** the returned `AgentDefinition` is identical to `BUILTIN_AGENTS.reviewer`

#### Scenario: Override systemPrompt

- **WHEN** `resolveAgent(BUILTIN_AGENTS.reviewer, { systemPrompt: 'Custom instructions' })` is called
- **THEN** the returned `AgentDefinition` has the custom system prompt while keeping the reviewer's default model, provider, and permissionMode

### Requirement: Pipeline contexts use AgentDefinition

Pipeline contexts SHALL accept `AgentDefinition` objects instead of separate model/prompt fields. `CodeReviewPipelineContext` SHALL have `reviewer` and `corrector` fields of type `AgentDefinition`. `CodeQualityContext` SHALL reference agent definitions for all its agent roles.

#### Scenario: Code review pipeline receives AgentDefinition

- **WHEN** the code review pipeline is started
- **THEN** `ctx.reviewer` and `ctx.corrector` are complete `AgentDefinition` objects

#### Scenario: spawnAgent uses AgentDefinition model and mode

- **WHEN** a pipeline node calls `ctx.provider.spawnAgent()` with an `agent` field
- **THEN** the agent's `model` and `permissionMode` are used as defaults for the spawn call

#### Scenario: Explicit model overrides agent default

- **WHEN** `spawnAgent({ agent: reviewerAgent, model: 'opus', prompt: '...' })` is called with both `agent` and explicit `model`
- **THEN** the explicit `model: 'opus'` takes precedence over `agent.model`

### Requirement: Arc agents resolved from registry

The agent runner SHALL resolve arc agent definitions from the registry based on thread purpose instead of using separate `getExplorePrompt()`/`getImplementPrompt()` functions.

#### Scenario: Explore thread uses arcExplore agent

- **WHEN** a thread with `purpose: 'explore'` and a valid `arcId` starts
- **THEN** the system resolves `BUILTIN_AGENTS.arcExplore` and uses its system prompt

#### Scenario: Plan thread uses arcPlan agent

- **WHEN** a thread with `purpose: 'plan'` and a valid `arcId` starts
- **THEN** the system resolves `BUILTIN_AGENTS.arcPlan` and uses its system prompt

#### Scenario: Implement thread uses arcImplement agent

- **WHEN** a thread with `purpose: 'implement'` and a valid `arcId` starts
- **THEN** the system resolves `BUILTIN_AGENTS.arcImplement` and uses its system prompt

### Requirement: SpawnAgentOpts accepts agent field

The `SpawnAgentOpts` interface SHALL include an optional `agent` field of type `AgentDefinition`. When provided, the agent's `model` and `permissionMode` are used as defaults that can be overridden by explicit `model` and `mode` fields.

#### Scenario: agent field is optional

- **WHEN** `spawnAgent({ prompt, cwd })` is called without an `agent` field
- **THEN** it works identically to current behavior (backward compatible)

#### Scenario: agent provides defaults

- **WHEN** `spawnAgent({ agent: correctorAgent, prompt, cwd })` is called without explicit model or mode
- **THEN** `correctorAgent.model` is used as the model and `correctorAgent.permissionMode` is used as the mode

### Requirement: Pipeline manager builds AgentDefinitions from DB

The `pipeline-manager.ts` SHALL construct `AgentDefinition` objects by merging built-in defaults with user-configured overrides from the pipeline database record before passing them to pipeline contexts.

#### Scenario: User-configured model applied

- **WHEN** a pipeline DB record has `reviewModel: 'haiku'`
- **THEN** the pipeline context receives a reviewer `AgentDefinition` with `model: 'haiku'` and all other fields from the built-in reviewer default

#### Scenario: No user overrides

- **WHEN** a pipeline DB record has no custom model or prompt for the reviewer
- **THEN** the pipeline context receives the built-in reviewer `AgentDefinition` unchanged

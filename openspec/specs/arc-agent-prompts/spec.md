# arc-agent-prompts Specification

## Purpose
TBD - created by archiving change native-arcs. Update Purpose after archive.

## Requirements

### Requirement: Explore purpose system prompt

The system SHALL inject an explore-purpose system prompt when a thread has `purpose` set to `'explore'`. The prompt SHALL instruct the agent to act as a thinking partner: ask clarifying questions, challenge assumptions, use ASCII diagrams, explore the codebase, and avoid writing application code. The prompt SHALL allow writing arc artifact files (`arcs/<name>/proposal.md`, `design.md`, `tasks.md`, `specs/`).

#### Scenario: Explore thread starts with explore prompt

- **WHEN** a thread with purpose "explore" and arcId "arc-1" (name "add-caching") is started
- **THEN** the agent's systemPrefix SHALL include the explore prompt with the arc name and artifact paths

#### Scenario: Explore prompt prevents code implementation

- **WHEN** the explore prompt is injected
- **THEN** it SHALL contain instructions telling the agent to never write application code, only arc artifacts

### Requirement: Implement purpose system prompt

The system SHALL inject an implement-purpose system prompt when a thread has `purpose` set to `'implement'` and an `arcId`. The prompt SHALL instruct the agent to read arc artifacts for context, work through tasks in `tasks.md`, mark completed tasks with `[x]`, and pause on ambiguity.

#### Scenario: Implement thread starts with implement prompt

- **WHEN** a thread with purpose "implement" and arcId "arc-1" is started
- **THEN** the agent's systemPrefix SHALL include the implement prompt referencing the arc's artifacts

#### Scenario: Implement thread without arc (no injection)

- **WHEN** a thread with purpose "implement" and no arcId is started
- **THEN** the agent's systemPrefix SHALL NOT include any arc-related prompt (existing behavior preserved)

### Requirement: Arc artifact content injection

The system SHALL read arc artifact files from the filesystem and include their content in the agent's systemPrefix when the thread has an `arcId`. Content SHALL be injected after the project system prompt and before Paisley Park memory context.

#### Scenario: Arc with all artifacts

- **WHEN** a thread is linked to an arc that has proposal.md, design.md, tasks.md, and specs/cache-storage/spec.md
- **THEN** the systemPrefix SHALL include the content of all four files, clearly labeled with section headers

#### Scenario: Arc with partial artifacts

- **WHEN** a thread is linked to an arc that only has proposal.md
- **THEN** the systemPrefix SHALL include only the proposal.md content and omit missing artifact sections

#### Scenario: SystemPrefix assembly order

- **WHEN** a thread has a project system prompt, arc context, memory context, and resume prefix
- **THEN** the systemPrefix SHALL be assembled in order: project system prompt → arc context → arc purpose prompt → memory context → resume prefix

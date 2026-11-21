# memory-operators Specification

## Purpose
TBD - created by archiving change paisley-park-memory. Update Purpose after archive.

## Requirements

### Requirement: Operator profile storage

In multi-user mode, each operator SHALL have a profile directory at `operators/{username}/` in the memory repository containing a `PROFILE.md` file with YAML frontmatter and markdown content describing the operator's preferences, expertise, and areas of ownership.

#### Scenario: Creating an operator profile

- **WHEN** a memory operation is performed for an operator who has no profile in the memory directory
- **THEN** the system creates `operators/{username}/PROFILE.md` with default frontmatter (operator name, role: "team member", empty expertise and preferences) and commits it

#### Scenario: Reading an existing operator profile

- **WHEN** the system needs operator preferences during recall for user "argenis"
- **THEN** it reads `operators/argenis/PROFILE.md`, parses the frontmatter and content, and extracts preference rules

#### Scenario: Human editing of operator profile

- **WHEN** a human directly edits `operators/argenis/PROFILE.md` and commits
- **THEN** the next recall for that operator reflects the updated preferences — the system does not overwrite manual edits

### Requirement: Operator preferences in recall

When `recall()` is called with `forOperator` specified, the system SHALL include operator-specific preferences in the results. These preferences SHALL be formatted as a separate section in the recall output.

#### Scenario: Recall with operator context

- **WHEN** `recall("API design", { forOperator: "argenis" })` is called and `operators/argenis/PROFILE.md` contains preferences like "commits atómicos", "no comentarios obvios"
- **THEN** the recall results include a dedicated operator section with those preferences, in addition to the regular project facts

#### Scenario: Recall without operator (local mode)

- **WHEN** `recall("API design")` is called without `forOperator` in local auth mode
- **THEN** no operator section is included in the recall results

### Requirement: Team knowledge directory

The memory repository SHALL include a `team/` directory with human-editable files: `ROSTER.md` (team member list with roles and expertise), `ownership.md` (module ownership mapping), and `norms.md` (team conventions like PR review rules, branching strategy).

#### Scenario: Team directory initialization

- **WHEN** the memory directory is initialized for a project
- **THEN** the `team/` directory is created with placeholder files (`ROSTER.md`, `ownership.md`, `norms.md`) containing template content that humans can fill in

#### Scenario: Team context in recall

- **WHEN** `recall("who owns the frontend?", { scope: "team" })` is called
- **THEN** the system searches `team/ownership.md` and returns relevant ownership information

#### Scenario: Team files are read-only for agents

- **WHEN** an agent attempts to modify team files via the memory API
- **THEN** the system rejects the write — team files are human-editable only, not writable via `add()` or `evolve()`

### Requirement: Session metadata tracking

The memory repository SHALL track session metadata in `sessions/{session-id}/meta.md` for audit and rollback purposes. Session metadata SHALL include the agent model, operator (if multi-user), timestamp, thread ID, and a summary of memory operations performed during the session.

#### Scenario: Session metadata creation

- **WHEN** a thread starts and performs memory operations
- **THEN** a `sessions/{thread-id}/meta.md` file is created with frontmatter containing thread ID, project ID, model, operator, start time, and a list of memory operations (adds, invalidations, evolves) performed during the session

#### Scenario: Session metadata on thread completion

- **WHEN** a thread completes (agent finishes or is stopped)
- **THEN** the session metadata is updated with end time and final operation summary, and committed

### Requirement: CONVENTIONS.md human-editable file

The memory repository SHALL include a `project/CONVENTIONS.md` file that humans can edit directly to define project conventions. This file SHALL be read during recall and its content treated as high-priority convention-type facts.

#### Scenario: Conventions included in recall

- **WHEN** `recall("coding style")` is called and `project/CONVENTIONS.md` contains relevant conventions
- **THEN** the conventions are included in the recall results with type "convention" and high confidence (1.0)

#### Scenario: Conventions file editing

- **WHEN** a human edits `project/CONVENTIONS.md` directly
- **THEN** the next recall reflects the changes — the system reads this file fresh on each recall

#### Scenario: Agents cannot modify CONVENTIONS.md

- **WHEN** an agent attempts to write to `project/CONVENTIONS.md` via the memory API
- **THEN** the system rejects the write — CONVENTIONS.md is human-editable only

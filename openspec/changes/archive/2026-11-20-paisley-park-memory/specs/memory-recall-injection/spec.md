## ADDED Requirements

### Requirement: Automatic recall on thread start

When a new thread starts (no existing session), the system SHALL automatically call `recall()` with the user's initial prompt as the query and inject the results into the agent's system prefix. This SHALL happen before the agent generates its first response.

#### Scenario: New thread with memory facts available

- **WHEN** a new thread is started with prompt "Add rate limiting to the API" and the project has memory facts
- **THEN** the system calls `recall("Add rate limiting to the API")`, formats the results as markdown, and injects them into the `systemPrefix` between project instructions and resume prefix

#### Scenario: New thread with no memory facts

- **WHEN** a new thread is started for a project with no memory facts (empty memory directory)
- **THEN** the system proceeds normally without injecting any memory context — the systemPrefix contains only project instructions and resume prefix as before

#### Scenario: Resumed thread (existing session)

- **WHEN** a thread resumes an existing session (has a sessionId)
- **THEN** automatic recall is NOT performed — the agent already has context from its prior conversation. Memory context was injected at the original thread start.

### Requirement: Memory context formatting

The recall results SHALL be formatted as structured markdown sections, grouped by fact type. Each fact SHALL show its content, confidence, and relative age. The total injection SHALL stay under 2000 tokens.

#### Scenario: Formatting recall results

- **WHEN** recall returns 8 facts of mixed types (3 decisions, 2 bugs, 2 patterns, 1 insight)
- **THEN** the formatted output is structured as:
  ```
  [PROJECT MEMORY]
  ## Decisions
  - {content} (confidence: 0.92, {relative time})
  - ...

  ## Known Issues
  - {content} (confidence: 0.88, {relative time})
  - ...

  ## Patterns
  - ...

  ## Insights
  - ...
  [/PROJECT MEMORY]
  ```

#### Scenario: Empty type groups omitted

- **WHEN** recall results contain no facts of type "bug"
- **THEN** the "Known Issues" section is omitted from the formatted output

#### Scenario: Token limit enforcement

- **WHEN** recall returns facts that would exceed 2000 tokens when formatted
- **THEN** the system truncates facts from the lowest-scored end until the formatted output is under 2000 tokens

### Requirement: SystemPrefix injection point

The memory context SHALL be injected into the `systemPrefix` array in `agent-runner.ts` as a distinct section wrapped in `[PROJECT MEMORY]` / `[/PROJECT MEMORY]` tags, positioned after project instructions and before resume prefix.

#### Scenario: SystemPrefix composition order

- **WHEN** a thread starts with project instructions, memory context, and resume prefix all present
- **THEN** the systemPrefix is composed as: `[PROJECT INSTRUCTIONS]...[/PROJECT INSTRUCTIONS]\n\n[PROJECT MEMORY]...[/PROJECT MEMORY]\n\n{resumePrefix}`

#### Scenario: SystemPrefix with memory but no project instructions

- **WHEN** a thread starts for a project with no `systemPrompt` but with memory facts
- **THEN** the systemPrefix contains only `[PROJECT MEMORY]...[/PROJECT MEMORY]\n\n{resumePrefix}` (or just memory context if no resume prefix)

### Requirement: Operator context in multi-user mode

In multi-user mode, the recall SHALL include operator-specific context when the current user has an operator profile in the memory directory. The operator's preferences SHALL appear in a separate section.

#### Scenario: Multi-user thread with operator profile

- **WHEN** a thread is started by user "argenis" in multi-user mode, and `operators/argenis/PROFILE.md` exists in the memory directory
- **THEN** the formatted output includes an additional section:
  ```
  ## Current Operator: {name} ({role})
  {preferences}
  ```

#### Scenario: Multi-user thread without operator profile

- **WHEN** a thread is started by a user with no operator profile in memory
- **THEN** no operator section is included — the recall only contains project-level facts

#### Scenario: Local mode (single user)

- **WHEN** a thread is started in local auth mode
- **THEN** operator-specific recall is skipped entirely

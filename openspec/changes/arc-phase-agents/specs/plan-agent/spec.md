## ADDED Requirements

### Requirement: ThreadPurpose includes plan value

The `ThreadPurpose` type SHALL include `'plan'` as a valid value alongside `'explore'` and `'implement'`.

#### Scenario: Plan purpose accepted in thread creation

- **WHEN** a thread is created with `purpose: 'plan'` and a valid `arcId`
- **THEN** the thread is created successfully with purpose stored as `'plan'`

#### Scenario: Existing purposes unchanged

- **WHEN** a thread is created with `purpose: 'explore'` or `purpose: 'implement'`
- **THEN** behavior is identical to before this change

### Requirement: Plan agent system prompt

The system SHALL provide a `getPlanPrompt(arcName)` function that returns a system prompt for the plan phase. The prompt SHALL instruct the agent to:

- Read existing explore artifacts (proposal.md, early design notes) for context
- Produce structured artifacts: design.md, tasks.md, and specs/ files
- Validate feasibility by reading the actual codebase
- Make concrete architecture decisions with rationale
- Never write application code

#### Scenario: Plan prompt injected for plan threads

- **WHEN** an agent is started for a thread with `purpose: 'plan'` and a valid `arcId`
- **THEN** the system prompt includes the plan-specific prompt wrapped in `[ARC PURPOSE]` tags

#### Scenario: Plan prompt references arc name

- **WHEN** `getPlanPrompt('add-caching')` is called
- **THEN** the returned prompt references the arc name `add-caching` and its artifact paths (`arcs/add-caching/`)

### Requirement: Plan threads use local mode

Plan threads SHALL use `local` mode (no git worktree) since they do not write application code.

#### Scenario: Plan purpose forces local mode in UI

- **WHEN** a user selects purpose `'plan'` in the NewThreadDialog
- **THEN** the worktree toggle is hidden and the thread is created with `mode: 'local'`

#### Scenario: Explore still forces local mode

- **WHEN** a user selects purpose `'explore'` in the NewThreadDialog
- **THEN** the worktree toggle is hidden and the thread is created with `mode: 'local'` (unchanged behavior)

### Requirement: UI shows three purpose options

The NewThreadDialog purpose selector SHALL display three options when an arc is selected: Explore, Plan, and Implement.

#### Scenario: Three options visible

- **WHEN** a user selects an arc in the NewThreadDialog
- **THEN** the purpose dropdown shows Explore, Plan, and Implement as options

#### Scenario: Default purpose

- **WHEN** a user selects an arc and the purpose selector appears
- **THEN** the default selected purpose is `'implement'`

### Requirement: Explore prompt refined for discovery only

The explore prompt SHALL be updated to focus purely on discovery and investigation, removing guidance about producing structured implementation artifacts (tasks.md, specs/) since that is now the plan agent's responsibility. The explore prompt SHALL still allow writing proposal.md and early design notes.

#### Scenario: Explore prompt does not mention tasks.md production

- **WHEN** `getExplorePrompt('my-arc')` is called
- **THEN** the returned prompt does not instruct the agent to produce `tasks.md` or `specs/` files as primary outputs

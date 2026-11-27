## Purpose

Let a member give a repository a factory flow that can merge, generated from the repository's own
stack and verified by running it, before the factory is enabled, so a factory is never turned on
into a state where no run could ever merge.

## ADDED Requirements

### Requirement: A member can generate the factory configuration from the factory settings

When a factory's configured flow loads but is not proof-ready, the factory settings SHALL offer to
generate its configuration, whether the factory is off or already enabled. They SHALL NOT offer it
for a flow file that does not load. Starting it SHALL require the `steer` capability on the project
and SHALL start a setup thread as that member, on that member's own runner for the project, never
another user's runner; when that runner is offline the start SHALL fail and nothing SHALL run
elsewhere. The setup SHALL work in its own worktree created from the remote state of the
repository's default branch, and SHALL NOT change the member's working copy. A member SHALL have at
most one setup that has not ended per project and flow; starting another SHALL return that one.

#### Scenario: Starting the setup

- **WHEN** a member with `steer` clicks "Generate configuration" on a factory whose flow has no
  proof rules and their runner is online
- **THEN** a setup thread starts on their runner in a new worktree from the default branch, and the
  settings show it in progress with a link to the thread

#### Scenario: The member's runner is offline

- **WHEN** a member starts the setup and their runner for the project is offline
- **THEN** the start fails saying the runner is offline, and no thread starts on any runner

#### Scenario: A second start while one runs

- **WHEN** a member starts the setup while their previous setup for that flow has not ended
- **THEN** the system answers that setup and starts nothing new

#### Scenario: A flow file that does not parse

- **WHEN** the repository's flow file has a YAML syntax error
- **THEN** the settings show the error and do not offer to generate the configuration

### Requirement: The stack is detected without a model before the agent writes rules

Before the setup's agent runs, the system SHALL detect from the setup's checkout, without a model:
the package manager, the workspace or monorepo layout, each package's test runner and test file
patterns, and the test files that look like they need infrastructure (databases, containers,
network). The agent SHALL receive those findings with its first message, and the proposal SHALL show
them. For a stack the detector does not know, the findings SHALL say so and the setup SHALL still
run.

#### Scenario: An Nx + pnpm repository

- **WHEN** the setup runs on a repository with `pnpm-lock.yaml`, `nx.json`, Jest configs per project
  and `*.integration.spec.ts` files
- **THEN** the findings list pnpm, the Nx projects with a `test` target and their Jest configs, the
  `*.spec.ts` pattern, and the integration specs as needing infrastructure

#### Scenario: An unknown stack

- **WHEN** the setup runs on a repository whose test runner the detector does not recognize
- **THEN** the findings say no test runner was recognized, and the agent still proposes rules that
  the system verifies

### Requirement: The setup changes only the regression proof of the flow

The generated flow file SHALL start from the repository's own flow file when the default branch has
one, and from the built-in flow otherwise, and SHALL differ from that starting file only in its
`regression_proof` step. The system SHALL refuse a file that differs anywhere else.

#### Scenario: A repository with its own flow and no rules

- **WHEN** the default branch has an `issue-to-merge.yaml` with its own steps and no proof rules
- **THEN** the proposed file keeps those steps and adds only the `regression_proof` rules

#### Scenario: The agent edits another step

- **WHEN** the agent's file removes the `review` step
- **THEN** the setup fails saying the file changes more than the regression proof, and nothing is
  proposed

### Requirement: Every generated rule is verified by running it, by the system

The agent SHALL write, for each rule, a passing and a failing canary test that match the rule's
globs. The system, not the agent, SHALL then parse the file with the flow parser, check that it is
proof-ready, and run each rule in a checkout of the setup's base commit that holds none of the
agent's other changes, after the file's setup command. A rule SHALL be accepted only when all of
these hold: its passing canary exits successfully and the output names it; its failing canary fails
by an assertion (not a timeout, a setup failure or a file that cannot load) and the output names it;
an existing test file of the repository that the rule matches, not marked as needing infrastructure,
exits successfully; and passing two files at once (the passing canary and that existing test file)
exits successfully and the output names both. A rule that matches no such existing file SHALL be
rejected. Rejected rules SHALL be removed from the file and listed with their output. The canaries
SHALL NOT be part of the commit. Verification SHALL have a time limit, and running out of it SHALL
fail the setup.

#### Scenario: A rule that runs the canary

- **WHEN** a rule `**/*.spec.ts` → `pnpm exec jest {{files}}` runs the passing canary green, the
  failing canary red on its `expect`, and an existing `*.spec.ts` green
- **THEN** the rule is accepted and the proposal shows the three runs

#### Scenario: A rule whose failing canary does not load

- **WHEN** the failing canary of a rule fails because the test runner cannot resolve a module
- **THEN** the rule is rejected as inconclusive, removed from the file, and the proposal shows the
  output

#### Scenario: A command that ignores the files

- **WHEN** a rule's command runs the whole suite and its output never names the canary
- **THEN** the rule is rejected

#### Scenario: A command that fails with more than one file

- **WHEN** a rule's command accepts one file (such as `ng test --include {{files}}`) and fails or
  drops the second file when given two files at once
- **THEN** the rule is rejected and the proposal shows that output

#### Scenario: Canaries pass and the repository's tests do not load

- **WHEN** a rule's canaries behave as required and every existing test file it matches fails to
  load a path alias
- **THEN** the rule is rejected and the proposal shows that output

#### Scenario: The agent changed the test configuration

- **WHEN** the agent edited `jest.config.ts` in its worktree and its rule passes only with that edit
- **THEN** the rule is run without the edit and is rejected

#### Scenario: No rule survives

- **WHEN** every rule is rejected
- **THEN** the setup fails, shows each rule's output, and offers only writing the file by hand or
  the explicit opt-out

### Requirement: Nothing is committed without the member's confirmation

The setup SHALL end with a proposal showing the file, the detected stack, each rule's verification
and what stays uncovered (packages without tests, excluded specs). The file SHALL be committed and
pushed only when the member who started the setup confirms it, for the exact file shown. The system
SHALL commit only the flow file and, when the flow starts from the built-in one, unchanged copies of
the built-in prompt files it names (a repository flow reads its prompt files from the repository),
and SHALL push them to the repository's default branch without force,
with the member's own credentials; when the remote branch moved it SHALL put the commit on top of it
once if that applies cleanly. The agent SHALL NOT commit or push. The member SHALL be able to
discard a proposal. When a setup ends committed or discarded, its worktree and branch SHALL be
removed.

#### Scenario: Confirming the proposal

- **WHEN** the member confirms the proposal and the default branch accepts the push
- **THEN** one commit that adds only `.funny/workflows/issue-to-merge.yaml` and its prompt files is on the default
  branch, the factory's flow is ready, and enabling is allowed

#### Scenario: The file changed after it was shown

- **WHEN** the member confirms a proposal whose file differs from the one shown
- **THEN** nothing is committed and the member is shown the current file to confirm again

#### Scenario: Another user cannot confirm

- **WHEN** a different member confirms someone else's proposal
- **THEN** the confirmation is refused and nothing is pushed

#### Scenario: The runner goes away while pushing

- **WHEN** the runner becomes unreachable during the push and the file is not on the default branch
- **THEN** the proposal is shown again, ready to confirm

### Requirement: A rejected push can become a pull request

When the default branch refuses the push (a required check, a required review, another branch rule),
nothing SHALL be pushed to it and the proposal SHALL show GitHub's reason. The member SHALL then be
able to have the system push the setup's branch and open a pull request to the default branch with
that one commit, as the member. The system SHALL NOT merge that pull request. The factory SHALL stay
off until the file is on the default branch; the setup SHALL show the pull request, end as committed
once the file is there, and end as discarded when the pull request is closed without merging.

#### Scenario: A protected branch

- **WHEN** the push to `main` is rejected because it requires status checks
- **THEN** nothing is pushed to `main`, the proposal shows GitHub's reason and offers to open a pull
  request, and the factory stays off

#### Scenario: Opening the pull request

- **WHEN** the member chooses to open the pull request
- **THEN** a pull request to `main` with only that commit is open in the member's name, and the
  settings link to it

#### Scenario: The pull request merges

- **WHEN** a person merges that pull request
- **THEN** the factory's flow is ready, enabling is allowed, and the setup's branch is removed

### Requirement: The member can opt out of the regression proof explicitly

The proposal, and a failed setup, SHALL also offer to commit the starting flow file with
`require_regression_proof: false` on its `merge` step, through the same confirmation and the same
pull request fallback, saying that runs will then merge without showing their test catches the bug.

#### Scenario: Opting out

- **WHEN** the member chooses "Merge without regression proof" and confirms
- **THEN** a commit with that flow is pushed to the default branch and the factory can be enabled

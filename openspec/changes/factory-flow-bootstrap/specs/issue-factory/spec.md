## MODIFIED Requirements

### Requirement: Changes are checked for weakened tests and classified by risk

For each head commit of a run's pull request, the system SHALL report, without an agent: removed
test files or test cases, added skip or focus markers, lowered coverage thresholds, and edits to CI
workflow files. The system SHALL classify the change `high` risk when it has any such finding,
exceeds the factory's line limit (400 unless the factory sets another) in changed lines (not
counting tests, Markdown files, lockfiles, translation catalogs, stories, snapshots and the
factory's own globs left out of size), touches a default or factory-configured sensitive path, or
the contract lists a risk hint, and `low` otherwise. The factory's own configuration (any file under
`.funny/`, and `.funny.json`) SHALL be a default sensitive path, and no factory setting SHALL remove
a default sensitive path. No agent result SHALL lower the risk class.

#### Scenario: The factory's own size settings

- **WHEN** a factory sets its line limit to 800 and leaves `**/generated/**` out of size, and a
  change adds 3000 lines under `src/generated/` and 500 elsewhere
- **THEN** the change is not high risk for its size, and a sensitive path under
  `src/generated/` would still make it high risk

#### Scenario: A skipped test

- **WHEN** a CI fix adds `.skip` to a test and the checks turn green
- **THEN** the run's risk class is `high`, the reviewer receives the finding, and the run row
  shows it

#### Scenario: A small change in ordinary code

- **WHEN** a 60-line change touches no sensitive path and weakens no test
- **THEN** its risk class is `low`

#### Scenario: A run edits its own flow

- **WHEN** a 5-line change edits `.funny/workflows/issue-to-merge.yaml`
- **THEN** its risk class is `high` because it touches a sensitive path, and it does not merge
  without a member's approval

## ADDED Requirements

### Requirement: A factory is enabled only with a flow that can merge

Turning a factory on SHALL require that its configured flow, loaded exactly as an admitted run would
load it, loads and is proof-ready: its `merge` step sets `require_regression_proof: false`, or its
`regression_proof` step has at least one rule, or the flow has no `merge` step. When the flow is
invalid or not proof-ready the system SHALL refuse, leave the factory off, and answer which of the
two it is with the flow's problems. When the repository cannot be read (GitHub unavailable, the
GitHub App not installed) the system SHALL refuse saying the flow could not be checked, and SHALL
NOT say it is missing. The check SHALL apply in both the automatic and the manual mode. Saving other
settings of a factory that is already enabled SHALL NOT run the check nor disable it; that factory
SHALL keep showing the admission blocker. The factory's settings SHALL show whether the flow is
ready before the member tries to enable it.

#### Scenario: Enabling a repository without proof rules

- **WHEN** a member enables the factory of a repository whose default branch has no
  `.funny/workflows/issue-to-merge.yaml`
- **THEN** the factory stays off, the answer says the flow has no regression proof rules, and the
  settings offer to generate the configuration

#### Scenario: Enabling with an explicit opt-out

- **WHEN** the flow file on the default branch sets `require_regression_proof: false` on its `merge`
  step
- **THEN** the factory is enabled

#### Scenario: A flow without a merge step

- **WHEN** a member enables a factory whose configured flow is the built-in `issue-to-pr`
- **THEN** the factory is enabled

#### Scenario: GitHub cannot be read

- **WHEN** a member enables a factory while the repository cannot be read
- **THEN** the factory stays off and the answer says the flow could not be checked, with GitHub's
  reason

#### Scenario: A factory enabled before this check

- **WHEN** a factory enabled earlier without proof rules has its label changed
- **THEN** the save succeeds, the factory stays enabled, and it still shows "regression proof not
  configured"

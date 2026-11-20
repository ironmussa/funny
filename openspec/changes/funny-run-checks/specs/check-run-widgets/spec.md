# Spec Delta

## Purpose

Makes every check an agent runs in a thread (tests, type check, lint, format,
build) show as a progress widget, whether it came from the funny check tool or
from a plain shell command, without the agent writing a visualizer fence.

## ADDED Requirements

### Requirement: Live widget on the check tool call

A `funny_run_checks` tool call SHALL render, in place of the generic tool
card, the test-progress widget for test runs and the task-progress widget for
the other kinds, following the run live while it is in progress and showing
the final state once it ends. The agent SHALL NOT need to write a
` ```test-progress ` or ` ```task-progress ` fence for it to appear.

#### Scenario: Running test suite

- **WHEN** a `funny_run_checks` call with `kind: "test"` is in progress in the open thread
- **THEN** its card shows the test-progress widget with the suites done so far and updates while the run advances

#### Scenario: Thread reopened after the run

- **WHEN** a user opens a thread whose `funny_run_checks` call finished earlier
- **THEN** the card shows the final result of that run

#### Scenario: Progress file gone

- **WHEN** the progress file of a finished call can no longer be read
- **THEN** the card falls back to the summary in the tool result instead of an error

### Requirement: Result widget for shell checks

A Bash tool call whose command is recognised as a check and whose output is
complete SHALL render a result widget built from that output: totals and the
reported issues, with the raw command and output still reachable from the
card. A Bash call that is not recognised, or whose output cannot be parsed,
SHALL render as a normal Bash card.

#### Scenario: Vitest run via Bash with Codex

- **WHEN** a Codex agent ran `npx vitest run` and the output contains a vitest summary
- **THEN** the card shows passed / failed / skipped totals and the failing tests, and the raw output can be expanded

#### Scenario: tsc errors via Bash

- **WHEN** a Bash call ran `bunx tsc --noEmit` and printed TypeScript diagnostics
- **THEN** the card shows the error count and the diagnostics as `file:line` entries

#### Scenario: Unparseable output

- **WHEN** a Bash call ran `npx vitest` but its output was truncated before the summary
- **THEN** the card renders as a normal Bash card

### Requirement: Redirect setting per project

The project settings SHALL include a switch for redirecting raw check commands
to the funny check tool, on by default, with an explanation that it applies to
Claude agents.

#### Scenario: Switch turned off

- **WHEN** a user turns the switch off for a project
- **THEN** new Claude agents in that project's threads run raw check commands unchanged

# Spec Delta

## Purpose

Lets an agent run a project's tests, type check, lint, format or build through
one funny tool that knows the project's toolchain, shows the run live in the
thread and answers with a compact summary instead of the raw log.

## ADDED Requirements

### Requirement: Check tool is always available

The `funny` MCP server SHALL expose a `funny_run_checks` tool to every agent
spawn, for every provider, listed without deferral behind tool search. Its
input SHALL be `kind` (one of `test`, `typecheck`, `lint`, `format`, `build`,
`verify`) plus optional `scope` (files, packages or test patterns), `filter`
(a test name), `command` (an exact command) and `background` (boolean). The
server instructions SHALL tell the agent to run checks with this tool instead
of Bash.

#### Scenario: Tool listed for Claude and other providers

- **WHEN** an agent is spawned with the Claude, Codex or Gemini provider
- **THEN** `funny_run_checks` is in its tool list without a tool-search step

#### Scenario: Invalid kind

- **WHEN** the agent calls the tool with `kind: "deploy"`
- **THEN** the call fails with an error listing the accepted kinds and nothing runs

### Requirement: Toolchain detection

For a call without `command`, the tool SHALL choose the command from the
thread's working directory: its manifests (`package.json` scripts and
dependencies, `pyproject.toml`, `Cargo.toml`, `go.mod`) and lockfile-implied
package manager. A project script for the kind (for example `test`,
`typecheck`, `lint`) SHALL take precedence over invoking a tool directly. When
no command fits the kind, the call SHALL fail with a message that names what
was looked for and suggests passing `command`.

#### Scenario: Vitest project without a test script

- **WHEN** `kind` is `test`, `package.json` has `vitest` in devDependencies and no `test` script
- **THEN** the tool runs vitest with the project's package manager

#### Scenario: Project script wins

- **WHEN** `kind` is `typecheck` and `package.json` defines a `typecheck` script
- **THEN** the tool runs that script rather than `tsc` directly

#### Scenario: Python project

- **WHEN** `kind` is `test` in a directory with `pyproject.toml` declaring pytest
- **THEN** the tool runs pytest

#### Scenario: Nothing detected

- **WHEN** `kind` is `lint` and no lint tool or script is found
- **THEN** the call fails, says which manifests and tools were checked, and suggests `command`

#### Scenario: Scope and filter narrow the run

- **WHEN** the agent passes `scope: ["src/a.test.ts"]` and `filter: "parses dates"`
- **THEN** the run is limited to that file and that test name, in the detected tool's syntax

### Requirement: Exact command escape hatch

With `command` set, the tool SHALL run that command in the thread's working
directory and still record progress and a summary when the command is
recognised as a check; when it is not recognised, the tool SHALL run it and
return its exit code and output tail.

#### Scenario: Custom vitest invocation

- **WHEN** the agent passes `command: "bunx vitest run --project client"`
- **THEN** the run shows live progress and returns the same summary shape as a detected run

### Requirement: Live progress file

Every recognised run SHALL write the existing test-progress JSON (test runs)
or task-progress JSON (typecheck, lint, format, build, verify), rewritten as
the run advances, in a location the thread's viewers can read. The file SHALL
reach a terminal status (`passed` or `failed`) when the process exits,
including when it is killed or cancelled.

#### Scenario: Run killed midway

- **WHEN** the check process is killed before finishing
- **THEN** the progress file ends with status `failed` and the reason in its output tail

### Requirement: Compact summary to the agent

The tool result SHALL be a summary, not the full output: the command run, the
exit code, the duration, the totals (tests passed/failed/skipped, or errors
and warnings per step), and up to a bounded number of issues as
`file:line[:column] message`. The output tail SHALL be included only when the
run failed without reporting any issue. The result SHALL include the progress
file path.

#### Scenario: Failing tests

- **WHEN** a test run finishes with 3 failures out of 120 tests
- **THEN** the result lists the 3 failures with file, line and message, and the totals, and omits passing tests

#### Scenario: Crash without issues

- **WHEN** the type checker exits non-zero without reporting any diagnostic
- **THEN** the result includes the last lines of its output

### Requirement: Background runs

With `background: true`, the tool SHALL start the run as a durable job (the
same guarantees as `funny_spawn`: survives turn end and runner restart),
return at once with the job id and progress file path, and wake the agent with
the summary when the run ends. Cancelling the job SHALL stop the run and mark
its progress `failed`.

#### Scenario: Long suite in background

- **WHEN** the agent runs `kind: "test", background: true` and ends its turn
- **THEN** the agent is woken with the summary when the suite ends

### Requirement: Claude redirect of raw check commands

For Claude agents, a Bash tool call whose whole command is a plain check
invocation (for example `npx vitest run`, `bunx tsc --noEmit`, `bun run lint`,
optionally after `cd <dir> &&`) SHALL be denied before it runs, with a reason
that names `mcp__funny__funny_run_checks` and the equivalent arguments.
Commands where a check is only part of a larger pipeline or script SHALL NOT
be denied. The redirect SHALL be enabled by default and switchable per
project; when disabled, no Bash command is denied for this reason.

#### Scenario: Plain vitest call is redirected

- **WHEN** a Claude agent runs Bash `cd packages/client && npx vitest run src/a.test.ts` with the redirect enabled
- **THEN** the call is denied and the reason suggests `funny_run_checks` with `kind: "test"` and that scope

#### Scenario: Check inside a pipeline is allowed

- **WHEN** the agent runs `bunx tsc --noEmit 2>&1 | rg "error TS" | head`
- **THEN** the command runs unchanged

#### Scenario: Redirect disabled for a project

- **WHEN** the project's redirect setting is off and the agent runs `npx vitest run`
- **THEN** the command runs unchanged

## Why

The test-progress and task-progress widgets only appear when an agent runs the
funny repo's own scripts (`bun run test`, `bun run steps`), sets
`FUNNY_TEST_PROGRESS` / `FUNNY_TASK_PROGRESS`, and writes a ` ```test-progress `
fence naming the file. Nothing tells the agent to do that. Of ~30k check runs
in the local thread history, 15 set the variable; most called `vitest`, `tsc`,
`oxlint`, `bun test` or `pytest` directly, and about 60% ran in other projects,
where those scripts do not exist. The widgets should not depend on how the
agent happens to invoke a check.

## What Changes

- New `funny_run_checks` tool on the `funny` MCP server, always loaded, for
  every provider: `{ kind: test | typecheck | lint | format | build | verify,
  scope?, filter?, command?, background? }`.
  - Detects the project's toolchain from its manifests and scripts
    (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and picks the
    command: vitest, bun test, jest, playwright, pytest, cargo, go for tests;
    tsc, mypy for typecheck; oxlint, eslint, ruff for lint; oxfmt, prettier,
    ruff format for format; the project's `build` script; `verify` runs the
    project's lint + typecheck + test.
  - Runs it instrumented, writing the existing test-progress / task-progress
    JSON, and shows the widget on the tool call itself. No fence, no env var.
  - Returns a compact summary to the agent (totals, failures as
    `file:line message`, the output tail only when a failure reported no
    issue) instead of the full log.
  - `background: true` runs it as a durable job (the `funny_spawn` machinery)
    and wakes the agent with the summary when it ends.
  - `command` runs an exact command through the same instrumentation, so the
    agent never needs raw Bash for a check.
- Claude only: the PreToolUse hook denies a Bash command that is a plain
  check invocation and points the agent at `funny_run_checks`. On by default,
  switchable per project.
- Every provider: a Bash tool call recognised as a check renders the same
  widget with the final result parsed from its output (no live progress).
- `scripts/run-tests.ts` and `scripts/run-steps.ts` stay as producers of the
  same progress format; the tool uses them in the funny repo.

## Capabilities

### New Capabilities

- `agent-check-runs`: the `funny_run_checks` tool (toolchain detection,
  instrumented runs, agent-facing summary, background runs) and the Claude
  redirect of raw check commands.
- `check-run-widgets`: how the thread shows a check: the live widget on a
  `funny_run_checks` call, and the result widget for a Bash call recognised as
  a check.

### Modified Capabilities

None.

## Impact

- `packages/runtime`: new tool in `services/agent-watch-tool.ts` (or a sibling
  module registered on the same server), check runner + toolchain detectors,
  reuse of `agent-job-manager.ts` for background runs, progress files under
  the thread's assets dir.
- `packages/core/src/agents/sdk-claude.ts`: PreToolUse redirect rule, fed by a
  per-project setting.
- `packages/shared`: check-output parsers (vitest, bun test, jest, pytest,
  tsc, oxlint/eslint, ruff, mypy, cargo, go) shared by the runtime summary and
  the client's passive detection; existing `test-progress` / `task-progress`
  schemas unchanged.
- `packages/client`: `tool-cards/dispatch.tsx` routes `funny_run_checks` and
  recognised Bash checks to `TestProgressBlock` / `TaskProgressBlock`; a
  project setting toggle for the redirect.
- `packages/server`: persists the per-project redirect setting.
- Docs: `docs/visualizer-plugins.md` (fences become optional), the funny MCP
  instructions.

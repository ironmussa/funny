# Design

## Context

- The widgets exist: `TestProgressBlock` / `TaskProgressBlock` render a
  progress JSON file (`@funny/shared/test-progress`, `task-progress`), polled
  through the thread's runner by `use-progress-file.ts`. Today they are reached
  only through a ` ```test-progress ` / ` ```task-progress ` fence.
- The producers are repo scripts: `scripts/run-tests.ts` (vitest reporter,
  bun test and cargo output parsing in `scripts/test-progress.ts`) and
  `scripts/run-steps.ts` (oxlint, tsc, cargo counts in `scripts/step-output.ts`).
  They only exist in the funny repo.
- The `funny` MCP server (`agent-watch-tool.ts`, served by `agent-mcp-http.ts`)
  reaches every provider and already supports `alwaysLoad`. `funny_spawn` /
  `agent-job-manager.ts` provide durable background jobs with completion wake.
- `sdk-claude.ts` already has a PreToolUse hook that can deny a call with a
  reason. Codex and Gemini have no equivalent.
- `tool-cards/dispatch.tsx` picks the card per tool name; Bash goes to
  `BashCard`, MCP tools to `McpToolCard`.

## Goals / Non-Goals

**Goals:**

- One detection layer (what is this command, which tool, how to parse its
  output) shared by the tool, the Claude redirect and the client's passive
  rendering.
- Cover, in this order, the toolchains that dominate the history: vitest,
  tsc, bun test, oxlint/eslint, playwright, pytest, ruff/mypy, jest; then
  cargo and go.

**Non-Goals:**

- Live progress for checks run through raw Bash (only the final result).
- Rewriting Bash commands in the hook (`updatedInput`): the redirect denies,
  it does not edit what the agent asked for.
- Logs, HTTP, CI and git widgets (separate changes).

## Decisions

### 1. Detection and output parsing live in `packages/shared/src/checks/`

`classifyCheckCommand(command) → { kind, tool, plain: boolean, scope? } | null`
and one parser per tool (`parseVitestOutput`, `parseTscOutput`, …) that turns
output, streamed or complete, into the existing `TestProgress` /
`TaskProgress` shapes. The bun test / cargo parsing in `scripts/test-progress.ts`
and the counters in `scripts/step-output.ts` move here, and the scripts import
them.

Why shared: the runtime (summary, progress), core (hook redirect) and client
(passive widget) all need the same answer; shared already hosts the progress
schemas and is the only package all three may import. Parsers are pure
functions, no I/O.

Alternative: parse in the runtime and send structured results to the client.
Rejected for passive Bash cards: the client already has the output, and a
runtime pass would need new persistence for every Bash call.

### 2. Toolchain detection is a runtime service, separate from command classification

`check-toolchain.ts` in `packages/runtime/src/services/` reads manifests in
the thread cwd (resolved through `thread-context.ts`, so scratch and sandbox
threads behave like any other) and returns a `CheckPlan`: argv, cwd, parser,
progress kind. Rules, first match wins: project script for the kind → known
tool in dependencies (with the lockfile's package manager) → language default
(`pytest` with `pyproject.toml`, `cargo test` with `Cargo.toml`, `go test ./...`
with `go.mod`). In the funny repo, the `test` script resolves to
`scripts/run-tests.ts` with `FUNNY_TEST_PROGRESS`, and lint / typecheck /
build / verify to `bun run steps <kind>` with `FUNNY_TASK_PROGRESS`, so the
existing producers keep working unchanged.

`scope` / `filter` are translated per tool (vitest: paths + `-t`; pytest:
paths + `-k`; bun test: paths + `-t`; tsc: unsupported, ignored with a note in
the summary).

### 3. Instrumentation: reporter when the tool has one, output parsing otherwise

- vitest: add the existing progress reporter (`--reporter=default
  --reporter=<path>`), bundled with the runtime instead of resolved from the
  repo's `scripts/`.
- Everything else: stream stdout/stderr through the shared parser and rewrite
  the progress file (atomic rename, throttled as in `scripts/progress-io.ts`).

The run is an Effect program: spawn through `core/git/process.ts` `execute`,
interrupt kills the process group and finalizes the file as `failed`, a
timeout bounds synchronous runs. The public tool handler adapts the Effect
to a Promise at the MCP boundary.

### 4. Progress file location and widget correlation

Each run gets a `runId`; its file is `<thread assets dir>/checks/<runId>.json`
(the directory `FUNNY_ASSETS_DIR` points to, already readable through the
runner by the client).

The client must find the file while the tool call is still running, before
the tool result exists. When a run starts, the runtime emits a realtime event
`agent:check_run` `{ threadId, runId, kind, path, inputKey }` where `inputKey`
is a stable hash of the tool input. The card for a pending `funny_run_checks`
call computes the same hash from its input and subscribes to the matching
event; ties (same input twice in flight) bind in start order. The final tool
result also carries `progressPath`, so a reloaded thread renders from the
result alone.

Alternative: the Claude MCP `_meta` tool-use id. Rejected: not available for
every provider.

### 5. Background runs reuse jobs

`background: true` wraps the planned argv in a job via `agent-job-manager.ts`
spawn; the job's wake message is the summary (computed from the progress file
when the job ends) instead of the raw log tail. Synchronous runs are the
default because lint and typecheck run ~5 times per thread and an extra
wake turn each time would cost more than it saves.

### 6. Claude redirect is a deny with a precise suggestion

`sdk-claude.ts` receives an optional `checkRedirect(command) → string | null`
in its options; the runtime builds it from `classifyCheckCommand` and the
project setting. It denies only when `plain` is true: a single invocation,
optionally preceded by `cd <dir> &&` and env assignments, with no pipe,
redirection beyond `2>&1`, `;`, `||` or further `&&`. The reason gives the
exact call, e.g. `Use mcp__funny__funny_run_checks with {"kind":"test",
"scope":["src/a.test.ts"]}; pass "command" for a custom invocation.`

The setting is a project-level boolean `redirectChecksToFunny` (default
`true`) stored with the other project settings on the server and passed to
the runner in the agent start payload.

### 7. Client routing

`dispatch.tsx`:

- `mcp__funny__funny_run_checks` → `CheckRunCard`, which renders
  `TestProgressBlock` / `TaskProgressBlock` from the correlated path, falling
  back to the summary text when the file is unreadable.
- `Bash` → if `classifyCheckCommand(command)` matches and the shared parser
  returns a result from the output, `CheckResultCard` (the same blocks fed
  with an in-memory progress object, plus a collapsible raw output);
  otherwise `BashCard`.

The progress blocks get a variant that takes a progress object instead of a
path, so both cards share one rendering.

## Risks / Trade-offs

- [The deny costs a round trip and the agent may loop on it] → deny only
  plain commands, always offer `command` as an escape hatch in the tool, and
  log redirect counts per thread to check the loop rate after rollout.
- [Toolchain detection picks the wrong command in a monorepo] → prefer the
  project's own scripts, resolve from the thread cwd, and report the chosen
  command in the summary so the agent can override with `command`.
- [Parsers break when tool output formats change] → parsers return `null`
  rather than a wrong result; cards fall back to `BashCard` / the summary.
  Fixture tests per tool version we see in the history.
- [Passive parsing on every Bash card costs render time] → classify by
  command first (cheap regex), parse only matches, memoize per tool call id.
- [Synchronous long runs hit MCP request timeouts] → bound synchronous runs
  and tell the agent in the timeout result to rerun with `background: true`;
  the progress file keeps updating either way.

## Migration Plan

Additive. Fences keep working. Rollback: remove the tool from the server
spec and turn the redirect default off; passive cards fall back to `BashCard`.

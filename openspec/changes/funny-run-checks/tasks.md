# Tasks

## 1. Shared check detection and parsers

- [ ] 1.1 Add `packages/shared/src/checks/classify.ts` with `classifyCheckCommand` (kind, tool, `plain`, scope) for vitest, bun test, jest, playwright, pytest, cargo, go, tsc, mypy, oxlint, eslint, ruff, oxfmt, prettier and `<pm> run <script>`; verify with table tests over real commands from the thread history, including `cd x && …`, env prefixes, pipelines (not plain) and non-checks
- [ ] 1.2 Move the bun test / cargo output parsing from `scripts/test-progress.ts` and the counters from `scripts/step-output.ts` into `packages/shared/src/checks/parsers/`, make the scripts import them, and verify `scripts/__tests__/test-progress.test.ts` and `run-steps.test.ts` still pass
- [ ] 1.3 Add parsers for vitest (default reporter output), tsc, oxlint/eslint, pytest, ruff, mypy, jest, playwright, go test, each returning `TestProgress` / `TaskProgress` or `null`; verify with fixture outputs per tool (passing, failing, crashed, truncated → `null`)
- [ ] 1.4 Export the checks module from `packages/shared/package.json` and verify `bun run typecheck` passes

## 2. Runtime check runner and toolchain detection

- [ ] 2.1 Add `services/check-toolchain.ts` resolving a `CheckPlan` from the thread cwd (project script → known dependency with lockfile package manager → language default), including the funny repo's `run-tests.ts` / `bun run steps` routes and `scope` / `filter` translation; verify with fixture-directory tests for a vitest, jest, bun, pytest, cargo, go and funny-like project, plus the "nothing detected" error
- [ ] 2.2 Bundle the vitest progress reporter with the runtime and verify a vitest plan resolves its path without the repo's `scripts/`
- [ ] 2.3 Add `services/check-runner.ts`: an Effect program that runs a plan through `execute`, streams output through the parser into `<assets dir>/checks/<runId>.json` (atomic, throttled), finalizes `failed` on kill / interrupt / timeout; verify with tests for pass, fail, interrupt during the run and timeout
- [ ] 2.4 Add the summary builder (command, exit code, duration, totals, bounded `file:line` issues, tail only for issue-less failures, `progressPath`); verify with unit tests on progress fixtures
- [ ] 2.5 Emit `agent:check_run` `{ threadId, runId, kind, path, inputKey }` through the ws broker when a run starts, with `inputKey` from a shared hash helper; verify with a runtime test that the event carries the hash the client helper computes for the same input

## 3. `funny_run_checks` MCP tool

- [ ] 3.1 Register `funny_run_checks` on the `funny` server (zod schema per spec, always loaded) wiring toolchain → runner → summary, and the `command` escape hatch for recognised and unrecognised commands; verify with handler tests for each kind, invalid kind and `command`
- [ ] 3.2 Implement `background: true` on top of `agent-job-manager.ts` with the summary as the wake payload and cancel finalizing the progress file; verify with a job test covering completion wake and cancel
- [ ] 3.3 Add the check instructions to the `funny` server instructions and verify the agent-lifecycle test that inspects MCP instructions includes them
- [ ] 3.4 Document the tool in `docs/visualizer-plugins.md` (fences become optional, tool and passive cards) and verify the documented example input matches the schema

## 4. Claude redirect

- [ ] 4.1 Add the project setting `redirectChecksToFunny` (default `true`) to the server project settings, the API and the agent start payload; verify with a server route test for read / update and a runtime test that it reaches the spawn options
- [ ] 4.2 Add `checkRedirect` to `sdk-claude.ts` options and deny plain check commands in the PreToolUse hook with the suggested tool call; verify with hook tests: plain vitest denied with the right scope, pipeline allowed, setting off allowed
- [ ] 4.3 Log each redirect with thread id and tool so the loop rate can be checked; verify the log line in the hook test

## 5. Client cards

- [ ] 5.1 Give `TestProgressBlock` / `TaskProgressBlock` a variant that takes a progress object instead of a path; verify with component tests and stories for both inputs
- [ ] 5.2 Add `CheckRunCard` for `mcp__funny__funny_run_checks`: correlate the pending call with `agent:check_run` by `inputKey`, follow the file live, fall back to the summary when unreadable; add `data-testid`s and i18n strings (en, es, pt); verify with component tests for running, finished-on-reload and missing-file cases
- [ ] 5.3 Add `CheckResultCard` for Bash calls classified as checks with a parseable output (memoized per tool call id), keeping the raw output collapsible, and route it in `tool-cards/dispatch.tsx`; verify with tests for vitest via Bash, tsc errors via Bash and truncated output → `BashCard`
- [ ] 5.4 Add the redirect switch to project settings with an explanation that it applies to Claude agents; verify with a component test that it reads and writes the setting

## 6. Integration

- [ ] 6.1 Run `bun run lint`, `bun run typecheck` and the affected test suites, and verify all pass
- [ ] 6.2 Run a Claude thread in a non-funny vitest project and confirm: raw `npx vitest` is redirected, `funny_run_checks` shows the live widget, and a Codex thread's Bash `npx vitest` shows the result card

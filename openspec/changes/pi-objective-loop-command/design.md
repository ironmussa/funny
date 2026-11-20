## Context

There are two different loops involved:

1. The Pi SDK internal agent loop: model calls, tool execution, retries, compaction, and continuation inside `AgentSession.prompt()` / `AgentSession.continue()`.
2. The Claude-like slash `loop` workflow: the user gives an objective and the agent keeps taking turns until that objective is complete, blocked, cancelled, or bounded by limits.

This change is about the second loop only. funny should not manually execute Pi tool calls or replace Pi SDK internals. funny should own an outer objective loop that repeatedly sends ordinary prompts/follow-ups to a Pi session and evaluates whether more work is needed.

## Goals / Non-Goals

**Goals:**

- Support `/loop <objective>` for Pi-backed threads even when Pi does not natively expose a slash `loop` command.
- Keep loop state per thread: objective, status, iteration count, start/end times, limits, and latest progress summary.
- Reuse the live Pi process/session through `sendPrompt()` for loop continuations when provider options remain compatible.
- Stop deterministically on completion, blocked state, user cancellation, provider error, max iterations, max wall time, or max cost if configured.
- Surface enough lifecycle information for the UI and logs to explain what the loop is doing.
- Keep Pi SDK internal model/tool execution delegated to Pi.

**Non-Goals:**

- Do not implement a manual `while tool_use -> execute tool -> continue` loop in funny.
- Do not require Pi to support Claude's native slash command list.
- Do not add broad workflow automation beyond the `/loop` objective lifecycle.
- Do not change provider id `pi` or the existing `CLIMessage` event contract unless a small provider-neutral loop status event is required.

## Decisions

### Decision 1: Implement `/loop` as a funny-owned command before provider dispatch

The send boundary will detect a leading `/loop` command for Pi before the prompt is forwarded to the provider. It will parse the objective and start an objective loop controller. The raw slash command should not be sent to Pi as plain text unless the loop command is intentionally disabled.

Alternative considered: rely on Pi SDK slash command support. That keeps funny simpler but does not give a stable contract when Pi does not report or implement `/loop`.

### Decision 2: Use Pi turns as loop iterations

Each objective-loop iteration is one normal Pi turn. The controller sends the initial objective prompt, waits for the Pi result, records progress, then either stops or queues the next follow-up prompt on the same thread/session.

The continuation prompt should be explicit and concise: continue pursuing the objective, use prior context, report if complete or blocked, and avoid restarting from scratch.

### Decision 3: Use an explicit loop status protocol

The loop prompt wrapper will ask the agent to report one status at the end of each iteration:

- `continue`: more work remains and the next iteration should proceed.
- `complete`: the objective is done.
- `blocked`: the agent cannot make meaningful progress without user input or an external state change.

The implementation should parse a structured marker or equivalent machine-readable field from the assistant output. If parsing fails, the controller may default to `continue` until limits are reached, but it must log the parse failure and avoid tight loops.

Alternative considered: infer completion from arbitrary assistant prose. That is too brittle for an autonomous loop.

### Decision 4: Bound the outer loop independently from provider `maxTurns`

The objective loop needs its own limits:

- max iterations
- max wall-clock duration
- max cost, if cost accounting is available
- cancellation by user/thread stop

Provider `maxTurns` still bounds each Pi turn's internal execution. The objective-loop max iterations bounds how many Pi turns funny will run for the objective.

### Decision 5: Keep cancellation and process reuse provider-neutral

Stopping a loop should clear the loop state and stop scheduling new iterations. If a Pi turn is already running, cancellation should reuse the existing orchestrator/process stop path. Follow-up iterations should use the same compatibility rules as normal warm follow-ups, so a changed model/cwd/permission mode starts a new compatible process rather than accidentally continuing stale state.

## Risks / Trade-offs

- Status parsing can be brittle -> require a structured marker and test malformed/missing markers.
- Long-running loops can spend too much -> provide conservative default max iterations and support cancellation.
- UI may need loop status -> prefer existing messages/logs first; add a provider-neutral status event only if existing surfaces are insufficient.
- Pi process reuse can fail after restart -> persist enough loop state to resume or fail clearly rather than silently dropping the objective.
- Agent may claim completion too early -> leave the decision agent-owned for V1, with future room for verifier hooks.

## Migration Plan

1. Add slash command detection for Pi `/loop` before provider dispatch.
2. Implement an objective loop controller with per-thread state and bounded iteration scheduling.
3. Add prompt wrappers and status parsing for `continue`, `complete`, and `blocked`.
4. Wire loop iterations through existing Pi `sendPrompt()` / start-agent orchestration.
5. Add cancellation and cleanup paths.
6. Add tests for parsing, loop state transitions, continuation, limits, provider errors, and cancellation.
7. Validate with focused tests, `bun run lint`, and `bun run typecheck`.

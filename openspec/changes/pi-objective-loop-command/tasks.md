## 1. Command Boundary

- [ ] 1.1 Add or update slash-command parsing so Pi-backed `/loop <objective>` is recognized before provider dispatch.
- [ ] 1.2 Reject `/loop` without an objective with a user-visible error and no provider turn.
- [ ] 1.3 Decide whether `/loop` should be advertised in Pi slash-command autocomplete when Pi SDK does not report it.

## 2. Loop Controller

- [ ] 2.1 Add per-thread objective-loop state: objective, status, iteration count, start/end time, latest progress summary, stop reason, and configured limits.
- [ ] 2.2 Implement loop start, continue, complete, blocked, failed, limit, and cancelled transitions.
- [ ] 2.3 Ensure terminal states stop all future scheduling for the objective.
- [ ] 2.4 Persist or recover loop state only as far as existing thread/session lifecycle requires for V1.

## 3. Pi Iteration Execution

- [ ] 3.1 Build the initial Pi loop prompt wrapper from the parsed objective.
- [ ] 3.2 Build concise continuation prompts that preserve the objective and current progress without restarting from scratch.
- [ ] 3.3 Execute each iteration through normal Pi start/reuse orchestration and `sendPrompt()` follow-ups.
- [ ] 3.4 Keep Pi SDK model/tool execution delegated to `AgentSession` and existing Pi event translation.

## 4. Status Protocol and Limits

- [ ] 4.1 Define the machine-readable status marker for `continue`, `complete`, and `blocked`.
- [ ] 4.2 Parse loop status and progress summary from Pi responses.
- [ ] 4.3 Handle malformed or missing status without tight-looping.
- [ ] 4.4 Add conservative default max iterations and wire configured max iterations if an options surface exists.
- [ ] 4.5 Stop on provider error, user cancellation, max iterations, max wall time, and max cost where data is available.

## 5. UI and Events

- [ ] 5.1 Surface loop start, iteration, completion, blocked, failed, limit, and cancellation state through existing messages/logs where possible.
- [ ] 5.2 Add a provider-neutral loop status event only if existing message types cannot represent the lifecycle clearly.
- [ ] 5.3 Ensure loop status does not require Pi-specific UI handling.

## 6. Tests and Verification

- [ ] 6.1 Add parser tests for valid `/loop`, missing objective, and non-loop prompts.
- [ ] 6.2 Add controller tests for all state transitions and terminal states.
- [ ] 6.3 Add integration-style tests with a mocked Pi process for first iteration, continuation, completion, blocked, malformed status, and provider failure.
- [ ] 6.4 Add cancellation and max-iteration tests.
- [ ] 6.5 Run focused tests for changed packages.
- [ ] 6.6 Run `bun run lint`.
- [ ] 6.7 Run `bun run typecheck`.

## Why

Claude exposes a slash `loop` workflow where the user defines an objective and the agent keeps working toward it until the objective is done, blocked, cancelled, or bounded by limits. Pi's SDK owns the internal model/tool execution loop, but funny still needs an outer objective loop so Pi-backed threads can support the same autonomous workflow.

Without a funny-owned objective loop, sending `/loop ...` to Pi is either treated as plain text or depends on provider-specific slash command support that Pi may not expose. The result is a different user contract from Claude: Pi can complete one prompt, but cannot reliably continue pursuing a larger objective across multiple turns.

## What Changes

- Add a funny-owned Pi objective loop command for prompts that begin with `/loop`.
- Parse the loop objective from the slash command and create per-thread loop state with status, objective, iteration count, limits, and last progress summary.
- Drive Pi through normal `PiSDKProcess` prompt/follow-up APIs for each loop iteration while leaving Pi SDK model/tool execution untouched.
- After each Pi result, decide whether the loop should continue, complete, stop as blocked, fail, or stop because it hit configured limits.
- Surface loop lifecycle updates through existing thread/run messaging where possible, without adding Pi-specific UI message schemas unless required.
- Add tests for parsing, state transitions, continuation, stop conditions, cancellation, and Pi process reuse.

## Capabilities

### New Capabilities

- `pi-objective-loop-command`: Pi-backed threads can execute a Claude-like `/loop <objective>` workflow where funny coordinates an outer objective loop over normal Pi SDK turns.

### Modified Capabilities

None.

## Impact

- Touches slash-command handling around prompt submission/orchestration.
- Touches Pi agent orchestration and possibly shared agent process reuse if loop iterations need explicit thread ownership.
- Touches client slash-command discovery/display only if `/loop` must be advertised for Pi when the SDK does not report it.
- Adds tests around the loop controller, slash command parsing, and Pi adapter integration.
- Does not reimplement Pi SDK's internal model/tool loop.

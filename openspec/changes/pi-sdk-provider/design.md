## Context

funny currently runs Pi through `PiACPProcess`, a small shim over `GenericACPProcess` and `piManifest`. That path spawns `pi-acp`, communicates through `@agentclientprotocol/sdk`, and contains Pi-specific compatibility behavior such as banner stripping, auto-allow permissions, MCP capability filtering, dynamic model discovery through ACP `newSession`, and ACP fork support.

Pi's first-party SDK (`@earendil-works/pi-coding-agent`) now exposes typed APIs for native integration: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager`, `AuthStorage`, `ModelRegistry`, prompt/follow-up/steer operations, event subscription, model/thinking-level control, abort, dispose, and runtime session replacement.

## Goals / Non-Goals

**Goals:**

- Preserve provider id `pi` and existing UI/API contracts.
- Remove Pi from the ACP process path.
- Implement a `PiSDKProcess` that emits funny `CLIMessage` events from Pi SDK session events.
- Use the Pi SDK model registry for model discovery.
- Use Pi SDK session/runtime APIs for resume/fork where feasible.
- Keep other ACP providers unchanged.

**Non-Goals:**

- Do not redesign funny's generic `CLIMessage` contract.
- Do not migrate codex, gemini, cursor, or opencode away from ACP.
- Do not add a fallback flag to keep Pi on ACP unless the SDK lacks a required API at implementation time.
- Do not add new Pi-specific UI beyond what current provider/model controls already expose.

## Decisions

### Decision 1: Pi becomes a bespoke SDK process, not an ACP manifest

`PiSDKProcess` will extend `BaseAgentProcess` directly, similar in role to `SDKClaudeProcess` and `DeepAgentProcess`. `process-factory.ts` will map `pi` to this new class, while the ACP registry continues to own codex, gemini, cursor, and opencode.

Alternative considered: keep Pi in `GenericACPProcess` and use the SDK only inside `pi-acp`. That preserves the current adapter shape but keeps the extra subprocess/protocol boundary and prevents direct use of SDK session state.

### Decision 2: Use SDK session events as the source of truth

The adapter will subscribe to `AgentSessionEvent` and translate text deltas, thinking deltas, tool execution start/update/end, lifecycle, and result events into funny's existing `CLIMessage` stream. The adapter will synthesize stable tool-use ids when the SDK event does not provide funny-shaped ids.

Alternative considered: use SDK `runPrintMode` or `runRpcMode`. Those modes are useful for CLI/subprocess integration, but they throw away in-process state access that motivated this migration.

### Decision 3: Preserve warm follow-up and steer semantics

`sendPrompt()` maps to Pi follow-up behavior on the current session. `steerPrompt()` maps to Pi steering behavior when a turn is active. Initial prompt uses `session.prompt()`. `kill()` calls `abort()` and `dispose()`.

Alternative considered: respawn SDK sessions for every prompt. That would simplify lifecycle but regress the warm-session behavior that funny already has for ACP providers.

### Decision 4: Resume and fork prefer SDK runtime; context recovery remains the fallback

The adapter should use `SessionManager.create(cwd)` and the SDK runtime layer so a persisted Pi session can be reopened by id/path if the SDK exposes that through the installed version. Fork routes should call the Pi runtime's fork API when available. If the installed SDK does not expose a compatible primitive, funny should clear/adopt no Pi session id and rely on its existing context-recovery path rather than blocking the provider migration.

## Risks / Trade-offs

- SDK event shape drift -> isolate translation in `pi-sdk.ts` and cover it with mocked SDK tests.
- Session id semantics differ from ACP -> persist the SDK `sessionId` emitted by `AgentSession`; fall back to context recovery when reopen/fork is unavailable.
- Tool event mapping may be less exact than ACP initially -> preserve visible tool start/end cards first, then refine streaming details with tests.
- Pi SDK requires Node >= 22.19.0 -> verify current runtime compatibility during install/typecheck.

## Migration Plan

1. Add the SDK dependency.
2. Add `PiSDKProcess` and switch `process-factory.ts` registration for `pi`.
3. Replace Pi model discovery with SDK `ModelRegistry`.
4. Update fork handling for Pi to use SDK runtime when available or fall back to no native session fork.
5. Replace Pi ACP tests with SDK adapter tests.
6. Run focused tests, then `bun run lint` and `bun run typecheck`.

## Context

`AgentOrchestrator` (`packages/core/src/agents/orchestrator.ts`) holds live agent processes in `activeAgents: Map<threadId, IAgentProcess>`. ACP adapters (`generic-acp.ts`) keep their child process alive across turns via `awaitShutdown()` and re-prompt through `sendPrompt()`/`steerPrompt()`. MCP servers are passed per session into `newSession()`/`loadSession()`, so the ACP agent spawns one set of MCP grandchildren per session.

Two confirmed facts drive this design:

1. **Termination is shallow.** `generic-acp.ts` spawns the child without `detached`, and `kill()` does `childProcess.kill('SIGTERM')` — the immediate child only. MCP grandchildren (`codegraph`, `railway mcp`) may be orphaned, which is the dominant memory cost. This is shared code: `CodexACPProcess`, `GeminiACPProcess`, `PiACPProcess`, `CursorACPProcess`, `OpenCodeACPProcess`, and external `ExternalACPProcess` all extend `GenericACPProcess`, so one fix covers every ACP provider. `DeepAgentProcess` has the identical shallow-kill pattern independently; `LLMApiProcess` is in-process (no subtree).
2. **Reaping is loss-free for cold-path providers.** `cold-path-guard.ts` forces context recovery for codex/gemini/pi (they replay history and race `loadSession`), rebuilding context from the DB via `buildThreadContext()` on the next message. Only the claude SDK truly resumes by `sessionId`, and that resume preserves ~25k tokens of prompt cache per turn. So killing an idle non-claude process loses nothing funny relies on; killing an idle claude process is costly.

Nothing currently reaps a process once its thread is `completed`/`waiting`; trees stay resident indefinitely.

## Goals / Non-Goals

**Goals:**

- Guarantee that terminating an agent reaps its entire descendant tree on every kill path and platform.
- Free memory from idle, turn-terminal agent processes after a configurable window.
- Keep reaping non-destructive: preserve `sessionId`, thread status, and resumability; never reap mid-turn or while awaiting a permission decision.
- Tie reaping aggressiveness to the same provider classification that governs resume cost.

**Non-Goals:**

- Multiplexing multiple ACP sessions onto one shared process (rejected: MCP is per-session, so it would not free the grandchildren that dominate memory).
- A shared/global process pool across users, projects, or cwds.
- Any DB schema change or client-visible requirement (an optional "idle, resumes on next message" badge is out of scope).
- Reducing the per-session MCP server footprint (related lever, tracked separately).

## Decisions

### Decision 1: Spawn ACP children in their own process group and tree-kill

Spawn with `detached: true` (POSIX) so the child becomes a process-group leader, then terminate with `process.kill(-pid, 'SIGTERM')` followed by `SIGKILL` after a grace timeout. On Windows, terminate the tree with `taskkill /PID <pid> /T /F`. Centralize this in a `base-process.ts` helper so all adapters share one correct implementation, and route `generic-acp.ts` `kill()`/unexpected-exit cleanup (covers all ACP providers including external) **and** `deepagent-process.ts` `kill()` through it. `LLMApiProcess` needs no change (no subprocess).

- **Why over relying on the agent's own cleanup:** we cannot assume `codex-acp` (or any ACP binary) reaps its MCP children on SIGTERM; depending on that is the current bug. Process-group termination is independent of the child's signal handling.
- **Alternative considered:** a `tree-kill` npm dependency — rejected to avoid a new dependency for behavior achievable with the process group plus existing `core/src/git/process.ts` primitives.

### Decision 2: Drive idle off message-activity recency plus turn-terminal state

Add `lastActivityAt: Map<threadId, number>` to the orchestrator, refreshed on start, every emitted `message` (in `wireProcessHandlers`), `sendPrompt`, `steerPrompt`, and `adoptProcess`. A mid-turn process emits messages continuously, so its timestamp stays fresh and it is structurally ineligible — no need to introspect adapter internals. Gate reaping additionally on turn-terminal state using the existing `resultReceived` set so a turn paused on a permission prompt (no result yet) is never reaped.

- **Why over a status-driven timer:** thread status (`completed`/`waiting`) lives in the runtime/DB, not in core; activity recency is already observable at the process boundary and keeps the core logic pure and unit-testable.
- **Alternative considered:** arming a per-thread `setTimeout` on result — rejected; a single periodic sweep is simpler, avoids timer leaks, and is trivially testable with an injected clock.

### Decision 3: Pure candidate selection in core, scheduling/policy in runtime

Core exposes `getIdleCandidates(nowMs, policy): string[]` (pure over `activeAgents` + `lastActivityAt` + `resultReceived`) and `reapIdleAgent(threadId)` (the mechanic). A new `packages/runtime/src/services/idle-reaper.ts` owns the single `setInterval` sweep, reads config, applies the provider policy, calls the core query/mechanic, and emits logs + metrics to Abbacchio. This respects the existing layering (core = portable logic, runtime = scheduling + telemetry) and keeps wall-clock and env out of core.

### Decision 4: Reap is a distinct, non-destructive operation

`reapIdleAgent` is separate from `stopAgent`: it tree-kills and removes from `activeAgents`/`lastOptions`/`lastActivityAt`, but does **not** add to `manuallyStopped`, does **not** clear the persisted `sessionId`, and does **not** change thread status. It emits a new `agent:reaped` event (carrying `threadId`, `provider`, `idleMs`) for telemetry. The next user message goes through the existing `startWithResume` → cold-path/resume path unchanged.

- **Provider policy (binary, not enumerated):** classify with the same predicate as `shouldForceColdPathRecovery` — `claude` is conservative (separate window, disabled by default); **every other provider** (codex, gemini, pi, cursor, opencode, external ACP, deepagent, llm-api) uses the standard window. Keying off `provider === 'claude'` rather than an allow-list means new/external providers are covered automatically with no code change.

### Decision 5: Configuration

`FUNNY_AGENT_IDLE_REAP_MS` (default 600000), `FUNNY_AGENT_IDLE_REAP_MS_CLAUDE` (default 0 = disabled), `FUNNY_AGENT_IDLE_SWEEP_MS` (default 60000). Zero disables reaping for that class. Defaults are conservative for claude until memory is measured.

## Risks / Trade-offs

- **Orphaned MCP children if tree-kill is incomplete on some platform** → centralize in one helper, cover with a test that asserts the process group (not just the pid) is signaled; verify on POSIX first since that is the deployment target.
- **Reaping a process the user pings every few minutes causes churn (respawn + one-time context re-injection)** → the idle window (default 10 min) targets genuinely done threads; activity refresh on `sendPrompt`/`steerPrompt` prevents reaping an active conversation.
- **Reaping claude would discard prompt cache (~25k tokens/turn)** → claude window disabled by default; gated behind its own env var.
- **Adopted processes after `bun --watch` restart could be reaped instantly** → seed `lastActivityAt = now` in `adoptProcess`.
- **Race: a message arrives between candidate selection and kill** → re-check idle immediately before `kill`; coarse sweep interval minimizes the window.
- **`resultReceived` semantics must actually represent the current turn** → verified during implementation; if it is cumulative rather than per-turn, gate instead on "last emitted message was a result/terminal" before reaping.

## Migration Plan

Ship in phases; each is independently revertable.

1. **Phase 0 — tree-kill** (Decision 1). Independent, high value; likely recovers memory on its own by ending MCP orphaning. Measure agent-tree RSS/PSS before and after.
2. **Phase 1 — core reaper primitives** (Decisions 2–4): `lastActivityAt`, `getIdleCandidates`, `reapIdleAgent`, `agent:reaped`. No behavior change until a driver calls them.
3. **Phase 2 — runtime driver + config** (Decisions 3, 5): `idle-reaper.ts` ticker, env config, telemetry, startup wiring, `adoptProcess` seeding.

Rollback: set the idle windows to `0` to disable reaping at runtime; revert Phase 0 independently if a platform regression appears.

## Open Questions

- Does `codex-acp` reap its own MCP children on SIGTERM, or are they genuinely orphaned? Measure during Phase 0 — determines how much Phase 0 alone recovers.
- Exact semantics of `resultReceived` (set on result, cleared on next prompt?) — confirms it is a safe "no permission pending" gate, per the Risks note.
- **`sdk-claude` POSIX tree-kill (deferred from Phase 0):** the custom SDK spawn shim tree-kills on Windows (`taskkill /F /T`) but on POSIX relies on the abort signal hitting only the immediate child, so a claude MCP subtree could orphan. Deferred because claude is the conservative (rarely-reaped) provider and the spawn is injected into the SDK; revisit by adding `detached` + `killProcessTree` there if claude memory shows orphaning.

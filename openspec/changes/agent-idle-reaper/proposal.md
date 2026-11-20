## Why

ACP-based agents (codex, gemini, pi) keep their child process alive after a turn completes so follow-ups can reuse the warm session. Each session also spawns its own MCP servers (`codegraph`, `railway mcp`, …) as grandchildren. Two problems compound: (1) killing an agent only signals the immediate child, so its MCP grandchildren can be orphaned and leak memory, and (2) nothing ever reaps a process whose thread is done — completed/waiting threads keep full process trees resident indefinitely. The result is steady memory growth from idle agent trees and orphaned MCP servers.

## What Changes

- Terminate the **entire process tree** when an agent process is killed — spawn agent children in their own process group and signal the group (SIGTERM → SIGKILL grace), so MCP grandchildren can never be orphaned. Fixed once in the shared `GenericACPProcess` path, this covers **every ACP provider** (codex, gemini, pi, cursor, opencode, and external/installed providers — all subclasses of `GenericACPProcess`); the same shallow-kill bug in `DeepAgentProcess` is fixed too. Applies to every kill path (manual stop, delete, respawn, reap).
- Track per-thread agent **last-activity** in the orchestrator and add an **idle reaper** that kills quiescent agent processes after a configurable idle window. The reaper lives in the orchestrator, so it is provider-agnostic by construction.
- Make reaping **provider-aware** with a binary policy that mirrors the existing cold-path rule (`provider !== 'claude'`): aggressive for **all non-claude providers** (codex, gemini, pi, cursor, opencode, external, deepagent — cold-path context recovery rebuilds state from the DB on the next message, so reaping is loss-free), conservative/off by default for claude (SDK resume preserves prompt cache, so reaping is costly).
- Reaping is **non-destructive**: it does not clear the persisted `sessionId`, does not mark the thread stopped/failed, and does not flag a manual stop. A new `agent:reaped` event is emitted for telemetry; the next user message resumes via the existing resume / cold-path path.
- Reaping never targets a process that is mid-turn or awaiting a user decision (permission prompt) — gated on turn-terminal state plus activity recency.
- Configurable via environment: idle window (non-claude), idle window (claude, default disabled), and sweep interval.

## Capabilities

### New Capabilities

- `agent-process-termination`: Terminating an agent process MUST reap its entire child process tree so no MCP server or other grandchild is left orphaned, on every kill path and platform.
- `agent-idle-reaping`: Idle, turn-terminal agent processes are reaped after a provider-aware idle window without losing resumability, thread status, or pending user decisions.

### Modified Capabilities

<!-- None — no existing spec's requirements change. -->

## Impact

- **`packages/core/src/agents/generic-acp.ts`** — spawn the ACP child detached (own process group) and tree-kill in `kill()` and the unexpected-exit cleanup. This single change covers all ACP providers (codex/gemini/pi/cursor/opencode + external `ExternalACPProcess`) since they all extend `GenericACPProcess`.
- **`packages/core/src/agents/deepagent-process.ts`** — same shallow `childProcess.kill('SIGTERM')` bug (lines ~72/181/387); route through the shared tree-kill helper. (`llm-api` is in-process, no subtree.)
- **`packages/core/src/agents/base-process.ts`** — shared tree-kill helper (cross-platform: POSIX process-group signal, Windows `taskkill /T`).
- **`packages/core/src/agents/orchestrator.ts`** — new `lastActivityAt` map, activity updates on start/message/`sendPrompt`/`steerPrompt`/`adoptProcess`, plus pure `getIdleCandidates(nowMs, policy)` and `reapIdleAgent(threadId)`; new `agent:reaped` event.
- **`packages/runtime/src/services/idle-reaper.ts`** (new) — single sweep ticker that drives the orchestrator's candidate query, applies the provider policy, and emits logs/metrics to Abbacchio.
- **Runtime startup wiring** — start/stop the reaper ticker with the runner lifecycle; seed activity on `adoptProcess` to survive `bun --watch` restarts.
- **Config** — `FUNNY_AGENT_IDLE_REAP_MS`, `FUNNY_AGENT_IDLE_REAP_MS_CLAUDE`, `FUNNY_AGENT_IDLE_SWEEP_MS`.
- No DB schema change. No client requirement change (optional future "idle, resumes on next message" badge is out of scope).

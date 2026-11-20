## 1. Phase 0 — Whole-tree termination

- [x] 1.1 Add a cross-platform tree-kill helper in `packages/core/src/agents/base-process.ts` (POSIX: signal the process group with SIGTERM then SIGKILL after a grace timeout; Windows: `taskkill /PID <pid> /T /F`)
- [x] 1.2 Spawn the ACP child in its own process group in `generic-acp.ts` (`detached: true` on POSIX) and capture the pid/pgid — this covers all ACP providers (codex/gemini/pi/cursor/opencode + external `ExternalACPProcess`) since they extend `GenericACPProcess`
- [x] 1.3 Route `generic-acp.ts` `kill()` and the unexpected-`exit` cleanup through the tree-kill helper
- [x] 1.4 Fix the same shallow `childProcess.kill('SIGTERM')` in `deepagent-process.ts` (~lines 72/181/387) via the shared helper; audit `sdk-claude.ts` and `acp-fork.ts`; confirm `llm-api-process.ts` has no subprocess (no change needed). Audit result: `sdk-claude` POSIX gap deferred (claude is conservative + SDK-managed spawn shim); `acp-fork`/`acp-discover` are one-shot `initialize`-only probes (no MCP session) → no change; `llm-api` has no subprocess.
- [x] 1.5 Add a core test asserting termination signals the process group (not just the immediate pid) and that a spawned grandchild is gone after `kill()` (`packages/core/src/__tests__/kill-process-tree.test.ts`)
- [ ] 1.6 Measure agent-tree RSS/PSS before vs after Phase 0 on a codex thread to confirm MCP grandchildren are freed (record in the change notes) — **MANUAL GATE: requires running the app**

## 2. Phase 1 — Core reaper primitives

- [x] 2.1 Add `lastActivityAt: Map<string, number>` to `AgentOrchestrator`
- [x] 2.2 Refresh `lastActivityAt` on `startAgent`/respawn, on every emitted `message` in `wireProcessHandlers`, on `sendPrompt` reuse, on `steerPrompt`, and on `adoptProcess` (seed = now)
- [x] 2.3 Verify `resultReceived` semantics represent the current turn; if cumulative, derive a turn-terminal gate from the last emitted message instead. Result: `resultReceived` is added on the turn's `result` and cleared on the next prompt/respawn/exit — so `resultReceived.has(threadId)` is a safe per-turn-terminal gate that also excludes permission-pending turns (no result yet). Used directly.
- [x] 2.4 Implement pure `getIdleCandidates(nowMs, policy)` gating on turn-terminal + idle-window + not-awaiting-permission, with per-provider windows
- [x] 2.5 Implement `reapIdleAgent(threadId)`: tree-kill, delete from `activeAgents`/`lastOptions`/`lastActivityAt`, do NOT touch `manuallyStopped`, sessionId, or thread status
- [x] 2.6 Add the `agent:reaped` event (payload: `threadId`, `provider`, `idleMs`) to the orchestrator's event surface (`OrchestratorEvents`) and re-export `IdleReapPolicy` from the `@funny/core/agents` barrel
- [x] 2.7 Map provider → policy with a binary `provider === 'claude'` check (claude conservative; all other providers — codex/gemini/pi/cursor/opencode/external/deepagent/llm-api — standard), consistent with `shouldForceColdPathRecovery`; do NOT enumerate an allow-list

## 3. Phase 1 — Core tests

- [x] 3.1 Idle past window + turn-terminal → returned by `getIdleCandidates` and reaped (fails without the feature)
- [x] 3.2 Mid-turn (recent messages) → not a candidate
- [x] 3.3 Awaiting permission (no terminal result) → not a candidate
- [x] 3.4 Claude with disabled window → not reaped; codex with standard window → reaped
- [x] 3.5 Adopted process seeded with activity → not reaped on the first sweep
- [x] 3.6 After reap: sessionId unchanged, thread status unchanged, `manuallyStopped` not set, `agent:reaped` emitted, no `agent:stopped` (in `orchestrator.test.ts`)

## 4. Phase 2 — Runtime driver, config, telemetry

- [x] 4.1 Add `packages/runtime/src/services/idle-reaper.ts` with a single `setInterval` sweep that calls `getIdleCandidates` and `reapIdleAgent`
- [x] 4.2 Read config: `FUNNY_AGENT_IDLE_REAP_MS` (default 600000), `FUNNY_AGENT_IDLE_REAP_MS_CLAUDE` (default 0), `FUNNY_AGENT_IDLE_SWEEP_MS` (default 60000); `0` disables that class
- [x] 4.3 Re-check idle immediately before kill to close the message-arrival race
- [x] 4.4 Emit logs + metric `agent.idle_reaped` (provider) to Abbacchio via the runtime logger/telemetry helpers (in `agent-event-router.ts` `agent:reaped` handler)
- [x] 4.5 Start/stop the reaper ticker with the runner lifecycle (enabled only on the default singleton runner via `AgentRunner`'s `enableIdleReaper`, stopped in `shutdownManager`); global-handle dedupe prevents a duplicate ticker across `bun --watch` restarts
- [x] 4.6 Handle the `agent:reaped` event in the runtime (log only; must not alter thread status)

## 5. Verification

- [x] 5.1 `bun run typecheck` introduces 0 new errors from this change (the 1 NEW-vs-baseline error is pre-existing in `runtime/src/lib/auth.ts`, unrelated to this work — from a Better Auth dep bump in the dirty working tree)
- [x] 5.2 Core suite 561 passed / 1 skipped; runtime 1329 passed. The 1 runtime failure (`command-runner-project-scope`) is pre-existing/unrelated — that subsystem has zero coupling to anything changed here and its files are unmodified
- [ ] 5.3 Manual smoke: idle a codex thread past the window, confirm process tree (incl. MCP) is gone, then send a follow-up and confirm cold-path resume continues the conversation — **MANUAL GATE: requires running the app**
- [x] 5.4 Update env/config docs (INSTALL.md / relevant CLAUDE.md) with the three new variables (added to INSTALL.md runner env table)

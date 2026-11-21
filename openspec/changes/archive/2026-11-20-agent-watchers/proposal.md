## Why

When an agent starts work that takes a while (a build, a CI run, a deploy, a long migration) it routinely says "I'll check back in 30 minutes" — but the agent's turn ends and the promise dies with it: the intent to re-check does not survive the turn boundary, so it never actually checks, and the user loses visibility. We need funny to own a **durable, deferred wake** that lives outside the agent's turn: when the time comes, funny wakes the thread, the agent re-checks with its own tools, and then either concludes or reschedules ("give it 5 more minutes"). This makes "I'll check later" real and keeps the user informed.

## What Changes

- Introduce a **watcher (snooze)**: a durable, funny-managed deferred wake that an agent schedules via a new `funny_watch` tool. A watcher records "wake this thread in N time" and survives the turn ending.
- **Pure-snooze model — the agent is the evaluator.** funny does **not** run a check command or interpret a condition. When a watcher fires, funny wakes the thread with a follow-up; the agent checks however it likes (its normal tools) and decides the outcome.
- **Reschedule.** On waking, the agent can extend the wait by scheduling the next check (30 min → +5 min → …). Scheduling and rescheduling are the **same idempotent operation** keyed by `(threadId, key)` — calling `funny_watch` again for the same key re-arms the existing watcher instead of creating a second one.
- **Invariant: only `funny_watch` creates a snooze.** Nothing inferred from the agent's prose ever creates a watcher. The decision of "did the agent schedule?" branches on the **structured `tool_use` signal** (`mcp__funny__funny_watch` appearing in the turn), never on message text — this prevents double-firing when the agent both schedules _and_ narrates it.
- **Reliability safety net.** If a turn ends with **no** `funny_watch` tool call but the agent expressed intent to check back later, funny does not let the turn die silently: it re-prompts the agent (constrained to `funny_watch` or an explicit conclusion). The safety net **never creates** a watcher — it only nudges the agent to call the tool itself, so the single creation path holds.
- **Durable engine, no new infra.** A single heartbeat scanner queries the DB for watchers whose `nextWakeAt` is due — the same pattern as `checkCompletedRuns` in `automation-scheduler.ts`. The DB row is the source of truth; the timer is a disposable projection. On runner restart, pending watchers are rehydrated and catch up. **No croner, no BullMQ/Redis/Postgres queue, no PM2** — preserving the SQLite-default, stateless-runner model.
- **Waking reuses existing plumbing**: the follow-up is delivered through `messaging.ts` + `sdk-session.ts` (session resume) + `agent-completed-queue-handler.ts` (so a wake waits for an idle thread instead of interrupting an active turn).
- **Integration surface**: `funny_watch` is exposed as an **in-process SDK MCP tool** (`createSdkMcpServer`) for the Claude path and as an **external MCP server** (translated via `toACPMcpServers`) for other providers — one shared handler behind both. funny injects it on every spawn, so it is always available (not a user-configured server, not a skill).
- **UI**: a **global** Watchers panel (cross-thread, like automations) shows each watcher's label, status, countdown to next wake, and wake count, with a cancel control.
- **Safety/lifecycle**: hard caps (`maxWakes`, `deadline`) bound a runaway reschedule loop; watchers die with their thread; cancellation is available from the UI.

## Capabilities

### New Capabilities

- `agent-watchers`: the durable deferred-wake primitive — the `funny_watch` tool (sole creation path) exposed in-process and via external MCP; idempotent create-or-reschedule keyed by `(threadId, key)`; the single `nextWakeAt` scanner engine with persistence and boot-time rehydration; lifecycle and safety caps; the global Watchers panel and live status broadcast.
- `watcher-agent-wake`: firing a watcher — waking the thread with a rendered follow-up that resumes the agent session, gated on thread-idle, and the reschedule loop by which the agent extends or concludes.
- `watcher-scheduling-reliability`: ensuring an agent's "I'll check later" reliably becomes a scheduled watcher — the only-`funny_watch`-creates invariant, branching on the structured `tool_use` signal, and the non-creating nudge safety net that re-prompts (constrained) when a turn ends with deferred-check intent but no tool call.

### Modified Capabilities

<!-- None — this is purely additive. -->

## Impact

- **New DB table** `watchers`: `id`, `threadId`, `userId`, `key`, `label`, `nextWakeAt`, `lastDelayMs`, `wakeCount`, `maxWakes`, `deadline`, `status`, `createdAt`, `updatedAt`. Schema in `packages/shared/src/db/schema.ts` (+ sqlite/pg variants), created via `db/migrate.ts`. New repository in `packages/shared/src/repositories/`.
- **New runtime service** `watcher-manager.ts` (the scanner engine + idempotent create-or-reschedule + lifecycle), a sibling of `automation-scheduler.ts`, registered with `ShutdownManager` and started on boot.
- **New agent tool** `funny_watch` wired through `options.mcpServers` in `packages/core/src/agents/sdk-claude.ts` (in-process via `createSdkMcpServer`) and translated for ACP providers via `acp-mcp.ts` (`toACPMcpServers`); one handler calling `watcher-manager.createOrReschedule`.
- **Reliability hook** at turn completion (in/around `agent-completed-queue-handler.ts`): detect "no `funny_watch` tool_use this turn" + deferred-check intent (small classifier) → constrained re-prompt. Plus a system-prompt addendum making `funny_watch` the mandated mechanism for deferred checks.
- **Reuses**: `wsBroker.emitToUser` (per-user visibility), `messaging.ts` / `sdk-session.ts` / `agent-completed-queue-handler.ts` (wake), `nanoid`.
- **New WS events** (`watcher:created`, `watcher:fired`, `watcher:rescheduled`, `watcher:completed`, `watcher:cancelled`) in `packages/shared/src/socket-events.ts`, consumed by `use-ws.ts` and a new Zustand slice.
- **New client UI**: a global Watchers panel in `packages/client` (cross-thread), with `data-testid` attributes per the project UI rules.
- **Runner-restart semantics**: a snooze is just a scheduled wake — after restart the scanner re-arms it from the DB and fires (possibly late) on the first heartbeat past `nextWakeAt`. Nothing about a watched process is held in memory.

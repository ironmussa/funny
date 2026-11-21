## Context

Agents in funny run as Claude Agent SDK turns (and other providers). When an agent kicks off work that finishes later (build, CI, deploy, migration) it commonly narrates "I'll check back in ~30 min" and then ends its turn. That intent is held only in prose; nothing in funny owns it, so the check never happens and the user is left with a finished turn and no visibility.

funny already has the building blocks:

- **`automation-scheduler.ts`** runs two mechanisms: `croner` for calendar cron expressions, and a plain `setInterval(checkCompletedRuns, 15_000)` — explicitly commented "no cron needed" — that scans running automation runs and acts on state change. That second mechanism is exactly the due-time scanner we need.
- **`messaging.ts` + `sdk-session.ts`** inject a follow-up into a thread and resume its existing agent session.
- **`agent-completed-queue-handler.ts`** queues work to run when a thread's current turn completes.
- **`sdk-claude.ts`** already accepts `options.mcpServers` (line 309), builds the `mcp__<name>__*` allow-pattern (line 312), and supports **in-process MCP** via `createSdkMcpServer` (line 415, with the streaming-input requirement handled). **`acp-mcp.ts` (`toACPMcpServers`)** translates the same servers for ACP providers.
- **`wsBroker.emitToUser`** broadcasts per-user, satisfying runner isolation.

Constraints: the runner is **stateless with no DB** (proxies persistence to the server); the default datastore is **SQLite**, Postgres optional; per-user runner isolation is a hard boundary.

## Goals / Non-Goals

**Goals:**

- Make an agent's "I'll check back in N minutes" survive the turn boundary and genuinely fire.
- Let the agent re-check on its own terms and **reschedule** (extend) the wait dynamically.
- Keep visibility: the user can see pending wakes and their countdown from a global panel.
- Be durable across runner restarts **without new infrastructure**.
- Guarantee that a scheduled wake comes from exactly one place — the `funny_watch` tool — with no double-firing.
- Make the tool **reliably reached for**: always present on every spawn, and a safety net when the agent forgets.

**Non-Goals:**

- A check engine inside funny (exit-code / output-match / condition evaluation). The **agent is the evaluator**; funny only schedules the wake.
- A persistent process supervisor / always-on service archetype (no PM2, no restart-on-crash, no health-port). Watchers are **jobs only**: schedule a wake, the agent checks, done or reschedule.
- A distributed job queue with multi-runner work-stealing, exactly-once, retries/backoff, or dead-letter queues. (DB-as-source-of-truth keeps a future migration to pg-boss cheap if ever needed.)
- Creating a watcher from anything other than a `funny_watch` tool call (no inference from prose).
- Cron-calendar scheduling — that is what automations already do.

## Decisions

### Decision 1: Pure snooze — the agent is the evaluator, funny only schedules the wake

A watcher records "wake `threadId` at `nextWakeAt`". funny runs no check command. When it fires, funny wakes the agent; the agent checks with its own tools and either concludes (does nothing further) or reschedules.

- **Why:** The user's real case is minutes-scale waits where the agent decides "ready or wait more." Funny-side evaluation (exit-code/output-match) adds an engine, a condition language, and rigidity for no benefit here, and can't express "the agent looks and judges." Pure snooze is dramatically less code and matches "with a job we have enough."
- **Trade-off:** each check costs an agent turn (tokens). Acceptable because intervals are minutes, not seconds, so the turn count is small, and the agent gains full flexibility (extend, change cadence, conclude).
- **Alternatives considered:** funny-run check command with edge-triggered wake (cheaper per check, but reintroduces the evaluation engine and a fixed condition; deferred to a possible v2 as an optional optimization).

### Decision 2: One due-time scanner, DB is the source of truth

A single heartbeat `setInterval` queries the DB for `status = pending` watchers with `nextWakeAt <= now`, fires them, and persists state. No per-watcher timer; no in-memory durable state. On boot, `WatcherManager` loads pending rows and resumes — exactly as `startScheduler()` rehydrates automations.

- **Why:** Durability comes from persistence + rehydration, not from a timer library. A single scanner over an absolute `nextWakeAt` has no drift, catches up automatically after downtime, and reconstructs from the DB on restart. A browser refresh is a non-event (the timer lives in the runner; the client just re-reads and re-subscribes).
- **Alternatives considered:** croner per watcher (its job map is equally in-memory; adds nothing); BullMQ/pg-boss (durable but force Redis/Postgres, breaking SQLite-default/stateless-runner); PM2 (a machine-global daemon that fights per-user isolation and keeps its **own** competing state store — rejected, see Decision 5).

### Decision 3: `funny_watch` is the sole creation path; branch on the structured tool_use signal

A watcher is created or rescheduled **only** by a `funny_watch` tool call. To decide "did the agent schedule?", funny inspects whether a `tool_use` named `mcp__funny__funny_watch` appeared in the turn — a structured fact — and **never** the message prose.

- **Why:** Prose is ambiguous: the agent can call the tool _and_ say "I scheduled a check." Inferring from text risks creating a second watcher (double-fire). The tool call is unambiguous; the prose is ignored for creation.
- **Consequence:** the reliability safety net (Decision 6) may re-prompt but may never create — keeping one creation path.

### Decision 4: Create and reschedule are one idempotent operation, keyed by (threadId, key)

`watcher-manager.createOrReschedule(threadId, key, delay, …)`: if a live watcher exists for `(threadId, key)`, set `nextWakeAt = now + delay` (reschedule); otherwise create one. The agent passes a stable `key` per logical thing it's watching.

- **Why:** "Give it 5 more minutes" is the same act as "schedule a check" — both are "next wake in X for this thing." Unifying them makes a duplicate `funny_watch` call (or a nudge-induced second call) re-arm rather than duplicate. One logical watcher, one row.

### Decision 5: Reject PM2 / external supervisors

funny does not adopt PM2 or a similar process manager.

- **Why:** PM2 is a machine-global daemon — `pm2 list` spans all users, breaking per-user isolation; it keeps its own state in `~/.pm2`, competing with the `watchers` row for source-of-truth; its keep-alive/restart model fights "run until done"; and it adds a heavy runtime dependency. Its good ideas (structured `jlist` status, pid tracking) are cheap to mirror without the daemon. Since the model is pure snooze (no launched/ supervised process), a supervisor is moot anyway.

### Decision 6: Reliability = mandate in the prompt + a non-creating nudge safety net

Two layers ensure the agent actually schedules:

1. **Prevention (Capa 1):** a system-prompt addendum on every spawn: "if you intend to wait and check later, you MUST call `funny_watch`; ending a turn with an unfulfilled 'I'll check later' is an error." The tool is guaranteed present (Decision 7), so the agent can always comply.
2. **Safety net (Capa 2):** at turn completion, **if and only if** no `funny_watch` tool_use occurred, a small classifier (haiku) decides whether the final message expressed a deferred-check intent. If yes, funny re-prompts the agent — constrained via `tool_choice` to `funny_watch` or an explicit `conclude`. The nudge **creates nothing**; it only gives the agent another turn to call the tool.

- **Why:** You cannot deterministically force an LLM to call a tool. The original failure was a turn ending _silently_ with an unfulfilled promise; the safety net makes that outcome impossible to reach without either scheduling or explicitly concluding. Because the classifier runs only in the no-tool-call branch and can't create a watcher, its worst failure is a redundant re-prompt — never a double snooze.

### Decision 7: In-process SDK MCP tool (Claude) + external MCP (other providers), one handler

`funny_watch` is exposed via `options.mcpServers`: in-process (`createSdkMcpServer`) for the Claude SDK path — the handler runs in the runner with direct access to the spawn's `threadId`/`userId` and `watcher-manager`, no transport or auth hop — and as an external MCP server (translated by `toACPMcpServers`) for ACP/other providers. Both sit in front of the same `createOrReschedule` handler.

- **Why:** funny owns the spawn, so an injected in-process tool is **always present** on every agent — unlike a user-configured project MCP server that can be forgotten — which is what makes the reliability invariant achievable. A skill is the wrong vehicle (it's guidance, not a callable capability) and a server-side ("cloud") handler adds a needless runner→server hop since the runner already proxies persistence.

### Decision 8: Global Watchers panel

A single cross-thread Watchers panel (like automations), not per-thread sub-items. It lists the user's watchers with label, status, countdown to next wake, and wake count, plus a cancel control.

- **Why:** Watchers span threads and the user wants one place to see "what is funny waiting on for me." Per-thread placement would scatter that view.

## Risks / Trade-offs

- **Runaway reschedule loop** (agent keeps extending forever) → `maxWakes` and `deadline` bound total lifetime; hitting either marks the watcher `expired` and is shown in the panel.
- **Token cost of agent-evaluated checks** → intervals are minutes-scale and agent-chosen, keeping turn count low; the `deadline` caps the worst case.
- **Classifier false positives** → bounded to a redundant re-prompt (it can't create a watcher); a cheap regex pre-filter avoids invoking the classifier when there's clearly no temporal intent.
- **Heartbeat vs. precision** → a watcher fires on the first heartbeat at/after `nextWakeAt`, so wakes are accurate to the heartbeat granularity (5s) — negligible for minute-scale snoozes.
- **Late fire after long downtime** → acceptable and by design: on boot the overdue watcher is detected and fires immediately; the agent re-checks current reality.
- **Cross-user leakage** → watchers carry `userId`; all WS emits go through `emitToUser`; reads/controls and the in-process handler are ownership-scoped, consistent with runner isolation.

## Migration Plan

Purely additive. Add the `watchers` table (sqlite + pg) and `db/migrate.ts` creation; add the repository; add `watcher-manager.ts` and start it on boot; wire `funny_watch` into `options.mcpServers` (in-process + external) with the shared handler; add the turn-completion reliability hook and the system-prompt addendum; add WS events and the global client panel. No existing behavior changes; rollback is dropping the table and unregistering the service. No data migration.

## Open Questions

- **Defaults**: heartbeat **5s** (fixed); minimum snooze delay clamp (proposed **60s** — sub-minute snoozes defeat the purpose and risk rapid loops); `maxWakes` default (proposed **~20**, a runaway backstop, with `deadline` as the primary bound); `deadline` default (proposed **1h**, agent-overridable).
- **Conclusion signal**: when the agent decides "done," does it just let the fired watcher lapse, or call an explicit `funny_watch_done`/`conclude` for a clean UI state? (Leaning: lapse is fine; explicit conclude is a nice-to-have.)
- **Classifier model/threshold**: haiku is the assumption; confirm cost/latency budget for running it on no-tool-call turn completions.

# Design

## Context

Automation execution lives in the runtime today (`runtime/src/services/automation-scheduler.ts`). It uses croner jobs, a 15-second poll that completes runs, and `triggerAutomationRun`. Since the runner became a separate, database-less process, none of it works:

- `startScheduler` is never called.
- The runner's `automations` repository is a stub (`runner-service-provider.ts`), so the manual trigger, which is proxied to the runner, always returns 404.

The server already owns the `automations` / `automation_runs` tables, the CRUD routes, and an unused `services/automation-repository.ts`.

Two existing server mechanisms make a server-owned design straightforward:

- **`createThreadOnRunner`** (`routes/threads.ts`) already does the whole sequence for interactive threads:
  1. Resolve the user's runner for a project (`findRunnerForProject`, falling back to `runnerResolver`, never to another user's runner).
  2. Sign the forwarded identity (`buildForwardHeaders`).
  3. `POST /api/threads` on the runner through the `RunnerRequestPort`.
  4. Register the thread (`threadRegistry.registerThread` + `cacheThreadRunner`).

  The runtime's `createThreadSchema` already accepts `source: 'automation'`, `mode`, `provider`, `model`, `permissionMode`, `prompt`, and `disallowedTools`. The catch is that it is written against the Hono context.

- **`notifyTerminalStatusPersisted`** (`services/data-handler.ts`) fires on the server whenever a runner persists a terminal thread status (`completed | failed | stopped | interrupted`). It is the durable "thread finished" signal; the live event stream is lossy.

## Goals / Non-Goals

**Goals:**

- One execution path for scheduled and manual runs, living on the server.
- Reuse interactive-thread runner resolution and identity signing instead of a second copy.
- Run completion driven by the persisted terminal status, with no polling.

**Non-Goals:**

- Multi-replica servers (leader election / distributed locks).
- Catching up occurrences missed during downtime.
- Changing the automation UI, the API shapes, or the "read-only" tool restriction.
- Worktree-mode automations. They stay local mode, as today.

## Decisions

### D1. The server owns the cron (croner), keyed by automation id

`server/src/services/automation-scheduler.ts` holds `Map<automationId, Cron>`.

- `start(deps)` schedules every enabled automation.
- `reschedule(automation)` and `unschedule(id)` are called by the create, update, and delete routes after their DB write.
- `stop()` is registered with server shutdown.
- `nextRunAt` is written from `cron.nextRun()` whenever a job is (re)scheduled and after each fire.

croner is already used by the runtime, at the same version, and has no catch-up by default (spec: no replay).

- _Alternative:_ the separate `thread-scheduler` process. Rejected: it dispatches pipelines through `/api/scheduler/system/*`, which is a different model, and it would add a network hop and a second process to keep alive for a cron.
- _Alternative:_ keep the cron in the runtime and give it data access. Rejected: a user with several runners would fire each automation once per runner, and runners are meant to stay database-less.

### D2. Extract `startThreadOnRunner` from `createThreadOnRunner`

Move the resolve → sign → request → register sequence into `server/src/services/runner-thread-launcher.ts`:

```text
startThreadOnRunner({ userId, orgId?, role?, orgName?, body, path = '/api/threads' }, { requests, presence })
  → Result<{ threadId, runnerId, response }, { kind: 'runner-unavailable' | 'runner-error', status, message }>
```

`createThreadOnRunner` becomes a thin adapter: it reads the context, calls the launcher, and maps the result to a response. The automation scheduler calls the same function with the owner's id and no org. Runner isolation and the pinned/dedicated rules are therefore enforced by exactly the code that already enforces them for interactive threads (spec: owner's runner only).

The runner request port only exists per request (`c.env`) or in `index.ts`. The scheduler receives `{ requests, presence }` from `index.ts` at `start`, right after `startRunnerServerComposition`.

### D3. Dispatch body

```text
{ projectId, title: "[Auto] <name> - <date>", mode: 'local', source: 'automation',
  provider, model, permissionMode, prompt, disallowedTools: ['Edit','Write','Bash','NotebookEdit'] }
```

The runtime's `createAndStartThread` creates the thread under the forwarded user and starts the agent. That is the path every interactive thread takes, so the thread belongs to the owner and goes through the normal WS and persistence flow.

### D4. Run bookkeeping on the server

- **Before dispatch:** generate `runId`.
- **Dispatch succeeds:** insert `automation_runs { status: 'running', threadId }`, set `lastRunAt`, and emit `automation:run_started` to the owner.
- **Dispatch fails** (runner unavailable or runner error): there is no thread, and `automation_runs.thread_id` is a NOT NULL FK to `threads`. So the run is recorded against a placeholder thread instead: insert a minimal archived thread row (`source: 'automation'`, `status: 'failed'`), then a run with `status: 'failed'` and a `summary` explaining why. This keeps failed runs in the existing history and inbox queries without a schema change.
  - _Alternative:_ make `thread_id` nullable. Rejected: it touches both dialects plus the inbox joins, for one edge case.

### D5. Completion from the terminal-status hook

`notifyTerminalStatusPersisted` (data-handler) gains one call: `automationRuns.onThreadTerminal(threadId, status)`.

The handler looks up the run with `getRunByThreadId`. If the run is not `running`, it does nothing, which makes the handler idempotent. Otherwise it:

1. Sets the status:
   - `completed` → `status: 'completed', hasFindings: 1`, triage stays `pending`.
   - Anything else → `status: 'failed', hasFindings: 0`, triage stays `pending`, so the failure remains visible (spec).
2. Records the summary, taken from the last assistant message and truncated to 500 characters.
3. Sets `completedAt`.
4. Emits `automation:run_completed`.
5. Archives threads beyond `maxRunHistory`.

The hook runs on the server for data persisted by any runner, so it works with no browser and no polling.

### D6. Manual trigger on the server

`POST /api/automations/:id/trigger` stops using `proxyToRunner`. It loads the automation scoped to the caller (owner only, matching the existing CRUD routes) and returns `404` otherwise. It then calls the scheduler's `runNow(automation)` and returns `{ ok: true, runId }`, or the dispatch failure status (`502` when the runner is unavailable). The run is still recorded as failed, as in D4.

### D7. Rollout migration `080_disable_automations_for_relaunch`

`UPDATE automations SET enabled = 0, updated_at = now WHERE enabled = 1`, applied once through the named-migration runner (spec: existing automations require re-enabling). The UI already exposes the enable toggle.

### D8. Delete the runtime implementation

Remove the following, and drop `croner` from runtime `package.json`:

- runtime `services/automation-scheduler.ts`
- runtime `services/automation-manager.ts`
- runtime `routes/automations.ts` and its mount
- the `automations` block in `runner-service-provider.ts` and the `server-interfaces.ts` entries it implements
- the automation `scheduler hooks`

The WS event types stay in shared. `AUTOMATION_DISALLOWED_TOOLS` moves to `@funny/shared` so the server owns the restriction.

## Risks / Trade-offs

- **Multiple server replicas would each fire every automation.** → Documented as a single-instance assumption. A future change can add a DB lease (`UPDATE … WHERE next_run_at = :expected`) if replicas are introduced.
- **A run fires while the owner's runner is briefly reconnecting.** → It is recorded as failed with the reason, and is visible in history. There is no automatic retry, by design, because a retry could double-run an agent.
- **The terminal-status hook misses a status** (for example, the runner dies before persisting it). → The run stays `running`. On `start`, mark runs that have been `running` longer than 24 h as `failed` ("no completion reported"), so they don't hang forever.
- **The extracted launcher changes interactive thread creation.** → It is a pure refactor. The existing `routes/threads.ts` creation tests must pass unchanged before any automation code uses it.
- **Disabling automations on rollout surprises users.** → It is deliberate and stated in the proposal. Owners re-enable with one click.

## Migration Plan

1. Deploy the server. Migration `080` disables existing automations, and the scheduler starts with nothing to schedule.
2. Deploy the runner. Its trigger route is gone, but the server no longer proxies there, so the order doesn't matter.
3. **Rollback:** redeploy the previous server. Automations remain disabled, which is harmless because they didn't run before either.

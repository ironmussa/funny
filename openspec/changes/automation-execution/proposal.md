# Proposal

## Why

Automations have not run since `b1b11de98` (March 2026). The cron lived in the runtime and only started in the in-process runner mode that commit removed. A runner also has no database, so its automation repository is a stub, and the manual "run now" endpoint always returns 404. Users can still create, edit, and enable automations in the UI, but none of them ever execute.

## What Changes

- The **server** owns automation scheduling. On startup it schedules every enabled automation, and it reschedules when an automation is created, updated, enabled/disabled, or deleted.
- Each run is **dispatched to the automation owner's runner**, chosen by the same project → runner resolution as interactive threads (dedicated/pinned runners respected, never another user's runner). The run creates a normal thread (`source: 'automation'`, local mode, write tools disallowed) through the runner's existing thread-creation endpoint, with a signed forwarded identity for the owner.
- The server records each run in `automation_runs` and updates `lastRunAt` / `nextRunAt`. If the owner's runner is offline, the run is recorded as failed with the reason, not silently dropped.
- Runs are completed from the server's existing terminal-thread-status hook (the thread finishing on the runner). This replaces the runtime's 15-second poll. On completion the server sets status, findings, a summary, and `completedAt`, auto-dismisses runs without findings, and archives runs beyond `maxRunHistory`.
- `POST /api/automations/:id/trigger` is handled by the server through the same dispatch path instead of being proxied to the runner.
- **BREAKING (data):** a one-time migration disables every automation that is currently enabled. Otherwise, after seven months of silence, deploying would immediately start agents on users' machines without them asking for it. Users re-enable the automations they still want.
- The dead runtime automation code is removed: the scheduler, the automation manager, the runtime `/automations/:id/trigger` route, the runner-provider stubs, and the runtime's `croner` dependency.

## Capabilities

### New Capabilities

- `automation-execution`: when and where automation runs execute (server-owned schedule, owner's runner only, offline handling, manual trigger), how runs are recorded and completed, run-history retention, and the re-enable-on-rollout rule.

### Modified Capabilities

<!-- None: no existing spec covers automations. -->

## Impact

- **Server:** new `services/automation-scheduler.ts` (cron and dispatch); `croner` dependency added. A reusable "start a thread on user U's runner" service is extracted from `routes/threads.ts` `createThreadOnRunner`, which keeps using it. `routes/automations.ts` gains reschedule hooks and a local trigger. The unused `services/automation-repository.ts` is put to use. `services/data-handler.ts` gets a terminal-status hook for automation runs. `index.ts` starts and stops the scheduler with the runner transport. There is a migration that disables enabled automations.
- **Runtime:** deletes `services/automation-scheduler.ts`, `services/automation-manager.ts`, `routes/automations.ts`, the `automations` block of `runner-service-provider.ts`, and the `croner` dependency.
- **Client:** no API shape change. The inbox starts receiving real runs.
- **Assumption:** there is a single server instance. Running several server replicas would fire each automation once per replica. That case is noted, not solved here.
- **Out of scope:** `scheduler-system` dispatch sends an unsigned forwarded identity, which runners reject. This was found while researching this change and is tracked separately.

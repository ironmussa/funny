# Plan: Server-side thread state machine (XState)

## Problem

Thread status transitions are scattered across 4+ server files with ad-hoc `updateThread({ status: '...' })` calls. This causes bugs like the one just fixed — where responding to a `waiting` thread (question/plan) was treated as a "session interrupted" resume because the code couldn't distinguish between the two contexts. The `previousStatus` fix patches one symptom, but the root cause is the lack of a centralized state machine on the server.

The client already has an XState machine (`packages/client/src/machines/thread-machine.ts`) that validates transitions, but the server — the actual source of truth — doesn't use one.

## Approach

Move the thread state machine to `packages/shared` so both client and server use the same definition. Then integrate it into the server so that all status transitions go through the machine, which also provides `resumeReason` context that downstream code can use instead of ad-hoc if/else checks.

## Steps

### 1. Move the machine to `packages/shared`

- Create `packages/shared/src/thread-machine.ts`
- Move the machine definition from `packages/client/src/machines/thread-machine.ts`
- Add `resumeReason` to the machine context: `'interrupted' | 'waiting-response' | 'post-merge' | 'follow-up' | null`
  - Set on entry to `running` based on which event triggered it (START vs RESTART vs RESPOND)
  - Add a `RESPOND` event (distinct from `START`/`RESTART`) for the waiting→running transition
- Export the machine, types, and `wsEventToMachineEvent` helper from shared
- Update `packages/client` to import from `@funny/shared` instead of local machine file
- Keep the client bridge (`thread-machine-bridge.ts`) as-is — it just wraps actors

### 2. Add XState to `packages/shared` and use it in the server

- Add `xstate` as a dependency to `packages/shared` (since shared is already depended on by both client and server)
- Create `packages/server/src/services/thread-status-machine.ts` — server-side bridge (similar to client's `thread-machine-bridge.ts`)
  - Actor registry: `Map<threadId, actor>`
  - `transitionStatus(threadId, event, currentStatus)` → returns `{ status, resumeReason }`
  - `getResumeReason(threadId)` — reads from actor context
  - Actors are lazy-created on first use, cleaned up on thread delete/archive

### 3. Integrate into agent-runner.ts

Replace the scattered status updates + `previousStatus` hack:

```typescript
// Before (current)
const previousStatus = this.threadManager.getThread(threadId)?.status;
this.threadManager.updateThread(threadId, { status: 'running' });
// ... later
const wasWaitingForUser = previousStatus === 'waiting';

// After (with machine)
const { status, resumeReason } = this.statusMachine.transition(threadId, { type: 'RESPOND' });
// or { type: 'RESTART' } for genuine resumes
this.threadManager.updateThread(threadId, { status });
const systemPrefix = RESUME_PREFIXES[resumeReason]; // clean lookup
```

### 4. Integrate into agent-message-handler.ts

Replace direct status updates for waiting/completed/failed:

```typescript
// Before
this.threadManager.updateThread(threadId, { status: 'waiting' });

// After
const { status } = this.statusMachine.transition(threadId, { type: 'WAIT', reason: 'question' });
this.threadManager.updateThread(threadId, { status });
```

### 5. Integrate into orchestrator event handlers (in agent-runner.ts constructor)

The `agent:stopped`, `agent:error`, `agent:unexpected-exit` handlers all set status directly. Route these through the machine:

```typescript
this.orchestrator.on('agent:stopped', (threadId) => {
  const { status } = this.statusMachine.transition(threadId, { type: 'STOP' });
  this.threadManager.updateThread(threadId, { status, completedAt: ... });
});
```

### 6. Update tests

- Update `packages/client/src/__tests__/machines/thread-machine.test.ts` to import from shared
- Add test for the new `RESPOND` event and `resumeReason` context
- Add server-side test for the bridge in `packages/server/src/__tests__/`

## What this fixes

- **The original bug**: `RESPOND` event produces `resumeReason: 'waiting-response'` which maps to a non-alarming system prefix (or none). `RESTART` from `stopped`/`failed`/`interrupted` produces `resumeReason: 'interrupted'` which maps to the current "session was interrupted" prefix.
- **Future bugs**: Invalid transitions are caught by the machine (e.g., `completed → waiting` would be rejected)
- **Code clarity**: One place defines all valid transitions instead of 10+ scattered `updateThread` calls

## Files changed

1. `packages/shared/src/thread-machine.ts` — NEW (moved from client)
2. `packages/shared/src/types.ts` — export `ResumeReason` type
3. `packages/client/src/machines/thread-machine.ts` — re-export from shared
4. `packages/server/src/services/thread-status-machine.ts` — NEW (server bridge)
5. `packages/server/src/services/agent-runner.ts` — use machine for transitions
6. `packages/server/src/services/agent-message-handler.ts` — use machine for transitions
7. Tests updated

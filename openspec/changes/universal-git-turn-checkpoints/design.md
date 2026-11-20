## Context

funny currently has two unrelated file-rewind paths:

- Claude enables SDK file checkpointing and calls `rewindFiles()` against a
  resumed SDK query.
- Codex captures one Git worktree/index snapshot before each turn in
  `packages/runtime/src/services/codex-git-checkpoints.ts` and restores it by
  replacing the worktree.

Provider selection happens in lifecycle, rewind validation, thread creation,
forking, and client predicates. This prevents Gemini, Pi, Cursor, OpenCode,
DeepAgent, extension providers, and public harness runtimes from using the Git
mechanism even though the mechanism does not depend on their model protocol.

The existing Codex restore is exact but destructive at the wrong boundary: it
restores the entire snapshot and runs `git clean -fd`. A manual change made
after the turn is therefore lost even if it is unrelated to the agent's work.
Capturing both sides of a turn lets the runtime reverse only the agent-turn
delta through Git's merge machinery.

The product runtime and `@funny/harness` also execute agents through different
entry points today. They should share the low-level Git engine and lifecycle
contract, while product-specific thread/message persistence stays in runtime.

```
 product AgentRunner                     @funny/harness session
          │                                      │
          ▼                                      ▼
 TurnCheckpointCoordinator              optional checkpoint hooks
          │                                      │
          ├──────── backend selection ───────────┤
          │                                      │
    ┌─────┴────────┐                    custom/remote backend
    ▼              ▼
 native backend   GitTurnCheckpointStore
 (Claude SDK)      (@funny/core/git)
                         │
                         ▼
 refs/funny/turn-checkpoints/<scope>/<turn>/...
```

## Goals / Non-Goals

**Goals:**

- Make file checkpointing available to any provider/model through runtime
  capabilities rather than provider allow-lists.
- Preserve unrelated manual changes when rewinding one or more agent turns.
- Detect overlapping edits before changing the real worktree or transcript.
- Preserve staged state, unstaged state, deletions, and non-ignored untracked
  files without moving `HEAD`.
- Give product runtime and public harness execution a shared checkpoint
  lifecycle contract.
- Keep file rewind separate from session/transcript rewind.
- Maintain native Claude checkpointing where it is the better backend.
- Bound checkpoint storage and clean refs when turns or threads disappear.

**Non-Goals:**

- Attribute every filesystem write to an individual tool call.
- Track ignored files or writes outside `cwd`.
- Isolate the agent in a separate overlay/worktree during this phase.
- Resolve semantic merge conflicts automatically.
- Guarantee anchored native conversation forks for every provider.
- Add checkpoint support to remote runtimes that do not expose filesystem or
  snapshot hooks.

## Decisions

### D1. Separate low-level Git storage from product coordination

Add a generic `GitTurnCheckpointStore` under `packages/core/src/git`. Its API is
defined in terms of `scopeId`, `turnId`, and `cwd`, not threads, providers, or
database messages:

```ts
type TurnBoundary = 'before' | 'after';

interface GitTurnCheckpointStore {
  capture(input: {
    scopeId: string;
    turnId: string;
    boundary: TurnBoundary;
    cwd: string;
  }): Promise<TurnCheckpointSnapshot>;

  planRewind(input: {
    scopeId: string;
    turnIdsNewestFirst: string[];
    cwd: string;
  }): Promise<TurnRewindPlan>;

  applyRewind(plan: TurnRewindPlan): Promise<TurnRewindResult>;
  deleteTurn(input: CheckpointIdentity): Promise<void>;
  deleteScope(input: { scopeId: string; cwd: string }): Promise<void>;
}
```

Runtime adds `TurnCheckpointCoordinator`, which maps `threadId` to `scopeId`, a
user message to `turnId`, selects a backend, owns lifecycle ordering, and
updates thread capability state. Harness adapters can use the same core store
without importing runtime services.

**Alternative considered:** move the whole feature into
`GitRuntimeService`. Rejected because that service owns product-level route
coordination, while the low-level checkpoint engine is useful to
`@funny/harness` and should not depend on runtime.

### D2. Model checkpoint support as strategies, not a boolean

Introduce shared types along these lines:

```ts
type FileCheckpointStrategy = 'native' | 'git-turn' | 'none';
type ConversationRewindStrategy = 'anchored-native' | 'rebuild' | 'none';

interface ThreadRewindCapabilities {
  fileStrategy: FileCheckpointStrategy;
  conversationStrategy: ConversationRewindStrategy;
  canRewind: boolean;
  canForkAndRewind: boolean;
  reason?: string;
}
```

Persist the selected file strategy on the thread so restarts do not infer old
checkpoint ownership from the current provider alone. Derive the effective
action capabilities from strategy, session support, directory eligibility, and
checkpoint completeness. Keep `fileCheckpointingEnabled` as a compatibility
projection during migration, then remove provider-based writes to it.

Strategy order for product threads:

1. Select `native` when the execution adapter provides native file
   checkpointing and an anchored restore operation.
2. Otherwise select `git-turn` when `cwd` is a writable local Git worktree and
   the thread is not scratch.
3. Otherwise select `none`.

The selected model never participates in this decision.

**Alternative considered:** add a checkpoint field only to bundled provider
manifests. Rejected because Git eligibility is an execution-environment
capability, extension providers are open-ended, and the same provider can run
locally or remotely.

### D3. Store four trees for each completed Git-backed turn

Private refs use a provider-neutral namespace:

```text
refs/funny/turn-checkpoints/<scope>/<turn>/before-worktree
refs/funny/turn-checkpoints/<scope>/<turn>/before-index
refs/funny/turn-checkpoints/<scope>/<turn>/after-worktree
refs/funny/turn-checkpoints/<scope>/<turn>/after-index
```

Identifiers are validated or encoded before use in ref names. Capture builds a
temporary index, seeds it from `HEAD` (or an empty tree for an unborn branch),
runs `git add -A -- .`, and writes the worktree tree. The real index is written
separately. This includes tracked/staged/unstaged/deleted and non-ignored
untracked content while leaving the active index, branch, and `HEAD` untouched.

A Git turn becomes rewindable only after all four refs exist. A before-only
record is incomplete and cannot be selectively reversed because its agent
delta is unknown.

**Alternative considered:** store patches instead of trees. Rejected because
trees preserve binary files, modes, renames as Git can infer them, untracked
content, and independent index state more reliably than serialized text
patches.

### D4. Capture `after` behind one terminal lifecycle barrier

The product lifecycle records an active checkpoint handle before agent spawn.
Every success, failure, and stop path must call one idempotent
`finalizeActiveTurn(threadId, outcome)` method before emitting
`agent:completed`. Queue processing already begins from that bus event, so this
ordering prevents the next turn from contaminating the current turn's after
state.

`AgentStateTracker` owns the in-memory active handle. The coordinator owns
capture errors and never changes the agent's terminal result. Duplicate terminal
signals join or reuse the same finalization promise.

On a hard process crash, a before-only record stays incomplete. Startup cleanup
can prune it after retention, but it is not retroactively finalized because
intervening user edits cannot be attributed safely.

**Alternative considered:** capture in an `agent:completed` handler. Rejected
because the queue handler also consumes that event and could start the next
turn concurrently.

### D5. Compute inverse deltas with separate worktree and index merges

For each completed turn:

```text
B = before tree
A = after tree
C = current accumulated tree

next = threeWayMerge(base=A, ours=C, theirs=B)
```

This applies the inverse `A -> B` to the current state. For a rewind covering
multiple turns, the store applies this operation newest-first through the
selected anchor. The worktree trees and index trees are planned independently,
so staging intent is preserved alongside file content.

Planning uses temporary indexes and produces final result trees plus an
explicit path set. Any unmerged index entry, binary conflict, rename conflict,
mode conflict, or delete/modify conflict produces a typed conflict response.
No real files or DB rows change during planning.

**Alternative considered:** restore the selected before tree directly. Rejected
because it discards all manual changes made after the checkpoint.

### D6. Apply rewind under a per-worktree lock with rollback state

Before planning, capture the current worktree/index trees as rollback state and
record a fingerprint. Hold the existing or a new canonical-cwd Git mutation
lock through planning and apply. Immediately before apply, verify that the
current fingerprint still matches; if it changed, discard the plan and return a
retryable concurrent-modification error.

Apply checks out the planned worktree tree without moving `HEAD`, restores the
planned index tree, and verifies the result. If an operation fails after the
real worktree changes, apply the rollback trees before returning an error.
Thread messages and session state are changed only after file apply succeeds.

Ignored files are never cleaned. Non-ignored current untracked files are part of
the current worktree tree and therefore survive unless their path conflicts with
an inverse delta.

**Alternative considered:** write conflict markers into the user's worktree.
Rejected for the first version because rewind should be cancellable and should
not modify either code or conversation when conflicts exist.

### D7. Resolve conversation rewind independently

After file rewind succeeds, runtime selects a conversation strategy:

- `anchored-native`: use a provider API that can produce/adopt a session at the
  selected user message. Claude remains the initial implementation.
- `rebuild`: truncate persisted DB messages, clear `sessionId`, set
  `contextRecoveryReason: 'rewound'`, and rebuild from the retained transcript
  on the next prompt.
- `none`: available to standalone harness executions that have no persisted
  transcript owner; the caller can still use file checkpoints directly.

ACP `forkSession` support by itself is not treated as anchored rewind unless it
can select the historical message. A provider may therefore support ordinary
fork while using transcript rebuild for rewind.

For fork-and-rewind, providers without an anchored native fork can create a
DB-only fork containing retained messages, start with no provider session, and
recover context on first use. The UI reports direct rewind and fork-and-rewind
as separate capabilities.

### D8. Add optional checkpoint hooks to the public harness

Extend `HarnessRuntimeCapabilities` and `HarnessRuntime` with an optional
checkpoint controller:

```ts
interface HarnessTurnCheckpointController {
  beginTurn(input: HarnessTurnContext): Promise<HarnessCheckpointHandle | null>;
  completeTurn(
    handle: HarnessCheckpointHandle,
    outcome: 'completed' | 'failed' | 'stopped',
  ): Promise<void>;
}
```

`AgentSession.prompt()` assigns or accepts a stable turn ID, calls `beginTurn`
before `spawnAgent`, and awaits `completeTurn` in its terminal path. A runtime
without the controller behaves exactly as today. The local adapter can opt into
`GitTurnCheckpointStore`; remote adapters can provide their own backend without
exposing remote files to the client.

The product's current `AgentRunner` path can use
`TurnCheckpointCoordinator` directly until it is migrated onto the harness
facade. Both paths share contracts and the core Git store, not duplicated Git
logic.

### D9. Report effective capabilities from the server

Remove client logic that assumes only Claude and Codex can rewind. Thread detail
responses expose `ThreadRewindCapabilities`, and client predicates become pure
consumers of those fields. This allows bundled and extension providers to gain
rewind without a client release when their runtime supplies the capability.

Rewind responses are a discriminated result:

```ts
type RewindResult =
  | { status: 'applied'; filesChanged: string[]; deletedMessageCount: number }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'unavailable'; reason: string };
```

Conflicts leave the UI on the existing thread and do not truncate messages.
The first version offers cancel/review guidance; an explicit force-overwrite
flow is out of scope.

### D10. Clean refs by scope and discarded turn

Successful rewind deletes refs for discarded turns only after the restored
files, truncated transcript, and thread state are durable. Thread deletion
deletes the whole scope namespace. A bounded maintenance pass prunes incomplete
or orphaned refs older than a configured retention period.

Cleanup failures are logged and metered but do not turn a successful rewind or
thread deletion into a user-visible failure. Ref deletion is idempotent so it
can be retried.

### D11. Preserve worktree isolation as the concurrency boundary

Only one checkpoint capture/rewind mutation may run for a canonical worktree at
a time. Independent thread worktrees continue concurrently. Multiple agent
threads sharing a project directory cannot attribute deltas reliably; runtime
must either serialize those turns with the same lock or mark selective rewind
unavailable for overlapping executions.

This phase chooses serialization for runtime-owned turns where feasible and a
clear unavailable result when another execution bypasses the coordinator.
True write attribution during concurrent user/agent activity would require an
isolated overlay/worktree per turn and is future work.

## Risks / Trade-offs

- **Git merge behavior differs across installed versions** -> Probe required
  commands once, cover the supported Git baseline, and return unavailable
  without starting destructive apply when three-way tree planning is missing.
- **Planning large repositories stores additional objects** -> Reuse Git's
  content-addressed objects, avoid commits, measure capture duration/object
  growth, and prune refs according to retention.
- **User edits race rewind** -> Hold a canonical-cwd lock and verify the current
  fingerprint immediately before apply.
- **Terminal paths remain duplicated** -> Make checkpoint finalization a single
  idempotent barrier and add tests for normal completion, provider error, stop,
  duplicate completion, and queued follow-ups.
- **Staging merge surprises users** -> Plan worktree and index separately and
  add mixed staged/unstaged regression fixtures.
- **Native and Git behavior differ** -> Expose the selected strategy in
  capabilities/telemetry and run a shared backend contract test suite where
  behavior overlaps.
- **Provider session cannot rewind historically** -> Use transcript rebuild;
  do not treat ordinary session fork as historical rewind.
- **Refs leak after crashes** -> Mark completeness through the four-ref set and
  run idempotent retention cleanup.

## Migration Plan

1. Add shared strategy/capability/result types while retaining the existing
   boolean as a compatibility projection.
2. Extract the Codex snapshot mechanics into a provider-neutral core Git store
   and migrate existing Codex tests to a backend contract suite.
3. Add after-state capture, inverse merge planning, atomic apply, conflicts,
   locks, and cleanup.
4. Add the runtime coordinator and central terminal finalization barrier.
5. Route Codex through the generic Git strategy with behavior-compatible direct
   rewind, then enable it for other eligible local providers.
6. Keep Claude native by default and add transcript rebuild as the generic
   conversation fallback.
7. Add optional harness checkpoint hooks and local adapter support.
8. Expose effective capabilities/results through shared API types and update the
   client.
9. Remove provider-specific UI/runtime allow-lists and delete the Codex-specific
   service after migration.
10. After one compatibility window, remove obsolete writes to
    `fileCheckpointingEnabled` and migrate remaining consumers to strategies.

Rollback can disable `git-turn` strategy selection and retain Claude native
rewind. Existing refs are private and can be pruned without moving branches or
deleting commits.

## Open Questions

- What retention default should apply to completed checkpoints: thread lifetime,
  a fixed age, or a maximum number of turns per thread?
- Should a later version offer an explicit user-confirmed force restore after a
  conflict, or require users to resolve/retry outside the rewind API?
- Should the local public harness enable Git checkpoints automatically whenever
  hooks are configured, or require an explicit session option in addition to
  runtime capability?
- Should shared-directory threads be serialized globally, or should selective
  rewind remain disabled unless each thread has an isolated worktree?

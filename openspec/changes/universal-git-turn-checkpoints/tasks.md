## 1. Shared Contracts and Persistence

- [ ] 1.1 Add shared `FileCheckpointStrategy`, `ConversationRewindStrategy`, `ThreadRewindCapabilities`, and discriminated rewind result types.
- [ ] 1.2 Add persisted thread checkpoint strategy/status fields to SQLite and PostgreSQL schemas with a migration that preserves existing Claude/Codex rows.
- [ ] 1.3 Keep `fileCheckpointingEnabled` as a temporary compatibility projection and document its removal path.
- [ ] 1.4 Add serialization and schema tests for native, Git-backed, unavailable, conflict, and applied states.

## 2. Provider-Neutral Git Checkpoint Store

- [ ] 2.1 Add `GitTurnCheckpointStore` under `packages/core/src/git` with safe scope/turn identity encoding and provider-neutral private refs.
- [ ] 2.2 Implement before/after worktree capture through a temporary index without mutating `HEAD`, branch, or the real index.
- [ ] 2.3 Capture the real index independently at both turn boundaries.
- [ ] 2.4 Support unborn repositories and reject gitless, read-only, invalid, or unsupported working directories with typed errors.
- [ ] 2.5 Add tests for clean, staged, unstaged, deleted, untracked, ignored, binary, executable-bit, rename, subdirectory-cwd, and unborn-branch fixtures.

## 3. Selective Rewind Planning and Apply

- [ ] 3.1 Capture the current worktree/index rollback trees and repository fingerprint before planning.
- [ ] 3.2 Implement inverse three-way merge planning for worktree trees using `after` as base, current as ours, and `before` as theirs.
- [ ] 3.3 Implement the corresponding independent merge plan for index trees so staged state is preserved.
- [ ] 3.4 Apply multiple completed turn deltas newest-first through the selected anchor.
- [ ] 3.5 Detect content, binary, rename, mode, add/add, and delete/modify conflicts and return typed path lists without modifying real state.
- [ ] 3.6 Apply successful result trees without moving `HEAD`, verify the final fingerprint, and restore rollback trees on partial failure.
- [ ] 3.7 Add a canonical-cwd mutation lock and abort stale plans when the working state changes between planning and apply.
- [ ] 3.8 Add regression tests proving unrelated current edits and untracked files survive while agent-created/deleted/modified files are selectively reversed.

## 4. Runtime Turn Checkpoint Coordinator

- [ ] 4.1 Add `TurnCheckpointCoordinator` to resolve native, Git-turn, or unavailable strategy from runtime and cwd capabilities rather than provider/model allow-lists.
- [ ] 4.2 Track stable active turn identity and checkpoint handle in `AgentStateTracker` before spawning an eligible agent.
- [ ] 4.3 Replace the Codex-only pre-turn branch in `agent-lifecycle.ts` with coordinator begin logic for every non-scratch local provider.
- [ ] 4.4 Add one idempotent terminal finalization barrier shared by success, failure, and stop paths.
- [ ] 4.5 Ensure after capture finishes before `agent:completed` is emitted and before the queued-message handler can start another turn.
- [ ] 4.6 Mark before-only checkpoints incomplete after capture failure or hard restart without changing the original agent result.
- [ ] 4.7 Add lifecycle tests for every terminal outcome, duplicate terminal signals, capture failures, hot-reload state, and queued follow-up ordering.

## 5. Backend and Capability Resolution

- [ ] 5.1 Implement a backend interface shared by the Claude native adapter and the Git turn adapter.
- [ ] 5.2 Keep Claude native file rewind as the preferred strategy when its SDK capability is available.
- [ ] 5.3 Enable Git-turn checkpoints for eligible Codex, Gemini, Pi, Cursor, OpenCode, DeepAgent, LLM API, and extension-provider executions without enumerating them in checkpoint logic.
- [ ] 5.4 Return unavailable without blocking execution for scratch, gitless, unsupported remote, read-only, or concurrently unsafe directories.
- [ ] 5.5 Add backend contract tests and table-driven strategy-resolution tests demonstrating that model changes do not affect checkpoint eligibility.

## 6. Thread Rewind and Conversation Recovery

- [ ] 6.1 Refactor `thread-service/rewind.ts` so file-backend dispatch and conversation strategy dispatch are separate.
- [ ] 6.2 Build the ordered completed-turn chain from persisted user messages and fail safely when any required Git turn is incomplete.
- [ ] 6.3 Return conflict/unavailable results before deleting messages or changing session/thread state.
- [ ] 6.4 Preserve Claude anchored native session rewind where available.
- [ ] 6.5 Implement the generic rebuild path by truncating DB messages only after file success, clearing `sessionId`, and setting `contextRecoveryReason: 'rewound'`.
- [ ] 6.6 Update fork-and-rewind to distinguish anchored native fork from DB transcript copy plus context rebuild.
- [ ] 6.7 Add integration tests for native rewind, Git rewind with rebuild, multi-turn rewind, fork fallback, conflicts, rollback, and message/session atomicity.

## 7. Public Harness Integration

- [ ] 7.1 Extend `HarnessRuntimeCapabilities` with optional turn checkpoint support and define begin/complete checkpoint controller contracts.
- [ ] 7.2 Give `AgentSession.prompt()` a stable turn ID and wrap `spawnAgent` with optional begin/complete hooks across success, failure, cancellation, and stop outcomes.
- [ ] 7.3 Add a local harness adapter that can use `GitTurnCheckpointStore` without importing runtime/thread services.
- [ ] 7.4 Let remote/custom harness runtimes provide their own checkpoint controller while preserving behavior when the capability is omitted.
- [ ] 7.5 Add harness tests for lifecycle ordering, optional capability compatibility, stable turn IDs, capture failures, and provider/model neutrality.
- [ ] 7.6 Add public harness documentation showing checkpoints with at least two different providers and explaining that conversation persistence remains runtime-owned.

## 8. API and Client Capability Flow

- [ ] 8.1 Expose effective `ThreadRewindCapabilities` on thread detail responses and keep old clients compatible during migration.
- [ ] 8.2 Update rewind API responses to discriminate applied, conflict, unavailable, and failure outcomes.
- [ ] 8.3 Replace `claude || codex` predicates in `thread-variant.ts` with server-reported direct-rewind and fork-and-rewind capabilities.
- [ ] 8.4 Add conflict UI that lists affected paths, leaves the transcript untouched, and offers safe cancel/review guidance.
- [ ] 8.5 Update English, Spanish, and Portuguese messages for unavailable strategies, concurrent modification, incomplete checkpoints, and conflicts.
- [ ] 8.6 Add client tests for a non-Codex/Claude provider gaining rewind, separate fork capability, conflict rendering, and compatibility fallback.

## 9. Cleanup, Retention, and Observability

- [ ] 9.1 Delete discarded turn refs after a successful rewind becomes durable.
- [ ] 9.2 Delete the entire checkpoint scope when a thread is permanently deleted.
- [ ] 9.3 Add idempotent cleanup for stale incomplete/orphaned refs with a bounded, documented retention policy.
- [ ] 9.4 Record strategy, capture duration/failure, stored object estimates, rewind duration, conflict count, rollback, and cleanup failure telemetry without logging file contents.
- [ ] 9.5 Add cleanup tests for rewind, thread deletion, retries, incomplete refs, and repositories that are temporarily unavailable.

## 10. Migration and Removal of Codex-Specific Logic

- [ ] 10.1 Migrate existing Codex checkpoint refs or retain a compatibility reader until their threads age out.
- [ ] 10.2 Move Codex checkpoint tests into the generic core/runtime suites.
- [ ] 10.3 Delete `packages/runtime/src/services/codex-git-checkpoints.ts` after all call sites use the generic store.
- [ ] 10.4 Remove provider-specific checkpoint writes from thread create/fork paths and derive capability through the coordinator.
- [ ] 10.5 Remove obsolete client/provider allow-lists and, after the compatibility window, the old boolean projection.

## 11. Verification

- [ ] 11.1 Run focused `@funny/core` Git checkpoint and merge tests on the supported Git baseline.
- [ ] 11.2 Run focused harness session/runtime tests.
- [ ] 11.3 Run focused runtime lifecycle, rewind, fork, queue, schema, and cleanup tests.
- [ ] 11.4 Run focused client capability and conflict-flow tests.
- [ ] 11.5 Run `bun run lint` and resolve new errors or warnings introduced by this change.
- [ ] 11.6 Run `bun run typecheck` and confirm no new workspace errors.
- [ ] 11.7 Run `openspec status --change "universal-git-turn-checkpoints"` and validate the change when the OpenSpec CLI is available.

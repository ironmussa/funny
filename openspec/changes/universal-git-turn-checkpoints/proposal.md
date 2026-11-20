## Why

File rewind is currently coupled to provider names: Claude delegates to its SDK
while Codex uses a runtime-owned Git snapshot. Other models and harnesses cannot
offer the same recovery even when they edit the same local Git worktree. The
Codex snapshot also restores the complete worktree, which can overwrite manual
changes made after the agent turn.

The runtime and public harness need a provider-independent checkpoint boundary.
File restoration should depend on execution and repository capabilities, while
conversation restoration remains a separate provider/session concern.

## What Changes

- Replace the Codex-specific Git checkpoint service with a generic turn
  checkpoint engine usable by any model, provider, or harness runtime operating
  on a local Git worktree.
- Capture both the state before a turn and the state after it completes, fails,
  or is stopped, including the worktree and index without moving `HEAD`.
- Rewind Git-backed turns by applying their inverse deltas newest-first through
  a three-way merge, preserving unrelated user changes and reporting overlapping
  edits as conflicts instead of silently overwriting them.
- Introduce explicit checkpoint and conversation-rewind strategies instead of
  client/server allow-lists keyed to `claude` and `codex`.
- Expose optional turn-checkpoint capabilities through `@funny/harness` so local
  runtimes can wrap any agent execution, while product threads continue to map
  turn IDs to user-message IDs.
- Keep Claude's native file checkpointing as a supported backend and use the Git
  backend as the general fallback when the execution directory is eligible.
- Add atomic restore, cleanup/retention, telemetry, and regression coverage for
  conflicts, staging, untracked files, multi-turn rewind, and provider-neutral
  execution.

## Non-Goals

- Tracking ignored files or files written outside the configured working
  directory.
- Inferring perfect authorship when a user and an agent edit the same lines
  concurrently during one turn; these cases surface as conflicts or remain part
  of the captured turn delta.
- Providing file rewind for scratch/gitless directories or remote runtimes that
  do not expose an equivalent checkpoint backend.
- Implementing a provider-independent native session fork. Providers without an
  anchored rewind API rebuild conversation context from the truncated persisted
  transcript.
- Automatically resolving merge conflicts or discarding user changes on the
  user's behalf.

## Capabilities

### New Capabilities

- `turn-file-checkpointing`: Provider-independent capture and selective rewind
  of file changes around agent turns, with native and Git-backed strategies,
  harness integration, conflict reporting, and lifecycle cleanup.

### Modified Capabilities

- None.

## Impact

- **Core Git:** Add a generic low-level Git turn checkpoint store under
  `packages/core/src/git` and export its typed capture, merge-plan, apply, and
  cleanup operations.
- **Harness:** Extend `packages/harness/src/contracts.ts` and local/runtime
  adapters with optional checkpoint lifecycle capabilities without making them
  mandatory for custom runtimes.
- **Runtime lifecycle:** Replace the Codex-only branch in
  `packages/runtime/src/services/agent-lifecycle.ts` with a turn checkpoint
  coordinator and finalize active checkpoints before completion handlers start
  queued work.
- **Runtime rewind:** Refactor
  `packages/runtime/src/services/thread-service/rewind.ts` to dispatch file and
  conversation rewind independently and to return typed conflicts.
- **State/schema:** Add an explicit checkpoint strategy/status to shared thread
  types and persisted thread state, retaining compatibility while migrating away
  from the provider-gated `fileCheckpointingEnabled` boolean.
- **Client:** Replace provider allow-lists in
  `packages/client/src/lib/thread-variant.ts` with server-reported capabilities
  and add a conflict-aware rewind result flow.
- **Cleanup:** Delete private checkpoint refs when their thread/turn is removed
  and prune stale or incomplete checkpoint records.
- **Tests:** Add focused core, harness, runtime, and client regression tests.

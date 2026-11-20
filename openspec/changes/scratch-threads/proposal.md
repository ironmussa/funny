## Why

Today, starting a conversation with an agent requires registering a full project (a valid git repo on disk). That fricción is too high for the common case of "I just want to bounce an idea, try a regex, or sketch some throwaway code." Users need a lightweight thread that behaves like a normal thread but doesn't pollute the project list and doesn't need a repo.

## What Changes

- New thread kind: **scratch thread**. Same chat/tool-call/message behavior as a normal thread, but with no project, no git, and no worktree.
- `Thread.projectId` becomes nullable. New boolean `Thread.isScratch`.
- Scratch threads run in a per-user, per-thread working directory on the runner: `~/.funny/scratch/<userId>/<threadId>/` (created on thread start, `rm -rf`'d on thread delete).
- Scratch threads always force `mode: 'local'`. Worktree mode is disabled.
- Git operations are not available for scratch threads:
  - `/api/git/:threadId/*` returns `400` when the thread is scratch.
  - Review pane and PR/commit/push/branch UI are hidden in the client.
- New global "+ New scratch" entry point in the sidebar (top-level "Scratch" section). No per-project scratch entry in v1.
- Per-user only: a user only sees their own scratch threads. No team/shared scratch in v1.
- WebSocket events, message persistence, tool-call persistence, and agent-runner spawning are unchanged.
- Internal: introduce helpers `resolveThreadCwd(thread)` and `canDoGitOps(thread)` so callers don't sprinkle `if (thread.isScratch)` checks.

## Capabilities

### New Capabilities

- `scratch-threads`: lightweight, projectless threads for exploration. Covers the data model change, runner cwd resolution, route guards on git endpoints, sidebar entry point, and cleanup lifecycle.

### Modified Capabilities

<!-- None: there are no existing capability specs in openspec/specs/ today. -->

## Impact

- **Schema**: `threads` table — `project_id` becomes nullable, new `is_scratch` boolean column. Migration in `packages/server/src/db/migrate.ts`.
- **Shared types**: `packages/shared/src/types/thread.ts` (or wherever `Thread` lives) — `projectId: string | null`, add `isScratch: boolean`.
- **Runtime**:
  - `packages/runtime/src/services/agent-runner.ts` — use `resolveThreadCwd(thread)` instead of `project.path`.
  - New `packages/runtime/src/services/thread-context.ts` (or similar) exporting `resolveThreadCwd` and `canDoGitOps`.
  - Thread delete path — `rm -rf` the scratch directory.
- **Server**:
  - `/api/git/:threadId/*` route group — guard with `canDoGitOps(thread)`; return `400` otherwise.
  - Thread list queries by project should exclude scratch (`AND is_scratch = false`).
  - New query: list current user's scratch threads.
- **Client**:
  - `NewThreadDialog` — a scratch variant with only prompt + model.
  - `Sidebar` — new top-level "Scratch" section with "+ New" button.
  - `ThreadView` — hide review pane / git actions when `thread.isScratch`.
- **No changes**: WebSocket broker, message/tool-call persistence, agent factories, auth, runner connection model.
- **Out of scope (v1)**: per-project scratch entry point, auto-cleanup by age, "promote scratch → project", team-shared scratch.

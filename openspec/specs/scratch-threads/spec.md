# scratch-threads Specification

## Purpose

TBD - created by archiving change scratch-threads. Update Purpose after archive.

## Requirements

### Requirement: Scratch thread creation without a project

The system SHALL allow an authenticated user to create a thread that is not associated with any project. Such a thread MUST be marked as a scratch thread (`isScratch = true`) and MUST have `projectId = null`.

#### Scenario: User creates a scratch thread from the sidebar

- **WHEN** the user clicks the global "+ New" button in the sidebar's "Scratch" section, provides a prompt and a model, and submits
- **THEN** the system creates a thread with `isScratch = true`, `projectId = null`, `userId` set to the current user, `mode = 'local'`, and starts the agent

#### Scenario: API rejects scratch thread with a project

- **WHEN** a client POSTs a thread create request with `isScratch = true` and a non-null `projectId`
- **THEN** the server responds with HTTP 400 and an error indicating that scratch threads cannot be attached to a project

#### Scenario: API rejects scratch thread with worktree mode

- **WHEN** a client POSTs a thread create request with `isScratch = true` and `mode = 'worktree'`
- **THEN** the server responds with HTTP 400 and an error indicating that scratch threads must use `mode = 'local'`

### Requirement: Per-user isolation of scratch threads

The system SHALL ensure that a user can only see, list, run, and delete their own scratch threads. Scratch threads MUST NOT appear in any listing scoped to another user, nor in any project-scoped thread listing.

#### Scenario: Listing scratch threads returns only the caller's

- **WHEN** an authenticated user GETs the list of scratch threads
- **THEN** the response contains only threads with `isScratch = true AND userId = currentUser`

#### Scenario: Project thread listing excludes scratch

- **WHEN** an authenticated user GETs the threads for a project they own
- **THEN** the response contains only threads with that `projectId` AND `isScratch = false`

#### Scenario: Cross-user access is rejected

- **WHEN** user A requests a scratch thread owned by user B by ID
- **THEN** the server responds with HTTP 404 (not 403, to avoid leaking existence)

### Requirement: Scratch thread working directory

The system SHALL allocate a per-thread working directory at `~/.funny/scratch/<userId>/<threadId>/` on the runner. The directory MUST be created lazily before the first agent process is spawned and MUST be removed when the thread is deleted.

#### Scenario: Directory is created on first agent start

- **WHEN** the agent runner is about to spawn the agent process for a scratch thread that has never run before
- **THEN** the runner ensures `~/.funny/scratch/<userId>/<threadId>/` exists (recursive mkdir) before spawning, and the agent is started with that path as its cwd

#### Scenario: Directory is removed on thread delete

- **WHEN** a user deletes a scratch thread they own
- **THEN** the runner removes `~/.funny/scratch/<userId>/<threadId>/` and all its contents

#### Scenario: Directory is not created for non-scratch threads

- **WHEN** the agent runner spawns the agent for a thread with `isScratch = false`
- **THEN** no scratch directory is created and the cwd is resolved from the project as today

### Requirement: Git operations are unavailable for scratch threads

The system SHALL reject any git or repository operation on a scratch thread. This includes diff, stage, unstage, revert, commit, push, branch listing, and PR creation.

#### Scenario: Git endpoint rejects scratch thread

- **WHEN** any request hits `/api/git/:threadId/*` and the referenced thread has `isScratch = true`
- **THEN** the server responds with HTTP 400 and an error code indicating that git operations are not available for scratch threads

#### Scenario: Helper centralizes the rule

- **WHEN** runtime or server code needs to decide whether to permit git operations on a thread
- **THEN** it calls `canDoGitOps(thread)` rather than inlining a check on `isScratch`

### Requirement: Centralized cwd resolution

The system SHALL resolve the working directory for any thread through a single helper, `resolveThreadCwd(thread, project, userHome)`, which encapsulates the scratch-vs-normal decision.

#### Scenario: Agent runner resolves cwd via helper

- **WHEN** the agent runner is about to spawn the agent process for any thread
- **THEN** it obtains the cwd by calling `resolveThreadCwd` and does not read `project.path` directly

#### Scenario: Helper errors when project is required but missing

- **WHEN** `resolveThreadCwd` is called with `isScratch = false` and a null `project`
- **THEN** it returns a `Result` error of kind `project-required`

### Requirement: Client UI surfaces scratch threads in a dedicated section

The system SHALL render scratch threads in a top-level "Scratch" section in the sidebar that is separate from the project list. The section MUST include a "+ New" entry point that opens a simplified thread creation dialog (prompt + model only).

#### Scenario: Scratch section is visible for the current user

- **WHEN** the user is signed in and any of their threads has `isScratch = true`
- **THEN** the sidebar shows a "Scratch" section above the project list listing those threads

#### Scenario: Scratch compose form hides project-only fields

- **WHEN** the user clicks "+ New" in the sidebar's Scratch section and the scratch thread compose form is displayed
- **THEN** the form shows fields for prompt, model, and permission mode only, and does NOT show branch selection, mode (local/worktree) selection, runtime selector, template selector, parent-thread context, or file references

#### Scenario: Review pane is hidden for scratch threads

- **WHEN** the user opens a scratch thread in the main view
- **THEN** the review pane / git actions (diff, stage, commit, push, create PR) are not rendered

### Requirement: WebSocket and message pipeline unchanged

The system SHALL stream messages, tool calls, and status updates for scratch threads using the same WebSocket broker, message persistence, and tool-call persistence used for normal threads.

#### Scenario: Scratch thread emits the same event shape

- **WHEN** an agent running in a scratch thread produces a message, tool call, or status change
- **THEN** the corresponding `agent:message` / `agent:tool_call` / `agent:status` / `agent:result` WebSocket event is emitted with the scratch thread's `threadId` and is delivered to the owning user's connected clients

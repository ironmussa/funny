## ADDED Requirements

### Requirement: Checkpoint eligibility is independent of model and provider identity

The system SHALL resolve file checkpointing from runtime capabilities, working
directory eligibility, and available backends rather than from a hard-coded
model or provider allow-list.

#### Scenario: Any local harness runs in a Git worktree

- **WHEN** an agent turn uses a runtime that supports turn checkpoint hooks and its working directory is a writable Git worktree
- **THEN** the system selects an available file checkpoint backend regardless of the selected provider or model

#### Scenario: Native backend is available

- **WHEN** the execution adapter exposes native file checkpoint and anchored rewind support
- **THEN** the system may select the native backend instead of capturing duplicate Git state

#### Scenario: Git fallback is available

- **WHEN** native file checkpointing is unavailable but the working directory is an eligible Git worktree
- **THEN** the system selects the Git turn checkpoint backend

#### Scenario: No backend is available

- **WHEN** the directory is gitless, scratch, read-only, or the runtime cannot expose a checkpoint backend
- **THEN** the agent turn continues without file checkpointing
- **AND** the thread or harness result reports that file rewind is unavailable

### Requirement: Git checkpoints bracket each agent turn

The Git checkpoint backend SHALL capture an immutable before state immediately
before the agent can modify files and an immutable after state before the turn's
completion permits queued work to start.

#### Scenario: Successful turn is captured

- **WHEN** an eligible agent turn starts and later completes successfully
- **THEN** the system records before-worktree, before-index, after-worktree, and after-index trees under private Git refs associated with the stable turn ID

#### Scenario: Failed or stopped turn is captured

- **WHEN** an eligible agent turn fails or is stopped after it may have modified files
- **THEN** the system attempts to capture its after state before emitting terminal lifecycle completion
- **AND** the completed before/after pair remains eligible for rewind

#### Scenario: Before capture fails

- **WHEN** the system cannot capture the before state
- **THEN** the agent still starts
- **AND** that turn is marked unavailable for Git rewind with a diagnostic reason

#### Scenario: After capture fails

- **WHEN** a before state exists but the after state cannot be captured
- **THEN** the turn is marked incomplete and is not used for selective rewind
- **AND** the failure does not replace the agent's original completion status

### Requirement: Git checkpoints preserve Git-visible working state

The Git backend SHALL preserve tracked changes, staged state, deletions, and
non-ignored untracked files without moving `HEAD` or changing the user's real
index during capture.

#### Scenario: Mixed working state is captured

- **WHEN** the worktree contains staged, unstaged, deleted, and non-ignored untracked files at a checkpoint boundary
- **THEN** the stored worktree and index trees represent those states independently

#### Scenario: Ignored file exists

- **WHEN** an ignored file exists under the working directory
- **THEN** it is excluded from the Git checkpoint

#### Scenario: Capture completes

- **WHEN** before or after capture succeeds
- **THEN** the active branch, `HEAD`, and real Git index remain unchanged

### Requirement: Rewind selectively reverses agent turn deltas

The Git backend SHALL rewind to an anchor by applying completed turn deltas in
reverse chronological order rather than replacing the complete current
worktree with the anchor snapshot.

#### Scenario: Unrelated manual edit follows an agent turn

- **WHEN** a user edits a file or hunk not changed by the rewound turns
- **THEN** rewind preserves that manual edit

#### Scenario: Agent created a file

- **WHEN** a rewound turn created a non-ignored file and the user has not subsequently modified it
- **THEN** rewind removes that file

#### Scenario: Agent deleted a file

- **WHEN** a rewound turn deleted a file and the user has not subsequently modified the same content
- **THEN** rewind restores that file to its pre-turn state

#### Scenario: Multiple turns follow the selected anchor

- **WHEN** the user rewinds to an earlier user-message turn
- **THEN** the system applies inverse deltas from the newest completed turn through the selected turn

#### Scenario: Rewind succeeds

- **WHEN** all inverse deltas merge without conflicts
- **THEN** the resulting worktree and index preserve unrelated current changes
- **AND** `HEAD` and the active branch remain unchanged

### Requirement: Rewind is atomic and conflict-aware

The system SHALL compute and validate a complete rewind plan before mutating the
real worktree, and SHALL expose overlapping edits as typed conflicts.

#### Scenario: User and agent changed overlapping content

- **WHEN** applying an inverse turn delta would overwrite a current edit to the same content
- **THEN** the rewind returns a conflict result listing the affected paths
- **AND** neither files, index state, thread messages, nor session state are changed

#### Scenario: Binary or rename conflict cannot be merged safely

- **WHEN** Git cannot safely merge a binary, rename, mode, or delete/modify combination
- **THEN** the rewind returns a typed conflict rather than forcing the anchor state

#### Scenario: Restore operation fails after planning

- **WHEN** an unexpected write failure occurs while applying an approved rewind plan
- **THEN** the system restores the pre-apply worktree and index state before returning an error whenever the repository remains accessible

#### Scenario: Rewind has been applied

- **WHEN** file restoration succeeds
- **THEN** transcript truncation and session updates occur only after the file operation commits successfully

### Requirement: File rewind and conversation rewind are separate strategies

The system SHALL resolve file restoration independently from provider session
restoration so all eligible harnesses can rewind files even when their session
protocols differ.

#### Scenario: Provider supports anchored native conversation rewind

- **WHEN** the selected provider can create or adopt a session truncated at the selected user message
- **THEN** the runtime uses that native session strategy after file rewind succeeds

#### Scenario: Provider lacks anchored conversation rewind

- **WHEN** the selected provider cannot rewind its session to the selected message
- **THEN** the runtime clears the provider session ID
- **AND** marks the thread to rebuild context from the retained database transcript on its next turn

#### Scenario: Transcript is truncated

- **WHEN** file rewind and conversation strategy preparation both succeed
- **THEN** messages strictly after the selected user message are deleted
- **AND** the thread returns to an idle state

#### Scenario: Fork and rewind is requested

- **WHEN** the provider cannot create an anchored native conversation fork
- **THEN** the fork may copy retained database messages and start without a provider session
- **AND** the copied thread rebuilds context on its next turn

### Requirement: Harness runtimes can expose optional turn checkpoint hooks

The public harness SHALL define an optional checkpoint capability that can wrap
agent turns without coupling agent definitions to a specific provider.

#### Scenario: Runtime exposes checkpoint hooks

- **WHEN** a harness session starts a prompt with a stable turn ID
- **THEN** it invokes the runtime checkpoint begin hook before `spawnAgent`
- **AND** invokes the completion hook with the terminal outcome before resolving the prompt

#### Scenario: Runtime omits checkpoint hooks

- **WHEN** a custom harness runtime does not implement checkpointing
- **THEN** existing agent and workflow execution behavior remains unchanged

#### Scenario: Product runtime adapts harness turn IDs

- **WHEN** a thread-backed harness session runs through the funny runtime
- **THEN** the adapter maps the harness turn ID to the thread and user-message checkpoint identity used by rewind

### Requirement: Clients consume reported rewind capabilities

The server SHALL report effective file and conversation rewind capabilities and
the client SHALL render actions from those values rather than provider names.

#### Scenario: Git checkpoint is available for a new provider

- **WHEN** a Gemini, Pi, Cursor, OpenCode, DeepAgent, extension provider, or other harness turn has a valid checkpoint chain
- **THEN** direct file rewind is enabled in the client

#### Scenario: File rewind exists but anchored fork does not

- **WHEN** direct rewind can rebuild conversation context but fork-and-rewind is unsupported
- **THEN** the client enables direct rewind and disables only fork-and-rewind with an explanatory reason

#### Scenario: Rewind returns conflicts

- **WHEN** the server reports conflicting paths
- **THEN** the client keeps the conversation unchanged and presents the paths and safe next actions to the user

### Requirement: Checkpoint records have bounded lifecycle

The system SHALL remove obsolete private refs and metadata when checkpoints are
no longer reachable from an active thread and SHALL provide bounded cleanup for
incomplete or stale records.

#### Scenario: Thread is deleted

- **WHEN** a thread is permanently deleted
- **THEN** all Git checkpoint refs and metadata owned by that thread are removed

#### Scenario: Thread is rewound

- **WHEN** a rewind succeeds and later transcript turns are discarded
- **THEN** checkpoint records for discarded turns are removed after the new thread state is durable

#### Scenario: Incomplete checkpoint becomes stale

- **WHEN** a checkpoint has no complete before/after pair beyond the configured retention period
- **THEN** cleanup removes its private refs and metadata without affecting repository history or working files

#### Scenario: Cleanup fails

- **WHEN** ref cleanup cannot complete
- **THEN** the user-visible rewind result remains valid
- **AND** the failure is logged and eligible for later cleanup retry

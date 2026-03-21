/**
 * @domain subdomain: Shared Kernel
 * @domain type: event-model
 * @domain layer: domain
 *
 * Event Model for the funny system.
 *
 * Describes the full event-driven architecture using the evflow DSL:
 * commands, events, aggregates, read models, screens, external systems,
 * automations, sagas, sequences, and slices.
 *
 * This is a living specification — keep it in sync with
 * packages/runtime/src/services/thread-event-bus.ts and handler-registry.ts.
 */

import { EventModel } from '@funny/evflow';

export function createRuntimeModel(): EventModel {
  const system = new EventModel('FunnyRuntime');
  const { flow } = system;

  // ══════════════════════════════════════════════════════════════
  // THREAD LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  // ── Commands ───────────────────────────────────────────────
  const CreateThread = system.command('CreateThread', {
    actor: 'User',
    fields: {
      projectId: 'string',
      title: 'string',
      mode: 'string', // 'local' | 'worktree'
      prompt: 'string',
      model: 'string',
      provider: 'string',
    },
    description: 'User creates a new thread to start agent work',
  });

  const StartAgent = system.command('StartAgent', {
    actor: 'User',
    fields: {
      threadId: 'string',
      prompt: 'string',
      model: 'string',
      provider: 'string',
      permissionMode: 'string',
    },
    description: 'Start or resume an agent process on a thread',
  });

  const StopAgent = system.command('StopAgent', {
    actor: 'User',
    fields: { threadId: 'string' },
    description: 'Kill a running agent process',
  });

  const SendFollowUp = system.command('SendFollowUp', {
    actor: 'User',
    fields: { threadId: 'string', content: 'string' },
    description: 'Send a follow-up message to a running or completed agent',
  });

  const ChangeStage = system.command('ChangeStage', {
    actor: 'System',
    fields: { threadId: 'string', toStage: 'string' },
    description: 'Transition thread stage (backlog → in_progress → review → done)',
  });

  const DeleteThread = system.command('DeleteThread', {
    actor: 'User',
    fields: { threadId: 'string' },
    description: 'Delete a thread and clean up its worktree',
  });

  const InsertComment = system.command('InsertComment', {
    actor: 'System',
    fields: { threadId: 'string', source: 'string', content: 'string' },
    description: 'Insert a system comment into a thread',
  });

  const SaveThreadEvent = system.command('SaveThreadEvent', {
    actor: 'System',
    fields: { threadId: 'string', type: 'string', data: 'string' },
    description: 'Persist a thread event to the database',
  });

  const InsertMessage = system.command('InsertMessage', {
    actor: 'System',
    fields: {
      threadId: 'string',
      role: 'string', // 'user' | 'assistant'
      content: 'string',
      model: 'string?',
      provider: 'string?',
    },
    description:
      'Persist a chat message (user prompt or assistant response) to the messages table via agent-message-handler.ts',
  });

  const InsertToolCall = system.command('InsertToolCall', {
    actor: 'System',
    fields: {
      threadId: 'string',
      toolName: 'string',
      input: 'string',
      output: 'string?',
    },
    description:
      'Persist a tool call (and later its output) to the tool_calls table via agent-message-handler.ts',
  });

  const BroadcastEvent = system.command('BroadcastEvent', {
    actor: 'System',
    fields: {
      userId: 'string',
      eventType: 'string', // 'agent:message' | 'agent:tool_call' | 'agent:status' | etc.
      payload: 'string',
    },
    description: 'Broadcast a real-time event to connected clients via ws-broker.ts pub/sub',
  });

  // ── Events ─────────────────────────────────────────────────
  const ThreadCreated = system.event('ThreadCreated', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      stage: 'string',
      status: 'string',
      worktreePath: 'string?',
      cwd: 'string',
    },
    description: 'A new thread has been created',
  });

  const AgentStarted = system.event('AgentStarted', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      model: 'string',
      provider: 'string',
      worktreePath: 'string?',
      cwd: 'string',
    },
    description: 'An agent process has been spawned and is running',
  });

  const AgentCompleted = system.event('AgentCompleted', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      status: 'string', // 'completed' | 'failed' | 'stopped'
      cost: 'decimal',
      worktreePath: 'string?',
      cwd: 'string',
    },
    description: 'An agent process has finished (completed, failed, or stopped)',
  });

  const ThreadStageChanged = system.event('ThreadStageChanged', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      fromStage: 'string?',
      toStage: 'string',
    },
    description: 'Thread stage transitioned (e.g. backlog → in_progress)',
  });

  const ThreadDeleted = system.event('ThreadDeleted', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      worktreePath: 'string?',
    },
    description: 'A thread has been permanently deleted',
  });

  const MessagePersisted = system.event('MessagePersisted', {
    fields: {
      threadId: 'string',
      messageId: 'string',
      role: 'string',
    },
    description: 'A chat message has been saved to the messages table and broadcast to clients',
  });

  const ToolCallPersisted = system.event('ToolCallPersisted', {
    fields: {
      threadId: 'string',
      toolCallId: 'string',
      toolName: 'string',
    },
    description: 'A tool call has been saved to the tool_calls table and broadcast to clients',
  });

  const EventBroadcasted = system.event('EventBroadcasted', {
    fields: {
      userId: 'string',
      eventType: 'string',
    },
    description: 'A real-time event has been sent to all connected WebSocket clients for the user',
  });

  // ── Aggregate ──────────────────────────────────────────────
  system.aggregate('Thread', {
    handles: [CreateThread, StartAgent, StopAgent, SendFollowUp, ChangeStage, DeleteThread],
    emits: [ThreadCreated, AgentStarted, AgentCompleted, ThreadStageChanged, ThreadDeleted],
    invariants: [
      'Only one agent can run per thread at a time',
      'Stage transitions follow state machine: backlog → in_progress → review → done',
      'Cannot delete a thread with a running agent',
      'Worktree mode requires project path to be a valid git repository',
      'Follow-up messages are queued if agent is running (queue mode)',
    ],
    description:
      'Thread lifecycle state in agent-runner.ts — manages agent process, stage transitions, worktree isolation',
  });

  // ── External Systems ───────────────────────────────────────
  system.external('ClaudeAgentSDK', {
    receives: [StartAgent, StopAgent],
    emits: [AgentStarted, AgentCompleted],
    description:
      'Claude Agent SDK (@anthropic-ai/claude-agent-sdk) — spawned as subprocess via packages/core/src/agents/, session resumption via sessionId',
  });

  system.external('Database', {
    receives: [SaveThreadEvent, InsertMessage, InsertToolCall, InsertComment],
    emits: [MessagePersisted, ToolCallPersisted],
    description:
      'SQLite/PostgreSQL via Drizzle ORM — messages, tool_calls, thread_events, and message_queue tables. Data channel proxied from runner to server via WebSocket tunnel.',
  });

  system.external('WebSocketBroker', {
    receives: [BroadcastEvent],
    emits: [EventBroadcasted],
    description:
      'ws-broker.ts singleton pub/sub — broadcasts agent:message, agent:tool_call, agent:tool_output, agent:status, agent:result, thread:created, thread:updated events to connected browser clients via Socket.IO rooms',
  });

  // ── Screens ────────────────────────────────────────────────
  system.screen('Sidebar', {
    displays: ['ThreadListView'],
    triggers: [CreateThread, DeleteThread],
    description:
      'Sidebar.tsx — project list with collapsible accordion, thread list with status badges, "New Thread" button',
  });

  system.screen('ThreadView', {
    displays: ['ThreadListView', 'ActiveAgentView', 'MessageStreamView'],
    triggers: [StartAgent, StopAgent, SendFollowUp, ChangeStage],
    description:
      'ThreadView.tsx — chat-style message display, tool call cards, prompt input with model/mode selectors, stop button',
  });

  // ── Read Models ────────────────────────────────────────────
  system.readModel('ThreadListView', {
    from: [ThreadCreated, ThreadStageChanged, ThreadDeleted, AgentCompleted],
    fields: {
      threads: 'Thread[]',
      activeCount: 'number',
      totalCost: 'decimal',
    },
    description: 'Client-side thread list with status badges and cost tracking',
  });

  system.readModel('ActiveAgentView', {
    from: [AgentStarted, AgentCompleted],
    fields: {
      runningAgents: 'string[]',
      isRunning: 'boolean',
    },
    description: 'Which agents are currently running (for stop button, status indicators)',
  });

  system.readModel('MessageStreamView', {
    from: [MessagePersisted, ToolCallPersisted, EventBroadcasted],
    fields: {
      messages: 'Message[]',
      toolCalls: 'ToolCall[]',
      isStreaming: 'boolean',
    },
    description:
      'Real-time chat stream in ThreadView — receives agent:message and agent:tool_call WebSocket events, renders messages and tool call cards as they arrive',
  });

  // ── Automations ────────────────────────────────────────────
  system.automation('TransitionStageOnAgentStart', {
    on: 'AgentStarted',
    triggers: 'ChangeStage',
    description:
      'Auto-transitions thread stage to in_progress when agent starts (if backlog/planning/review)',
  });

  system.automation('CommentOnAgentCompletion', {
    on: 'AgentCompleted',
    triggers: 'InsertComment',
    description: 'Creates a system comment when an agent completes/fails/stops',
  });

  system.automation('MemoryGCOnCompletion', {
    on: 'AgentCompleted',
    triggers: 'RunMemoryGC',
    description: 'Trigger memory garbage collection after N thread completions',
  });

  system.automation('PersistMessageOnReceive', {
    on: 'AgentStarted',
    triggers: 'InsertMessage',
    description:
      'agent-message-handler.ts persists each user/assistant message to the DB as the agent streams responses',
  });

  system.automation('PersistToolCallOnExecute', {
    on: 'AgentStarted',
    triggers: 'InsertToolCall',
    description:
      'agent-message-handler.ts persists each tool call and updates its output when the tool completes',
  });

  system.automation('BroadcastMessageToClients', {
    on: 'MessagePersisted',
    triggers: 'BroadcastEvent',
    description:
      'After a message is persisted, broadcast agent:message event to connected clients via ws-broker',
  });

  system.automation('BroadcastToolCallToClients', {
    on: 'ToolCallPersisted',
    triggers: 'BroadcastEvent',
    description:
      'After a tool call is persisted, broadcast agent:tool_call event to connected clients via ws-broker',
  });

  system.automation('BroadcastThreadCreated', {
    on: 'ThreadCreated',
    triggers: 'BroadcastEvent',
    description: 'Broadcast thread:created event so Sidebar updates in real-time',
  });

  system.automation('BroadcastAgentStatus', {
    on: 'AgentStarted',
    triggers: 'BroadcastEvent',
    description: 'Broadcast agent:status event so ThreadView shows running indicator',
  });

  system.automation('BroadcastAgentResult', {
    on: 'AgentCompleted',
    triggers: 'BroadcastEvent',
    description: 'Broadcast agent:result event with cost/status when agent finishes',
  });

  system.automation('PersistThreadCreation', {
    on: 'ThreadCreated',
    triggers: 'SaveThreadEvent',
    description: 'Persist thread creation to the threads table via data channel',
  });

  system.automation('PersistAgentCompletion', {
    on: 'AgentCompleted',
    triggers: 'SaveThreadEvent',
    description: 'Update thread status and cost in the threads table when agent finishes',
  });

  // ── Saga ─────────────────────────────────────────────────
  system.saga('FollowUpQueueSaga', {
    on: [AgentCompleted],
    correlationKey: 'threadId',
    when: 'queued messages exist for threadId',
    triggers: [StartAgent],
    description:
      'Process manager that drains queued follow-up messages — on AgentCompleted, checks if thread has pending messages, dequeues next and triggers StartAgent',
  });

  // ══════════════════════════════════════════════════════════════
  // GIT OPERATIONS
  // ══════════════════════════════════════════════════════════════

  // ── Commands ───────────────────────────────────────────────
  const GitStage = system.command('GitStage', {
    actor: 'User',
    fields: { threadId: 'string', paths: 'string[]', cwd: 'string' },
    description: 'Stage files for commit',
  });

  const GitUnstage = system.command('GitUnstage', {
    actor: 'User',
    fields: { threadId: 'string', paths: 'string[]', cwd: 'string' },
    description: 'Unstage previously staged files',
  });

  const GitCommit = system.command('GitCommit', {
    actor: 'User',
    fields: { threadId: 'string', message: 'string', cwd: 'string' },
    description: 'Create a git commit from staged changes',
  });

  const GitPush = system.command('GitPush', {
    actor: 'User',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Push branch to remote',
  });

  const GitRevert = system.command('GitRevert', {
    actor: 'User',
    fields: { threadId: 'string', paths: 'string[]', cwd: 'string' },
    description: 'Revert file changes',
  });

  const GitPull = system.command('GitPull', {
    actor: 'User',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Pull changes from remote',
  });

  const GitMerge = system.command('GitMerge', {
    actor: 'User',
    fields: {
      threadId: 'string',
      sourceBranch: 'string',
      targetBranch: 'string',
    },
    description: 'Merge source branch into target',
  });

  const GitStash = system.command('GitStash', {
    actor: 'User',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Stash current changes',
  });

  const GitStashPop = system.command('GitStashPop', {
    actor: 'User',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Pop stashed changes',
  });

  const GitResetSoft = system.command('GitResetSoft', {
    actor: 'User',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Soft reset (undo last commit, keep changes staged)',
  });

  const EmitGitStatus = system.command('EmitGitStatus', {
    actor: 'System',
    fields: { threadId: 'string', cwd: 'string' },
    description: 'Compute and emit git status via WebSocket',
  });

  system.command('InvalidateGitCache', {
    actor: 'System',
    fields: { projectId: 'string' },
    description: 'Invalidate the git status HTTP cache for a project',
  });

  system.command('RunMemoryGC', {
    actor: 'System',
    fields: { projectId: 'string' },
    description: 'Trigger Paisley Park memory garbage collection',
  });

  // ── Events ─────────────────────────────────────────────────
  const GitChanged = system.event('GitChanged', {
    fields: {
      threadId: 'string',
      projectId: 'string',
      userId: 'string',
      toolName: 'string',
      cwd: 'string',
      worktreePath: 'string?',
    },
    description: 'A file-modifying tool was executed (Write, Edit, Bash, etc.)',
  });

  const GitStaged = system.event('GitStaged', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      paths: 'string[]',
      cwd: 'string',
    },
    description: 'Files have been staged',
  });

  const GitUnstaged = system.event('GitUnstaged', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      paths: 'string[]',
      cwd: 'string',
    },
    description: 'Files have been unstaged',
  });

  const GitCommitted = system.event('GitCommitted', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      message: 'string',
      cwd: 'string',
      commitSha: 'string?',
      isPipelineCommit: 'boolean?',
      pipelineRunId: 'string?',
      workflowId: 'string?',
    },
    description: 'A commit has been created',
  });

  const GitPushed = system.event('GitPushed', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      cwd: 'string',
    },
    description: 'Branch has been pushed to remote',
  });

  const GitReverted = system.event('GitReverted', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      paths: 'string[]',
      cwd: 'string',
    },
    description: 'File changes have been reverted',
  });

  const GitPulled = system.event('GitPulled', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      cwd: 'string',
      output: 'string',
    },
    description: 'Changes pulled from remote',
  });

  const GitMerged = system.event('GitMerged', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      sourceBranch: 'string',
      targetBranch: 'string',
      output: 'string',
    },
    description: 'Branch merged successfully',
  });

  const GitStashed = system.event('GitStashed', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      cwd: 'string',
      output: 'string',
    },
    description: 'Changes stashed',
  });

  const GitStashPopped = system.event('GitStashPopped', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      cwd: 'string',
      output: 'string',
    },
    description: 'Stashed changes restored',
  });

  const GitResetSoftDone = system.event('GitResetSoftDone', {
    fields: {
      threadId: 'string',
      userId: 'string',
      projectId: 'string',
      cwd: 'string',
      output: 'string',
    },
    description: 'Soft reset completed',
  });

  // ── Aggregate ──────────────────────────────────────────────
  system.aggregate('GitRepository', {
    handles: [
      GitStage,
      GitUnstage,
      GitCommit,
      GitPush,
      GitRevert,
      GitPull,
      GitMerge,
      GitStash,
      GitStashPop,
      GitResetSoft,
    ],
    emits: [
      GitStaged,
      GitUnstaged,
      GitCommitted,
      GitPushed,
      GitReverted,
      GitPulled,
      GitMerged,
      GitStashed,
      GitStashPopped,
      GitResetSoftDone,
    ],
    invariants: [
      'Cannot commit with an empty staging area',
      'Cannot push without commits ahead of remote',
      'Cannot merge a branch into itself',
      'Stash requires uncommitted changes to exist',
      'cwd must be a valid git repository',
    ],
    description:
      'Git repository state managed via packages/core/src/git/ — concurrency pools (gitRead/gitWrite), worktree awareness',
  });

  // ── External Systems ───────────────────────────────────────
  system.external('GitCLI', {
    receives: [
      GitStage,
      GitUnstage,
      GitCommit,
      GitPush,
      GitRevert,
      GitPull,
      GitMerge,
      GitStash,
      GitStashPop,
      GitResetSoft,
      EmitGitStatus,
    ],
    emits: [
      GitStaged,
      GitUnstaged,
      GitCommitted,
      GitPushed,
      GitReverted,
      GitPulled,
      GitMerged,
      GitStashed,
      GitStashPopped,
      GitResetSoftDone,
      GitChanged,
    ],
    description:
      'Git CLI executed via packages/core/src/git/process.ts — gitRead/gitWrite concurrency pools, cross-platform process execution',
  });

  system.external('GitHubAPI', {
    receives: [GitPush],
    emits: [GitPushed],
    description:
      'GitHub CLI (gh) integration via packages/core/src/git/github.ts — push, PR creation, repo operations, uses GH_TOKEN from user profile',
  });

  // ── Screen ─────────────────────────────────────────────────
  system.screen('ReviewPane', {
    displays: ['GitStatusView', 'CommitHistoryView'],
    triggers: [GitStage, GitUnstage, GitCommit, GitPush, GitRevert, GitPull, GitMerge],
    description:
      'ReviewPane.tsx — git diff viewer with stage/unstage/revert/commit/push/PR actions, file list with checkboxes',
  });

  // ── Read Models ────────────────────────────────────────────
  system.readModel('GitStatusView', {
    from: [
      GitChanged,
      GitStaged,
      GitUnstaged,
      GitCommitted,
      GitReverted,
      GitPulled,
      GitResetSoftDone,
    ],
    fields: {
      staged: 'string[]',
      unstaged: 'string[]',
      untracked: 'string[]',
      syncState: 'string',
    },
    description: 'Git file status for the ReviewPane (staged/unstaged/untracked files)',
  });

  system.readModel('CommitHistoryView', {
    from: [GitCommitted, GitPushed, GitMerged],
    fields: {
      commits: 'Commit[]',
      isPushed: 'boolean',
      isMerged: 'boolean',
    },
    description: 'Commit log and push/merge state in the ReviewPane',
  });

  // ── Automations ────────────────────────────────────────────
  system.automation('EmitGitStatusOnChange', {
    on: 'GitChanged',
    triggers: 'EmitGitStatus',
    description: 'Debounced git status emission via WebSocket on file changes',
  });

  system.automation('RefreshGitStatusOnAgentComplete', {
    on: 'AgentCompleted',
    triggers: 'EmitGitStatus',
    description: 'Refreshes git status after agent finishes work',
  });

  system.automation('PersistGitCommit', {
    on: 'GitCommitted',
    triggers: 'SaveThreadEvent',
    description: 'Persist commit metadata to thread events',
  });

  system.automation('PersistGitPush', {
    on: 'GitPushed',
    triggers: 'SaveThreadEvent',
    description: 'Persist push event to thread events',
  });

  system.automation('PersistGitMerge', {
    on: 'GitMerged',
    triggers: 'SaveThreadEvent',
    description: 'Persist merge event to thread events',
  });

  system.automation('PersistGitStage', {
    on: 'GitStaged',
    triggers: 'SaveThreadEvent',
    description: 'Persist stage event to thread events',
  });

  system.automation('PersistGitUnstage', {
    on: 'GitUnstaged',
    triggers: 'SaveThreadEvent',
    description: 'Persist unstage event to thread events',
  });

  system.automation('PersistGitRevert', {
    on: 'GitReverted',
    triggers: 'SaveThreadEvent',
    description: 'Persist revert event to thread events',
  });

  system.automation('PersistGitPull', {
    on: 'GitPulled',
    triggers: 'SaveThreadEvent',
    description: 'Persist pull event to thread events',
  });

  system.automation('PersistGitStash', {
    on: 'GitStashed',
    triggers: 'SaveThreadEvent',
    description: 'Persist stash event to thread events',
  });

  system.automation('PersistGitStashPop', {
    on: 'GitStashPopped',
    triggers: 'SaveThreadEvent',
    description: 'Persist stash-pop event to thread events',
  });

  system.automation('PersistGitResetSoft', {
    on: 'GitResetSoftDone',
    triggers: 'SaveThreadEvent',
    description: 'Persist reset-soft event to thread events',
  });

  // ══════════════════════════════════════════════════════════════
  // PIPELINE / WATCHERS
  // ══════════════════════════════════════════════════════════════

  const StartPipelineReview = system.command('StartPipelineReview', {
    actor: 'System',
    fields: {
      threadId: 'string',
      projectId: 'string',
      commitSha: 'string?',
      cwd: 'string',
    },
    description: 'Start a pipeline code review run',
  });

  const StartGitWatcher = system.command('StartGitWatcher', {
    actor: 'System',
    fields: { projectId: 'string', threadId: 'string' },
    description: 'Start watching a project for file changes',
  });

  const StopGitWatcher = system.command('StopGitWatcher', {
    actor: 'System',
    fields: { projectId: 'string', threadId: 'string' },
    description: 'Stop watching a project for file changes',
  });

  system.external('FileSystemWatcher', {
    receives: [StartGitWatcher, StopGitWatcher],
    description:
      'File system watcher (chokidar/fs.watch) — monitors project directories for changes, emits GitChanged events',
  });

  system.automation('TriggerPipelineOnCommit', {
    on: 'GitCommitted',
    triggers: 'StartPipelineReview',
    description:
      'Starts pipeline code review when a commit is created (if pipeline enabled, not a pipeline commit)',
  });

  system.automation('StartWatcherOnThreadCreated', {
    on: 'ThreadCreated',
    triggers: 'StartGitWatcher',
    description: 'Start watching project files when a thread is created',
  });

  system.automation('StopWatcherOnThreadDeleted', {
    on: 'ThreadDeleted',
    triggers: 'StopGitWatcher',
    description: 'Stop watching project files when a thread is deleted',
  });

  // ══════════════════════════════════════════════════════════════
  // TERMINAL / PTY LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  // ── Commands ───────────────────────────────────────────────
  const SpawnPty = system.command('SpawnPty', {
    actor: 'User',
    fields: {
      id: 'string', // UUID generated client-side
      cwd: 'string',
      cols: 'number',
      rows: 'number',
      shell: 'string?', // bash, zsh, powershell, etc.
      projectId: 'string?',
      label: 'string?',
    },
    description:
      'User clicks "+" in terminal tab bar, selects a shell, and spawns a new PTY session',
  });

  const WritePty = system.command('WritePty', {
    actor: 'User',
    fields: {
      id: 'string',
      data: 'string', // raw keystrokes / paste data
    },
    description: 'User types input in xterm.js terminal (onData callback)',
  });

  const ResizePty = system.command('ResizePty', {
    actor: 'System',
    fields: {
      id: 'string',
      cols: 'number',
      rows: 'number',
    },
    description: 'Terminal panel resized (ResizeObserver / FitAddon triggers pty:resize)',
  });

  const RestorePty = system.command('RestorePty', {
    actor: 'System',
    fields: { id: 'string' },
    description: 'Client reconnects and requests terminal state restore (pty:restore event)',
  });

  const ListPtySessions = system.command('ListPtySessions', {
    actor: 'System',
    fields: { userId: 'string' },
    description: 'On WebSocket connect, client emits pty:list to discover existing sessions',
  });

  const KillPty = system.command('KillPty', {
    actor: 'User',
    fields: { id: 'string' },
    description: 'User closes terminal tab → pty:kill sent to kill the process',
  });

  const RenamePty = system.command('RenamePty', {
    actor: 'User',
    fields: { id: 'string', label: 'string' },
    description: 'User renames a terminal tab label',
  });

  const LoadPtySessions = system.command('LoadPtySessions', {
    actor: 'System',
    fields: { backend: 'string' },
    description:
      'On server startup, reattachSessions() loads all persisted sessions from pty_sessions table and reattaches via backend.reattach()',
  });

  const SerializeTerminalState = system.command('SerializeTerminalState', {
    actor: 'System',
    fields: { id: 'string' },
    description:
      'On graceful shutdown, serialize headless-xterm state to pty_sessions.terminal_state column before killing processes',
  });

  const CleanupStaleSessions = system.command('CleanupStaleSessions', {
    actor: 'System',
    fields: {},
    description:
      'When daemon reports 0 live sessions but DB has entries, remove stale rows — sessions were lost on daemon restart',
  });

  const AdoptOrphanedSession = system.command('AdoptOrphanedSession', {
    actor: 'System',
    fields: { id: 'string', userId: 'string' },
    description:
      'In runner mode, sessions reattached from daemon lack userId (no DB). Assign the first requesting userId since runner is single-user.',
  });

  // ── Events ─────────────────────────────────────────────────
  const PtySpawned = system.event('PtySpawned', {
    fields: {
      id: 'string',
      userId: 'string',
      cwd: 'string',
      shell: 'string?',
      projectId: 'string?',
      backend: 'string', // daemon | headless-xterm | bun-native | node-pty
    },
    description:
      'PTY process successfully created by backend, session stored in activeSessions map',
  });

  const PtyDataReceived = system.event('PtyDataReceived', {
    fields: {
      id: 'string',
      data: 'string', // raw terminal output
    },
    description:
      'Backend onData callback fired — shell produced output, relayed to client via wsBroker',
  });

  const PtyRestored = system.event('PtyRestored', {
    fields: {
      id: 'string',
      terminalState: 'string?', // serialized xterm state (headless backend)
    },
    description: 'Session reattached after server restart or client reconnect, scrollback replayed',
  });

  const PtyExited = system.event('PtyExited', {
    fields: {
      id: 'string',
      exitCode: 'number?',
    },
    description:
      'PTY process exited (user killed, shell exited, or error) — session removed from activeSessions',
  });

  const PtyError = system.event('PtyError', {
    fields: {
      id: 'string',
      error: 'string',
    },
    description: 'PTY spawn failed or backend error (e.g. cwd not in user projects)',
  });

  const PtySessionsListed = system.event('PtySessionsListed', {
    fields: {
      userId: 'string',
      sessions: 'SessionMeta[]',
    },
    description:
      'Server responds with list of active PTY sessions for the user (pty:sessions event)',
  });

  const PtySessionsLoaded = system.event('PtySessionsLoaded', {
    fields: {
      count: 'number',
      backend: 'string',
    },
    description:
      'Sessions loaded from pty_sessions table on startup and reattached via backend.reattach() — includes terminal_state for headless-xterm',
  });

  const TerminalStateSerialized = system.event('TerminalStateSerialized', {
    fields: {
      count: 'number',
    },
    description:
      'On graceful shutdown, headless-xterm backend serialized all terminal states to pty_sessions.terminal_state for restore on next startup',
  });

  const StaleSessionsCleaned = system.event('StaleSessionsCleaned', {
    fields: {
      count: 'number',
    },
    description:
      'DB rows removed after daemon reported 0 live sessions — PTY processes were lost on daemon restart',
  });

  const OrphanedSessionAdopted = system.event('OrphanedSessionAdopted', {
    fields: {
      id: 'string',
      userId: 'string',
    },
    description:
      'In runner mode, a session without userId (reattached from daemon, no DB) was assigned the requesting userId',
  });

  // ── Aggregate ──────────────────────────────────────────────
  system.aggregate('PtySession', {
    handles: [
      SpawnPty,
      WritePty,
      ResizePty,
      KillPty,
      RestorePty,
      RenamePty,
      LoadPtySessions,
      SerializeTerminalState,
      CleanupStaleSessions,
      AdoptOrphanedSession,
    ],
    emits: [
      PtySpawned,
      PtyDataReceived,
      PtyExited,
      PtyError,
      PtyRestored,
      PtySessionsLoaded,
      TerminalStateSerialized,
      StaleSessionsCleaned,
      OrphanedSessionAdopted,
    ],
    invariants: [
      'cwd must resolve to absolute path within user project directories or worktrees',
      'session id must not already exist in activeSessions (duplicate spawn → auto-restore)',
      'backend must be available (not null backend in production)',
      'terminal_state serialization only applies to headless-xterm backend',
      'orphan adoption only applies in runner mode (single-user, no DB)',
    ],
    description:
      'Manages PTY session state in pty-manager.ts — activeSessions map, scrollback buffer, backend selection, DB persistence via pty_sessions table',
  });

  // ── External Systems ──────────────────────────────────────
  system.external('ServerSocketProxy', {
    receives: [SpawnPty, WritePty, ResizePty, KillPty, RestorePty, ListPtySessions, RenamePty],
    emits: [PtyDataReceived, PtyExited, PtyError, PtySessionsListed, PtyRestored],
    description:
      'Socket.IO server (socketio.ts) — authenticates browser session, resolves runner for project, forwards pty:* events via central:browser_ws tunnel, relays runner responses back to user room',
  });

  system.external('PtySessionsDatabase', {
    receives: [LoadPtySessions, SerializeTerminalState, CleanupStaleSessions],
    emits: [PtySessionsLoaded, TerminalStateSerialized, StaleSessionsCleaned],
    description:
      'pty_sessions SQLite table — stores id, tmux_session, user_id, cwd, project_id, label, shell, cols, rows, terminal_state (serialized xterm content for headless backend restore)',
  });

  // ── Screen ─────────────────────────────────────────────────
  system.screen('TerminalPanel', {
    displays: ['TerminalSessionView'],
    triggers: [SpawnPty, WritePty, ResizePty, KillPty, RenamePty],
    description:
      'TerminalPanel.tsx — tab bar with "+" button, shell picker dropdown, xterm.js instances, resize observer',
  });

  // ── Read Models ────────────────────────────────────────────
  system.readModel('TerminalSessionView', {
    from: [PtySpawned, PtyExited, PtyError, PtySessionsListed, PtyRestored],
    fields: {
      tabs: 'TerminalTab[]', // id, label, cwd, alive, shell, projectId
      activeTabId: 'string?',
      sessionsChecked: 'boolean',
    },
    description:
      'terminal-store.ts Zustand store — tracks open tabs, alive/dead state, pending PTY data buffers',
  });

  // ── Automations ────────────────────────────────────────────
  system.automation('PersistSessionOnSpawn', {
    on: 'PtySpawned',
    triggers: 'SaveThreadEvent',
    description: 'Persist PTY session metadata to pty_sessions table (persistent backends only)',
  });

  system.automation('CleanupSessionOnExit', {
    on: 'PtyExited',
    triggers: 'SaveThreadEvent',
    description: 'Remove session from activeSessions map, clear scrollback buffer, delete from DB',
  });

  system.automation('BufferDataBeforeCallback', {
    on: 'PtyDataReceived',
    triggers: 'SaveThreadEvent',
    description:
      'If xterm callback not yet registered (lazy load), buffer data in pendingPtyData for replay',
  });

  system.automation('ReattachOnServerRestart', {
    on: 'PtySessionsListed',
    triggers: 'RestorePty',
    description:
      'On client reconnect, restore tabs from pty:sessions and trigger pty:restore for each alive session',
  });

  system.automation('BroadcastPtyData', {
    on: 'PtyDataReceived',
    triggers: 'BroadcastEvent',
    description:
      'Relay pty:data event to browser client via wsBroker.emitToUser() → Socket.IO room',
  });

  system.automation('BroadcastPtyExit', {
    on: 'PtyExited',
    triggers: 'BroadcastEvent',
    description: 'Relay pty:exit event to browser client so terminal tab shows dead state',
  });

  system.automation('BroadcastPtyError', {
    on: 'PtyError',
    triggers: 'BroadcastEvent',
    description: 'Relay pty:error event to browser client so terminal tab shows error',
  });

  system.automation('BroadcastPtyRestored', {
    on: 'PtyRestored',
    triggers: 'BroadcastEvent',
    description: 'Send serialized terminal state to reconnecting client via pty:data event',
  });

  system.automation('LoadSessionsOnStartup', {
    on: 'PtySessionsLoaded',
    triggers: 'RestorePty',
    description:
      'After loading sessions from DB on startup, call backend.reattach() for each — passes terminal_state for headless-xterm restore',
  });

  system.automation('SerializeStateOnShutdown', {
    on: 'TerminalStateSerialized',
    triggers: 'SaveThreadEvent',
    description:
      'On graceful shutdown, headless-xterm backend calls serializeAll(), saves each session terminal_state to pty_sessions table',
  });

  system.automation('CleanupOnDaemonSessionLoss', {
    on: 'StaleSessionsCleaned',
    triggers: 'SaveThreadEvent',
    description:
      'When daemon restart is detected (0 live sessions, N DB rows), remove all stale DB rows so clients see clean state',
  });

  system.automation('AdoptOrphanOnFirstRequest', {
    on: 'OrphanedSessionAdopted',
    triggers: 'SaveThreadEvent',
    description:
      'In runner mode, listActiveSessions() assigns requesting userId to sessions that have empty userId (reattached from daemon without DB)',
  });

  system.automation('BufferScrollbackOnData', {
    on: 'PtyDataReceived',
    triggers: 'SaveThreadEvent',
    description:
      'For non-persistent backends (bun-native, node-pty), append data to 128KB ring buffer for replay on reconnect via capturePane()',
  });

  // ══════════════════════════════════════════════════════════════
  // SEQUENCES (temporal flows)
  // ══════════════════════════════════════════════════════════════

  // Thread
  system.sequence(
    'Thread Happy Path',
    flow`${CreateThread} -> ${ThreadCreated} -> ${StartAgent} -> ${AgentStarted} -> ${AgentCompleted}`,
  );

  system.sequence(
    'Follow-up via Saga',
    flow`${AgentCompleted} -> ${SendFollowUp} -> ${StartAgent} -> ${AgentStarted} -> ${AgentCompleted}`,
  );

  system.sequence('Delete Thread', flow`${DeleteThread} -> ${ThreadDeleted}`);

  system.sequence('Stage Transition', flow`${ChangeStage} -> ${ThreadStageChanged}`);

  // Thread → DB → WebSocket → UI
  system.sequence(
    'Message Persistence Flow',
    flow`${AgentStarted} -> ${InsertMessage} -> ${MessagePersisted} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Tool Call Persistence Flow',
    flow`${AgentStarted} -> ${InsertToolCall} -> ${ToolCallPersisted} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Thread Creation Full Flow',
    flow`${CreateThread} -> ${ThreadCreated} -> ${SaveThreadEvent} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Agent Completion Full Flow',
    flow`${AgentCompleted} -> ${SaveThreadEvent} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  // Git
  system.sequence(
    'Stage and Commit',
    flow`${GitStage} -> ${GitStaged} -> ${GitCommit} -> ${GitCommitted}`,
  );

  system.sequence(
    'Commit triggers Pipeline Review',
    flow`${GitCommit} -> ${GitCommitted} -> ${StartPipelineReview}`,
  );

  system.sequence(
    'Full PR Flow',
    flow`${GitStage} -> ${GitStaged} -> ${GitCommit} -> ${GitCommitted} -> ${GitPush} -> ${GitPushed}`,
  );

  system.sequence('Agent triggers Git Status', flow`${AgentCompleted} -> ${EmitGitStatus}`);

  system.sequence(
    'Pull and Merge',
    flow`${GitPull} -> ${GitPulled} -> ${GitMerge} -> ${GitMerged}`,
  );

  // Terminal
  system.sequence(
    'Terminal Spawn Happy Path',
    flow`${SpawnPty} -> ${PtySpawned} -> ${PtyDataReceived}`,
  );

  system.sequence('Terminal Input Loop', flow`${WritePty} -> ${PtyDataReceived}`);

  system.sequence('Terminal Close', flow`${KillPty} -> ${PtyExited}`);

  system.sequence(
    'Terminal Restore on Reconnect',
    flow`${ListPtySessions} -> ${PtySessionsListed} -> ${RestorePty} -> ${PtyRestored} -> ${PtyDataReceived}`,
  );

  system.sequence('Terminal Spawn Error', flow`${SpawnPty} -> ${PtyError}`);

  // Terminal → DB → WebSocket → UI
  system.sequence(
    'Terminal Spawn Full Flow',
    flow`${SpawnPty} -> ${PtySpawned} -> ${SaveThreadEvent} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Terminal Data Broadcast Flow',
    flow`${WritePty} -> ${PtyDataReceived} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Terminal Exit Full Flow',
    flow`${KillPty} -> ${PtyExited} -> ${SaveThreadEvent} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Terminal Restore Full Flow',
    flow`${ListPtySessions} -> ${PtySessionsListed} -> ${RestorePty} -> ${PtyRestored} -> ${BroadcastEvent} -> ${EventBroadcasted}`,
  );

  system.sequence(
    'Terminal DB Load on Startup',
    flow`${LoadPtySessions} -> ${PtySessionsLoaded} -> ${RestorePty} -> ${PtyRestored}`,
  );

  system.sequence(
    'Terminal State Serialize on Shutdown',
    flow`${SerializeTerminalState} -> ${TerminalStateSerialized}`,
  );

  system.sequence(
    'Terminal Stale Session Cleanup',
    flow`${CleanupStaleSessions} -> ${StaleSessionsCleaned}`,
  );

  system.sequence(
    'Terminal Orphan Adoption (Runner Mode)',
    flow`${ListPtySessions} -> ${AdoptOrphanedSession} -> ${OrphanedSessionAdopted} -> ${PtySessionsListed}`,
  );

  // ══════════════════════════════════════════════════════════════
  // SLICES (vertical feature cuts)
  // ══════════════════════════════════════════════════════════════

  system.slice('Thread Management', {
    ui: 'ThreadView',
    commands: [
      CreateThread,
      StartAgent,
      StopAgent,
      SendFollowUp,
      ChangeStage,
      DeleteThread,
      InsertMessage,
      InsertToolCall,
      InsertComment,
      SaveThreadEvent,
      BroadcastEvent,
    ],
    events: [
      ThreadCreated,
      AgentStarted,
      AgentCompleted,
      ThreadStageChanged,
      ThreadDeleted,
      MessagePersisted,
      ToolCallPersisted,
      EventBroadcasted,
    ],
    readModels: ['ThreadListView', 'ActiveAgentView', 'MessageStreamView'],
    automations: [
      'TransitionStageOnAgentStart',
      'CommentOnAgentCompletion',
      'MemoryGCOnCompletion',
      'PersistMessageOnReceive',
      'PersistToolCallOnExecute',
      'BroadcastMessageToClients',
      'BroadcastToolCallToClients',
      'BroadcastThreadCreated',
      'BroadcastAgentStatus',
      'BroadcastAgentResult',
      'PersistThreadCreation',
      'PersistAgentCompletion',
    ],
    aggregates: ['Thread'],
    screens: ['Sidebar', 'ThreadView'],
    externals: ['ClaudeAgentSDK', 'Database', 'WebSocketBroker'],
    sagas: ['FollowUpQueueSaga'],
  });

  system.slice('Git Operations', {
    ui: 'ReviewPane',
    commands: [
      GitStage,
      GitUnstage,
      GitCommit,
      GitPush,
      GitRevert,
      GitPull,
      GitMerge,
      GitStash,
      GitStashPop,
      GitResetSoft,
    ],
    events: [
      GitChanged,
      GitStaged,
      GitUnstaged,
      GitCommitted,
      GitPushed,
      GitReverted,
      GitPulled,
      GitMerged,
      GitStashed,
      GitStashPopped,
      GitResetSoftDone,
    ],
    readModels: ['GitStatusView', 'CommitHistoryView'],
    automations: [
      'EmitGitStatusOnChange',
      'RefreshGitStatusOnAgentComplete',
      'PersistGitCommit',
      'PersistGitPush',
      'PersistGitMerge',
      'PersistGitStage',
      'PersistGitUnstage',
      'PersistGitRevert',
      'PersistGitPull',
      'PersistGitStash',
      'PersistGitStashPop',
      'PersistGitResetSoft',
    ],
    aggregates: ['GitRepository'],
    screens: ['ReviewPane'],
    externals: ['GitCLI', 'GitHubAPI'],
  });

  system.slice('Pipeline', {
    commands: [StartPipelineReview],
    events: [GitCommitted],
    automations: ['TriggerPipelineOnCommit'],
  });

  system.slice('Watcher Lifecycle', {
    commands: [StartGitWatcher, StopGitWatcher],
    events: [ThreadCreated, ThreadDeleted],
    automations: ['StartWatcherOnThreadCreated', 'StopWatcherOnThreadDeleted'],
    externals: ['FileSystemWatcher'],
  });

  system.slice('Terminal Management', {
    ui: 'TerminalPanel',
    commands: [
      SpawnPty,
      WritePty,
      ResizePty,
      KillPty,
      RestorePty,
      ListPtySessions,
      RenamePty,
      LoadPtySessions,
      SerializeTerminalState,
      CleanupStaleSessions,
      AdoptOrphanedSession,
      SaveThreadEvent,
      BroadcastEvent,
    ],
    events: [
      PtySpawned,
      PtyDataReceived,
      PtyExited,
      PtyError,
      PtyRestored,
      PtySessionsListed,
      PtySessionsLoaded,
      TerminalStateSerialized,
      StaleSessionsCleaned,
      OrphanedSessionAdopted,
      EventBroadcasted,
    ],
    readModels: ['TerminalSessionView'],
    automations: [
      'PersistSessionOnSpawn',
      'CleanupSessionOnExit',
      'BufferDataBeforeCallback',
      'ReattachOnServerRestart',
      'BroadcastPtyData',
      'BroadcastPtyExit',
      'BroadcastPtyError',
      'BroadcastPtyRestored',
      'LoadSessionsOnStartup',
      'SerializeStateOnShutdown',
      'CleanupOnDaemonSessionLoss',
      'AdoptOrphanOnFirstRequest',
      'BufferScrollbackOnData',
    ],
    aggregates: ['PtySession'],
    screens: ['TerminalPanel'],
    externals: ['ServerSocketProxy', 'PtySessionsDatabase', 'Database', 'WebSocketBroker'],
  });

  return system;
}

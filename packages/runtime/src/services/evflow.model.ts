/**
 * @domain subdomain: Shared Kernel
 * @domain type: event-model
 * @domain layer: domain
 *
 * Event Model for the funny runtime domain.
 *
 * Describes the full event-driven architecture of packages/runtime using
 * the evflow DSL: commands (user intents), events (facts), read models
 * (projections), automations (reactive handlers), sequences (temporal flows),
 * and slices (bounded contexts).
 *
 * This is a living specification — keep it in sync with thread-event-bus.ts
 * and handler-registry.ts.
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

  const _InsertComment = system.command('InsertComment', {
    actor: 'System',
    fields: { threadId: 'string', source: 'string', content: 'string' },
    description: 'Insert a system comment into a thread',
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

  const _InvalidateGitCache = system.command('InvalidateGitCache', {
    actor: 'System',
    fields: { projectId: 'string' },
    description: 'Invalidate the git status HTTP cache for a project',
  });

  const _SaveThreadEvent = system.command('SaveThreadEvent', {
    actor: 'System',
    fields: { threadId: 'string', type: 'string', data: 'string' },
    description: 'Persist a thread event to the database',
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

  // ══════════════════════════════════════════════════════════════
  // PIPELINE / CODE REVIEW
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

  const _RunMemoryGC = system.command('RunMemoryGC', {
    actor: 'System',
    fields: { projectId: 'string' },
    description: 'Trigger Paisley Park memory garbage collection',
  });

  // ══════════════════════════════════════════════════════════════
  // AUTOMATIONS (reactive handlers from handler-registry.ts)
  // ══════════════════════════════════════════════════════════════

  // Thread Management
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

  system.automation('DrainQueueOnCompletion', {
    on: 'AgentCompleted',
    triggers: 'StartAgent',
    description: 'Auto-sends the next queued message when agent completes (queue follow-up mode)',
  });

  // Git Operations
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

  // Git Event Persistence (one per git event type)
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

  // Pipeline
  system.automation('TriggerPipelineOnCommit', {
    on: 'GitCommitted',
    triggers: 'StartPipelineReview',
    description:
      'Starts pipeline code review when a commit is created (if pipeline enabled, not a pipeline commit)',
  });

  // Watcher Lifecycle
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

  // Memory
  system.automation('MemoryGCOnCompletion', {
    on: 'AgentCompleted',
    triggers: 'RunMemoryGC',
    description: 'Trigger memory garbage collection after N thread completions',
  });

  // ══════════════════════════════════════════════════════════════
  // READ MODELS (client-side projections)
  // ══════════════════════════════════════════════════════════════

  system.readModel('ThreadListView', {
    from: ['ThreadCreated', 'ThreadStageChanged', 'ThreadDeleted', 'AgentCompleted'],
    fields: {
      threads: 'Thread[]',
      activeCount: 'number',
      totalCost: 'decimal',
    },
    description: 'Client-side thread list with status badges and cost tracking',
  });

  system.readModel('ActiveAgentView', {
    from: ['AgentStarted', 'AgentCompleted'],
    fields: {
      runningAgents: 'string[]',
      isRunning: 'boolean',
    },
    description: 'Which agents are currently running (for stop button, status indicators)',
  });

  system.readModel('GitStatusView', {
    from: [
      'GitChanged',
      'GitStaged',
      'GitUnstaged',
      'GitCommitted',
      'GitReverted',
      'GitPulled',
      'GitResetSoftDone',
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
    from: ['GitCommitted', 'GitPushed', 'GitMerged'],
    fields: {
      commits: 'Commit[]',
      isPushed: 'boolean',
      isMerged: 'boolean',
    },
    description: 'Commit log and push/merge state in the ReviewPane',
  });

  // ══════════════════════════════════════════════════════════════
  // SEQUENCES (temporal flows)
  // ══════════════════════════════════════════════════════════════

  system.sequence(
    'Thread Happy Path',
    flow`${CreateThread} -> ${ThreadCreated} -> ${StartAgent} -> ${AgentStarted} -> ${AgentCompleted}`,
  );

  system.sequence(
    'Follow-up Message',
    flow`${AgentCompleted} -> ${SendFollowUp} -> ${StartAgent} -> ${AgentStarted} -> ${AgentCompleted}`,
  );

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

  // ══════════════════════════════════════════════════════════════
  // SLICES (bounded contexts)
  // ══════════════════════════════════════════════════════════════

  system.slice('Thread Management', {
    ui: 'ThreadView',
    commands: [CreateThread, StartAgent, StopAgent, SendFollowUp, ChangeStage, DeleteThread],
    events: [ThreadCreated, AgentStarted, AgentCompleted, ThreadStageChanged, ThreadDeleted],
    readModels: ['ThreadListView', 'ActiveAgentView'],
    automations: [
      'TransitionStageOnAgentStart',
      'CommentOnAgentCompletion',
      'DrainQueueOnCompletion',
    ],
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
  });

  return system;
}

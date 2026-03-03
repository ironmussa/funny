/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created, thread:stage-changed, thread:deleted
 * @domain depends: ThreadRepository, AgentRunner, WorktreeManager, WSBroker
 */

import {
  createWorktree,
  removeWorktree,
  removeBranch,
  getCurrentBranch,
  git,
} from '@funny/core/git';
import { setupWorktree, type SetupProgressFn } from '@funny/core/ports';
import type { WSEvent, AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { augmentPromptWithFiles } from '../utils/file-mentions.js';
import { startAgent, stopAgent, isAgentRunning, cleanupThreadState } from './agent-runner.js';
import { stopCommandsByCwd } from './command-runner.js';
import { cleanupExternalThread } from './ingest-mapper.js';
import * as mq from './message-queue.js';
import * as pm from './project-manager.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import { wsBroker } from './ws-broker.js';

// ── Error type ──────────────────────────────────────────────────

export class ThreadServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Create a URL-safe slug from a title for branch naming */
export function slugifyTitle(title: string, maxLength = 40): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, maxLength)
      .replace(/-$/, '') || 'thread'
  );
}

function createSetupProgressEmitter(userId: string, threadId: string): SetupProgressFn {
  return (step, label, status, error) => {
    wsBroker.emitToUser(userId, {
      type: 'worktree:setup',
      threadId,
      data: { step, label, status, error },
    });
  };
}

function emitThreadUpdated(userId: string, threadId: string, data: Record<string, any>): void {
  wsBroker.emitToUser(userId, {
    type: 'thread:updated',
    threadId,
    data,
  } as WSEvent);
}

function emitAgentFailed(userId: string, threadId: string): void {
  const event = {
    type: 'agent:status' as const,
    threadId,
    data: { status: 'failed' },
  };
  if (userId && userId !== '__local__') {
    wsBroker.emitToUser(userId, event);
  } else {
    wsBroker.emit(event);
  }
}

// ── Create Idle Thread ──────────────────────────────────────────

export interface CreateIdleThreadParams {
  projectId: string;
  userId: string;
  title: string;
  mode: 'local' | 'worktree';
  source?: string;
  baseBranch?: string;
  prompt?: string;
  images?: string[];
  stage?: 'backlog' | 'planning';
}

export async function createIdleThread(params: CreateIdleThreadParams) {
  const project = pm.getProject(params.projectId);
  if (!project) throw new ThreadServiceError('Project not found', 404);

  const threadId = nanoid();
  const resolvedBaseBranch = params.baseBranch?.trim() || undefined;
  let branch: string | undefined;
  let baseBranch: string | undefined;

  if (params.mode === 'worktree') {
    const slug = slugifyTitle(params.title);
    const projectSlug = slugifyTitle(project.name);
    branch = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;
    baseBranch = resolvedBaseBranch;
  } else {
    const branchResult = await getCurrentBranch(project.path);
    if (branchResult.isOk()) branch = branchResult.value;
    baseBranch = resolvedBaseBranch || branch;
  }

  const thread = {
    id: threadId,
    projectId: params.projectId,
    userId: params.userId,
    title: params.title,
    mode: params.mode,
    provider: 'claude' as const,
    permissionMode: 'autoEdit' as const,
    model: 'sonnet' as const,
    source: params.source || 'web',
    status: 'idle' as const,
    stage: (params.stage || 'backlog') as 'backlog' | 'planning',
    branch,
    baseBranch,
    worktreePath: undefined as string | undefined,
    initialPrompt: params.prompt,
    cost: 0,
    createdAt: new Date().toISOString(),
    createdBy: params.userId,
  };

  tm.createThread(thread);

  if (params.prompt) {
    tm.insertMessage({
      threadId,
      role: 'user',
      content: params.prompt,
      images: params.images?.length ? JSON.stringify(params.images) : null,
    });
  }

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: params.projectId,
    userId: params.userId,
    cwd: project.path,
    worktreePath: null,
    stage: thread.stage,
    status: 'idle',
    initialPrompt: params.prompt,
  });

  return thread;
}

// ── Create and Start Thread ─────────────────────────────────────

export interface CreateAndStartThreadParams {
  projectId: string;
  userId: string;
  title?: string;
  mode: 'local' | 'worktree';
  provider?: string;
  model?: string;
  permissionMode?: string;
  source?: string;
  baseBranch?: string;
  prompt: string;
  images?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: string[];
  worktreePath?: string;
  parentThreadId?: string;
}

export async function createAndStartThread(params: CreateAndStartThreadParams) {
  const project = pm.getProject(params.projectId);
  if (!project) throw new ThreadServiceError('Project not found', 404);

  const threadId = nanoid();
  const resolvedBaseBranch = params.baseBranch?.trim() || undefined;

  // Resolve defaults: explicit value > project default > hardcoded fallback
  const resolvedProvider = (params.provider ||
    project.defaultProvider ||
    'claude') as AgentProvider;
  const resolvedModel = (params.model || project.defaultModel || 'sonnet') as AgentModel;
  const resolvedPermissionMode = (params.permissionMode ||
    project.defaultPermissionMode ||
    'autoEdit') as PermissionMode;

  const emitSetupProgress = createSetupProgressEmitter(params.userId, threadId);

  // ── Worktree mode (new worktree) ──────────────────────────────
  if (params.mode === 'worktree' && !params.worktreePath) {
    const slug = slugifyTitle(params.title || params.prompt);
    const projectSlug = slugifyTitle(project.name);
    const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;

    const thread = {
      id: threadId,
      projectId: params.projectId,
      userId: params.userId,
      title: params.title || params.prompt,
      mode: params.mode,
      provider: resolvedProvider,
      permissionMode: resolvedPermissionMode,
      model: resolvedModel,
      source: params.source || 'web',
      status: 'setting_up' as const,
      branch: branchName,
      baseBranch: resolvedBaseBranch,
      worktreePath: undefined as string | undefined,
      parentThreadId: params.parentThreadId,
      cost: 0,
      createdAt: new Date().toISOString(),
      createdBy: params.userId,
    };

    tm.createThread(thread);

    if (params.prompt) {
      // Augment prompt with file contents so the stored message includes <referenced-files> XML
      const storedContent = await augmentPromptWithFiles(
        params.prompt,
        params.fileReferences,
        project.path,
      );
      tm.insertMessage({
        threadId,
        role: 'user',
        content: storedContent,
        images: params.images?.length ? JSON.stringify(params.images) : null,
      });
    }

    threadEventBus.emit('thread:created', {
      threadId,
      projectId: params.projectId,
      userId: params.userId,
      cwd: project.path,
      worktreePath: null,
      stage: 'in_progress' as const,
      status: 'setting_up',
    });

    // Background: create worktree, run post-create commands, start agent
    (async () => {
      try {
        const wtResult = await createWorktree(
          project.path,
          branchName,
          resolvedBaseBranch,
          emitSetupProgress,
        );
        if (wtResult.isErr()) {
          tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(params.userId, threadId, { status: 'failed' });
          return;
        }
        const wtPath = wtResult.value;

        try {
          const setup = await setupWorktree(project.path, wtPath, emitSetupProgress);
          if (setup.postCreateErrors.length) {
            log.warn('Worktree postCreate errors', { threadId, errors: setup.postCreateErrors });
          }
        } catch (err) {
          log.warn('Failed to setup worktree', { threadId, error: String(err) });
        }

        // Update thread with worktree info and transition to pending
        tm.updateThread(threadId, { worktreePath: wtPath, status: 'pending' });
        wsBroker.emitToUser(params.userId, {
          type: 'worktree:setup_complete',
          threadId,
          data: { branch: branchName, worktreePath: wtPath },
        } as WSEvent);
        emitThreadUpdated(params.userId, threadId, {
          status: 'pending',
          branch: branchName,
          worktreePath: wtPath,
        });

        // Start agent
        const augmentedPrompt = await augmentPromptWithFiles(
          params.prompt,
          params.fileReferences,
          wtPath,
        );
        try {
          await startAgent(
            threadId,
            augmentedPrompt,
            wtPath,
            resolvedModel,
            resolvedPermissionMode,
            params.images,
            params.disallowedTools,
            params.allowedTools,
            resolvedProvider,
            undefined,
            true, // skipMessageInsert — already inserted at thread creation
          );
        } catch (err: any) {
          log.error('Failed to start agent after worktree setup', { threadId, error: err });
          tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(params.userId, threadId, { status: 'failed' });
        }
      } catch (err) {
        log.error('Background worktree setup failed', { threadId, error: String(err) });
        tm.updateThread(threadId, { status: 'failed' });
        emitThreadUpdated(params.userId, threadId, { status: 'failed' });
      }
    })();

    return thread;
  }

  // ── Non-worktree paths (local mode, or reusing an existing worktree) ──
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;

  if (params.worktreePath) {
    worktreePath = params.worktreePath;
    const branchResult = await getCurrentBranch(params.worktreePath);
    if (branchResult.isOk()) threadBranch = branchResult.value;
  } else {
    const branchResult = await getCurrentBranch(project.path);
    if (branchResult.isOk()) {
      threadBranch = branchResult.value;

      if (resolvedBaseBranch && resolvedBaseBranch !== threadBranch) {
        // Switch to the requested branch — git checkout handles both local
        // and remote-only branches (auto-creates tracking branch from origin).
        const checkoutResult = await git(['checkout', resolvedBaseBranch], project.path);
        if (checkoutResult.isErr()) {
          throw new ThreadServiceError(
            `Failed to checkout branch "${resolvedBaseBranch}": ${checkoutResult.error.message}`,
            400,
          );
        }
        threadBranch = resolvedBaseBranch;
      }
    }
  }

  const thread = {
    id: threadId,
    projectId: params.projectId,
    userId: params.userId,
    title: params.title || params.prompt,
    mode: params.mode,
    provider: resolvedProvider,
    permissionMode: resolvedPermissionMode,
    model: resolvedModel,
    source: params.source || 'web',
    status: 'pending' as const,
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (params.mode === 'local' ? threadBranch : undefined),
    worktreePath,
    parentThreadId: params.parentThreadId,
    cost: 0,
    createdAt: new Date().toISOString(),
    createdBy: params.userId,
  };

  tm.createThread(thread);

  const cwd = worktreePath ?? project.path;

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: params.projectId,
    userId: params.userId,
    cwd,
    worktreePath: worktreePath ?? null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  // Augment prompt with file contents if file references were provided
  const augmentedPrompt = await augmentPromptWithFiles(params.prompt, params.fileReferences, cwd);

  // Start agent (throws on failure — caller handles HTTP error response)
  await startAgent(
    threadId,
    augmentedPrompt,
    cwd,
    resolvedModel,
    resolvedPermissionMode,
    params.images,
    params.disallowedTools,
    params.allowedTools,
    resolvedProvider,
  );

  return thread;
}

// ── Send Message / Follow-Up ────────────────────────────────────

export interface SendMessageParams {
  threadId: string;
  userId: string;
  content: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  images?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: string[];
  baseBranch?: string;
}

export interface SendMessageResult {
  ok: true;
  queued?: boolean;
  queuedCount?: number;
  queuedMessageId?: string;
}

export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const thread = tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) throw new ThreadServiceError('Project path not found', 404);

  const effectiveProvider = (params.provider || thread.provider || 'claude') as AgentProvider;
  const effectiveModel = (params.model || thread.model || 'sonnet') as AgentModel;
  const effectivePermission = (params.permissionMode ||
    thread.permissionMode ||
    'autoEdit') as PermissionMode;

  // Update thread's permission mode, model, and baseBranch if they changed
  const updates: Record<string, any> = {};
  if (params.permissionMode && params.permissionMode !== thread.permissionMode) {
    updates.permissionMode = params.permissionMode;
  }
  if (params.model && params.model !== thread.model) {
    updates.model = params.model;
  }
  if (params.baseBranch && params.baseBranch !== thread.baseBranch) {
    updates.baseBranch = params.baseBranch;
  }
  if (Object.keys(updates).length > 0) {
    tm.updateThread(params.threadId, updates);
  }

  // Auto-move idle backlog threads to in_progress when a message is sent
  let hasDraftMessage = false;
  if (thread.status === 'idle' && thread.stage === 'backlog') {
    const stageUpdates: Record<string, any> = { stage: 'in_progress' };
    if (thread.initialPrompt && params.content !== thread.initialPrompt) {
      stageUpdates.title = params.content.slice(0, 200);
      stageUpdates.initialPrompt = params.content;
    }
    tm.updateThread(params.threadId, stageUpdates);

    const { messages: draftMessages } = tm.getThreadMessages({
      threadId: params.threadId,
      limit: 1,
    });
    const draftMsg = draftMessages[0];
    if (draftMsg && draftMsg.role === 'user') {
      tm.updateMessage(draftMsg.id, {
        content: params.content,
        images: params.images?.length ? JSON.stringify(params.images) : null,
      });
      hasDraftMessage = true;
    }
  }

  // If the thread was waiting for user input, persist the answer in tool call output
  if (thread.status === 'waiting') {
    const pendingTC = tm.findLastUnansweredInteractiveToolCall(params.threadId);
    if (pendingTC) {
      tm.updateToolCallOutput(pendingTC.id, params.content);
    }
  }

  // Augment prompt with file contents
  const augmentedContent = await augmentPromptWithFiles(params.content, params.fileReferences, cwd);

  // Check if the agent is running and the project uses queue mode
  const agentRunning = isAgentRunning(params.threadId);
  const project = pm.getProject(thread.projectId);
  const followUpMode = project?.followUpMode || 'interrupt';

  if (agentRunning && followUpMode === 'queue') {
    const queued = mq.enqueue(params.threadId, {
      content: augmentedContent,
      provider: effectiveProvider,
      model: effectiveModel,
      permissionMode: effectivePermission,
      images: params.images ? JSON.stringify(params.images) : undefined,
      allowedTools: params.allowedTools ? JSON.stringify(params.allowedTools) : undefined,
      disallowedTools: params.disallowedTools ? JSON.stringify(params.disallowedTools) : undefined,
      fileReferences: params.fileReferences ? JSON.stringify(params.fileReferences) : undefined,
    });

    tm.insertMessage({
      threadId: params.threadId,
      role: 'user',
      content: augmentedContent,
      images: params.images ? JSON.stringify(params.images) : null,
      model: effectiveModel,
      permissionMode: effectivePermission,
    });

    const qCount = mq.queueCount(params.threadId);
    const nextMsg = mq.peek(params.threadId);
    const queueEvent = {
      type: 'thread:queue_update' as const,
      threadId: params.threadId,
      data: {
        threadId: params.threadId,
        queuedCount: qCount,
        nextMessage: nextMsg?.content?.slice(0, 100),
      },
    } as WSEvent;
    if (thread.userId) {
      wsBroker.emitToUser(thread.userId, queueEvent);
    } else {
      wsBroker.emit(queueEvent);
    }

    return { ok: true, queued: true, queuedCount: qCount, queuedMessageId: queued.id };
  }

  // When sending to an idle thread that had a draft, update draft with augmented content
  if (hasDraftMessage) {
    const { messages: draftMsgs } = tm.getThreadMessages({ threadId: params.threadId, limit: 1 });
    if (draftMsgs[0]) {
      tm.updateMessage(draftMsgs[0].id, { content: augmentedContent });
    }
  }

  // Default interrupt behavior — start agent (throws on failure)
  await startAgent(
    params.threadId,
    augmentedContent,
    cwd,
    effectiveModel,
    effectivePermission,
    params.images,
    params.disallowedTools,
    params.allowedTools,
    effectiveProvider,
    undefined,
    hasDraftMessage, // skipMessageInsert — draft already exists
  );

  return { ok: true };
}

// ── Stop Thread ─────────────────────────────────────────────────

export async function stopThread(threadId: string): Promise<void> {
  const thread = tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);
  if (thread.provider === 'external') {
    cleanupExternalThread(threadId);
    return;
  }
  await stopAgent(threadId);
}

// ── Approve / Deny Tool ─────────────────────────────────────────

export interface ApproveToolParams {
  threadId: string;
  userId: string;
  toolName: string;
  approved: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export async function approveToolCall(params: ApproveToolParams): Promise<void> {
  const thread = tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) throw new ThreadServiceError('Project path not found', 404);

  const tools = params.allowedTools
    ? [...params.allowedTools]
    : [
        'Read',
        'Edit',
        'Write',
        'Bash',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TodoWrite',
        'NotebookEdit',
      ];

  const threadProvider = (thread.provider || 'claude') as AgentProvider;

  if (params.approved) {
    if (!tools.includes(params.toolName)) {
      tools.push(params.toolName);
    }
    const disallowed = params.disallowedTools?.filter((t) => t !== params.toolName);
    const message = `The user has approved the use of ${params.toolName}. Please proceed with using it.`;
    await startAgent(
      params.threadId,
      message,
      cwd,
      (thread.model as AgentModel) || 'sonnet',
      (thread.permissionMode as PermissionMode) || 'autoEdit',
      undefined,
      disallowed,
      tools,
      threadProvider,
    );
  } else {
    const message = `The user denied permission to use ${params.toolName}. Please continue without it.`;
    await startAgent(
      params.threadId,
      message,
      cwd,
      (thread.model as AgentModel) || 'sonnet',
      (thread.permissionMode as PermissionMode) || 'autoEdit',
      undefined,
      params.disallowedTools,
      params.allowedTools,
      threadProvider,
    );
  }
}

// ── Update Thread (stage transitions, archive) ──────────────────

export interface UpdateThreadParams {
  threadId: string;
  userId: string;
  archived?: boolean;
  pinned?: boolean;
  stage?: string;
}

export async function updateThread(params: UpdateThreadParams) {
  const thread = tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  const updates: Record<string, any> = {};
  if (params.archived !== undefined) {
    updates.archived = params.archived ? 1 : 0;
  }
  if (params.pinned !== undefined) {
    updates.pinned = params.pinned ? 1 : 0;
  }
  if (params.stage !== undefined) {
    updates.stage = params.stage;
  }

  const fromStage = thread.stage;

  // Cleanup worktree + branch when archiving
  if (
    params.archived &&
    thread.worktreePath &&
    thread.mode === 'worktree' &&
    thread.provider !== 'external'
  ) {
    const project = pm.getProject(thread.projectId);
    if (project) {
      await stopCommandsByCwd(thread.worktreePath).catch(() => {});
      await removeWorktree(project.path, thread.worktreePath).catch((e) => {
        log.warn('Failed to remove worktree', { namespace: 'cleanup', error: String(e) });
      });
      if (thread.branch) {
        await removeBranch(project.path, thread.branch).catch((e) => {
          log.warn('Failed to remove branch', { namespace: 'cleanup', error: String(e) });
        });
      }
    }
    updates.worktreePath = null;
    updates.branch = null;
    mq.clearQueue(params.threadId);
    cleanupThreadState(params.threadId);
  }

  if (Object.keys(updates).length > 0) {
    tm.updateThread(params.threadId, updates);
  }

  // Emit stage-changed events
  const project = pm.getProject(thread.projectId);
  const eventCtx = {
    threadId: params.threadId,
    projectId: thread.projectId,
    userId: thread.userId,
    worktreePath: thread.worktreePath ?? null,
    cwd: thread.worktreePath ?? project?.path ?? '',
  };
  if (params.archived) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: 'archived',
    });
  } else if (params.stage && params.stage !== fromStage) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: params.stage as any,
    });
  }

  // Auto-start agent when idle thread is moved to in_progress
  if (params.stage === 'in_progress' && thread.status === 'idle' && thread.initialPrompt) {
    if (project) {
      await autoStartIdleThread(params.threadId, thread, project);
    }
  }

  return tm.getThread(params.threadId);
}

// ── Auto-start idle thread ──────────────────────────────────────

async function autoStartIdleThread(
  threadId: string,
  thread: NonNullable<ReturnType<typeof tm.getThread>>,
  project: NonNullable<ReturnType<typeof pm.getProject>>,
): Promise<void> {
  const needsWorktreeSetup = thread.mode === 'worktree' && !thread.worktreePath && thread.branch;

  if (needsWorktreeSetup) {
    // Deferred worktree setup: create worktree first, then start agent
    tm.updateThread(threadId, { status: 'setting_up' });
    const emitSetupProgress = createSetupProgressEmitter(thread.userId, threadId);
    emitThreadUpdated(thread.userId, threadId, { status: 'setting_up', stage: 'in_progress' });

    // Background: create worktree, run post-create, then start agent
    (async () => {
      try {
        const wtResult = await createWorktree(
          project.path,
          thread.branch!,
          thread.baseBranch || undefined,
          emitSetupProgress,
        );
        if (wtResult.isErr()) {
          tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(thread.userId, threadId, { status: 'failed' });
          return;
        }
        const wtPath = wtResult.value;

        try {
          const setup = await setupWorktree(project.path, wtPath, emitSetupProgress);
          if (setup.postCreateErrors.length) {
            log.warn('Worktree postCreate errors', { threadId, errors: setup.postCreateErrors });
          }
        } catch (err) {
          log.warn('Failed to setup worktree', { threadId, error: String(err) });
        }

        // Update thread with worktree info
        tm.updateThread(threadId, { worktreePath: wtPath, status: 'pending' });
        wsBroker.emitToUser(thread.userId, {
          type: 'worktree:setup_complete',
          threadId,
          data: { branch: thread.branch, worktreePath: wtPath },
        } as WSEvent);
        emitThreadUpdated(thread.userId, threadId, {
          status: 'pending',
          branch: thread.branch,
          worktreePath: wtPath,
        });

        // Start agent
        const { messages: draftMessages } = tm.getThreadMessages({ threadId, limit: 1 });
        const draftMsg = draftMessages[0];
        const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
        await startAgent(
          threadId,
          thread.initialPrompt!,
          wtPath,
          (thread.model || project.defaultModel || 'sonnet') as AgentModel,
          (thread.permissionMode || 'autoEdit') as PermissionMode,
          draftImages,
          undefined,
          undefined,
          (thread.provider || project.defaultProvider || 'claude') as AgentProvider,
          undefined,
          !!draftMsg,
        );
      } catch (err) {
        log.error('Failed to setup worktree and start agent', {
          namespace: 'agent',
          threadId,
          error: err,
        });
        tm.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
        emitAgentFailed(thread.userId, threadId);
      }
    })();
  } else {
    // Worktree already exists or local mode: start agent directly
    const cwd = thread.worktreePath || project.path;
    const { messages: draftMessages } = tm.getThreadMessages({ threadId, limit: 1 });
    const draftMsg = draftMessages[0];
    const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
    startAgent(
      threadId,
      thread.initialPrompt!,
      cwd,
      (thread.model || project.defaultModel || 'sonnet') as AgentModel,
      (thread.permissionMode || 'autoEdit') as PermissionMode,
      draftImages,
      undefined,
      undefined,
      (thread.provider || project.defaultProvider || 'claude') as AgentProvider,
      undefined,
      !!draftMsg,
    ).catch((err) => {
      log.error('Failed to auto-start agent for idle thread', {
        namespace: 'agent',
        threadId,
        error: err,
      });
      tm.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
      emitAgentFailed(thread.userId, threadId);
    });
  }
}

// ── Delete Thread ───────────────────────────────────────────────

export async function deleteThread(threadId: string): Promise<void> {
  const thread = tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  threadEventBus.emit('thread:deleted', {
    threadId,
    projectId: thread.projectId,
    userId: thread.userId,
    worktreePath: thread.worktreePath ?? null,
  });

  if (isAgentRunning(threadId)) {
    try {
      await stopAgent(threadId);
    } catch (err) {
      log.error('Failed to stop agent', { namespace: 'agent', threadId, error: err });
    }
  }

  // Only remove worktree/branch for worktree-mode threads
  if (thread.worktreePath && thread.mode === 'worktree' && thread.provider !== 'external') {
    await stopCommandsByCwd(thread.worktreePath).catch(() => {});

    const project = pm.getProject(thread.projectId);
    if (project) {
      await removeWorktree(project.path, thread.worktreePath).catch((e) => {
        log.warn('Failed to remove worktree', { namespace: 'cleanup', error: String(e) });
      });
      if (thread.branch) {
        await removeBranch(project.path, thread.branch).catch((e) => {
          log.warn('Failed to remove branch', { namespace: 'cleanup', error: String(e) });
        });
      }
    }
  }

  mq.clearQueue(threadId);
  cleanupThreadState(threadId);
  tm.deleteThread(threadId);
}

// ── Queue Operations ────────────────────────────────────────────

export function cancelQueuedMessage(threadId: string, messageId: string): { queuedCount: number } {
  const cancelled = mq.cancel(messageId);
  if (!cancelled) throw new ThreadServiceError('Queued message not found', 404);

  const thread = tm.getThread(threadId);
  const qCount = mq.queueCount(threadId);
  const nextMsg = mq.peek(threadId);

  const queueEvent = {
    type: 'thread:queue_update' as const,
    threadId,
    data: { threadId, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
  } as WSEvent;
  if (thread?.userId) {
    wsBroker.emitToUser(thread.userId, queueEvent);
  } else {
    wsBroker.emit(queueEvent);
  }

  return { queuedCount: qCount };
}

// ── Comment Operations ──────────────────────────────────────────

export function deleteComment(threadId: string, commentId: string): void {
  const thread = tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  tm.deleteComment(commentId);

  const event = {
    type: 'thread:comment_deleted' as const,
    threadId,
    data: { commentId },
  };
  if (thread.userId && thread.userId !== '__local__') {
    wsBroker.emitToUser(thread.userId, event);
  } else {
    wsBroker.emit(event);
  }
}

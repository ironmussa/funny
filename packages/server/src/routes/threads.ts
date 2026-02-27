import { createWorktree, removeWorktree, removeBranch, getCurrentBranch } from '@funny/core/git';
import type { WSEvent } from '@funny/shared';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import {
  startAgent,
  stopAgent,
  isAgentRunning,
  cleanupThreadState,
} from '../services/agent-runner.js';
import { cleanupExternalThread } from '../services/ingest-mapper.js';
import * as mq from '../services/message-queue.js';
import * as pm from '../services/project-manager.js';
import { threadEventBus } from '../services/thread-event-bus.js';
import { getThreadEvents } from '../services/thread-event-service.js';
import * as tm from '../services/thread-manager.js';
import { wsBroker } from '../services/ws-broker.js';
import type { HonoEnv } from '../types/hono-env.js';
import { augmentPromptWithFiles } from '../utils/file-mentions.js';
import { resultToResponse } from '../utils/result-response.js';
import {
  requireThread,
  requireThreadWithMessages,
  requireProject,
} from '../utils/route-helpers.js';
import {
  createThreadSchema,
  createIdleThreadSchema,
  sendMessageSchema,
  updateThreadSchema,
  approveToolSchema,
  validate,
} from '../validation/schemas.js';

export const threadRoutes = new Hono<HonoEnv>();

/** Create a URL-safe slug from a title for branch naming */
function slugifyTitle(title: string, maxLength = 40): string {
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

// GET /api/threads?projectId=xxx&includeArchived=true
threadRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const threads = tm.listThreads({ projectId: projectId || undefined, userId, includeArchived });
  return c.json(threads);
});

// GET /api/threads/archived?page=1&limit=100&search=xxx
threadRoutes.get('/archived', (c) => {
  const userId = c.get('userId') as string;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
  const search = c.req.query('search')?.trim() || '';

  const { threads, total } = tm.listArchivedThreads({ page, limit, search, userId });
  return c.json({ threads, total, page, limit });
});

// GET /api/threads/search/content?q=xxx&projectId=xxx
threadRoutes.get('/search/content', (c) => {
  const userId = c.get('userId') as string;
  const q = c.req.query('q')?.trim() || '';
  const projectId = c.req.query('projectId');
  if (!q) return c.json({ threadIds: [], snippets: {} });
  const matches = tm.searchThreadIdsByContent({
    query: q,
    projectId: projectId || undefined,
    userId,
  });
  return c.json({ threadIds: [...matches.keys()], snippets: Object.fromEntries(matches) });
});

// GET /api/threads/:id?messageLimit=50
threadRoutes.get('/:id', (c) => {
  const userId = c.get('userId') as string;
  const messageLimitParam = c.req.query('messageLimit');
  const _messageLimit = messageLimitParam
    ? Math.min(200, Math.max(1, parseInt(messageLimitParam, 10)))
    : undefined;
  const threadResult = requireThreadWithMessages(c.req.param('id'), userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(threadResult.value);
});

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50
threadRoutes.get('/:id/messages', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '50', 10)));

  const result = tm.getThreadMessages({ threadId: id, cursor: cursor || undefined, limit });
  return c.json(result);
});

// GET /api/threads/:id/events — get all events for a thread
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const events = await getThreadEvents(id);
  return c.json({ events });
});

// POST /api/threads/idle
threadRoutes.post('/idle', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createIdleThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, title, mode, source, baseBranch, prompt, images, stage } = parsed.value;

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const threadId = nanoid();
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;

  // Create worktree if needed
  const resolvedBaseBranch = baseBranch?.trim() || undefined;
  if (mode === 'worktree') {
    const slug = slugifyTitle(title);
    const projectSlug = slugifyTitle(project.name);
    const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;
    const wtResult = await createWorktree(project.path, branchName, resolvedBaseBranch);
    if (wtResult.isErr()) {
      return c.json({ error: `Failed to create worktree: ${wtResult.error.message}` }, 500);
    }
    worktreePath = wtResult.value;
    threadBranch = branchName;
  } else {
    // Local mode: detect the current branch of the project
    const branchResult = await getCurrentBranch(project.path);
    if (branchResult.isOk()) {
      threadBranch = branchResult.value;
    }
  }

  const userId = c.get('userId') as string;
  const thread = {
    id: threadId,
    projectId,
    userId,
    title,
    mode,
    provider: 'claude' as const,
    permissionMode: 'autoEdit' as const,
    model: 'sonnet' as const,
    source: source || 'web',
    status: 'idle' as const,
    stage: (stage || 'backlog') as 'backlog' | 'planning',
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (mode === 'local' ? threadBranch : undefined),
    worktreePath,
    initialPrompt: prompt,
    cost: 0,
    createdAt: new Date().toISOString(),
    createdBy: userId, // Track who created this thread
  };

  tm.createThread(thread);

  // Create a draft user message so prompt+images survive page refresh
  if (prompt) {
    tm.insertMessage({
      threadId,
      role: 'user',
      content: prompt,
      images: images?.length ? JSON.stringify(images) : null,
    });
  }

  threadEventBus.emit('thread:created', {
    threadId,
    projectId,
    userId,
    cwd: worktreePath ?? project.path,
    worktreePath: worktreePath ?? null,
    stage: 'backlog',
    status: 'idle',
    initialPrompt: prompt,
  });

  return c.json(thread, 201);
});

// POST /api/threads
threadRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const {
    projectId,
    title,
    mode,
    provider,
    model,
    permissionMode,
    source,
    baseBranch,
    prompt,
    images,
    allowedTools,
    disallowedTools,
    fileReferences,
    worktreePath: requestWorktreePath,
    parentThreadId,
  } = parsed.value;

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const threadId = nanoid();
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;

  // Create worktree if needed
  const resolvedBaseBranch = baseBranch?.trim() || undefined;
  if (mode === 'worktree') {
    const slug = slugifyTitle(title || prompt);
    const projectSlug = slugifyTitle(project.name);
    const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;
    const wtResult = await createWorktree(project.path, branchName, resolvedBaseBranch);
    if (wtResult.isErr()) {
      return c.json({ error: `Failed to create worktree: ${wtResult.error.message}` }, 500);
    }
    worktreePath = wtResult.value;
    threadBranch = branchName;
  } else if (requestWorktreePath) {
    // Local mode reusing an existing worktree directory (e.g. conflict resolution)
    worktreePath = requestWorktreePath;
    const branchResult = await getCurrentBranch(requestWorktreePath);
    if (branchResult.isOk()) {
      threadBranch = branchResult.value;
    }
  } else {
    // Local mode: detect the current branch of the project
    const branchResult = await getCurrentBranch(project.path);
    if (branchResult.isOk()) {
      threadBranch = branchResult.value;

      // If a specific branch was requested in local mode, validate it matches the current branch
      if (resolvedBaseBranch && resolvedBaseBranch !== threadBranch) {
        return c.json(
          {
            error: `Cannot create local thread on branch "${resolvedBaseBranch}". Current branch is "${threadBranch}". Enable "Create worktree" to work on a different branch.`,
          },
          400,
        );
      }
    }
  }

  const userId = c.get('userId') as string;
  // Resolve defaults: explicit value > project default > hardcoded fallback
  const resolvedProvider = provider || project.defaultProvider || 'claude';
  const resolvedModel = model || project.defaultModel || 'sonnet';
  const resolvedPermissionMode = permissionMode || project.defaultPermissionMode || 'autoEdit';
  const thread = {
    id: threadId,
    projectId,
    userId,
    title: title || prompt,
    mode,
    provider: resolvedProvider,
    permissionMode: resolvedPermissionMode,
    model: resolvedModel,
    source: source || 'web',
    status: 'pending' as const,
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (mode === 'local' ? threadBranch : undefined),
    worktreePath,
    parentThreadId,
    cost: 0,
    createdAt: new Date().toISOString(),
    createdBy: userId, // Thread creator is the authenticated user
  };

  tm.createThread(thread);

  const cwd = worktreePath ?? project.path;

  threadEventBus.emit('thread:created', {
    threadId,
    projectId,
    userId,
    cwd,
    worktreePath: worktreePath ?? null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  const pMode = resolvedPermissionMode;

  // Augment prompt with file contents if file references were provided
  const augmentedPrompt = await augmentPromptWithFiles(prompt, fileReferences, cwd);

  // Start agent and handle errors (especially Claude CLI not installed)
  try {
    await startAgent(
      threadId,
      augmentedPrompt,
      cwd,
      resolvedModel,
      pMode,
      images,
      disallowedTools,
      allowedTools,
      resolvedProvider,
    );
  } catch (err: any) {
    // If startAgent throws (e.g. Claude CLI not found), return error to client
    log.error('Failed to start agent', { namespace: 'agent', threadId, error: err });

    // Check if it's a binary-not-found error
    const isBinaryError =
      err.message?.includes('Could not find the claude CLI binary') ||
      err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json(
        {
          error: 'Claude CLI not installed',
          message:
            'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
          details: err.message,
        },
        503,
      ); // 503 Service Unavailable
    }

    // Other errors
    return c.json(
      {
        error: 'Failed to start agent',
        message: err.message || 'Unknown error occurred while starting the agent',
      },
      500,
    );
  }

  return c.json(thread, 201);
});

// POST /api/threads/:id/message
threadRoutes.post('/:id/message', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(sendMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const {
    content,
    provider,
    model,
    permissionMode,
    images,
    allowedTools,
    disallowedTools,
    fileReferences,
    baseBranch,
  } = parsed.value;

  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) return c.json({ error: 'Project path not found' }, 404);

  const effectiveProvider = (provider ||
    thread.provider ||
    'claude') as import('@funny/shared').AgentProvider;
  const effectiveModel = (model || thread.model || 'sonnet') as import('@funny/shared').AgentModel;
  const effectivePermission = (permissionMode ||
    thread.permissionMode ||
    'autoEdit') as import('@funny/shared').PermissionMode;

  // Update thread's permission mode, model, and baseBranch if they changed
  const updates: Record<string, any> = {};
  if (permissionMode && permissionMode !== thread.permissionMode) {
    updates.permissionMode = permissionMode;
  }
  if (model && model !== thread.model) {
    updates.model = model;
  }
  if (baseBranch && baseBranch !== thread.baseBranch) {
    updates.baseBranch = baseBranch;
  }
  if (Object.keys(updates).length > 0) {
    tm.updateThread(id, updates);
  }

  // Auto-move idle backlog threads to in_progress when a message is sent
  let hasDraftMessage = false;
  if (thread.status === 'idle' && thread.stage === 'backlog') {
    const stageUpdates: Record<string, any> = { stage: 'in_progress' };
    // Update title if the prompt changed from the original initialPrompt
    if (thread.initialPrompt && content !== thread.initialPrompt) {
      stageUpdates.title = content.slice(0, 200);
      stageUpdates.initialPrompt = content;
    }
    tm.updateThread(id, stageUpdates);

    // Update existing draft message (created when idle thread was added to backlog)
    const { messages: draftMessages } = tm.getThreadMessages({ threadId: id, limit: 1 });
    const draftMsg = draftMessages[0];
    if (draftMsg && draftMsg.role === 'user') {
      tm.updateMessage(draftMsg.id, {
        content,
        images: images?.length ? JSON.stringify(images) : null,
      });
      hasDraftMessage = true;
    }
  }

  // If the thread was waiting for user input (question/plan), persist the answer
  // in the tool call's output so it survives refresh even if the agent's tool_result
  // never arrives (e.g. on resume, the processedToolUseIds map is cleared).
  if (thread.status === 'waiting') {
    const pendingTC = tm.findLastUnansweredInteractiveToolCall(id);
    if (pendingTC) {
      tm.updateToolCallOutput(pendingTC.id, content);
    }
  }

  // Augment prompt with file contents if file references were provided
  const augmentedContent = await augmentPromptWithFiles(content, fileReferences, cwd);

  // Check if the agent is running and the project uses queue mode
  const agentRunning = isAgentRunning(id);
  const project = pm.getProject(thread.projectId);
  const followUpMode = project?.followUpMode || 'interrupt';

  if (agentRunning && followUpMode === 'queue') {
    // Queue the message instead of interrupting
    const queued = mq.enqueue(id, {
      content: augmentedContent,
      provider: effectiveProvider,
      model: effectiveModel,
      permissionMode: effectivePermission,
      images: images ? JSON.stringify(images) : undefined,
      allowedTools: allowedTools ? JSON.stringify(allowedTools) : undefined,
      disallowedTools: disallowedTools ? JSON.stringify(disallowedTools) : undefined,
      fileReferences: fileReferences ? JSON.stringify(fileReferences) : undefined,
    });

    // Save user message in DB immediately so it shows in the chat
    tm.insertMessage({
      threadId: id,
      role: 'user',
      content,
      images: images ? JSON.stringify(images) : null,
      model: effectiveModel,
      permissionMode: effectivePermission,
    });

    // Emit queue update via WebSocket
    const qCount = mq.queueCount(id);
    const nextMsg = mq.peek(id);
    const queueEvent = {
      type: 'thread:queue_update' as const,
      threadId: id,
      data: { threadId: id, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
    } as WSEvent;
    if (thread.userId) {
      wsBroker.emitToUser(thread.userId, queueEvent);
    } else {
      wsBroker.emit(queueEvent);
    }

    return c.json({ ok: true, queued: true, queuedCount: qCount, queuedMessageId: queued.id });
  }

  // When sending to an idle thread that had a draft, update draft with augmented content
  if (hasDraftMessage) {
    const { messages: draftMsgs } = tm.getThreadMessages({ threadId: id, limit: 1 });
    if (draftMsgs[0]) {
      tm.updateMessage(draftMsgs[0].id, { content: augmentedContent });
    }
  }

  // Default interrupt behavior — start agent (kills existing if running)
  try {
    await startAgent(
      id,
      augmentedContent,
      cwd,
      effectiveModel,
      effectivePermission,
      images,
      disallowedTools,
      allowedTools,
      effectiveProvider,
      undefined, // systemPrompt
      hasDraftMessage, // skipMessageInsert — draft already exists
    );
  } catch (err: any) {
    log.error('Failed to start agent', { namespace: 'agent', threadId: id, error: err });

    // Check if it's a binary-not-found error
    const isBinaryError =
      err.message?.includes('Could not find the claude CLI binary') ||
      err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json(
        {
          error: 'Claude CLI not installed',
          message:
            'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
          details: err.message,
        },
        503,
      );
    }

    // Other errors
    return c.json(
      {
        error: 'Failed to start agent',
        message: err.message || 'Unknown error occurred while starting the agent',
      },
      500,
    );
  }

  return c.json({ ok: true });
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;
  if (thread.provider === 'external') {
    cleanupExternalThread(id);
    return c.json({ ok: true });
  }
  await stopAgent(id);
  return c.json({ ok: true });
});

// POST /api/threads/:id/approve-tool
threadRoutes.post('/:id/approve-tool', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(approveToolSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const {
    toolName,
    approved,
    allowedTools: clientAllowedTools,
    disallowedTools: clientDisallowedTools,
  } = parsed.value;

  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) return c.json({ error: 'Project path not found' }, 404);

  // Use client-provided tools list, or fall back to defaults
  const tools = clientAllowedTools
    ? [...clientAllowedTools]
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

  try {
    const threadProvider = (thread.provider || 'claude') as import('@funny/shared').AgentProvider;
    if (approved) {
      // Add the approved tool to allowedTools and remove from disallowedTools
      if (!tools.includes(toolName)) {
        tools.push(toolName);
      }
      const disallowed = clientDisallowedTools?.filter((t) => t !== toolName);
      const message = `The user has approved the use of ${toolName}. Please proceed with using it.`;
      await startAgent(
        id,
        message,
        cwd,
        (thread.model as import('@funny/shared').AgentModel) || 'sonnet',
        (thread.permissionMode as import('@funny/shared').PermissionMode) || 'autoEdit',
        undefined,
        disallowed,
        tools,
        threadProvider,
      );
    } else {
      // User denied permission
      const message = `The user denied permission to use ${toolName}. Please continue without it.`;
      await startAgent(
        id,
        message,
        cwd,
        (thread.model as import('@funny/shared').AgentModel) || 'sonnet',
        (thread.permissionMode as import('@funny/shared').PermissionMode) || 'autoEdit',
        undefined,
        clientDisallowedTools,
        clientAllowedTools,
        threadProvider,
      );
    }
  } catch (err: any) {
    log.error('Failed to start agent', { namespace: 'agent', threadId: id, error: err });

    // Check if it's a binary-not-found error
    const isBinaryError =
      err.message?.includes('Could not find the claude CLI binary') ||
      err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json(
        {
          error: 'Claude CLI not installed',
          message:
            'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
          details: err.message,
        },
        503,
      );
    }

    // Other errors
    return c.json(
      {
        error: 'Failed to start agent',
        message: err.message || 'Unknown error occurred while starting the agent',
      },
      500,
    );
  }

  return c.json({ ok: true });
});

// PATCH /api/threads/:id — update thread fields (e.g. archived)
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(updateThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const updates: Record<string, any> = {};
  if (parsed.value.archived !== undefined) {
    updates.archived = parsed.value.archived ? 1 : 0;
  }
  if (parsed.value.pinned !== undefined) {
    updates.pinned = parsed.value.pinned ? 1 : 0;
  }
  if (parsed.value.stage !== undefined) {
    updates.stage = parsed.value.stage;
  }

  const fromStage = thread.stage;

  // Cleanup worktree + branch when archiving (skip for external threads and local threads reusing a worktree)
  if (
    parsed.value.archived &&
    thread.worktreePath &&
    thread.mode === 'worktree' &&
    thread.provider !== 'external'
  ) {
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
    updates.worktreePath = null;
    updates.branch = null;
    // Release in-memory agent state and clear queue for the archived thread
    mq.clearQueue(id);
    cleanupThreadState(id);
  }

  if (Object.keys(updates).length > 0) {
    tm.updateThread(id, updates);
  }

  // Emit stage-changed events
  const project = pm.getProject(thread.projectId);
  const eventCtx = {
    threadId: id,
    projectId: thread.projectId,
    userId: thread.userId,
    worktreePath: thread.worktreePath ?? null,
    cwd: thread.worktreePath ?? project?.path ?? '',
  };
  if (parsed.value.archived) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: 'archived',
    });
  } else if (parsed.value.stage && parsed.value.stage !== fromStage) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: parsed.value.stage as any,
    });
  }

  // Auto-start agent when idle thread is moved to in_progress
  if (parsed.value.stage === 'in_progress' && thread.status === 'idle' && thread.initialPrompt) {
    if (project) {
      const cwd = thread.worktreePath || project.path;
      // Read the draft message to get images (if any)
      const { messages: draftMessages } = tm.getThreadMessages({ threadId: id, limit: 1 });
      const draftMsg = draftMessages[0];
      const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
      // Start agent — skip inserting user message since draft already exists
      startAgent(
        id,
        thread.initialPrompt,
        cwd,
        (thread.model || project.defaultModel || 'sonnet') as import('@funny/shared').AgentModel,
        (thread.permissionMode || 'autoEdit') as import('@funny/shared').PermissionMode,
        draftImages,
        undefined,
        undefined,
        (thread.provider ||
          project.defaultProvider ||
          'claude') as import('@funny/shared').AgentProvider,
        undefined,
        !!draftMsg, // skipMessageInsert — draft already exists
      ).catch((err) => {
        log.error('Failed to auto-start agent for idle thread', {
          namespace: 'agent',
          threadId: id,
          error: err,
        });
        tm.updateThread(id, { status: 'failed', completedAt: new Date().toISOString() });
        const failEvent = {
          type: 'agent:status' as const,
          threadId: id,
          data: { status: 'failed' },
        };
        if (thread.userId && thread.userId !== '__local__') {
          wsBroker.emitToUser(thread.userId, failEvent);
        } else {
          wsBroker.emit(failEvent);
        }
      });
    }
  }

  const updated = tm.getThread(id);
  return c.json(updated);
});

// ── Message Queue ────────────────────────────────────────────────

// GET /api/threads/:id/queue
threadRoutes.get('/:id/queue', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(mq.listQueue(id));
});

// DELETE /api/threads/:id/queue/:messageId
threadRoutes.delete('/:id/queue/:messageId', (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cancelled = mq.cancel(messageId);
  if (!cancelled) return c.json({ error: 'Queued message not found' }, 404);

  // Emit updated queue count
  const qCount = mq.queueCount(id);
  const nextMsg = mq.peek(id);
  const queueEvent = {
    type: 'thread:queue_update' as const,
    threadId: id,
    data: { threadId: id, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
  } as WSEvent;
  if (thread.userId) {
    wsBroker.emitToUser(thread.userId, queueEvent);
  } else {
    wsBroker.emit(queueEvent);
  }

  return c.json({ ok: true, queuedCount: qCount });
});

// ── Thread Comments ──────────────────────────────────────────────

// GET /api/threads/:id/comments
threadRoutes.get('/:id/comments', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(tm.listComments(id));
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const { content } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'content is required' }, 400);
  }
  const comment = tm.insertComment({ threadId: id, userId, source: 'user', content });
  return c.json(comment, 201);
});

// DELETE /api/threads/:id/comments/:commentId
threadRoutes.delete('/:id/comments/:commentId', (c) => {
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  tm.deleteComment(commentId);

  const thread = threadResult.value;
  const event = {
    type: 'thread:comment_deleted' as const,
    threadId: id,
    data: { commentId },
  };
  if (thread.userId && thread.userId !== '__local__') {
    wsBroker.emitToUser(thread.userId, event);
  } else {
    wsBroker.emit(event);
  }

  return c.json({ ok: true });
});

// DELETE /api/threads/:id
threadRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  if (thread) {
    threadEventBus.emit('thread:deleted', {
      threadId: id,
      projectId: thread.projectId,
      userId: thread.userId,
      worktreePath: thread.worktreePath ?? null,
    });

    if (isAgentRunning(id)) {
      try {
        await stopAgent(id);
      } catch (err) {
        log.error('Failed to stop agent', { namespace: 'agent', threadId: id, error: err });
      }
    }

    // Only remove worktree/branch for worktree-mode threads (skip local threads reusing a worktree and external threads)
    if (thread.worktreePath && thread.mode === 'worktree' && thread.provider !== 'external') {
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

    mq.clearQueue(id);
    cleanupThreadState(id);
    tm.deleteThread(id);
  }

  return c.json({ ok: true });
});

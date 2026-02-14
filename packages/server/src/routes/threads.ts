import { Hono } from 'hono';
import * as tm from '../services/thread-manager.js';
import * as pm from '../services/project-manager.js';
import * as wm from '../services/worktree-manager.js';
import { startAgent, stopAgent, isAgentRunning } from '../services/agent-runner.js';
import { nanoid } from 'nanoid';
import { createThreadSchema, createIdleThreadSchema, sendMessageSchema, updateThreadSchema, approveToolSchema, validate } from '../validation/schemas.js';
import { requireThread, requireThreadWithMessages, requireProject } from '../utils/route-helpers.js';
import { resultToResponse } from '../utils/result-response.js';
import { notFound } from '@a-parallel/shared/errors';
import { getCurrentBranch } from '../utils/git-v2.js';
import { augmentPromptWithFiles } from '../utils/file-mentions.js';

export const threadRoutes = new Hono();

/** Create a URL-safe slug from a title for branch naming */
function slugifyTitle(title: string, maxLength = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '') || 'thread';
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

// GET /api/threads/:id
threadRoutes.get('/:id', (c) => {
  const result = requireThreadWithMessages(c.req.param('id'));
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// POST /api/threads/idle
threadRoutes.post('/idle', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createIdleThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, title, mode, baseBranch, prompt } = parsed.value;

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
    const wtResult = await wm.createWorktree(project.path, branchName, resolvedBaseBranch);
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
    permissionMode: 'autoEdit' as const,
    model: 'sonnet' as const,
    status: 'idle' as const,
    stage: 'backlog' as const,
    branch: threadBranch,
    baseBranch: mode === 'worktree' ? resolvedBaseBranch : undefined,
    worktreePath,
    initialPrompt: prompt,
    cost: 0,
    createdAt: new Date().toISOString(),
  };

  tm.createThread(thread);

  return c.json(thread, 201);
});

// POST /api/threads
threadRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, title, mode, model, permissionMode, baseBranch, prompt, images, allowedTools, disallowedTools, fileReferences } = parsed.value;

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
    const wtResult = await wm.createWorktree(project.path, branchName, resolvedBaseBranch);
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
    title: title || prompt,
    mode,
    permissionMode: permissionMode || 'autoEdit',
    model: model || 'sonnet',
    status: 'pending' as const,
    branch: threadBranch,
    baseBranch: mode === 'worktree' ? resolvedBaseBranch : undefined,
    worktreePath,
    cost: 0,
    createdAt: new Date().toISOString(),
  };

  tm.createThread(thread);

  const cwd = worktreePath ?? project.path;

  const pMode = permissionMode || 'autoEdit';

  // Augment prompt with file contents if file references were provided
  const augmentedPrompt = await augmentPromptWithFiles(prompt, fileReferences, cwd);

  // Start agent and handle errors (especially Claude CLI not installed)
  try {
    await startAgent(threadId, augmentedPrompt, cwd, model || 'sonnet', pMode, images, disallowedTools, allowedTools);
  } catch (err: any) {
    // If startAgent throws (e.g. Claude CLI not found), return error to client
    console.error(`[agent] Failed to start agent for thread ${threadId}:`, err);

    // Check if it's a binary-not-found error
    const isBinaryError = err.message?.includes('Could not find the claude CLI binary') ||
                          err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json({
        error: 'Claude CLI not installed',
        message: 'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
        details: err.message
      }, 503); // 503 Service Unavailable
    }

    // Other errors
    return c.json({
      error: 'Failed to start agent',
      message: err.message || 'Unknown error occurred while starting the agent'
    }, 500);
  }

  return c.json(thread, 201);
});

// POST /api/threads/:id/message
threadRoutes.post('/:id/message', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(sendMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { content, model, permissionMode, images, allowedTools, disallowedTools, fileReferences } = parsed.value;

  const threadResult = requireThread(id);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) return c.json({ error: 'Project path not found' }, 404);

  const effectiveModel = (model || thread.model || 'sonnet') as import('@a-parallel/shared').ClaudeModel;
  const effectivePermission = (permissionMode || thread.permissionMode || 'autoEdit') as import('@a-parallel/shared').PermissionMode;

  // Update thread's permission mode and model if they changed
  const updates: Record<string, any> = {};
  if (permissionMode && permissionMode !== thread.permissionMode) {
    updates.permissionMode = permissionMode;
  }
  if (model && model !== thread.model) {
    updates.model = model;
  }
  if (Object.keys(updates).length > 0) {
    tm.updateThread(id, updates);
  }

  // Auto-move idle backlog threads to in_progress when a message is sent
  if (thread.status === 'idle' && thread.stage === 'backlog') {
    tm.updateThread(id, { stage: 'in_progress' });
  }

  // Augment prompt with file contents if file references were provided
  const augmentedContent = await augmentPromptWithFiles(content, fileReferences, cwd);

  // Start agent and handle errors (especially Claude CLI not installed)
  try {
    await startAgent(id, augmentedContent, cwd, effectiveModel, effectivePermission, images, disallowedTools, allowedTools);
  } catch (err: any) {
    console.error(`[agent] Failed to start agent for thread ${id}:`, err);

    // Check if it's a binary-not-found error
    const isBinaryError = err.message?.includes('Could not find the claude CLI binary') ||
                          err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json({
        error: 'Claude CLI not installed',
        message: 'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
        details: err.message
      }, 503);
    }

    // Other errors
    return c.json({
      error: 'Failed to start agent',
      message: err.message || 'Unknown error occurred while starting the agent'
    }, 500);
  }

  return c.json({ ok: true });
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  await stopAgent(c.req.param('id'));
  return c.json({ ok: true });
});

// POST /api/threads/:id/approve-tool
threadRoutes.post('/:id/approve-tool', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(approveToolSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { toolName, approved, allowedTools: clientAllowedTools, disallowedTools: clientDisallowedTools } = parsed.value;

  const threadResult = requireThread(id);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) return c.json({ error: 'Project path not found' }, 404);

  // Use client-provided tools list, or fall back to defaults
  const tools = clientAllowedTools ? [...clientAllowedTools] : [
    'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit',
  ];

  try {
    if (approved) {
      // Add the approved tool to allowedTools and remove from disallowedTools
      if (!tools.includes(toolName)) {
        tools.push(toolName);
      }
      const disallowed = clientDisallowedTools?.filter(t => t !== toolName);
      const message = `The user has approved the use of ${toolName}. Please proceed with using it.`;
      await startAgent(
        id,
        message,
        cwd,
        thread.model as import('@a-parallel/shared').ClaudeModel || 'sonnet',
        thread.permissionMode as import('@a-parallel/shared').PermissionMode || 'autoEdit',
        undefined,
        disallowed,
        tools
      );
    } else {
      // User denied permission
      const message = `The user denied permission to use ${toolName}. Please continue without it.`;
      await startAgent(
        id,
        message,
        cwd,
        thread.model as import('@a-parallel/shared').ClaudeModel || 'sonnet',
        thread.permissionMode as import('@a-parallel/shared').PermissionMode || 'autoEdit',
        undefined,
        clientDisallowedTools,
        clientAllowedTools
      );
    }
  } catch (err: any) {
    console.error(`[agent] Failed to start agent for thread ${id}:`, err);

    // Check if it's a binary-not-found error
    const isBinaryError = err.message?.includes('Could not find the claude CLI binary') ||
                          err.message?.includes('CLAUDE_BINARY_PATH');

    if (isBinaryError) {
      return c.json({
        error: 'Claude CLI not installed',
        message: 'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
        details: err.message
      }, 503);
    }

    // Other errors
    return c.json({
      error: 'Failed to start agent',
      message: err.message || 'Unknown error occurred while starting the agent'
    }, 500);
  }

  return c.json({ ok: true });
});

// PATCH /api/threads/:id — update thread fields (e.g. archived)
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(updateThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id);
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

  // Cleanup worktree + branch when archiving
  if (parsed.value.archived && thread.worktreePath) {
    const project = pm.getProject(thread.projectId);
    if (project) {
      await wm.removeWorktree(project.path, thread.worktreePath).catch((e) => {
        console.warn(`[cleanup] Failed to remove worktree: ${e}`);
      });
      if (thread.branch) {
        await wm.removeBranch(project.path, thread.branch).catch((e) => {
          console.warn(`[cleanup] Failed to remove branch: ${e}`);
        });
      }
    }
    updates.worktreePath = null;
    updates.branch = null;
  }

  if (Object.keys(updates).length > 0) {
    tm.updateThread(id, updates);
  }

  // Auto-start agent when idle thread is moved to in_progress
  if (parsed.value.stage === 'in_progress' && thread.status === 'idle' && thread.initialPrompt) {
    const project = pm.getProject(thread.projectId);
    if (project) {
      const cwd = thread.worktreePath || project.path;
      // Start agent with the saved initial prompt
      startAgent(
        id,
        thread.initialPrompt,
        cwd,
        'sonnet', // default model for idle threads
        thread.permissionMode || 'autoEdit'
      ).catch((err) => {
        console.error(`[idle-start] Failed to auto-start agent for thread ${id}:`, err);
        tm.updateThread(id, { status: 'failed', completedAt: new Date().toISOString() });
      });
    }
  }

  const updated = tm.getThread(id);
  return c.json(updated);
});

// DELETE /api/threads/:id
threadRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const thread = tm.getThread(id);

  if (thread) {
    if (isAgentRunning(id)) {
      stopAgent(id).catch(console.error);
    }

    if (thread.worktreePath) {
      const project = pm.getProject(thread.projectId);
      if (project) {
        await wm.removeWorktree(project.path, thread.worktreePath).catch((e) => {
          console.warn(`[cleanup] Failed to remove worktree: ${e}`);
        });
        if (thread.branch) {
          await wm.removeBranch(project.path, thread.branch).catch((e) => {
            console.warn(`[cleanup] Failed to remove branch: ${e}`);
          });
        }
      }
    }

    tm.deleteThread(id);
  }

  return c.json({ ok: true });
});

/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */

import { createWorktree, getCurrentBranch, git } from '@funny/core/git';
import { setupWorktree } from '@funny/core/ports';
import type {
  WSEvent,
  AgentProvider,
  AgentModel,
  PermissionMode,
  ImageAttachment,
} from '@funny/shared';
import { DEFAULT_MODEL } from '@funny/shared/models';
import { nanoid } from 'nanoid';

import { log } from '../../lib/logger.js';
import {
  augmentPromptWithFiles,
  augmentPromptWithSymbols,
  type FileRef,
  type SymbolRef,
} from '../../utils/file-mentions.js';
import { startAgent } from '../agent-runner.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { launchContainer } from '../podman-service.js';
import { getServices } from '../service-registry.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import {
  ThreadServiceError,
  createSetupProgressEmitter,
  emitThreadUpdated,
  slugifyTitle,
} from './helpers.js';

/**
 * Pre-merge "always allow" permission rules into the agent's allowedTools so
 * the SDK preToolUseHook short-circuits without prompting. Mirrors the helper
 * in messaging.ts; kept local here to avoid an extra cross-module import.
 */
async function augmentAllowedToolsWithRules(
  userId: string,
  projectPath: string,
  allowedTools: string[] | undefined,
): Promise<string[] | undefined> {
  try {
    const rules = await listPermissionRules({ userId, projectPath });
    if (!rules.length) return allowedTools;
    const allowToolNames = new Set<string>();
    for (const rule of rules) {
      if (rule.decision === 'allow') allowToolNames.add(rule.toolName);
    }
    if (!allowToolNames.size) return allowedTools;
    const merged = new Set<string>(allowedTools ?? []);
    for (const t of allowToolNames) merged.add(t);
    return [...merged];
  } catch (err) {
    log.warn('augmentAllowedToolsWithRules failed', {
      namespace: 'thread-service',
      userId,
      projectPath,
      error: (err as Error)?.message,
    });
    return allowedTools;
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
  images?: ImageAttachment[];
  stage?: 'backlog' | 'planning';
  designId?: string;
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
}

export async function createIdleThread(params: CreateIdleThreadParams) {
  const project = await getServices().projects.getProject(params.projectId);
  if (!project) throw new ThreadServiceError('Project not found', 404);

  // Resolve per-user path (owner uses project.path, member uses localPath)
  const pathResult = await getServices().projects.resolveProjectPath(
    params.projectId,
    params.userId,
  );
  if (pathResult.isErr()) throw new ThreadServiceError(pathResult.error.message, 400);
  const projectPath = pathResult.value;

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
    const branchResult = await getCurrentBranch(projectPath);
    if (branchResult.isOk()) branch = branchResult.value;
    baseBranch = resolvedBaseBranch || branch;
  }

  const thread = {
    id: threadId,
    projectId: params.projectId,
    userId: params.userId,
    title: params.title,
    mode: params.mode,
    runtime: 'local' as const,
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
    designId: params.designId,
    agentTemplateId: params.agentTemplateId,
    templateVariables: params.templateVariables
      ? JSON.stringify(params.templateVariables)
      : undefined,
    fileCheckpointingEnabled: 1,
    cost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await tm.createThread(thread as any);

  if (params.prompt) {
    await tm.insertMessage({
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
    cwd: projectPath,
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
  runtime?: 'local' | 'remote';
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  source?: string;
  baseBranch?: string;
  prompt: string;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  worktreePath?: string;
  parentThreadId?: string;
  designId?: string;
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
}

export async function createAndStartThread(params: CreateAndStartThreadParams) {
  const project = await getServices().projects.getProject(params.projectId);
  if (!project) throw new ThreadServiceError('Project not found', 404);

  // Resolve per-user path (owner uses project.path, member uses localPath)
  const pathResult = await getServices().projects.resolveProjectPath(
    params.projectId,
    params.userId,
  );
  if (pathResult.isErr()) throw new ThreadServiceError(pathResult.error.message, 400);
  const projectPath = pathResult.value;

  const threadId = nanoid();
  log.info('createAndStartThread called', {
    namespace: 'thread-service',
    threadId,
    userId: params.userId ?? 'unknown',
    projectId: params.projectId,
    mode: params.mode ?? 'local',
    model: params.model ?? 'default',
    provider: params.provider ?? 'default',
    promptPreview: params.prompt.slice(0, 120),
  });
  const resolvedBaseBranch = params.baseBranch?.trim() || undefined;

  // Resolve defaults: explicit value > project default > hardcoded fallback
  const resolvedProvider = (params.provider ||
    project.defaultProvider ||
    'claude') as AgentProvider;
  const resolvedModel = (params.model || project.defaultModel || DEFAULT_MODEL) as AgentModel;
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
      runtime: (params.runtime || 'local') as 'local' | 'remote',
      provider: resolvedProvider,
      permissionMode: resolvedPermissionMode,
      model: resolvedModel,
      source: params.source || 'web',
      status: 'setting_up' as const,
      branch: branchName,
      baseBranch: resolvedBaseBranch,
      worktreePath: undefined as string | undefined,
      parentThreadId: params.parentThreadId,
      designId: params.designId,
      agentTemplateId: params.agentTemplateId,
      templateVariables: params.templateVariables
        ? JSON.stringify(params.templateVariables)
        : undefined,
      fileCheckpointingEnabled: resolvedProvider === 'claude' ? 1 : 0,
      cost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await tm.createThread(thread as any);

    if (params.prompt) {
      // Augment prompt with file/symbol contents so the stored message includes context XML
      let storedContent = await augmentPromptWithFiles(
        params.prompt,
        params.fileReferences,
        projectPath,
      );
      storedContent = await augmentPromptWithSymbols(
        storedContent,
        params.symbolReferences,
        projectPath,
      );
      await tm.insertMessage({
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
      cwd: projectPath,
      worktreePath: null,
      stage: 'in_progress' as const,
      status: 'setting_up',
    });

    // Background: create worktree, run post-create commands, start agent
    void (async () => {
      try {
        const wtResult = await createWorktree(
          projectPath,
          branchName,
          resolvedBaseBranch,
          emitSetupProgress,
        );
        if (wtResult.isErr()) {
          await tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(params.userId, threadId, { status: 'failed' });
          return;
        }
        const wtPath = wtResult.value;

        const setupResult = await setupWorktree(projectPath, wtPath, emitSetupProgress);
        if (setupResult.isOk() && setupResult.value.postCreateErrors.length) {
          log.warn('Worktree postCreate errors', {
            threadId,
            errors: setupResult.value.postCreateErrors,
          });
        } else if (setupResult.isErr()) {
          log.warn('Failed to setup worktree', { threadId, error: setupResult.error.message });
        }

        // Update thread with worktree info and transition to pending
        await tm.updateThread(threadId, { worktreePath: wtPath, status: 'pending' });
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

        // Start agent — use projectPath (not wtPath) because file references
        // were selected from the main repo; untracked/gitignored files won't
        // exist in the freshly created worktree.
        let augmentedPrompt = await augmentPromptWithFiles(
          params.prompt,
          params.fileReferences,
          projectPath,
        );
        augmentedPrompt = await augmentPromptWithSymbols(
          augmentedPrompt,
          params.symbolReferences,
          projectPath,
        );
        try {
          const allowedToolsForRun = await augmentAllowedToolsWithRules(
            params.userId,
            wtPath,
            params.allowedTools,
          );
          await startAgent(
            threadId,
            augmentedPrompt,
            wtPath,
            resolvedModel,
            resolvedPermissionMode,
            params.images,
            params.disallowedTools,
            allowedToolsForRun,
            resolvedProvider,
            undefined,
            true, // skipMessageInsert — already inserted at thread creation
            params.effort,
          );
        } catch (err: any) {
          log.error('Failed to start agent after worktree setup', { threadId, error: err });
          await tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(params.userId, threadId, { status: 'failed' });
        }
      } catch (err) {
        log.error('Background worktree setup failed', { threadId, error: String(err) });
        await tm.updateThread(threadId, { status: 'failed' });
        emitThreadUpdated(params.userId, threadId, { status: 'failed' });
      }
    })();

    return thread;
  }

  // ── Non-worktree paths (local mode, or reusing an existing worktree) ──
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;
  let needsBranchCheckout = false;

  if (params.worktreePath) {
    worktreePath = params.worktreePath;
    const branchResult = await getCurrentBranch(params.worktreePath);
    if (branchResult.isOk()) threadBranch = branchResult.value;
  } else {
    const branchResult = await getCurrentBranch(projectPath);
    if (branchResult.isOk()) {
      threadBranch = branchResult.value;
      needsBranchCheckout = !!(resolvedBaseBranch && resolvedBaseBranch !== threadBranch);
      if (needsBranchCheckout) threadBranch = resolvedBaseBranch;
    }
  }

  // ── Local mode with branch checkout (synchronous, no setting_up UI) ──
  if (needsBranchCheckout && !worktreePath) {
    const fetchResult = await git(['fetch', 'origin', resolvedBaseBranch!], projectPath);
    if (fetchResult.isErr()) {
      log.warn('Failed to fetch branch before checkout (non-fatal)', {
        namespace: 'thread-service',
        threadId,
        branch: resolvedBaseBranch,
        error: fetchResult.error.message,
      });
    }

    const checkoutResult = await git(['checkout', resolvedBaseBranch!], projectPath);
    if (checkoutResult.isErr()) {
      throw new ThreadServiceError(
        `Failed to checkout branch "${resolvedBaseBranch}": ${checkoutResult.error.message}`,
        400,
      );
    }

    threadBranch = resolvedBaseBranch;
    needsBranchCheckout = false;
    // Falls through to normal path below (status: 'pending')
  }

  // ── Normal path (no branch checkout needed) ──
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
    runtime: (params.runtime || 'local') as 'local' | 'remote',
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (params.mode === 'local' ? threadBranch : undefined),
    worktreePath,
    parentThreadId: params.parentThreadId,
    designId: params.designId,
    agentTemplateId: params.agentTemplateId,
    templateVariables: params.templateVariables
      ? JSON.stringify(params.templateVariables)
      : undefined,
    fileCheckpointingEnabled: resolvedProvider === 'claude' ? 1 : 0,
    cost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await tm.createThread(thread as any);

  const cwd = worktreePath ?? projectPath;

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: params.projectId,
    userId: params.userId,
    cwd,
    worktreePath: worktreePath ?? null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  // Augment prompt with file/symbol contents if references were provided
  let augmentedPrompt = await augmentPromptWithFiles(params.prompt, params.fileReferences, cwd);
  augmentedPrompt = await augmentPromptWithSymbols(augmentedPrompt, params.symbolReferences, cwd);

  // ── Remote runtime: launch container instead of local agent ──
  if (params.runtime === 'remote') {
    if (!project.launcherUrl) {
      throw new ThreadServiceError('Project has no launcher URL configured', 400);
    }

    const branch = threadBranch || 'main';
    const githubToken = await getServices().profile.getGithubToken(params.userId);

    // Launch container in background
    void (async () => {
      await tm.updateThread(threadId, { status: 'setting_up' });
      emitThreadUpdated(params.userId, threadId, { status: 'setting_up' });

      const result = await launchContainer({
        threadId,
        projectPath: project.path,
        launcherUrl: project.launcherUrl!,
        branch,
        githubToken: githubToken ?? undefined,
      });

      if (result.isErr()) {
        log.error('Failed to launch container', { threadId, error: result.error.message });
        await tm.updateThread(threadId, { status: 'failed' });
        emitThreadUpdated(params.userId, threadId, { status: 'failed' });
        return;
      }

      const { containerUrl, containerName } = result.value;
      await tm.updateThread(threadId, {
        containerUrl,
        containerName,
        status: 'running',
      });
      emitThreadUpdated(params.userId, threadId, {
        status: 'running',
        containerUrl,
        containerName,
      });

      // Forward the initial prompt to the container's Funny server
      try {
        const res = await fetch(`${containerUrl}/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: params.projectId,
            title: params.title || params.prompt,
            mode: params.mode,
            provider: resolvedProvider,
            model: resolvedModel,
            permissionMode: resolvedPermissionMode,
            prompt: augmentedPrompt,
            images: params.images,
            allowedTools: params.allowedTools,
            disallowedTools: params.disallowedTools,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => 'Unknown error');
          log.error('Container rejected thread creation', { threadId, status: res.status, text });
        }
      } catch (err) {
        log.error('Failed to forward prompt to container', { threadId, error: String(err) });
      }
    })();

    return thread;
  }

  // Start agent (throws on failure — caller handles HTTP error response)
  const allowedToolsForRun = await augmentAllowedToolsWithRules(
    params.userId,
    cwd,
    params.allowedTools,
  );
  await startAgent(
    threadId,
    augmentedPrompt,
    cwd,
    resolvedModel,
    resolvedPermissionMode,
    params.images,
    params.disallowedTools,
    allowedToolsForRun,
    resolvedProvider,
    undefined,
    undefined,
    params.effort,
  );

  return thread;
}

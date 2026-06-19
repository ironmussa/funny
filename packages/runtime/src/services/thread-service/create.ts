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
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { safeFetchUserUrl } from '../../lib/ssrf-guard.js';
import {
  augmentPromptWithFiles,
  augmentPromptWithSymbols,
  stripInlineReferencedContent,
  type FileRef,
  type SymbolRef,
} from '../../utils/file-mentions.js';
import { startAgent } from '../agent-runner.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { launchContainer } from '../podman-service.js';
import { getServices } from '../service-registry.js';
import { scratchPathFor } from '../thread-context.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import {
  ThreadServiceError,
  createSetupProgressEmitter,
  emitThreadUpdated,
  slugifyTitle,
  stripReferencedFilesBlock,
} from './helpers.js';
import {
  executeShellEscape,
  extractShellEscapeCommand,
  formatShellEscapeOutput,
} from './shell-escape.js';

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

export function createIdleThread(
  params: CreateIdleThreadParams,
): ResultAsync<Awaited<ReturnType<typeof createIdleThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(createIdleThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function createIdleThreadImpl(params: CreateIdleThreadParams) {
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
  /** Null only when isScratch === true. */
  projectId: string | null;
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
  /** True for lightweight projectless threads (no git, no worktree). */
  isScratch?: boolean;
}

export function createAndStartThread(
  params: CreateAndStartThreadParams,
): ResultAsync<Awaited<ReturnType<typeof createAndStartThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(createAndStartThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function createAndStartThreadImpl(params: CreateAndStartThreadParams) {
  if (params.isScratch) {
    return createAndStartScratchThread(params);
  }
  if (!params.projectId) {
    throw new ThreadServiceError('projectId is required for non-scratch threads', 400);
  }
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

  // Strip any leading `<referenced-files>` XML block so titles, slugs, and
  // forwarded prompts don't show raw markup when files were attached inline.
  const titleSource = params.title || stripReferencedFilesBlock(params.prompt) || params.prompt;
  const shellCommand = extractShellEscapeCommand(params.prompt);
  if (shellCommand !== null) {
    if (!shellCommand) {
      throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
    }

    const branchResult = await getCurrentBranch(projectPath);
    const thread = {
      id: threadId,
      projectId: params.projectId,
      userId: params.userId,
      title: titleSource,
      mode: 'local' as const,
      runtime: 'local' as const,
      provider: resolvedProvider,
      permissionMode: resolvedPermissionMode,
      model: resolvedModel,
      source: params.source || 'web',
      status: 'completed' as const,
      branch: branchResult.isOk() ? branchResult.value : undefined,
      baseBranch: resolvedBaseBranch || (branchResult.isOk() ? branchResult.value : undefined),
      worktreePath: undefined as string | undefined,
      parentThreadId: params.parentThreadId,
      designId: params.designId,
      agentTemplateId: params.agentTemplateId,
      templateVariables: params.templateVariables
        ? JSON.stringify(params.templateVariables)
        : undefined,
      fileCheckpointingEnabled: 0,
      cost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await createCompletedShellEscapeThread({
      thread,
      threadId,
      projectId: params.projectId,
      userId: params.userId,
      cwd: projectPath,
      command: shellCommand,
      prompt: params.prompt,
      images: params.images,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      effort: params.effort,
    });

    return thread;
  }

  // ── Worktree mode (new worktree) ──────────────────────────────
  if (params.mode === 'worktree' && !params.worktreePath) {
    const slug = slugifyTitle(titleSource);
    const projectSlug = slugifyTitle(project.name);
    const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;

    const thread = {
      id: threadId,
      projectId: params.projectId,
      userId: params.userId,
      title: titleSource,
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
      // The agent gets the fully augmented prompt (with file contents inlined)
      // when startAgent runs; what we persist for display is the path-only
      // metadata version. See stripInlineReferencedContent.
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
        content: stripInlineReferencedContent(storedContent),
        images: params.images?.length ? JSON.stringify(params.images) : null,
        model: params.model ?? null,
        permissionMode: params.permissionMode ?? null,
        effort: params.effort ?? null,
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
    // Security CR-4: client-supplied worktreePath becomes the cwd for
    // browse/file-index/text-search/agent-spawn. An attacker who supplies
    // an absolute path outside the project's worktree base — `/etc`,
    // another user's HOME, etc. — would otherwise pivot every downstream
    // file/command op into that scope. Verify against the project's
    // worktree base (`getWorktreeBasePath(projectPath)`) using realpath.
    const { checkWorktreePathInProject } = await import('@funny/core/git');
    const containmentErr = checkWorktreePathInProject(projectPath, params.worktreePath);
    if (containmentErr) {
      throw new ThreadServiceError(containmentErr.message, 400);
    }
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
    title: titleSource,
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

      // Forward the initial prompt to the container's Funny server.
      //
      // Security HI-5: `containerUrl` is returned by the project's launcher
      // (a project-config'd URL), so a compromised launcher response could
      // point at a cloud-metadata endpoint. `safeFetchUserUrl` blocks IMDS
      // ranges while allowing legitimate LAN container URLs.
      try {
        const res = await safeFetchUserUrl(`${containerUrl}/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: params.projectId,
            title: titleSource,
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

// ── Create and Start Scratch Thread ─────────────────────────────
/**
 * Scratch threads are the lightweight projectless variant — no git, no
 * worktree, no branch. The agent runs in `~/.funny/scratch/<userId>/<threadId>/`
 * (path resolved by `resolveThreadCwd` inside `agent-lifecycle.startAgent`).
 *
 * The agent-lifecycle helper creates the directory lazily and emits the
 * cwd in the `thread:started` event; this function only handles thread-
 * row creation + first message + agent start.
 */
async function createAndStartScratchThread(params: CreateAndStartThreadParams) {
  const threadId = nanoid();
  const titleSource = params.title || stripReferencedFilesBlock(params.prompt) || params.prompt;

  const resolvedProvider = (params.provider || 'claude') as AgentProvider;
  const resolvedModel = (params.model || DEFAULT_MODEL) as AgentModel;
  const resolvedPermissionMode = (params.permissionMode || 'autoEdit') as PermissionMode;

  log.info('createAndStartScratchThread called', {
    namespace: 'scratch-threads',
    threadId,
    userId: params.userId,
    promptPreview: params.prompt.slice(0, 120),
  });

  const thread = {
    id: threadId,
    projectId: null as string | null,
    userId: params.userId,
    title: titleSource,
    mode: 'local' as const,
    runtime: 'local' as const,
    provider: resolvedProvider,
    permissionMode: resolvedPermissionMode,
    model: resolvedModel,
    source: params.source || 'web',
    status: 'pending' as const,
    branch: undefined as string | undefined,
    baseBranch: undefined as string | undefined,
    worktreePath: undefined as string | undefined,
    parentThreadId: params.parentThreadId,
    designId: params.designId,
    agentTemplateId: params.agentTemplateId,
    templateVariables: params.templateVariables
      ? JSON.stringify(params.templateVariables)
      : undefined,
    fileCheckpointingEnabled: resolvedProvider === 'claude' ? 1 : 0,
    isScratch: 1,
    cost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const shellCommand = extractShellEscapeCommand(params.prompt);
  if (shellCommand !== null) {
    if (!shellCommand) {
      throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
    }

    const cwd = scratchPathFor(params.userId, threadId);
    const completedThread = {
      ...thread,
      status: 'completed' as const,
      fileCheckpointingEnabled: 0,
    };
    await createCompletedShellEscapeThread({
      thread: completedThread,
      threadId,
      projectId: '',
      userId: params.userId,
      cwd,
      command: shellCommand,
      prompt: params.prompt,
      images: params.images,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      effort: params.effort,
    });

    return completedThread;
  }

  await tm.createThread(thread as any);

  // Persist the user message ourselves so we can pass skipMessageInsert
  // to startAgent (matches the worktree-mode pattern above).
  await tm.insertMessage({
    threadId,
    role: 'user',
    content: params.prompt,
    images: params.images?.length ? JSON.stringify(params.images) : null,
    model: params.model ?? null,
    permissionMode: params.permissionMode ?? null,
    effort: params.effort ?? null,
  });

  threadEventBus.emit('thread:created', {
    threadId,
    // Scratch threads have no project — use the empty-string sentinel.
    projectId: '',
    userId: params.userId,
    cwd: '',
    worktreePath: null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  // startAgent will resolve the scratch cwd via resolveThreadCwd and
  // create the directory before spawning. The cwd we pass here is a
  // best-effort placeholder; agent-lifecycle overrides it.
  await startAgent(
    threadId,
    params.prompt,
    '',
    resolvedModel,
    resolvedPermissionMode,
    params.images,
    params.disallowedTools,
    params.allowedTools,
    resolvedProvider,
    undefined,
    true, // skipMessageInsert — we already inserted above
    params.effort,
  );

  return thread;
}

async function createCompletedShellEscapeThread(args: {
  thread: Record<string, any>;
  threadId: string;
  projectId: string;
  userId: string;
  cwd: string;
  command: string;
  prompt: string;
  images?: ImageAttachment[];
  model: AgentModel;
  permissionMode: PermissionMode;
  effort?: string;
}) {
  await tm.createThread(args.thread as any);

  const userMessageId = await tm.insertMessage({
    threadId: args.threadId,
    role: 'user',
    content: args.prompt,
    images: args.images?.length ? JSON.stringify(args.images) : null,
    model: args.model,
    permissionMode: args.permissionMode,
    effort: args.effort ?? null,
  });
  const assistantMessageId = await tm.insertMessage({
    threadId: args.threadId,
    role: 'assistant',
    content: '',
  });
  const toolInput = { command: args.command };
  const toolCallId = await tm.insertToolCall({
    messageId: assistantMessageId,
    name: 'Bash',
    input: JSON.stringify(toolInput),
    author: 'shell',
  });

  threadEventBus.emit('thread:created', {
    threadId: args.threadId,
    projectId: args.projectId,
    userId: args.userId,
    cwd: args.cwd,
    worktreePath: null,
    stage: 'in_progress' as const,
    status: 'completed',
  });

  const result = await executeShellEscape(args.command, args.cwd);
  const output = formatShellEscapeOutput(result);
  await tm.updateToolCallOutput(toolCallId, output);

  wsBroker.emitToUser(args.userId, {
    type: 'agent:message',
    threadId: args.threadId,
    data: { messageId: userMessageId, role: 'user', content: args.prompt },
  } as WSEvent);
  wsBroker.emitToUser(args.userId, {
    type: 'agent:tool_call',
    threadId: args.threadId,
    data: {
      toolCallId,
      messageId: assistantMessageId,
      name: 'Bash',
      input: toolInput,
      author: 'shell',
    },
  } as WSEvent);
  wsBroker.emitToUser(args.userId, {
    type: 'agent:tool_output',
    threadId: args.threadId,
    data: { toolCallId, output },
  } as WSEvent);
}

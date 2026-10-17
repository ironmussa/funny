/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */

import {
  createWorktree,
  findWorktreeForBranch,
  getCurrentBranch,
  git,
  isRegisteredWorktreePath,
} from '@funny/core/git';
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
import { startAgent } from '../agent-runner-control.js';
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

interface ResolvedRunDefaults {
  provider: AgentProvider;
  model: AgentModel;
  permissionMode: PermissionMode;
}

type StartProject = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getServices>['projects']['getProject']>>
>;

/** Everything the project-thread creation phases share. */
interface ProjectThreadContext {
  params: CreateAndStartThreadParams;
  projectId: string;
  project: StartProject;
  projectPath: string;
  threadId: string;
  resolvedBaseBranch: string | undefined;
  defaults: ResolvedRunDefaults;
  titleSource: string;
}

async function createAndStartThreadImpl(params: CreateAndStartThreadParams) {
  if (params.isScratch) {
    return createAndStartScratchThread(params);
  }
  const ctx = await resolveProjectThreadContext(params);

  const shellCommand = extractShellEscapeCommand(params.prompt);
  if (shellCommand !== null) {
    return createShellEscapeProjectThread(ctx, shellCommand);
  }

  // ── Worktree mode (new worktree) ──────────────────────────────
  if (params.mode === 'worktree' && !params.worktreePath) {
    return createNewWorktreeThread(ctx);
  }

  // ── Non-worktree paths (local mode, or reusing an existing worktree) ──
  return createLocalThread(ctx);
}

/** Validate the project, resolve the per-user path and run defaults. */
async function resolveProjectThreadContext(
  params: CreateAndStartThreadParams,
): Promise<ProjectThreadContext> {
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

  const threadId = nanoid();
  logCreateAndStart(params, threadId);

  return {
    params,
    projectId: params.projectId,
    project,
    projectPath: pathResult.value,
    threadId,
    resolvedBaseBranch: params.baseBranch?.trim() || undefined,
    defaults: resolveRunDefaults(params, project),
    titleSource: titleSourceFor(params),
  };
}

function logCreateAndStart(params: CreateAndStartThreadParams, threadId: string): void {
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
}

/**
 * Strip any leading `<referenced-files>` XML block so titles, slugs, and
 * forwarded prompts don't show raw markup when files were attached inline.
 */
function titleSourceFor(params: CreateAndStartThreadParams): string {
  return params.title || stripReferencedFilesBlock(params.prompt) || params.prompt;
}

/** Resolve defaults: explicit value > project default > hardcoded fallback. */
function resolveRunDefaults(
  params: CreateAndStartThreadParams,
  project: StartProject,
): ResolvedRunDefaults {
  return {
    provider: (params.provider || project.defaultProvider || 'claude') as AgentProvider,
    model: (params.model || project.defaultModel || DEFAULT_MODEL) as AgentModel,
    permissionMode: (params.permissionMode ||
      project.defaultPermissionMode ||
      'autoEdit') as PermissionMode,
  };
}

/** Columns shared by every project-thread row variant. */
function baseProjectThreadRow(ctx: ProjectThreadContext) {
  const { params, defaults } = ctx;
  return {
    id: ctx.threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    title: ctx.titleSource,
    provider: defaults.provider,
    permissionMode: defaults.permissionMode,
    model: defaults.model,
    source: params.source || 'web',
    parentThreadId: params.parentThreadId,
    designId: params.designId,
    agentTemplateId: params.agentTemplateId,
    templateVariables: params.templateVariables
      ? JSON.stringify(params.templateVariables)
      : undefined,
    cost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function checkpointingFor(provider: AgentProvider): number {
  return provider === 'claude' ? 1 : 0;
}

async function augmentPromptReferences(
  params: CreateAndStartThreadParams,
  cwd: string,
): Promise<string> {
  const withFiles = await augmentPromptWithFiles(params.prompt, params.fileReferences, cwd);
  return augmentPromptWithSymbols(withFiles, params.symbolReferences, cwd);
}

/** `!cmd` initial prompts run locally and produce an already-completed thread. */
async function createShellEscapeProjectThread(ctx: ProjectThreadContext, shellCommand: string) {
  if (!shellCommand) {
    throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
  }
  const { params, defaults } = ctx;

  const branchResult = await getCurrentBranch(ctx.projectPath);
  const currentBranch = branchResult.isOk() ? branchResult.value : undefined;
  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: 'local' as const,
    runtime: 'local' as const,
    status: 'completed' as const,
    branch: currentBranch,
    baseBranch: ctx.resolvedBaseBranch || currentBranch,
    worktreePath: undefined as string | undefined,
    fileCheckpointingEnabled: 0,
  };

  await createCompletedShellEscapeThread({
    thread,
    threadId: ctx.threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    cwd: ctx.projectPath,
    command: shellCommand,
    prompt: params.prompt,
    images: params.images,
    model: defaults.model,
    permissionMode: defaults.permissionMode,
    effort: params.effort,
  });

  return thread;
}

/**
 * Create the thread row in `setting_up`, persist the first message and kick
 * off worktree creation + agent start in the background.
 */
async function createNewWorktreeThread(ctx: ProjectThreadContext) {
  const { params, defaults, threadId, projectPath } = ctx;
  const slug = slugifyTitle(ctx.titleSource);
  const projectSlug = slugifyTitle(ctx.project.name);
  const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;

  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: params.mode,
    runtime: (params.runtime || 'local') as 'local' | 'remote',
    status: 'setting_up' as const,
    branch: branchName,
    baseBranch: ctx.resolvedBaseBranch,
    worktreePath: undefined as string | undefined,
    fileCheckpointingEnabled: checkpointingFor(defaults.provider),
  };

  await tm.createThread(thread as any);

  if (params.prompt) {
    // The agent gets the fully augmented prompt (with file contents inlined)
    // when startAgent runs; what we persist for display is the path-only
    // metadata version. See stripInlineReferencedContent.
    const storedContent = await augmentPromptReferences(params, projectPath);
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
    projectId: ctx.projectId,
    userId: params.userId,
    cwd: projectPath,
    worktreePath: null,
    stage: 'in_progress' as const,
    status: 'setting_up',
  });

  // Background: create worktree, run post-create commands, start agent
  void setupWorktreeAndStartAgent(ctx, branchName);

  return thread;
}

async function markThreadFailed(userId: string, threadId: string): Promise<void> {
  await tm.updateThread(threadId, { status: 'failed' });
  emitThreadUpdated(userId, threadId, { status: 'failed' });
}

async function setupWorktreeAndStartAgent(
  ctx: ProjectThreadContext,
  branchName: string,
): Promise<void> {
  const { params, threadId, projectPath } = ctx;
  const emitSetupProgress = createSetupProgressEmitter(params.userId, threadId);
  try {
    const wtResult = await createWorktree(
      projectPath,
      branchName,
      ctx.resolvedBaseBranch,
      emitSetupProgress,
    );
    if (wtResult.isErr()) {
      await markThreadFailed(params.userId, threadId);
      return;
    }
    const wtPath = wtResult.value;

    logWorktreeSetupResult(threadId, await setupWorktree(projectPath, wtPath, emitSetupProgress));
    await markWorktreeReady(params.userId, threadId, branchName, wtPath);
    await startAgentInNewWorktree(ctx, wtPath);
  } catch (err) {
    log.error('Background worktree setup failed', { threadId, error: String(err) });
    await markThreadFailed(params.userId, threadId);
  }
}

/** Post-create setup problems are logged but never block the thread. */
function logWorktreeSetupResult(
  threadId: string,
  setupResult: Awaited<ReturnType<typeof setupWorktree>>,
): void {
  if (setupResult.isErr()) {
    log.warn('Failed to setup worktree', { threadId, error: setupResult.error.message });
    return;
  }
  const { postCreateErrors } = setupResult.value;
  if (postCreateErrors.length) {
    log.warn('Worktree postCreate errors', { threadId, errors: postCreateErrors });
  }
}

/** Record the worktree on the thread, transition it to pending and notify the user. */
async function markWorktreeReady(
  userId: string,
  threadId: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  await tm.updateThread(threadId, { worktreePath, status: 'pending' });
  wsBroker.emitToUser(userId, {
    type: 'worktree:setup_complete',
    threadId,
    data: { branch, worktreePath },
  } as WSEvent);
  emitThreadUpdated(userId, threadId, { status: 'pending', branch, worktreePath });
}

async function startAgentInNewWorktree(ctx: ProjectThreadContext, wtPath: string): Promise<void> {
  const { params, defaults, threadId } = ctx;
  // Use projectPath (not wtPath) because file references were selected from
  // the main repo; untracked/gitignored files won't exist in the freshly
  // created worktree.
  const augmentedPrompt = await augmentPromptReferences(params, ctx.projectPath);
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
      defaults.model,
      defaults.permissionMode,
      params.images,
      params.disallowedTools,
      allowedToolsForRun,
      defaults.provider,
      undefined,
      true, // skipMessageInsert — already inserted at thread creation
      params.effort,
    );
  } catch (err: any) {
    log.error('Failed to start agent after worktree setup', { threadId, error: err });
    await markThreadFailed(params.userId, threadId);
  }
}

interface LocalPlacement {
  worktreePath: string | undefined;
  threadBranch: string | undefined;
  needsBranchCheckout: boolean;
}

/**
 * Security CR-4: client-supplied worktreePath becomes the cwd for
 * browse/file-index/text-search/agent-spawn. An attacker who supplies an
 * arbitrary path — `/etc`, another user's HOME, etc. — would otherwise pivot
 * downstream file/command ops into that scope. Accept only paths registered
 * by Git as worktrees for this project, including externally-created
 * worktrees outside `.funny-worktrees`.
 */
async function assertRegisteredWorktree(projectPath: string, worktreePath: string): Promise<void> {
  const registeredResult = await isRegisteredWorktreePath(projectPath, worktreePath);
  if (registeredResult.isErr()) {
    throw new ThreadServiceError(registeredResult.error.message, 400);
  }
  if (!registeredResult.value) {
    throw new ThreadServiceError('worktreePath is not registered for this project', 400);
  }
}

/**
 * Decide where a local / existing-worktree thread runs and on which branch.
 * When a different base branch is requested, prefer an existing worktree
 * already on it; otherwise flag that a checkout is needed.
 */
async function resolveLocalPlacement(ctx: ProjectThreadContext): Promise<LocalPlacement> {
  const { params, projectPath, resolvedBaseBranch } = ctx;
  let worktreePath: string | undefined;
  if (params.worktreePath) {
    await assertRegisteredWorktree(projectPath, params.worktreePath);
    worktreePath = params.worktreePath;
  }

  const branchResult = await getCurrentBranch(params.worktreePath || projectPath);
  if (branchResult.isErr()) {
    return { worktreePath, threadBranch: undefined, needsBranchCheckout: false };
  }
  const currentBranch = branchResult.value;
  if (!resolvedBaseBranch || resolvedBaseBranch === currentBranch) {
    return { worktreePath, threadBranch: currentBranch, needsBranchCheckout: false };
  }

  const existingWorktree = await findWorktreeForBranch(projectPath, resolvedBaseBranch);
  if (existingWorktree.isOk() && existingWorktree.value) {
    return {
      worktreePath: existingWorktree.value,
      threadBranch: resolvedBaseBranch,
      needsBranchCheckout: false,
    };
  }
  return { worktreePath, threadBranch: resolvedBaseBranch, needsBranchCheckout: true };
}

/** Local mode with branch checkout (synchronous, no setting_up UI). */
async function checkoutBaseBranch(
  ctx: ProjectThreadContext,
  branch: string,
  checkoutCwd: string,
): Promise<void> {
  const fetchResult = await git(['fetch', 'origin', branch], checkoutCwd);
  if (fetchResult.isErr()) {
    log.warn('Failed to fetch branch before checkout (non-fatal)', {
      namespace: 'thread-service',
      threadId: ctx.threadId,
      branch,
      error: fetchResult.error.message,
    });
  }

  const checkoutResult = await git(['checkout', branch], checkoutCwd);
  if (checkoutResult.isErr()) {
    throw new ThreadServiceError(
      `Failed to checkout branch "${branch}": ${checkoutResult.error.message}`,
      400,
    );
  }
}

async function createLocalThread(ctx: ProjectThreadContext) {
  const { params, defaults, threadId, projectPath, resolvedBaseBranch } = ctx;
  const { worktreePath, threadBranch, needsBranchCheckout } = await resolveLocalPlacement(ctx);

  if (needsBranchCheckout) {
    // Falls through to the normal path below (status: 'pending')
    await checkoutBaseBranch(ctx, resolvedBaseBranch!, worktreePath ?? projectPath);
  }

  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: params.mode,
    status: 'pending' as const,
    runtime: (params.runtime || 'local') as 'local' | 'remote',
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (params.mode === 'local' ? threadBranch : undefined),
    worktreePath,
    fileCheckpointingEnabled: checkpointingFor(defaults.provider),
  };

  await tm.createThread(thread as any);

  const cwd = worktreePath ?? projectPath;

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    cwd,
    worktreePath: worktreePath ?? null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  // Augment prompt with file/symbol contents if references were provided
  const augmentedPrompt = await augmentPromptReferences(params, cwd);

  // ── Remote runtime: launch container instead of local agent ──
  if (params.runtime === 'remote') {
    await startRemoteContainerThread(ctx, threadBranch, augmentedPrompt);
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
    defaults.model,
    defaults.permissionMode,
    params.images,
    params.disallowedTools,
    allowedToolsForRun,
    defaults.provider,
    undefined,
    undefined,
    params.effort,
  );

  return thread;
}

/** Validate the launcher config and launch the container in the background. */
async function startRemoteContainerThread(
  ctx: ProjectThreadContext,
  threadBranch: string | undefined,
  augmentedPrompt: string,
): Promise<void> {
  const { project, params } = ctx;
  if (!project.launcherUrl) {
    throw new ThreadServiceError('Project has no launcher URL configured', 400);
  }

  const branch = threadBranch || 'main';
  const githubToken = await getServices().profile.getGithubToken(params.userId);

  // Launch container in background
  void launchRemoteContainer(ctx, {
    launcherUrl: project.launcherUrl,
    branch,
    githubToken: githubToken ?? undefined,
    augmentedPrompt,
  });
}

async function launchRemoteContainer(
  ctx: ProjectThreadContext,
  launch: { launcherUrl: string; branch: string; githubToken?: string; augmentedPrompt: string },
): Promise<void> {
  const { params, threadId } = ctx;
  await tm.updateThread(threadId, { status: 'setting_up' });
  emitThreadUpdated(params.userId, threadId, { status: 'setting_up' });

  const result = await launchContainer({
    threadId,
    projectPath: ctx.project.path,
    launcherUrl: launch.launcherUrl,
    branch: launch.branch,
    githubToken: launch.githubToken,
  });

  if (result.isErr()) {
    log.error('Failed to launch container', { threadId, error: result.error.message });
    await markThreadFailed(params.userId, threadId);
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

  await forwardPromptToContainer(ctx, containerUrl, launch.augmentedPrompt);
}

/**
 * Forward the initial prompt to the container's Funny server.
 *
 * Security HI-5: `containerUrl` is returned by the project's launcher (a
 * project-config'd URL), so a compromised launcher response could point at a
 * cloud-metadata endpoint. `safeFetchUserUrl` blocks IMDS ranges while
 * allowing legitimate LAN container URLs.
 */
async function forwardPromptToContainer(
  ctx: ProjectThreadContext,
  containerUrl: string,
  augmentedPrompt: string,
): Promise<void> {
  const { params, defaults, threadId } = ctx;
  try {
    const res = await safeFetchUserUrl(`${containerUrl}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ctx.projectId,
        title: ctx.titleSource,
        mode: params.mode,
        provider: defaults.provider,
        model: defaults.model,
        permissionMode: defaults.permissionMode,
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

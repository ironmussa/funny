/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */
/**
 * Shared types and helpers of thread creation (`create.ts`): the request
 * params, the project-thread context, run defaults and the row columns every
 * variant shares.
 */

import type { AgentProvider, AgentModel, PermissionMode, ImageAttachment } from '@funny/shared';
import { DEFAULT_PROVIDER, getDefaultModel } from '@funny/shared/models';
import { nanoid } from 'nanoid';

import { log } from '../../lib/logger.js';
import {
  augmentPromptWithFiles,
  augmentPromptWithSymbols,
  type FileRef,
  type SymbolRef,
} from '../../utils/file-mentions.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { getServices } from '../service-registry.js';
import * as tm from '../thread-manager.js';
import { ThreadServiceError, emitThreadUpdated, stripReferencedFilesBlock } from './helpers.js';

/**
 * Pre-merge "always allow" permission rules into the agent's allowedTools so
 * the SDK preToolUseHook short-circuits without prompting. Mirrors the helper
 * in messaging.ts; kept local here to avoid an extra cross-module import.
 */
export async function augmentAllowedToolsWithRules(
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
      // SAFETY: only `.message` is read, optional-chained; it is undefined when the
      // rule lookup throws something that is not Error-like.
      error: (err as Error)?.message,
    });
    return allowedTools;
  }
}

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
  /** Start a new worktree from `origin/<baseBranch>` (fetched first), not the local branch. */
  baseFromRemote?: boolean;
  /** Refuse (409) instead of falling back to a generated branch when `branch` is held elsewhere. */
  requireBranch?: boolean;
  /** The agent may only read, at every start (`threads.read_only`). */
  readOnly?: boolean;
  /** What a read-only agent reads besides its checkout (`agent-startup/role-inputs.ts`). */
  roleInputs?: Record<string, string>;
  /** Branch for a `worktree` thread's worktree; generated from the title when absent. */
  branch?: string;
  prompt: string;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  /** Ids from POST /api/uploads/staging — adopted into the thread on creation. */
  stagedUploads?: string[];
  worktreePath?: string;
  parentThreadId?: string;
  designId?: string;
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
  /** True for lightweight projectless threads (no git, no worktree). */
  isScratch?: boolean;
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
export interface ProjectThreadContext {
  params: CreateAndStartThreadParams;
  projectId: string;
  project: StartProject;
  projectPath: string;
  threadId: string;
  resolvedBaseBranch: string | undefined;
  defaults: ResolvedRunDefaults;
  titleSource: string;
}

/** Validate the project, resolve the per-user path and run defaults. */
export async function resolveProjectThreadContext(
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
    // Only the length: the prompt can start with client-inlined file contents (#182).
    promptLength: params.prompt.length,
  });
}

/**
 * Strip any leading `<referenced-files>` XML block so titles, slugs, and
 * forwarded prompts don't show raw markup when files were attached inline.
 */
function titleSourceFor(params: CreateAndStartThreadParams): string {
  return params.title || stripReferencedFilesBlock(params.prompt) || params.prompt;
}

/**
 * Resolve defaults: explicit value > project default > hardcoded fallback.
 * Provider and model always come as a pair: a model sent without a provider is
 * a DEFAULT_PROVIDER model, and a provider sent without a model gets the
 * project's model only when the project uses that provider (else the
 * provider's own default model).
 */
function resolveRunDefaults(
  params: CreateAndStartThreadParams,
  project: StartProject,
): ResolvedRunDefaults {
  const projectProvider: AgentProvider = project.defaultProvider || DEFAULT_PROVIDER;
  const provider: AgentProvider =
    params.provider || (params.model ? DEFAULT_PROVIDER : projectProvider);
  const projectModel = provider === projectProvider ? project.defaultModel : undefined;
  return {
    provider,
    // SAFETY: params.model passed agentModelSchema and projects.default_model is validated
    // the same way on project update; ids of dynamic-catalog providers (pi, cursor, ...) are
    // not in the AgentModel union and are passed through unchanged by resolveModelId.
    model: (params.model || projectModel || getDefaultModel(provider)) as AgentModel,
    // SAFETY: params.permissionMode and projects.default_permission_mode are both
    // validated with permissionModeSchema, whose values are exactly PermissionMode.
    permissionMode: (params.permissionMode ||
      project.defaultPermissionMode ||
      'autoEdit') as PermissionMode,
  };
}

/** Columns shared by every project-thread row variant. */
export function baseProjectThreadRow(ctx: ProjectThreadContext) {
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
    readOnly: params.readOnly ? 1 : 0,
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

export function checkpointingFor(provider: AgentProvider): number {
  return provider === 'claude' ? 1 : 0;
}

export async function augmentPromptReferences(
  params: CreateAndStartThreadParams,
  cwd: string,
): Promise<string> {
  const withFiles = await augmentPromptWithFiles(params.prompt, params.fileReferences, cwd);
  return augmentPromptWithSymbols(withFiles, params.symbolReferences, cwd);
}

export async function markThreadFailed(userId: string, threadId: string): Promise<void> {
  await tm.updateThread(threadId, { status: 'failed' });
  emitThreadUpdated(userId, threadId, { status: 'failed' });
}

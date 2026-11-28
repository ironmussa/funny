/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */

import { stat } from 'fs/promises';
import { join } from 'path';

import { getCurrentBranch, isContainedPath } from '@funny/core/git';
import type { ImageAttachment } from '@funny/shared';
import { addReferencedEntries, type ReferencedEntry } from '@funny/shared/attachments';
import { nanoid } from 'nanoid';
import { ResultAsync } from 'neverthrow';

import { stripInlineReferencedContent, type FileRef } from '../../utils/file-mentions.js';
import { getServices } from '../service-registry.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import {
  ThreadServiceError,
  slugifyTitle,
  releaseStagedUploadsOnSuccess,
  stripReferencedFilesBlock,
  withStagedUploads,
} from './helpers.js';
import { prepareWorktree } from './worktree-preparation.js';

export interface CreateIdleThreadParams {
  projectId: string;
  userId: string;
  title: string;
  mode: 'local' | 'worktree';
  source?: string;
  branch?: string;
  baseBranch?: string;
  /** When `prepareWorktree` is true, branch from `origin/<baseBranch>` fetched fresh. */
  baseFromRemote?: boolean;
  /** Create the worktree immediately instead of waiting for the first message. */
  prepareWorktree?: boolean;
  prompt?: string;
  images?: ImageAttachment[];
  /** Stored as path-only entries; read when the thread starts. */
  fileReferences?: FileRef[];
  /** Ids from POST /api/uploads/staging — adopted into the project checkout. */
  stagedUploads?: string[];
  stage?: 'backlog' | 'planning';
  designId?: string;
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
}

/**
 * Record a backlog thread's references in its prompt as path-only
 * `<referenced-files>` entries (the attachment manifest). Nothing is read
 * now: `hydrateReferencedFiles` inlines them when the thread starts.
 */
async function withReferenceManifest(
  prompt: string,
  refs: readonly FileRef[],
  basePath: string,
): Promise<string> {
  if (refs.length === 0) return prompt;
  const entries = await Promise.all(
    refs.map(async (ref): Promise<ReferencedEntry> => {
      // Only to pick the chip type; containment is enforced again on hydration.
      const fullPath = join(basePath, ref.path);
      const info = isContainedPath(basePath, fullPath)
        ? await stat(fullPath).catch(() => null)
        : null;
      return { type: info?.isDirectory() ? 'folder' : 'file', path: ref.path };
    }),
  );
  return addReferencedEntries(prompt, entries);
}

export function createIdleThread(
  params: CreateIdleThreadParams,
): ResultAsync<Awaited<ReturnType<typeof createIdleThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(createIdleThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  ).map(releaseStagedUploadsOnSuccess(params));
}

/**
 * The stored prompt of a backlog thread: staged uploads are adopted into the
 * project checkout (a worktree thread gets them copied when it starts) and
 * every reference is recorded in the attachment manifest.
 */
async function idleThreadPrompt(
  params: CreateIdleThreadParams,
  threadId: string,
  projectPath: string,
): Promise<string | undefined> {
  const { fileReferences: refs = [] } = await withStagedUploads(params, threadId, projectPath);
  if (params.prompt === undefined && refs.length === 0) return undefined;
  return withReferenceManifest(params.prompt ?? '', refs, projectPath);
}

/** Branch a backlog thread will run on: a new worktree branch, or the checkout's current one. */
async function idleThreadBranches(
  params: CreateIdleThreadParams,
  projectName: string,
  threadId: string,
  projectPath: string,
): Promise<{ branch?: string; baseBranch?: string }> {
  const resolvedBaseBranch = params.baseBranch?.trim() || undefined;
  if (params.mode === 'worktree') {
    const explicitBranch = params.branch?.trim();
    if (explicitBranch) {
      return { branch: explicitBranch, baseBranch: resolvedBaseBranch };
    }
    // Titles may carry the attachments block (badge) — never slug the XML.
    const slug = slugifyTitle(stripReferencedFilesBlock(params.title));
    const branch = `${slugifyTitle(projectName)}/${slug}-${threadId.slice(0, 6)}`;
    return { branch, baseBranch: resolvedBaseBranch };
  }
  const branchResult = await getCurrentBranch(projectPath);
  const branch = branchResult.isOk() ? branchResult.value : undefined;
  return { branch, baseBranch: resolvedBaseBranch || branch };
}

function buildIdleThreadRecord(
  params: CreateIdleThreadParams,
  threadId: string,
  prompt: string | undefined,
  branch: string | undefined,
  baseBranch: string | undefined,
  worktreePath: string | undefined,
) {
  const now = new Date().toISOString();
  return {
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
    stage: params.stage || ('backlog' as const),
    branch,
    baseBranch,
    worktreePath,
    initialPrompt: prompt,
    designId: params.designId,
    agentTemplateId: params.agentTemplateId,
    templateVariables: params.templateVariables
      ? JSON.stringify(params.templateVariables)
      : undefined,
    fileCheckpointingEnabled: 1,
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function persistInitialIdleMessage(
  threadId: string,
  prompt: string | undefined,
  images: CreateIdleThreadParams['images'],
) {
  const hasImages = Boolean(images?.length);
  if (!prompt && !hasImages) return;
  await tm.insertMessage({
    threadId,
    role: 'user',
    content: stripInlineReferencedContent(prompt ?? ''),
    images: hasImages ? JSON.stringify(images) : null,
  });
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
  const prompt = await idleThreadPrompt(params, threadId, projectPath);
  const { branch, baseBranch } = await idleThreadBranches(
    params,
    project.name,
    threadId,
    projectPath,
  );

  let worktreePath: string | undefined;
  if (params.prepareWorktree && params.mode === 'worktree' && branch) {
    const prep = await prepareWorktree({
      projectPath,
      branchName: branch,
      baseBranch,
      baseFromRemote: params.baseFromRemote,
      userId: params.userId,
      threadId,
      flow: 'create',
      projectId: params.projectId,
    });
    if (prep.isErr()) {
      throw new ThreadServiceError(prep.error.message, 409);
    }
    worktreePath = prep.value;
  }

  const thread = buildIdleThreadRecord(params, threadId, prompt, branch, baseBranch, worktreePath);

  await tm.createThread(thread);
  await persistInitialIdleMessage(threadId, prompt, params.images);

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: params.projectId,
    userId: params.userId,
    cwd: worktreePath ?? projectPath,
    worktreePath: worktreePath ?? null,
    stage: thread.stage,
    status: 'idle',
    initialPrompt: prompt,
  });

  return thread;
}

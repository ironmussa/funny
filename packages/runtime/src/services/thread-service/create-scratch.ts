/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */

import { mkdir } from 'fs/promises';

import type { AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import { DEFAULT_MODEL } from '@funny/shared/models';
import { nanoid } from 'nanoid';

import { log } from '../../lib/logger.js';
import { stripInlineReferencedContent } from '../../utils/file-mentions.js';
import { startAgent } from '../agent-runner-control.js';
import { scratchPathFor } from '../thread-context.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { augmentPromptReferences, type CreateAndStartThreadParams } from './create-context.js';
import { createScratchShellEscapeThread } from './create-shell-escape.js';
import { stripReferencedFilesBlock, withStagedUploads } from './helpers.js';
import { extractShellEscapeCommand } from './shell-escape.js';

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
/** Scratch cwd for a new thread, with any staged uploads adopted into it. */
async function prepareScratchThread(rawParams: CreateAndStartThreadParams, threadId: string) {
  const scratchCwd = scratchPathFor(rawParams.userId, threadId);
  if (rawParams.stagedUploads?.length) await mkdir(scratchCwd, { recursive: true });
  return { scratchCwd, params: await withStagedUploads(rawParams, threadId, scratchCwd) };
}

export async function createAndStartScratchThread(rawParams: CreateAndStartThreadParams) {
  const threadId = nanoid();
  const { scratchCwd, params } = await prepareScratchThread(rawParams, threadId);
  const titleSource = params.title || stripReferencedFilesBlock(params.prompt) || params.prompt;

  const resolvedProvider = (params.provider || 'claude') as AgentProvider;
  const resolvedModel = (params.model || DEFAULT_MODEL) as AgentModel;
  const resolvedPermissionMode = (params.permissionMode || 'autoEdit') as PermissionMode;

  log.info('createAndStartScratchThread called', {
    namespace: 'scratch-threads',
    threadId,
    userId: params.userId,
    // Only the length: the prompt can start with client-inlined file contents (#182).
    promptLength: params.prompt.length,
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
    return createScratchShellEscapeThread(thread, shellCommand, {
      params,
      cwd: scratchCwd,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
    });
  }

  await tm.createThread(thread as any);

  // Persist the user message ourselves so we can pass skipMessageInsert
  // to startAgent (matches the worktree-mode pattern above). Like project
  // threads, the agent gets file contents inlined; the stored copy keeps
  // path-only references so the UI renders chips.
  const augmentedPrompt = await augmentPromptReferences(params, scratchCwd);
  await tm.insertMessage({
    threadId,
    role: 'user',
    content: stripInlineReferencedContent(augmentedPrompt),
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
  const started = await startAgent(
    threadId,
    augmentedPrompt,
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
  if (started.isErr()) throw new Error(started.error.message);

  return thread;
}

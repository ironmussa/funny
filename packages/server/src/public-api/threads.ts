/**
 * Thread creation and the model registry for the public REST API v1
 * (openspec public-rest-api-v1, design D3).
 *
 * Creation runs the same use case as the web app's `POST /api/threads` and the
 * automations (`startThreadOnRunner` → `modules/threads`), which picks the
 * caller's own runner through `withRunnerFor` and sends through
 * `AuthorizedRunnerRequests`, signed as the caller. There is no other path to
 * a runner here and no fallback: without a usable runner of the caller's it
 * answers 502.
 */

import { failure, type ApiFailure } from '@funny/api';
import type { AgentProvider, ThreadSource } from '@funny/shared';
import type {
  CreateThreadInput,
  PublicModelList,
  PublicThread,
} from '@funny/shared/contracts/public-v1';
import {
  DEFAULT_PROVIDER,
  getDefaultModel,
  getProviderModelsWithLabels,
  MODEL_REGISTRY,
  PROVIDER_LABELS,
} from '@funny/shared/models';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { repos } from '../db/repos.js';
import { audit } from '../lib/audit.js';
import { projectRole } from '../lib/server-authorizer.js';
import { decideProjectAccess } from '../middleware/project-access.js';
import { startThreadOnRunner } from '../services/runner-thread-launcher.js';
import type { PublicApiContext } from './trpc.js';

const threadRepo = repos.threads();

/** The body the runner's thread-creation endpoint receives: only what v1 accepts. */
function runnerBody(input: CreateThreadInput): Record<string, unknown> {
  const source: ThreadSource = input.client === 'chrome_extension' ? 'chrome_extension' : 'api';
  return {
    projectId: input.projectId,
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    mode: input.mode,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    permissionMode: input.permissionMode,
    source,
    ...(input.images?.length
      ? {
          images: input.images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
        }
      : {}),
  };
}

/** The fields read off the runner's reply when the server has no row for the thread. */
const runnerThreadReply = z
  .object({
    id: z.string().catch(''),
    title: z.string().catch(''),
    status: z.string().catch('pending'),
    createdAt: z.string().catch(() => new Date().toISOString()),
  })
  .catch(() => ({ id: '', title: '', status: 'pending', createdAt: new Date().toISOString() }));

/**
 * The created thread as published, from the server's row. The runner persists
 * the row through the data channel before replying, so the fallback to its
 * reply only covers a row that is somehow missing.
 */
async function publishedThread(
  threadId: string | undefined,
  runnerThread: unknown,
  projectId: string,
): Promise<PublicThread> {
  const row = threadId ? await threadRepo.getThread(threadId) : undefined;
  if (row) {
    const { id, title, status, createdAt } = row;
    return { id, projectId, title, status, createdAt };
  }
  return { ...runnerThreadReply.parse(runnerThread), projectId };
}

/**
 * Create and start a thread on the caller's runner. 404 for a project the
 * caller has no role on, 403 without the `steer` capability (what the runner's
 * data channel requires of a non-owner too: owner or project member), 502 when
 * the caller has no usable runner.
 */
export async function createPublicThread(
  userId: string,
  runners: PublicApiContext['runners'],
  input: CreateThreadInput,
): Promise<Result<PublicThread, ApiFailure>> {
  const refused = await decideProjectAccess(
    projectRole,
    'steer',
    input.projectId,
    userId,
    'You cannot create threads in this project',
  );
  if (refused) return err(failure(refused.status, refused.message));
  if (!runners.requests) return err(failure(502, 'No runner connection is available'));

  const started = await startThreadOnRunner(
    { userId, body: runnerBody(input) },
    { requests: runners.requests, presence: runners.presence },
  );
  if (started.isErr()) return err(failure(started.error.status, started.error.message));

  const { threadId, thread } = started.value;
  audit({
    action: 'pat.thread_created',
    actorId: userId,
    detail: 'Thread created through the public REST API',
    meta: { threadId, projectId: input.projectId, client: input.client ?? 'api' },
  });
  return ok(await publishedThread(threadId, thread, input.projectId));
}

/** Every provider and model the server's registry offers, with their defaults. */
export function listPublicModels(): PublicModelList {
  const providers = (Object.keys(MODEL_REGISTRY) as AgentProvider[]).map((id) => ({
    id,
    name: PROVIDER_LABELS[id] ?? id,
    defaultModel: getDefaultModel(id),
    models: getProviderModelsWithLabels(id).map((m) => ({ id: m.value, name: m.label })),
  }));
  return { defaultProvider: DEFAULT_PROVIDER, providers };
}
